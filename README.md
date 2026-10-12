# sns-scheduled-poster

[![test](https://github.com/Mxhlix/sns-scheduled-poster/actions/workflows/test.yml/badge.svg)](https://github.com/Mxhlix/sns-scheduled-poster/actions/workflows/test.yml)

English | [日本語](#日本語)

A Google Apps Script that posts to X, Instagram and Threads at the times written in a Google Sheets spreadsheet, using each service's official API.
Each result is written back to the scheduled row and also recorded in a log sheet.

## What it does

- Reads the 「投稿予定」 (schedule) sheet, where each row has the text, the posting date and time, the platform and an optional image URL.
- Posts only the rows whose time has come. Rows with a future time, an empty text or an unreadable date are left as they are.
- Writes the status, post ID, post URL, sent time and any error back to the same row.
- Adds one line per processed row to the 「投稿ログ」 (post log) sheet: run time, row number, platform, the first 40 characters of the text, scheduled time, result, post ID and details.
- Can run every 15 minutes on a time-driven trigger. Run `setupTrigger` once to set it up. It can also be run by hand.
- Can notify by email or Slack when a post fails. This is off by default.
- A demo mode lets it run without any SNS account or API key.

## Design notes

- It posts only through the official APIs: `POST /2/tweets` for X, and the two-step create-then-publish calls of the Instagram Graph API and the Threads API. It does not use browser automation.
- No double posting. A row that already has a status or a post ID is skipped. Running it again does not post the same row twice. A row that ended in an error also keeps its status, so it is not retried until the status is cleared.
- Rows are checked before posting. An unsupported platform, text over the length limit, or an Instagram row without an image becomes an error, and no API is called for that row.
- API keys and tokens are not written in the code. They are read from the Apps Script script properties.
- Rate limit and auth errors from X (HTTP 401, 403, 429) are recorded as errors with the response body.
- In demo mode it sends nothing. It writes a dummy post ID starting with `DEMO-` and the status 「送信済(デモ)」 (sent, demo).
- The length limits in `CONFIG.MAX_LEN` (X 280, Instagram 2200, Threads 500) are rough values written in the code. They need to be checked against each service's current documentation.

## Verification

GAS does not run locally, so `test/mock-gas.js` imitates GAS features (spreadsheets, script properties, URL fetch, email, triggers and so on), and `src/Code.gs` runs on Node without modification.

Main things checked:

- The decision of whether a row is due: empty text, existing post ID, existing status, invalid date, future time, and past time not yet processed.
- Row checks: unsupported platform, text over the X length limit, Instagram without an image, and normal rows.
- In demo mode, a run fills 3 sample rows, posts the 2 rows whose time has come (X and Instagram), leaves the future Threads row untouched, and adds 2 lines to the post log.
- A second run posts nothing, and both the schedule sheet and the post log stay the same.
- A row that fails the checks gets the status 「エラー」 (error) and a reason, one email is sent when failure notice is on, and no API call is made.
- The X, Instagram and Threads posting functions, with the API responses replaced by mocks: an OAuth header is built for X, a 200 response gives a post ID, a 429 response becomes an error, missing credentials give an error (for X, without any API call), Instagram calls create and then publish in that order, and Threads returns a post ID after its two calls.
- Demo sample rows are not added when the sheet already has data.

Run on 2026-10-05 with Node.js 24.12.0, all 29 checks passed.
`npm test` exits with code 1 when any check fails. This was confirmed on a copy with the due check deliberately broken (2026-10-05).

## Getting started

The tests use only Node.js built-ins, with no external packages.
Checked locally on Node.js 24.12.0. On GitHub Actions it passes on Node.js 18, 20 and 22 (2026-10-05).

```
npm test    # run Code.gs in the GAS imitation and check 29 items
```

To run it on GAS, open Extensions > Apps Script in a Google Sheets spreadsheet, add `src/Code.gs` and `src/appsscript.json`, and run the function `runScheduledPosts`.
It starts in demo mode. It creates 3 sample rows and processes the 2 whose time has come, without posting anywhere.
The demo steps, switching to real accounts and setting up the trigger are in [src/README.md](src/README.md) (Japanese).

## Project layout

```
src/
  Code.gs            main logic (due check, row checks, X / Instagram / Threads clients, sheets, log, trigger)
  appsscript.json    manifest (time zone and permissions)
  README.md          setup steps for Apps Script
test/
  mock-gas.js        imitation of GAS features
  load-code.js       loads Code.gs with Node's vm
  run-tests.js       the tests
```

## Not yet verified

- All tests in this repository are results in the GAS imitation. It has not posted to a real X, Instagram or Threads account, and no real API key was used.
- The OAuth 1.0a signature for X is not checked for correctness. In the imitation, the HMAC-SHA1 calculation returns a fixed value, so the tests only check the shape of the header.
- Posting a Threads row with an image, the Slack notice, and `setupTrigger` are not covered by the tests.
- For Instagram and Threads, the post URL column gets a placeholder text instead of a real link. The code does not fetch the permalink.
- Date formatting in the imitation ignores the time zone. Real GAS formats in `Asia/Tokyo`, so times near the date boundary have not been checked in the imitation.
- The API version (`v21.0` for the Graph API, `v1.0` for Threads) and the length limits are values written at the time of writing. They have not been checked against the current documentation.

## License

MIT. See [LICENSE](LICENSE).

---

## 日本語

Google スプレッドシートに書いた日時に、X・Instagram・Threads へ各社の公式APIで投稿する Google Apps Script です。
結果は予定の行に書き戻し、ログ用のシートにも記録します。

### できること

- 「投稿予定」シートを読みます。各行に本文・投稿日時・プラットフォームと、必要なら画像URLを書きます。
- 投稿日時が来た行だけを投稿します。未来の日時・本文が空・日時が読めない行はそのままにします。
- ステータス・投稿ID・投稿URL・送信日時・エラーを、同じ行に書き戻します。
- 処理した行ごとに「投稿ログ」シートへ1行足します。中身は実行日時・行番号・プラットフォーム・本文の先頭40字・予定日時・結果・投稿ID・詳細です。
- 時間で動くトリガーで15分おきに実行できます。設定は `setupTrigger` を1回実行するだけです。手で実行することもできます。
- 投稿に失敗したとき、メールか Slack で知らせることができます。初期設定では切ってあります。
- SNSのアカウントやAPIキーが無くても動くデモモードがあります。

### 設計で気をつけたこと

- 公式APIだけで投稿します。X は `POST /2/tweets`、Instagram Graph API と Threads API は「作成してから公開」の2段階の呼び出しです。ブラウザの自動操作は使いません。
- 二重に投稿しません。ステータスか投稿IDが入っている行は飛ばします。もう一度実行しても、同じ行を2回投稿しません。エラーになった行もステータスが残るため、ステータスを消すまでは再実行されません。
- 投稿の前に行を確かめます。未対応のプラットフォーム、文字数の上限超え、画像の無い Instagram の行はエラーにし、その行ではAPIを呼びません。
- APIキーやトークンはコードに書きません。Apps Script のスクリプトプロパティから読みます。
- X が返す認証エラーと回数制限のエラー（HTTP 401・403・429）は、応答の中身をつけてエラーとして記録します。
- デモモードでは何も送りません。`DEMO-` で始まるダミーの投稿IDと、ステータス「送信済(デモ)」を書きます。
- `CONFIG.MAX_LEN` の文字数上限（X 280、Instagram 2200、Threads 500）は、コードに書いた目安の値です。各社の今のドキュメントで確かめる必要があります。

### 検証

GAS はローカルでは動かないので、`test/mock-gas.js` で GAS の機能（スプレッドシート・スクリプトプロパティ・URL取得・メール・トリガーなど）を模擬し、`src/Code.gs` を書き換えずに Node の上で実行して確かめています。

主に確かめていること:

- 行が投稿の対象かどうかの判定。本文が空、投稿IDあり、ステータスあり、日時が不正、未来の日時、過去の日時で未処理、の6通りです。
- 行の確認。未対応のプラットフォーム、X の文字数の上限超え、画像の無い Instagram、正常な行です。
- デモモードで実行すると、サンプルを3行作り、日時が来た2行（X と Instagram）を処理し、未来の Threads の行は残し、投稿ログに2行足すこと。
- 2回目の実行では何も投稿せず、投稿予定シートも投稿ログも変わらないこと。
- 確認で引っかかった行は、ステータスが「エラー」になって理由が残り、失敗の通知を入れているとメールが1通送られ、APIは呼ばれないこと。
- X・Instagram・Threads の投稿の関数。APIの応答を模擬に差し替えて確かめています。X 用の OAuth ヘッダが作られること、200 の応答で投稿IDが取れること、429 の応答がエラーになること、認証情報が無いとエラーになること（X ではAPIを呼ばないことも確認）、Instagram が作成・公開の順に呼ぶこと、Threads が2回の呼び出しのあと投稿IDを返すことです。
- シートにデータがあるときは、デモのサンプル行を足さないこと。

2026-10-05 に Node.js 24.12.0 で実行し、29項目すべて合格しました。
1項目でも落ちると、`npm test` は終了コード 1 で終わります。投稿対象の判定をわざと壊したコピーで確かめました（2026-10-05）。

### 動かし方

テストは Node.js の標準機能だけで動き、外部のパッケージは使っていません。
手元で確かめたのは Node.js 24.12.0 です。GitHub Actions では Node.js 18・20・22 で通っています（2026-10-05）。

```
npm test    # GAS を模擬した環境で Code.gs を動かし、29項目を確かめる
```

GAS で動かすときは、Google スプレッドシートの拡張機能 > Apps Script に `src/Code.gs` と `src/appsscript.json` を入れて、関数 `runScheduledPosts` を実行します。
最初はデモモードになっていて、サンプルを3行作り、日時が来た2行をどこにも送らずに処理します。
デモの手順、実際のアカウントへの切り替え、トリガーの設定は [src/README.md](src/README.md) にあります。

### フォルダ構成

```
src/
  Code.gs            本体（投稿対象の判定・行の確認・X / Instagram / Threads の投稿・シート・ログ・トリガー）
  appsscript.json    マニフェスト（タイムゾーンと権限）
  README.md          Apps Script への設置手順
test/
  mock-gas.js        GAS の機能の模擬
  load-code.js       Code.gs を Node の vm で読み込む
  run-tests.js       テスト本体
```

### まだ確かめていないこと

- このリポジトリのテストは、すべて GAS を模擬した環境での結果です。本物の X・Instagram・Threads のアカウントには投稿しておらず、本物のAPIキーも使っていません。
- X 用の OAuth 1.0a の署名が正しいかは確かめていません。模擬では HMAC-SHA1 の計算が決まった値を返すため、テストで見ているのはヘッダの形だけです。
- 画像つきの Threads の投稿、Slack への通知、`setupTrigger` はテストで扱っていません。
- Instagram と Threads では、投稿URLの列に本物のリンクではなく仮の文が入ります。コードはパーマリンクを取りに行きません。
- 模擬の日付整形はタイムゾーンを見ていません。本物の GAS は `Asia/Tokyo` で整形するため、日をまたぐ時刻の扱いは模擬では確かめられていません。
- APIのバージョン（Graph API の `v21.0`、Threads の `v1.0`）と文字数上限は、書いた時点の値です。今のドキュメントとは突き合わせていません。

### ライセンス

MIT です。[LICENSE](LICENSE) を見てください。
