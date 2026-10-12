/**
 * SNS予約投稿エンジン
 *
 * 何をする:
 *   スプレッドシート「投稿予定」に本文・投稿日時・プラットフォームを書いておくと、
 *   GASの時間主導トリガー（または手動実行）が「投稿対象時刻が来た行」だけを判定し、
 *   各SNSの公式APIで投稿する。結果（成功/失敗・投稿ID・投稿URL）を元の行と
 *   「投稿ログ」シートの両方に記録する。同じ行を再実行しても二重投稿しない。
 *
 * 設計上の境界:
 *   各SNSの公式APIのみを使用する。ブラウザの自動操作（Selenium/Playwright等での
 *   ログイン・クリック）や非公式APIは扱わない（アカウント凍結リスクのため）。
 *
 * デモモード:
 *   DEMO_MODE=true では各SNSへ実際にはPOSTせず、ダミーID とステータス
 *   「送信済(デモ)」を書き込む（実アカウント・実APIキー無しで動きを確かめるため）。
 *
 * 一次確認・出典（使う前に必ず最新情報を再確認すること。数値は執筆時点のスナップショット）:
 *   - X API: 2026-02-06 に pay-per-use（従量課金）がデフォルト化。新規開発者向けの
 *     無料tierは無い。投稿作成 $0.015/件（URL無し）/ $0.20/件（URL入り）。
 *     レート制限は課金額と別枠で存在: ユーザーコンテキスト 100件/15分・10,000件/24時間。
 *     出典: docs.x.com/x-api/getting-started/pricing、docs.x.com/x-api/fundamentals/rate-limits
 *     （確認日 2026-07-03。料金・上限は変わり得るので要最新確認）。
 *   - Instagram Graph API: 投稿にはビジネス/クリエイターアカウントへの切り替えと
 *     Facebookアプリの権限（App Review）が前提。フィード投稿は画像/動画などの
 *     メディアが必須で、テキストのみの投稿はできない仕様（Meta公式ドキュメントの
 *     一般公開仕様。要最新確認）。
 *   - Threads API: Meta開発者アカウントでのアプリ登録・トークン発行が前提
 *     （Meta公式ドキュメントの一般公開仕様。要最新確認）。
 *   - 文字数上限（CONFIG.MAX_LEN）は執筆時点で広く知られる目安値。各社の最新仕様を
 *     使う前に確認し、必要ならこの値を差し替える。
 */

// ==== 設定（認証情報はここに書かず、スクリプトプロパティに置く）====
var CONFIG = {
  DEMO_MODE: true,
  DEMO_NOW: null,              // デモ/テスト用に「今」を固定したい場合はISO文字列（例 '2026-07-15T09:00:00+09:00'）

  SCHEDULE_SHEET: '投稿予定',
  LOG_SHEET: '投稿ログ',
  TIMEZONE: 'Asia/Tokyo',

  // 使う媒体だけを並べる。ここに無い媒体の行は検証エラーになる。
  ENABLED_PLATFORMS: ['X', 'Instagram', 'Threads'],

  // 文字数上限の目安（要最新確認。使う前に各社最新ドキュメントで確認しここを差し替える）
  MAX_LEN: { X: 280, Instagram: 2200, Threads: 500 },

  NOTIFY_ON_FAILURE: false,    // true で投稿失敗時にメール/Slack通知
  NOTIFY_EMAIL: '',
  SLACK_WEBHOOK_URL: '',

  X_API_BASE: 'https://api.x.com/2/tweets',
  META_GRAPH_VERSION: 'v21.0', // 要最新確認。使う前に現行バージョンへ更新する
  META_GRAPH_BASE: 'https://graph.facebook.com',
  THREADS_API_BASE: 'https://graph.threads.net/v1.0'
};

var SCHEDULE_HEADERS = ['本文', '投稿日時', 'プラットフォーム', '画像URL', 'ステータス', '投稿ID', '投稿URL', '送信日時', 'エラー'];
var LOG_HEADERS = ['実行日時', '対象行', 'プラットフォーム', '本文(先頭40字)', '予定投稿日時', '結果', '投稿ID', '詳細'];

/**
 * メイン: 投稿対象時刻が来た行を判定して投稿する。時間主導トリガーまたは手動実行から呼ぶ。
 */
