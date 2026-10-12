'use strict';
// Code.gs のNodeモックハーネステスト。
// 確かめること:
//  (1) デモモードでシートに行を追加→トリガー実行→ログシートに「送信済(デモ)」の記録が正しい内容で追記される
//  (2) 二重投稿しない（同じ行を再実行しても再送されない）冪等性
//  (3) 追加: 検証ロジック(validateRow_)・エラー時のスキップ/通知トリガー・isRowDue_の判定分岐
const assert = require('assert');
const { loadCode } = require('./load-code');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('OK   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

// ---- 1. isRowDue_ の判定分岐（純関数） ----
(function () {
  const { context } = loadCode();
  const now = new Date('2026-07-15T09:00:00+09:00');

  test('isRowDue_: 本文が空なら対象外', () => {
    const r = context.isRowDue_({ body: '', scheduledAt: now, status: '', externalId: '' }, now);
    assert.strictEqual(r.due, false);
    assert.strictEqual(r.reason, 'empty_body');
  });

  test('isRowDue_: 投稿ID済みなら対象外(冪等性ガード1)', () => {
    const r = context.isRowDue_({ body: 'x', scheduledAt: now, status: '', externalId: 'abc' }, now);
    assert.strictEqual(r.due, false);
    assert.strictEqual(r.reason, 'already_sent');
  });

  test('isRowDue_: ステータス済みなら対象外(冪等性ガード2)', () => {
    const r = context.isRowDue_({ body: 'x', scheduledAt: now, status: '送信済(デモ)', externalId: '' }, now);
    assert.strictEqual(r.due, false);
    assert.strictEqual(r.reason, 'already_processed');
  });

  test('isRowDue_: 日時不正なら対象外', () => {
    const r = context.isRowDue_({ body: 'x', scheduledAt: null, status: '', externalId: '' }, now);
    assert.strictEqual(r.due, false);
    assert.strictEqual(r.reason, 'invalid_date');
  });

  test('isRowDue_: 未来日時なら対象外', () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000);
    const r = context.isRowDue_({ body: 'x', scheduledAt: future, status: '', externalId: '' }, now);
    assert.strictEqual(r.due, false);
    assert.strictEqual(r.reason, 'future');
  });

  test('isRowDue_: 過去日時・未処理なら対象', () => {
    const past = new Date(now.getTime() - 60 * 1000);
    const r = context.isRowDue_({ body: 'x', scheduledAt: past, status: '', externalId: '' }, now);
    assert.strictEqual(r.due, true);
  });
})();

// ---- 2. validateRow_ ----
(function () {
  const { context } = loadCode();

  test('validateRow_: 未対応プラットフォームはエラー', () => {
    const errs = context.validateRow_({ platform: 'Facebook', body: 'hi', imageUrl: '' });
    assert.ok(errs.length >= 1);
  });

  test('validateRow_: X文字数超過はエラー', () => {
    const long = 'あ'.repeat(281);
    const errs = context.validateRow_({ platform: 'X', body: long, imageUrl: '' });
    assert.ok(errs.some(e => e.indexOf('文字数上限') !== -1));
  });

  test('validateRow_: Instagramは画像必須', () => {
    const errs = context.validateRow_({ platform: 'Instagram', body: 'hi', imageUrl: '' });
    assert.ok(errs.some(e => e.indexOf('画像') !== -1));
  });

  test('validateRow_: Instagramに画像URLがあれば通る', () => {
    const errs = context.validateRow_({ platform: 'Instagram', body: 'hi', imageUrl: 'https://example.com/a.jpg' });
    assert.strictEqual(errs.length, 0);
  });

  test('validateRow_: 正常なXの投稿は問題なし', () => {
    const errs = context.validateRow_({ platform: 'X', body: '通常の投稿文です', imageUrl: '' });
    assert.strictEqual(errs.length, 0);
  });
})();

