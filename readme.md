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

- YouTube Data API v3 のアップロード一覧から最新5件を取得（RSS不使用）
- 保存済みの配信予定・配信中の動画は、最新5件から外れても API で追跡
- `status.privacyStatus` が `public`（公開）の動画のみ通知・更新対象です。非公開・限定公開・公開状態不明の動画は除外し、既存行は保持します。
- 取得した動画情報を Google スプレッドシートに保存
- 新しい動画がある場合、Lambda 経由で Discord に通知を送信
- チャンネルのアイコン URL 更新機能
- Discord 送信失敗時のスプレッドシート整合性維持（新規動画は書き込みスキップ、更新時はロールバック）

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

### RSS版からの移行とAPI利用量

- `youtubeToDiscord.js` を差し替え、既存の YouTube Data API v3 サービスを有効にしたまま実行してください。追加の API キーは不要です。
- 既存のシート、通知済み動画ID、スクリプトプロパティ、トリガーをそのまま利用できます。`updated` 列はRSS更新日時からAPI確認時刻に変わります。
- `channels.list` で取得したアップロード一覧IDは `uploadsPlaylistId:<チャンネルID>` というスクリプトプロパティに自動保存します。
- 通常は1チャンネル・1実行あたり `playlistItems.list` 1回と `videos.list` 1回（最大50動画の一括取得）です。5分間隔で約576ユニット/日/チャンネル。初回取得、アイコン取得、追跡動画が50件を超える場合の追加呼び出しは別途必要です。
- 新着探索は最新5件に限定されます。実行間隔中に5件を超える追加があると見逃す可能性があります。必要に応じてコード先頭の `recentVideoLimit` を50以下で増やしてください（初回通知件数も増えます）。
- 新しい配信予定はアップロード一覧に現れてから検知します。配信予約の網羅的・即時検知は保証しません。

### 配信終了時の通知方法を選ぶ

GAS のスクリプトプロパティ `DISCORD_ARCHIVE_MODE` で、全チャンネル共通の動作を選べます。

| 値 | 配信終了を検知したときの動作 |
|---|---|
| `post`（未設定時の既定値） | 従来どおり、アーカイブ案内を新規投稿 |
| `edit` | 配信開始時の投稿を、アーカイブ案内と配信時間に編集 |

導入時は先に `lambda/index.mjs` を Lambda に反映し、その後 `youtubeToDiscord.js` を GAS に反映してください。`edit` を設定すると編集形式に切り替わり、`post` に戻すと新規投稿形式に戻ります。配信終了を検知した時点の設定が適用されます。

- 配信開始投稿のメッセージIDと送信先キーを GAS のスクリプトプロパティ `discordLiveMessage:<動画ID>` に自動保存します。シートの列追加は不要です。終了通知の成功後にこの保存情報を削除します。
- `post` モードでも開始投稿のIDを保存するため、配信途中で `edit` に変更できます。
- 導入前の配信など、開始投稿のIDがない場合は、`edit` でも終了時に新規投稿します。
- 配信予定・配信開始・タイトル変更などの通知は、従来どおり新規投稿です。タイトル変更の投稿で開始投稿のIDを上書きしません。
- 編集に失敗した場合は配信中の状態とIDを保持し、次回再試行します。開始投稿が削除されている場合は `post` に変更すると新規投稿で処理を完了できます。
- 配信中は使用した Webhook と `WEBHOOK_MAP` の対応を維持してください。終了の反映は定期実行と YouTube API の反映タイミングに従います。

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
- GAS 側では送信失敗時に新規動画のスプレッドシート書き込みをスキップし、配信状態の更新時はロールバックして次回再試行します。

### リアルタイム通知について

- 本システムはリアルタイム通知を保証しません。YouTube Data API の反映遅延やトリガー実行タイミングにより、通知が遅れることがあります。

### チャンネル情報の追加と通知

- 「channels」シートに新しいチャンネルを追加すると、過去の動画情報（約 5 件）が取得され、通知対象になります。
- 初回実行時は通知が大量に発生する可能性があります。チャンネル追加と実行タイミングは慎重に管理してください。

### 配信予定の取り扱い

- 配信予定・配信中の動画は毎回APIで確認します。削除・非公開などでAPIに返らない動画や、取得に失敗した動画は既存状態を保持します。配信中止を推測して変更しないため、`upcoming` のまま残る場合があります。

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

- Fetches the latest 5 uploads using YouTube Data API v3 only; no RSS requests
- Continues polling stored upcoming/live videos even after they leave the latest uploads
- Only public videos are eligible for notifications and updates. Private, unlisted, and unknown privacy status videos are excluded, preserving existing rows.
- Stores video data in Google Spreadsheet
- Sends Discord notifications via Lambda relay
- Updates channel icon URLs
- Preserves spreadsheet consistency on Discord delivery failures (skip new rows / rollback updates)

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

Existing installations can replace the script without changing sheets, properties, or triggers. No additional API key is required. The `updated` column now stores API check time. Upload playlist IDs are cached automatically in script properties. A typical poll costs 2 units per channel (about 576 units/day at 5-minute intervals), plus channel lookups and additional batches beyond 50 tracked videos. Discovery covers the latest 5 uploads; increase `recentVideoLimit` up to 50 if needed. New scheduled streams are detected only once exposed in the uploads playlist. Missing/private/deleted videos retain their stored state.

#### Choose how stream endings are announced

Set the GAS script property `DISCORD_ARCHIVE_MODE` to `post` (default when unset) for a new archive post, or `edit` to update the original stream-start post with the archive link and duration. This setting applies to all channels and is read when the end is detected.

Deploy `lambda/index.mjs` first, then update `youtubeToDiscord.js` in GAS. No sheet columns need to change. Start message IDs and webhook keys are stored in script properties (`discordLiveMessage:<videoId>`) in both modes and removed after successful archive delivery. Missing IDs, including streams notified before this update, fall back to new posts. Upcoming, start, and title-change notifications remain new posts. Failed edits preserve the live state and ID for retry; switch to `post` if the original message was deleted. Keep webhook mappings stable while streams are live.

#### Triggers

Run `fetchUpdateAndNotify` every 5 minutes (time-driven trigger).

#### Optional: Multiple Discord Channels

Set `discordChannelId` in the spreadsheet and add matching entries to Lambda `WEBHOOK_MAP`.

### Notes

- Lambda relay mainly avoids GAS shared-IP Cloudflare limits; Discord rate limits may still apply.
- Lambda retries Discord 429 up to 3 times using `retry_after`.
- GAS skips spreadsheet writes for new videos and rolls back updates when notifications fail, allowing retries on the next run.

### Language Note

`youtubeToDiscord.js` uses Japanese for Discord messages, comments, and logs. Feel free to replace them with your preferred language.

## License

[MIT License](LICENSE)
