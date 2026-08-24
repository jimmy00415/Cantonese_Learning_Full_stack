import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

async function startApp(t, configOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-security-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://v1.example.test';
  const config = loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 's'.repeat(32), V1_TRUST_PROXY_HOPS: '1', ...configOverrides });
  const app = createApp({ config, store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, origin, directory, store };
}

async function json(url, options = {}) { const response = await fetch(url, options); return { response, body: await response.json() }; }

test('security rejects missing and cross-site origins before session writes', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const missing = await json(`${baseUrl}/api/v1/session`, { method: 'POST' });
  const crossSite = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: 'https://attacker.example' } });
  const exact = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(missing.response.status, 403);
  assert.equal(missing.body.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(crossSite.response.status, 403);
  assert.equal(exact.response.status, 201);
});

test('security rate limit hashes bootstrap IP and enforces durable session chat limits', async (t) => {
  const { baseUrl, origin, directory } = await startApp(t, { V1_MESSAGE_LIMIT_5M: '1' });
  const bootstrap = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': '198.51.100.72' } });
  const cookie = bootstrap.response.headers.getSetCookie()[0].split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const firstPayload = { clientMessageId: '66666666-6666-4666-8666-666666666666', text: '一' };
  const first = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(firstPayload) });
  const retry = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(firstPayload) });
  const limited = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ clientMessageId: '77777777-7777-4777-8777-777777777777', text: '二' }) });
  assert.equal(first.response.status, 202);
  assert.equal(retry.response.status, 202);
  assert.equal(retry.body.data.idempotent, true);
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.match(limited.response.headers.get('retry-after'), /^\d+$/);
  const raw = JSON.stringify(limited.body);
  assert.equal(raw.includes('198.51.100.72'), false);
  assert.equal(raw.includes(cookie), false);
  const persisted = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'));
  const bootstrapBucket = persisted.rateLimitBuckets.find((bucket) => bucket.quota === 'session-bootstrap');
  assert.equal(bootstrapBucket.subjectHash, createHmac('sha256', 's'.repeat(32)).update('198.51.100.72').digest('hex'));
  assert.equal(bootstrapBucket.count, 1);
  assert.match(bootstrapBucket.windowStart, /^\d{4}-\d{2}-\d{2}T/);
});

test('security concurrent identical sends share one accepted record and one durable quota consumption', async (t) => {
  const { baseUrl, origin, directory } = await startApp(t, { V1_MESSAGE_LIMIT_5M: '1' });
  const bootstrap = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = bootstrap.response.headers.getSetCookie()[0].split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const payload = { clientMessageId: '88888888-8888-4888-8888-888888888888', text: '同一個請求' };
  const [left, right] = await Promise.all([
    json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(payload) }),
    json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(payload) }),
  ]);

  assert.deepEqual([left.response.status, right.response.status].sort(), [202, 202]);
  assert.equal([left.body.data.idempotent, right.body.data.idempotent].filter(Boolean).length, 1);
  assert.equal(left.body.data.message.id, right.body.data.message.id);
  const persisted = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'));
  const expectedSubjectHash = createHmac('sha256', 's'.repeat(32)).update(bootstrap.body.data.session.id).digest('hex');
  const chatBuckets = persisted.rateLimitBuckets.filter((bucket) => bucket.subjectHash === expectedSubjectHash);
  assert.deepEqual(chatBuckets.map((bucket) => [bucket.quota, bucket.count]).sort(), [['messages-5m', 1], ['messages-day', 1]]);
});
