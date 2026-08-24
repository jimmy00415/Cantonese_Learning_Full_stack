import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

async function startApp(t, configOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-api-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://v1.example.test';
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 'x'.repeat(32), ...configOverrides }), store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, origin, directory, store };
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

test('session api resumes an existing cookie without calling a mutating session method', async (t) => {
  const { baseUrl, origin, store } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const originalCreate = store.createOrResumeSession.bind(store);
  let createCalls = 0;
  store.createOrResumeSession = async (...arguments_) => { createCalls += 1; return originalCreate(...arguments_); };
  const resumed = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(resumed.response.status, 200);
  assert.equal(createCalls, 0);
  assert.equal(resumed.body.data.session.id, created.body.data.session.id);
});

test('session api uses a 30-day secure production cookie without weakening production config validation', async (t) => {
  const { baseUrl, origin } = await startApp(t, {
    NODE_ENV: 'production', V1_TRUST_PROXY_HOPS: '1', V1_STORE_DRIVER: 'postgres', DATABASE_URL: 'postgres://localhost/v1',
    V1_MEDIA_DRIVER: 'azure-blob', V1_AZURE_BLOB_CONTAINER: 'v1-media', V1_AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    V1_LLM_PROVIDER: 'hkbu', HKBU_API_KEY: 'test-key', HKBU_BASE_URL: 'https://hkbu.example.test', HKBU_MODEL: 'hkbu-model', HKBU_API_VERSION: 'v1',
    V1_INSTANCE_POLICY: 'single', V1_PRIVACY_NOTICE_VERSION: '2026-08-25', V1_PRIVACY_NOTICE_APPROVED: 'true', V1_RETENTION_WORKER_ENABLED: 'true',
  });
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.get('set-cookie');
  assert.equal(created.response.status, 201);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
});

test('session api normalizes malformed, oversized, invalid-voice, and unexpected failures', async (t) => {
  const { baseUrl, origin, store } = await startApp(t);
  const malformed = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_REQUEST');
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const oversized = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ clientMessageId: '99999999-9999-4999-8999-999999999999', text: 'x'.repeat(70 * 1024) }) });
  const invalidVoice = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'voice', voiceDraftId: 'missing-draft' }) });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(invalidVoice.response.status, 400);
  assert.equal(invalidVoice.body.error.code, 'INVALID_VOICE_DRAFT');
  store.getSessionByTokenHash = async () => { const error = new Error('private ENOENT detail'); error.code = 'ENOENT'; throw error; };
  const unexpected = await json(`${baseUrl}/api/v1/messages`, { headers: { Cookie: cookie } });
  assert.equal(unexpected.response.status, 500);
  assert.equal(unexpected.body.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(unexpected.body).includes('ENOENT'), false);
});
