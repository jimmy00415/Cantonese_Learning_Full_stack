import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

async function startApp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-api-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://v1.example.test';
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 'x'.repeat(32) }), store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, origin };
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('session api creates, sends, backfills, and deletes an owned conversation', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const conversationId = created.body.data.conversation.id;
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.messages.length, 0);
  assert.equal(created.body.data.conversation.id, conversationId);
  assert.equal(JSON.stringify(created.body).includes('hb_v1_session='), false);

  const sent = await json(`${baseUrl}/api/v1/messages`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientMessageId: '44444444-4444-4444-8444-444444444444', text: '  唔該  ' }),
  });
  assert.equal(sent.response.status, 202);
  assert.equal(sent.body.data.message.sequence, 1);
  assert.equal(sent.body.data.turn.state, 'accepted');

  const backfill = await json(`${baseUrl}/api/v1/messages?after=0`, { headers: { Cookie: cookie } });
  assert.equal(backfill.response.status, 200);
  assert.deepEqual(backfill.body.data.messages.map((message) => message.text), ['唔該']);

  const deleted = await json(`${baseUrl}/api/v1/session`, { method: 'DELETE', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(deleted.response.status, 200);
  assert.match(deleted.response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  const denied = await json(`${baseUrl}/api/v1/messages?after=0`, { headers: { Cookie: cookie } });
  assert.equal(denied.response.status, 401);
});

test('session api accepts an identical retry but rejects changed idempotency payloads', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const input = { clientMessageId: '55555555-5555-4555-8555-555555555555', text: '你好' };
  const first = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(input) });
  const retry = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(input) });
  const conflict = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...input, text: '再見' }) });
  assert.equal(first.response.status, 202);
  assert.equal(retry.response.status, 202);
  assert.equal(retry.body.data.idempotent, true);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
});