function runScheduledPosts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedule = getOrCreateSheet_(ss, CONFIG.SCHEDULE_SHEET, SCHEDULE_HEADERS);
  if (CONFIG.DEMO_MODE) ensureDemoData_(schedule);
  var log = getOrCreateSheet_(ss, CONFIG.LOG_SHEET, LOG_HEADERS);

  var now = resolveNow_();
  var headerMap = headerMap_(schedule);
  var rows = readScheduleRows_(schedule, headerMap);

  var summary = { sent: 0, skipped: 0, failed: 0 };
  rows.forEach(function (row) {
    var check = isRowDue_(row, now);
    if (!check.due) {
      if (check.reason !== 'already_processed' && check.reason !== 'already_sent') summary.skipped++;
      return; // 未到来・空行・処理済みなどはそのままスキップ（=二重投稿しない）
    }
    var outcome = processRow_(row, now);
    writeRowResult_(schedule, headerMap, row.rowIndex, outcome, now);
    appendLog_(log, now, row, outcome);
    if (outcome.status === 'エラー') {
      summary.failed++;
      if (CONFIG.NOTIFY_ON_FAILURE) notifyFailure_(row, outcome);
    } else {
      summary.sent++;
    }
  });

  Logger.log('実行完了: %s（DEMO_MODE=%s, now=%s）', JSON.stringify(summary), CONFIG.DEMO_MODE, now.toISOString());
  return summary;
}

// ==== 判定・処理（コア。テストで検証する純関数群）====

/**
 * 行が「今回処理すべき対象」かどうかを判定する。
 * すでに投稿ID/ステータスが入っている行は対象外にする＝これが二重投稿を防ぐ仕組み。
 */
function isRowDue_(row, now) {
  if (!row.body) return { due: false, reason: 'empty_body' };
  if (row.externalId) return { due: false, reason: 'already_sent' };
  if (row.status) return { due: false, reason: 'already_processed' };
  if (!row.scheduledAt || isNaN(row.scheduledAt.getTime())) return { due: false, reason: 'invalid_date' };
  if (row.scheduledAt.getTime() > now.getTime()) return { due: false, reason: 'future' };
  return { due: true, reason: 'due' };
}

/**
 * 投稿前チェック。プラットフォーム未対応・文字数超過・Instagramの画像必須などを検出する。
 * 戻り値は空配列なら問題なし。
 */
function validateRow_(row) {
  var errors = [];
  if (CONFIG.ENABLED_PLATFORMS.indexOf(row.platform) === -1) {
    errors.push('未対応または未設定のプラットフォーム: ' + row.platform);
    return errors; // 以降のチェックは無意味なのでここで返す
  }
  var maxLen = CONFIG.MAX_LEN[row.platform];
  if (maxLen && row.body.length > maxLen) {
    errors.push(row.platform + 'の文字数上限(目安' + maxLen + '字)を超えています(' + row.body.length + '字)');
  }
  if (row.platform === 'Instagram' && !row.imageUrl) {
    errors.push('Instagramのフィード投稿は画像/動画が必須です（テキストのみは投稿できません）');
  }
  return errors;
}

/** 検証→投稿（デモ or 本番）まで行い、結果を返す。 */
function processRow_(row, now) {
  var errors = validateRow_(row);
  if (errors.length) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: errors.join(' / ') };
  }
  return CONFIG.DEMO_MODE ? postDemo_(row) : postToPlatform_(row);
}

/** デモ投稿: 実際にはどこにもPOSTせず、投稿した体のダミー結果を返す。 */
function postDemo_(row) {
  var id = 'DEMO-' + Utilities.getUuid().slice(0, 8);
  return { status: '送信済(デモ)', externalId: id, externalUrl: '(デモのため実URLはありません)', error: '' };
}

/** 本番投稿の振り分け。DEMO_MODE=false かつ本物の認証情報が設定されて初めて呼ばれる。 */
function postToPlatform_(row) {
  switch (row.platform) {
    case 'X': return postToX_(row);
    case 'Instagram': return postToInstagram_(row);
    case 'Threads': return postToThreads_(row);
    default: return { status: 'エラー', externalId: '', externalUrl: '', error: '未対応のプラットフォーム: ' + row.platform };
  }
}

// ==== 本番クライアント（公式APIのみ。DEMO_MODE=falseかつ認証情報設定時のみ実行される）====

/**
 * X（旧Twitter）投稿: OAuth1.0a User Context で POST /2/tweets。
 * 認証情報はスクリプトプロパティ（X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET）。
 */
function postToX_(row) {
  var cred = getProps_(['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET']);
  if (!cred.X_API_KEY || !cred.X_ACCESS_TOKEN) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'X認証情報が未設定です（スクリプトプロパティ）' };
  }
  var url = CONFIG.X_API_BASE;
  var authHeader = buildOAuth1Header_('POST', url, {},
    cred.X_API_KEY, cred.X_API_SECRET, cred.X_ACCESS_TOKEN, cred.X_ACCESS_SECRET);
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: authHeader },
    payload: JSON.stringify({ text: row.body })
  });
  var code = res.getResponseCode();
  var json = safeJsonParse_(res.getContentText());
  if (code === 401 || code === 403 || code === 429) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'X API エラー(' + code + '): ' + res.getContentText() };
  }
  if (code >= 200 && code < 300 && json && json.data && json.data.id) {
    return { status: '送信済', externalId: json.data.id, externalUrl: 'https://x.com/i/web/status/' + json.data.id, error: '' };
  }
  return { status: 'エラー', externalId: '', externalUrl: '', error: 'X API 想定外の応答(' + code + '): ' + res.getContentText() };
}