// ---- 3. runScheduledPosts: デモ実行 → ログ記録 → 冪等性(二重投稿しない) ----
(function () {
  const now = '2026-07-15T09:00:00+09:00';
  const { context } = loadCode();
  context.CONFIG.DEMO_MODE = true;
  context.CONFIG.DEMO_NOW = now;

  const summary1 = context.runScheduledPosts();

  test('1回目実行: ensureDemoData_で3行投入され、到来済み2行(X, Instagram)が送信済(デモ)になる', () => {
    assert.strictEqual(summary1.sent, 2); // past×2件(X, Instagram)。future(Threads)は対象外
    const sheet = context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿予定');
    const rows = sheet.data.slice(1); // header除く
    const xRow = rows[0];
    // ヘッダ順: 本文,投稿日時,プラットフォーム,画像URL,ステータス,投稿ID,投稿URL,送信日時,エラー
    assert.strictEqual(xRow[4], '送信済(デモ)');
    assert.ok(String(xRow[5]).indexOf('DEMO-') === 0, '投稿IDにDEMO-プレフィックスが付与される');
    assert.strictEqual(xRow[8], '', 'エラー列は空');
  });

  test('1回目実行: 未来行(Threads)は未処理のまま', () => {
    const sheet = context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿予定');
    const threadsRow = sheet.data[2]; // 2行目データ(1-indexedで行3)
    assert.strictEqual(threadsRow[4], '', '未来の行はステータス未設定のまま');
  });

  test('1回目実行: 投稿ログに送信済(デモ)の行が正しい内容で2件追記される', () => {
    const log = context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿ログ');
    const logRows = log.data.slice(1);
    assert.strictEqual(logRows.length, 2);
    // ヘッダ順: 実行日時,対象行,プラットフォーム,本文(先頭40字),予定投稿日時,結果,投稿ID,詳細
    assert.strictEqual(logRows[0][2], 'X');
    assert.strictEqual(logRows[0][5], '送信済(デモ)');
    assert.ok(String(logRows[0][6]).indexOf('DEMO-') === 0);
  });

  // ---- 冪等性: 同じ状態で2回目を実行しても再送されない ----
  // vm(別レルム)のDateオブジェクトはホスト側Dateとプロトタイプが別物になり deepStrictEqual が
  // 誤検知するため、Dateを ISO文字列化したうえで比較する(値としての一致だけを見る)。
  const stableJson = data => JSON.stringify(data, (k, v) => (v && typeof v.getTime === 'function') ? v.toISOString() : v);
  const savedScheduleBefore = stableJson(
    context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿予定').data
  );
  const summary2 = context.runScheduledPosts();

  test('2回目実行(冪等性): 既に処理済みの行は再送されない(sent=0)', () => {
    assert.strictEqual(summary2.sent, 0);
  });

  test('2回目実行(冪等性): 投稿予定シートの内容が変化しない(同じ投稿IDのまま)', () => {
    const after = stableJson(context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿予定').data);
    assert.strictEqual(after, savedScheduleBefore);
  });

  test('2回目実行(冪等性): 投稿ログに新規行が追加されない(合計2件のまま)', () => {
    const log = context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿ログ');
    assert.strictEqual(log.data.length - 1, 2);
  });
})();

// ---- 4. 検証エラー行 → ステータス「エラー」・通知発火 ----
(function () {
  const { context } = loadCode();
  context.CONFIG.DEMO_MODE = true;
  context.CONFIG.NOTIFY_ON_FAILURE = true;
  context.CONFIG.NOTIFY_EMAIL = 'owner@example.com';
  const now = new Date('2026-07-15T09:00:00+09:00');
  context.CONFIG.DEMO_NOW = now.toISOString();

  const ss = context.SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet('投稿予定');
  sheet.getRange(1, 1, 1, context.SCHEDULE_HEADERS.length).setValues([context.SCHEDULE_HEADERS]);
  const past = new Date(now.getTime() - 60 * 1000);
  // Instagramなのに画像URLなし → validateRow_でエラーになるはずの行
  sheet.getRange(2, 1, 1, context.SCHEDULE_HEADERS.length).setValues([
    ['画像なしInstagram投稿', past, 'Instagram', '', '', '', '', '', '']
  ]);
  ss.insertSheet('投稿ログ').getRange(1, 1, 1, context.LOG_HEADERS.length).setValues([context.LOG_HEADERS]);

  const summary = context.runScheduledPosts();

  test('検証エラー行: failed=1・sent=0', () => {
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.sent, 0);
  });

  test('検証エラー行: ステータス列に「エラー」、エラー列に理由が書かれる', () => {
    const row = sheet.data[1];
    assert.strictEqual(row[4], 'エラー');
    assert.ok(row[8].indexOf('画像') !== -1);
  });

  test('検証エラー行: NOTIFY_ON_FAILURE=trueでMailApp.sendEmailが呼ばれる', () => {
    assert.strictEqual(context.calls.mail.length, 1);
    assert.strictEqual(context.calls.mail[0][0], 'owner@example.com');
  });

  test('検証エラー行でもUrlFetchApp(実際のSNS API)は一切呼ばれない(DEMO_MODE)', () => {
    assert.strictEqual(context.calls.urlFetch.length, 0);
  });
})();

