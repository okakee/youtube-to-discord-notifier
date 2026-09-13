const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.RELAY_TOKEN = 'test-token';
process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111/test-token';
process.env.WEBHOOK_MAP = JSON.stringify({ original: 'https://discord.com/api/webhooks/222/other-token?thread_id=333' });
const modulePromise = import('../lambda/index.mjs');

async function request(body) {
  const { handler } = await modulePromise;
  return handler({
    headers: { authorization: 'Bearer test-token' },
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body)
  });
}

test('new posts request and return a message ID, including legacy payloads', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).searchParams.get('wait'), 'true');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).content, 'live');
    return new Response(JSON.stringify({ id: '123456789012345678' }), { status: 200 });
  });
  for (const body of [{ payload: { content: 'live', wait: true } }, { content: 'live' }]) {
    const response = await request(body);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).messageId, '123456789012345678');
  }
});

test('edits PATCH the selected webhook message and preserve thread routing', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://discord.com/api/webhooks/222/other-token/messages/123456789012345678?thread_id=333');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { content: 'ended', allowed_mentions: { parse: [] } });
    return new Response(JSON.stringify({ id: '123456789012345678' }), { status: 200 });
  });
  const response = await request({ action: 'edit', webhookKey: 'original', messageId: '123456789012345678', payload: { content: 'ended', username: 'Channel', avatar_url: 'ignored' } });
  assert.equal(response.statusCode, 200);
});

test('invalid edit requests never reach Discord', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected fetch'); });
  for (const body of [
    { action: 'delete' },
    { action: 'edit', messageId: '../bad' },
    { action: 'edit', messageId: 123 },
    { action: 'edit', messageId: '123', payload: {} }
  ]) assert.equal((await request(body)).statusCode, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test('a deleted start message returns an edit failure without creating another post', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'PATCH');
    return new Response(JSON.stringify({ code: 10008, message: 'Unknown Message' }), { status: 404 });
  });
  const response = await request({ action: 'edit', messageId: '123', payload: { content: 'ended' } });
  assert.equal(response.statusCode, 404);
  assert.equal(fetch.mock.callCount(), 1);
});

test('rate limited edits retry PATCH and return the message ID', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'PATCH');
    attempts += 1;
    return attempts === 1
      ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
      : new Response(JSON.stringify({ id: '123' }), { status: 200 });
  });
  assert.equal((await request({ action: 'edit', messageId: '123', payload: { content: 'ended' } })).statusCode, 200);
  assert.equal(attempts, 2);
});