/**
 * Instagram投稿: Graph API の2段階（メディアコンテナ作成→公開）。
 * 認証情報はスクリプトプロパティ（IG_USER_ID / IG_ACCESS_TOKEN）。
 */
function postToInstagram_(row) {
  var cred = getProps_(['IG_USER_ID', 'IG_ACCESS_TOKEN']);
  if (!cred.IG_USER_ID || !cred.IG_ACCESS_TOKEN) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'Instagram認証情報が未設定です（スクリプトプロパティ）' };
  }
  var base = CONFIG.META_GRAPH_BASE + '/' + CONFIG.META_GRAPH_VERSION + '/' + cred.IG_USER_ID;

  var createRes = UrlFetchApp.fetch(base + '/media', {
    method: 'post',
    muteHttpExceptions: true,
    payload: { image_url: row.imageUrl, caption: row.body, access_token: cred.IG_ACCESS_TOKEN }
  });
  var createJson = safeJsonParse_(createRes.getContentText());
  if (!createJson || !createJson.id) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'Instagramメディア作成失敗: ' + createRes.getContentText() };
  }

  var publishRes = UrlFetchApp.fetch(base + '/media_publish', {
    method: 'post',
    muteHttpExceptions: true,
    payload: { creation_id: createJson.id, access_token: cred.IG_ACCESS_TOKEN }
  });
  var publishJson = safeJsonParse_(publishRes.getContentText());
  if (!publishJson || !publishJson.id) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'Instagram公開失敗: ' + publishRes.getContentText() };
  }
  // 投稿URL(パーマリンク)取得には追加のAPI呼び出しが要るため、ここではIDの記録に留める
  return { status: '送信済', externalId: publishJson.id, externalUrl: '(パーマリンクは未取得)', error: '' };
}

/**
 * Threads投稿: Threads API の2段階（投稿コンテナ作成→公開）。
 * 認証情報はスクリプトプロパティ（THREADS_USER_ID / THREADS_ACCESS_TOKEN）。
 */
function postToThreads_(row) {
  var cred = getProps_(['THREADS_USER_ID', 'THREADS_ACCESS_TOKEN']);
  if (!cred.THREADS_USER_ID || !cred.THREADS_ACCESS_TOKEN) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'Threads認証情報が未設定です（スクリプトプロパティ）' };
  }
  var base = CONFIG.THREADS_API_BASE + '/' + cred.THREADS_USER_ID;

  var createPayload = { media_type: 'TEXT', text: row.body, access_token: cred.THREADS_ACCESS_TOKEN };
  if (row.imageUrl) { createPayload.media_type = 'IMAGE'; createPayload.image_url = row.imageUrl; }

  var createRes = UrlFetchApp.fetch(base + '/threads', {
    method: 'post', muteHttpExceptions: true, payload: createPayload
  });
  var createJson = safeJsonParse_(createRes.getContentText());
  if (!createJson || !createJson.id) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'Threadsコンテナ作成失敗: ' + createRes.getContentText() };
  }

  var publishRes = UrlFetchApp.fetch(base + '/threads_publish', {
    method: 'post', muteHttpExceptions: true,
    payload: { creation_id: createJson.id, access_token: cred.THREADS_ACCESS_TOKEN }
  });
  var publishJson = safeJsonParse_(publishRes.getContentText());
  if (!publishJson || !publishJson.id) {
    return { status: 'エラー', externalId: '', externalUrl: '', error: 'Threads公開失敗: ' + publishRes.getContentText() };
  }
  return { status: '送信済', externalId: publishJson.id, externalUrl: '(パーマリンクは未取得)', error: '' };
}

/** X用 OAuth1.0a 署名ヘッダ組み立て（RFC5849）。GASの Utilities.computeHmacSignature を使う。 */
function buildOAuth1Header_(method, url, extraParams, apiKey, apiSecret, token, tokenSecret) {
  var oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: Utilities.getUuid().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0'
  };
  var allParams = {};
  Object.keys(oauthParams).forEach(function (k) { allParams[k] = oauthParams[k]; });
  Object.keys(extraParams || {}).forEach(function (k) { allParams[k] = extraParams[k]; });

  var paramString = Object.keys(allParams).sort().map(function (k) {
    return pctEncode_(k) + '=' + pctEncode_(allParams[k]);
  }).join('&');
  var baseString = method.toUpperCase() + '&' + pctEncode_(url) + '&' + pctEncode_(paramString);
  var signingKey = pctEncode_(apiSecret) + '&' + pctEncode_(tokenSecret);
  var signatureBytes = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, baseString, signingKey);
  var signature = Utilities.base64Encode(signatureBytes);

  var headerParams = { oauth_signature: signature };
  Object.keys(oauthParams).forEach(function (k) { headerParams[k] = oauthParams[k]; });
  var header = 'OAuth ' + Object.keys(headerParams).sort().map(function (k) {
    return pctEncode_(k) + '="' + pctEncode_(headerParams[k]) + '"';
  }).join(', ');
  return header;
}