// ---- 5b. 本番クライアント関数の配線確認(実キーは使わずUrlFetchAppをモックして応答だけ差し替える) ----
(function () {
  function mockRes(code, obj) { return { getResponseCode: () => code, getContentText: () => JSON.stringify(obj) }; }

  test('buildOAuth1Header_: OAuth ヘッダの形になる', () => {
    const { context } = loadCode();
    const h = context.buildOAuth1Header_('POST', 'https://api.x.com/2/tweets', {}, 'key', 'secret', 'token', 'tokensecret');
    assert.ok(h.indexOf('OAuth ') === 0);
    assert.ok(h.indexOf('oauth_consumer_key="key"') !== -1);
    assert.ok(h.indexOf('oauth_signature=') !== -1);
  });

  test('postToX_: 認証情報未設定ならエラーを返しUrlFetchAppは呼ばれない', () => {
    const { context } = loadCode();
    const r = context.postToX_({ body: 'hello', platform: 'X' });
    assert.strictEqual(r.status, 'エラー');
    assert.ok(r.error.indexOf('認証情報') !== -1);
    assert.strictEqual(context.calls.urlFetch.length, 0);
  });

  test('postToX_: 認証情報ありでAPIが200を返せば送信済・externalIdを取得', () => {
    const { context } = loadCode({
      scriptProperties: { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts' },
      urlFetchResponses: [mockRes(200, { data: { id: '999' } })]
    });
    const r = context.postToX_({ body: 'hello', platform: 'X' });
    assert.strictEqual(r.status, '送信済');
    assert.strictEqual(r.externalId, '999');
    assert.strictEqual(context.calls.urlFetch.length, 1);
    assert.ok(context.calls.urlFetch[0].options.headers.Authorization.indexOf('OAuth ') === 0);
  });

  test('postToX_: 429を返されたらエラー扱い(halt相当)になる', () => {
    const { context } = loadCode({
      scriptProperties: { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts' },
      urlFetchResponses: [mockRes(429, { title: 'Too Many Requests' })]
    });
    const r = context.postToX_({ body: 'hello', platform: 'X' });
    assert.strictEqual(r.status, 'エラー');
    assert.ok(r.error.indexOf('429') !== -1);
  });

  test('postToInstagram_: 認証情報未設定ならエラー', () => {
    const { context } = loadCode();
    const r = context.postToInstagram_({ body: 'hi', imageUrl: 'https://example.com/a.jpg' });
    assert.strictEqual(r.status, 'エラー');
    assert.ok(r.error.indexOf('認証情報') !== -1);
  });

  test('postToInstagram_: 2段階(media作成→publish)が成功すると送信済', () => {
    const { context } = loadCode({
      scriptProperties: { IG_USER_ID: 'ig1', IG_ACCESS_TOKEN: 'tok' },
      urlFetchResponses: [mockRes(200, { id: 'creation1' }), mockRes(200, { id: 'media1' })]
    });
    const r = context.postToInstagram_({ body: 'hi', imageUrl: 'https://example.com/a.jpg' });
    assert.strictEqual(r.status, '送信済');
    assert.strictEqual(r.externalId, 'media1');
    assert.strictEqual(context.calls.urlFetch.length, 2);
    assert.ok(context.calls.urlFetch[0].url.indexOf('/media') !== -1);
    assert.ok(context.calls.urlFetch[1].url.indexOf('/media_publish') !== -1);
  });

  test('postToThreads_: 2段階(コンテナ作成→publish)が成功すると送信済', () => {
    const { context } = loadCode({
      scriptProperties: { THREADS_USER_ID: 'th1', THREADS_ACCESS_TOKEN: 'tok' },
      urlFetchResponses: [mockRes(200, { id: 'container1' }), mockRes(200, { id: 'thread1' })]
    });
    const r = context.postToThreads_({ body: 'hi', imageUrl: '' });
    assert.strictEqual(r.status, '送信済');
    assert.strictEqual(r.externalId, 'thread1');
  });
})();

// ---- 5. ensureDemoData_ は既存データがあれば何もしない(冪等) ----
(function () {
  const { context } = loadCode();
  const ss = context.SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet('投稿予定');
  sheet.getRange(1, 1, 1, context.SCHEDULE_HEADERS.length).setValues([context.SCHEDULE_HEADERS]);
  sheet.getRange(2, 1, 1, context.SCHEDULE_HEADERS.length).setValues([
    ['既存の行', new Date(), 'X', '', '', '', '', '', '']
  ]);
  context.ensureDemoData_(sheet);

  test('ensureDemoData_: 既にデータがある場合はサンプルを追加しない', () => {
    assert.strictEqual(sheet.getLastRow(), 2); // header + 既存1行のまま
  });
})();

console.log('\n合計: ' + (pass + fail) + '件 / 成功 ' + pass + ' / 失敗 ' + fail);
process.exit(fail > 0 ? 1 : 0);
