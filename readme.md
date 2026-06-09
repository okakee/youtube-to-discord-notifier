forked from [tatsumin39/youtube-to-discord-notifier](https://github.com/tatsumin39/youtube-to-discord-notifier)

---

# YouTube Channel Feed Automation

English follows Japanese.

## 概要

この Google Apps Script（GAS）は、YouTube チャンネルの動画投稿や配信情報（配信予定、配信中、アーカイブ動画）を Discord チャンネルに通知します。配信予定時刻や配信タイトルの変更時にも通知を行います。

Discord への通知は **AWS Lambda Function URL** を経由して送信します。GAS から Discord Webhook を直接叩くと、Google の共有 IP による Cloudflare 制限（429 / 1015）に巻き込まれることがあるため、Lambda で中継する構成にしています。

参考: [GAS→Discord Webhookの429エラーをLambda Function URLを活用して解決した話](https://qiita.com/1987Shiz321/items/d2760ebffabd4b9967b0)

## アーキテクチャ

```
GAS (youtubeToDiscord.js)
  → POST Lambda Function URL
      Authorization: Bearer <RELAY_TOKEN>
      Body: { webhookKey, payload }
  → Lambda (lambda/index.mjs)
      → Discord Webhook URL へ POST
  → Discord
```

## 機能

- YouTube チャンネルの RSS フィードから最新の動画情報を取得
- 取得した動画情報を Google スプレッドシートに保存
- 新しい動画がある場合、Lambda 経由で Discord に通知を送信
- チャンネルのアイコン URL 更新機能
- Discord 429 発生時のスプレッドシート整合性維持（新規動画は書き込みスキップ、更新時はロールバック）

#### オプション機能：複数の Discord チャンネルに通知を送信

スプレッドシートの「channels」シートに `discordChannelId` 列を追加し、各 YouTube チャンネルに対応する識別子を記入します。

- `discordChannelId` 列が空の場合、Lambda の環境変数 `DISCORD_WEBHOOK_URL`（デフォルト Webhook）が使用されます。
- 値がある場合、その文字列を `webhookKey` として Lambda に渡し、環境変数 `WEBHOOK_MAP` から Webhook URL を解決します。

## 使い方

### Discord Webhook の設定

1. Discord で、通知を送信したいチャンネルを選択します。
2. チャンネルの設定（歯車アイコン）を開き、「連携サービス」を選択します。
3. 「Webhooks」セクションで「新しい Webhook」をクリックします。
4. Webhook の名前を設定し、「Webhook URL」をコピーします。

Webhook URL は GAS ではなく **Lambda の環境変数** に設定します（後述）。

### AWS Lambda のセットアップ

1. [AWS Lambda コンソール](https://console.aws.amazon.com/lambda/) で関数を作成します。
   - ランタイム: **Node.js 22.x**
   - ハンドラ: `index.handler`（`index.mjs` をルートに配置した場合）
2. 本リポジトリの [`lambda/index.mjs`](lambda/index.mjs) の内容を Lambda のコードエディタに貼り付けるか、ZIP でアップロードします。
3. **設定 → 環境変数** に以下を追加します。

   | 環境変数 | 必須 | 説明 |
   |---|---|---|
   | `RELAY_TOKEN` | はい | GAS と共有する長いランダム文字列（32 文字以上推奨） |
   | `DISCORD_WEBHOOK_URL` | はい | デフォルトの Discord Webhook URL |
   | `WEBHOOK_MAP` | 任意 | 複数 Webhook 用の JSON。例: `{"myDiscordChannel":"https://discord.com/api/webhooks/..."}` |

4. **設定 → 一般設定** でタイムアウトを **10〜30 秒** に延長します（Discord の応答待ち・429 リトライ用）。
5. **設定 → 関数 URL** で Function URL を作成します。
   - 認証タイプ: `NONE`（Bearer トークンは Lambda 内で検証）
   - CORS: オフ（GAS からのサーバー間通信のため通常不要）
6. 発行された Function URL を控えます（GAS の `DISCORD_RELAY_URL` に設定）。

#### Lambda のテスト

Lambda コンソールの **テスト** タブで、次のようなイベントを使います（`YOUR_RELAY_TOKEN` を環境変数と同じ値に置き換え）。

```json
{
  "version": "2.0",
  "headers": {
    "authorization": "Bearer YOUR_RELAY_TOKEN",
    "content-type": "application/json"
  },
  "requestContext": {
    "http": {
      "method": "POST"
    }
  },
  "body": "{\"webhookKey\":null,\"payload\":{\"username\":\"テスト\",\"content\":\"Lambda relay test\"}}",
  "isBase64Encoded": false
}
```

成功時は `statusCode: 200`、Discord チャンネルにメッセージが届きます。

#### 推奨のセキュリティ設定

- `RELAY_TOKEN` は十分長いランダム文字列にする
- Function URL とトークンを公開しない
- 予約済み同時実行数を低めに設定する
- CloudWatch Logs / Alarm を設定する

### Google スプレッドシートの準備

1. 新しい Google スプレッドシートを作成し、「channels」と「videoData」の 2 つのシートを準備します。
   - 「channels」シートの見出し行: `CHANNEL_NAME`、`CHANNEL_ID`、`CHANNEL_ICON_URL`、`discordChannelId`
   - 「videoData」シートの見出し行: `title`、`published`、`updated`、`videoId`、`channel`、`live`、`scheduledStartTime`、`actualStartTime`、`duration`

### Google Apps Script のセットアップ

1. スプレッドシートの「拡張機能」メニューから「Apps Script」を選択します。
2. Apps Script のプロジェクトの設定を開き、スクリプト プロパティに以下を追加します。

   | プロパティ名 | 値 |
   |---|---|
   | `DISCORD_RELAY_URL` | Lambda Function URL |
   | `RELAY_TOKEN` | Lambda の `RELAY_TOKEN` と同じ値 |
   | `sheetId` | 用意した Google スプレッドシートの ID |

3. 本プロジェクトの `youtubeToDiscord.js` をスクリプトエディタにペーストします。
4. スクリプトエディタの「ライブラリ」で dayjs を追加します。ライブラリ ID: `1ShsRhHc8tgPy5wGOzUvgEhOedJUQD53m-gd8lG2MOgs-dXC_aCZn9lFB`
5. スクリプトエディタの「サービス」で YouTube Data API v3 を有効にします。
6. （任意）Google Cloud Platform でプロジェクトを作成し、YouTube Data API v3 を有効にします。
7. （任意）Apps Script プロジェクトを GCP プロジェクトに紐づけます。
8. 初回実行時、YouTube Data API v3 へのアクセス許可を与えます。

> **注意:** Discord Webhook URL は GAS のスクリプト プロパティには保存しません。Lambda の環境変数で管理してください。

### トリガーの設定

1. Apps Script の「トリガー」から新しいトリガーを追加します。
2. 実行する関数: `fetchUpdateAndNotify`
3. 時間主導型、実行間隔: **5 分おき**

#### オプション機能の追加設定（複数 Discord チャンネル）

1. 「channels」シートの `discordChannelId` 列に識別子を記入します（例: `myDiscordChannel`）。
2. Lambda の環境変数 `WEBHOOK_MAP` に、その識別子と Webhook URL の対応を追加します。

   ```json
   {"myDiscordChannel":"https://discord.com/api/webhooks/..."}
   ```

`discordChannelId` が空の行は、Lambda の `DISCORD_WEBHOOK_URL` が使われます。

## 注意事項および留意事項

### Lambda 中継について

- Lambda 経由でも Discord 自体のレート制限は残りますが、GAS 共有 IP による Cloudflare 制限の回避が主な目的です。
- Lambda 側では Discord 429 時に `retry_after` を見て最大 3 回まで再送します。
- GAS 側では 429 時に新規動画のスプレッドシート書き込みをスキップし、配信状態の更新時はロールバックします。

### リアルタイム通知について

- 本システムはリアルタイム通知を保証しません。YouTube のフィード反映遅延やトリガー実行タイミングにより、通知が遅れることがあります。

### チャンネル情報の追加と通知

- 「channels」シートに新しいチャンネルを追加すると、過去の動画情報（約 5 件）が取得され、通知対象になります。
- 初回実行時は通知が大量に発生する可能性があります。チャンネル追加と実行タイミングは慎重に管理してください。

### 配信予定の取り扱い

- 配信予定が設定されたまま配信が行われなかった場合、「videoData」シートの `live` 列は `upcoming` のまま残ります。YouTube のフィードが更新されないため、スクリプトは自動でステータスを変更しません。

## ライセンス

[MIT License](LICENSE)

---

## English Version

### Overview

This Google Apps Script (GAS) notifies Discord channels about new YouTube videos and live stream updates (upcoming, live, archived). It also notifies when scheduled times or stream titles change.

Notifications are sent through an **AWS Lambda Function URL** relay instead of calling Discord Webhooks directly from GAS. This reduces intermittent 429 / Cloudflare 1015 errors caused by Google's shared outbound IPs.

### Architecture

```
GAS → Lambda Function URL (Bearer token) → Discord Webhook → Discord
```

### Features

- Fetches latest video info from YouTube RSS feeds
- Stores video data in Google Spreadsheet
- Sends Discord notifications via Lambda relay
- Updates channel icon URLs
- Preserves spreadsheet consistency on Discord 429 (skip new rows / rollback updates)

#### Optional: Multiple Discord Channels

Add a `discordChannelId` column to the `channels` sheet. When empty, Lambda uses `DISCORD_WEBHOOK_URL`. When set, the value is sent as `webhookKey` and resolved via Lambda's `WEBHOOK_MAP` environment variable.

### How to Use

#### Discord Webhook

Create a Webhook in Discord and copy the URL. Store it in Lambda environment variables (not in GAS).

#### AWS Lambda Setup

1. Create a Lambda function (Node.js 22.x).
2. Deploy [`lambda/index.mjs`](lambda/index.mjs).
3. Set environment variables:
   - `RELAY_TOKEN` (required): shared secret with GAS
   - `DISCORD_WEBHOOK_URL` (required): default Discord Webhook URL
   - `WEBHOOK_MAP` (optional): JSON map of keys to Webhook URLs
4. Set timeout to 10–30 seconds.
5. Create a Function URL (auth type: `NONE`; token is validated inside Lambda).
6. Copy the Function URL for GAS `DISCORD_RELAY_URL`.

#### Google Spreadsheet

Create `channels` and `videoData` sheets with headers:

- `channels`: `CHANNEL_NAME`, `CHANNEL_ID`, `CHANNEL_ICON_URL`, `discordChannelId`
- `videoData`: `title`, `published`, `updated`, `videoId`, `channel`, `live`, `scheduledStartTime`, `actualStartTime`, `duration`

#### Google Apps Script Setup

Script properties:

| Property | Value |
|---|---|
| `DISCORD_RELAY_URL` | Lambda Function URL |
| `RELAY_TOKEN` | Same as Lambda `RELAY_TOKEN` |
| `sheetId` | Spreadsheet ID |

Then paste `youtubeToDiscord.js`, add the dayjs library, and enable YouTube Data API v3.

#### Triggers

Run `fetchUpdateAndNotify` every 5 minutes (time-driven trigger).

#### Optional: Multiple Discord Channels

Set `discordChannelId` in the spreadsheet and add matching entries to Lambda `WEBHOOK_MAP`.

### Notes

- Lambda relay mainly avoids GAS shared-IP Cloudflare limits; Discord rate limits may still apply.
- Lambda retries Discord 429 up to 3 times using `retry_after`.
- GAS skips spreadsheet writes on 429 for new videos and rolls back updates when status notifications fail.

### Language Note

`youtubeToDiscord.js` uses Japanese for Discord messages, comments, and logs. Feel free to replace them with your preferred language.

## License

[MIT License](LICENSE)