function pctEncode_(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

// ==== 通知（NOTIFY_ON_FAILURE=true のとき）====
function notifyFailure_(row, outcome) {
  var subject = 'SNS予約投稿 失敗: ' + row.platform + ' (行' + row.rowIndex + ')';
  var body = '対象行: ' + row.rowIndex + '\nプラットフォーム: ' + row.platform +
    '\n本文冒頭: ' + truncate_(row.body, 40) + '\nエラー: ' + outcome.error;
  if (CONFIG.NOTIFY_EMAIL) {
    MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, subject, body);
  }
  if (CONFIG.SLACK_WEBHOOK_URL) {
    UrlFetchApp.fetch(CONFIG.SLACK_WEBHOOK_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ text: subject + '\n' + body })
    });
  }
}

// ==== シート入出力 ====

function headerMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { if (h !== '') map[String(h)] = i + 1; });
  return map;
}

function readScheduleRows_(sheet, headerMap) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map(function (r, i) {
    return {
      rowIndex: i + 2,
      body: String(r[headerMap['本文'] - 1] || '').trim(),
      scheduledAt: parseDateCell_(r[headerMap['投稿日時'] - 1]),
      platform: String(r[headerMap['プラットフォーム'] - 1] || '').trim(),
      imageUrl: String(r[headerMap['画像URL'] - 1] || '').trim(),
      status: String(r[headerMap['ステータス'] - 1] || '').trim(),
      externalId: String(r[headerMap['投稿ID'] - 1] || '').trim()
    };
  });
}

function writeRowResult_(sheet, headerMap, rowIndex, outcome, now) {
  sheet.getRange(rowIndex, headerMap['ステータス']).setValue(outcome.status);
  sheet.getRange(rowIndex, headerMap['投稿ID']).setValue(outcome.externalId || '');
  sheet.getRange(rowIndex, headerMap['投稿URL']).setValue(outcome.externalUrl || '');
  sheet.getRange(rowIndex, headerMap['送信日時']).setValue(fmtDateTime_(now));
  sheet.getRange(rowIndex, headerMap['エラー']).setValue(outcome.error || '');
}

function appendLog_(logSheet, now, row, outcome) {
  logSheet.appendRow([
    fmtDateTime_(now), row.rowIndex, row.platform, truncate_(row.body, 40),
    row.scheduledAt ? fmtDateTime_(row.scheduledAt) : '', outcome.status, outcome.externalId || '', outcome.error || ''
  ]);
}

function getOrCreateSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** デモ用: 未来1件・現在到来済み1件・処理済み1件のサンプル行を用意する（空シートの時だけ）。 */
function ensureDemoData_(sheet) {
  if (sheet.getLastRow() >= 2) return;
  var now = resolveNow_();
  var past = new Date(now.getTime() - 10 * 60 * 1000);   // 10分前=到来済み
  var future = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24時間後=未来
  sheet.getRange(2, 1, 3, SCHEDULE_HEADERS.length).setValues([
    ['新商品を本日リリースしました。詳しくはプロフィールのリンクから。', past, 'X', '', '', '', '', '', ''],
    ['週末限定キャンペーンのお知らせです。', future, 'Threads', '', '', '', '', '', ''],
    ['季節のおすすめ商品をご紹介します。', past, 'Instagram', 'https://example.com/sample.jpg', '', '', '', '', '']
  ]);
}

// ==== ユーティリティ ====
function resolveNow_() {
  return CONFIG.DEMO_NOW ? new Date(CONFIG.DEMO_NOW) : new Date();
}
function parseDateCell_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDateTime_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function truncate_(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function safeJsonParse_(text) { try { return JSON.parse(text); } catch (e) { return null; } }
function getProps_(keys) {
  var props = PropertiesService.getScriptProperties();
  var out = {};
  keys.forEach(function (k) { out[k] = props.getProperty(k) || ''; });
  return out;
}

/** 時間主導トリガーの設定（任意・1回実行すればよい）。15分おきに runScheduledPosts を呼ぶ。 */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runScheduledPosts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runScheduledPosts').timeBased().everyMinutes(15).create();
  Logger.log('トリガー作成: 15分おきに runScheduledPosts を実行');
}
