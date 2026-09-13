// index.mjs (Node.js 18+ / 22.x, ESM)
// 環境変数:
//   RELAY_TOKEN          - GAS と共有する長いランダム文字列
//   DISCORD_WEBHOOK_URL  - デフォルト Webhook（webhookKey 未指定時）
//   WEBHOOK_MAP          - 任意。JSON文字列。例: {"myChannelId":"https://discord.com/api/webhooks/..."}

const DEFAULT_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;

function parseWebhookMap() {
  if (!process.env.WEBHOOK_MAP) return {};
  try {
    return JSON.parse(process.env.WEBHOOK_MAP);
  } catch {
    throw new Error('WEBHOOK_MAP is invalid JSON');
  }
}

const WEBHOOK_MAP = parseWebhookMap();

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getBearerToken(event) {
  const headers = event.headers || {};
  const auth =
    headers.authorization ||
    headers.Authorization ||
    '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function resolveWebhookUrl(webhookKey) {
  if (webhookKey && WEBHOOK_MAP[webhookKey]) {
    return WEBHOOK_MAP[webhookKey];
  }
  return DEFAULT_WEBHOOK_URL;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToDiscord(webhookUrl, payload, messageId = null, maxRetries = 3) {
  let attempt = 0;
  const url = new URL(webhookUrl);
  if (messageId) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/messages/' + messageId;
  } else {
    // waitはJSON本文ではなくクエリパラメーター。作成したメッセージIDを取得する。
    url.searchParams.set('wait', 'true');
  }

  while (true) {
    const response = await fetch(url.toString(), {
      method: messageId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'discord-webhook-relay/1.0',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let discordBody;
    try {
      discordBody = text ? JSON.parse(text) : null;
    } catch {
      discordBody = text;
    }

    if (response.ok) {
      return { ok: true, status: response.status, body: discordBody };
    }

    // Discord の通常 429: retry_after を尊重して再送
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfterSec =
        discordBody?.retry_after ??
        Number(response.headers.get('retry-after')) ??
        1;
      const waitMs = Math.ceil(Number(retryAfterSec) * 1000) + 100;
      console.warn(`Discord 429. retry after ${waitMs}ms (attempt ${attempt + 1})`);
      await sleep(waitMs);
      attempt += 1;
      continue;
    }

    return {
      ok: false,
      status: response.status,
      body: discordBody,
      rateLimited: response.status === 429,
    };
  }
}

export const handler = async (event) => {
  try {
    const token = getBearerToken(event);
    if (!RELAY_TOKEN || token !== RELAY_TOKEN) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }

    if (event.requestContext?.http?.method !== 'POST') {
      return jsonResponse(405, { error: 'Method Not Allowed' });
    }

    if (!event.body) {
      return jsonResponse(400, { error: 'Empty body' });
    }

    const request = JSON.parse(event.body);
    const action = request.action || 'post';
    if (action !== 'post' && action !== 'edit') {
      return jsonResponse(400, { error: 'Invalid action' });
    }
    if (action === 'edit' && (typeof request.messageId !== 'string' || !/^\d+$/.test(request.messageId))) {
      return jsonResponse(400, { error: 'Invalid messageId' });
    }

    // GAS から { webhookKey, payload } を受け取る想定
    const webhookKey = request.webhookKey || null;
    let payload = request.payload || request; // 後方互換: payload だけ送っても可
    if (action === 'edit') {
      if (typeof payload.content !== 'string') {
        return jsonResponse(400, { error: 'Edit requires content' });
      }
      payload = { content: payload.content, allowed_mentions: { parse: [] } };
    }

    const webhookUrl = resolveWebhookUrl(webhookKey);
    if (!webhookUrl) {
      return jsonResponse(400, { error: 'Webhook URL not configured' });
    }

    const result = await postToDiscord(webhookUrl, payload, action === 'edit' ? request.messageId : null);

    console.log('Discord response:', result.status, JSON.stringify(result.body));

    if (!result.ok) {
      return jsonResponse(result.status, {
        error: 'Discord webhook failed',
        discordStatus: result.status,
        discordBody: result.body,
        rateLimited: result.rateLimited === true,
      });
    }

    return jsonResponse(200, {
      ok: true,
      discordStatus: result.status,
      messageId: result.body?.id || null,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: err.message || 'Internal Server Error' });
  }
};
