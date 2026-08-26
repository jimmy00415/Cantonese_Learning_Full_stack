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

test('exact origin allowlist accepts stable and one candidate but rejects unrelated Cloud Run tags', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-origin-list-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const stable = 'https://hkbuddy-v1-api-582852715831.asia-east2.run.app';
  const candidate = 'https://candidate-aaaaaaaaaaaa---hkbuddy-v1-api-582852715831.asia-east2.run.app';
  const config = loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: stable, V1_SESSION_SECRET: 's'.repeat(32) });
  config.allowedOrigins = [stable, candidate];
  const app = createApp({ config, store });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [origin, expected] of [
    [stable, 201],
    [candidate, 201],
    ['https://other---hkbuddy-v1-api-582852715831.asia-east2.run.app', 403],
    ['https://candidate-aaaaaaaaaaaa---hkbuddy-api-582852715831.asia-east2.run.app', 403],
    ['https://candidate-aaaaaaaaaaaa---hkbuddy-v1-api-93662314720.asia-east2.run.app', 403],
    ['https://hkbuddy-pilot-0630.azurewebsites.net', 403],
  ]) {
    const result = await json(`${baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: { Origin: origin, 'X-Client-Instance-Id': crypto.randomUUID() },
    });
    assert.equal(result.response.status, expected, origin);
  }
});

test('campus NAT bootstrap uses bounded client instance plus coarse proxy-derived IP with post-load QA headroom', async (t) => {
  const { baseUrl, origin, directory } = await startApp(t);
  const bootstrap = (clientId, forwardedFor = '203.0.113.4, 198.51.100.72') => json(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: { Origin: origin, 'X-Client-Instance-Id': clientId, 'X-Forwarded-For': forwardedFor },
  });
  const fixedClient = '11111111-1111-4111-8111-111111111111';
  for (let index = 0; index < 4; index += 1) assert.equal((await bootstrap(fixedClient)).response.status, 201);
  assert.equal((await bootstrap(fixedClient)).response.status, 429, 'one client instance is bounded');

  for (let index = 0; index < 21; index += 1) {
    const id = `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`;
    assert.equal((await bootstrap(id)).response.status, 201, `load plus browser QA request ${index + 1}`);
  }
  const persisted = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'));
  const ipBuckets = persisted.rateLimitBuckets.filter(({ quota }) => quota === 'session-bootstrap-coarse-ip');
  assert.equal(ipBuckets.length, 1, 'spoofed leftmost XFF is ignored and the trusted rightmost address is coarsened');
  assert.equal(ipBuckets[0].subjectHash, createHmac('sha256', 's'.repeat(32)).update('198.51.100.0/24').digest('hex'));
  assert.equal(ipBuckets[0].count, 26);
});

test('security rate limit hashes bootstrap IP and enforces durable session chat limits', async (t) => {
  const { baseUrl, origin, directory } = await startApp(t, { V1_MESSAGE_LIMIT_5M: '1' });
  const bootstrap = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': '198.51.100.72', 'X-Client-Instance-Id': '33333333-3333-4333-8333-333333333333' } });
  const cookie = bootstrap.response.headers.getSetCookie()[0].split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const firstPayload = { clientMessageId: '66666666-6666-4666-8666-666666666666', text: '一', replyLanguage: 'en', replyMode: 'text' };
  const first = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(firstPayload) });
  const retry = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(firstPayload) });
  const limited = await json(`${baseUrl}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ clientMessageId: '77777777-7777-4777-8777-777777777777', text: '二', replyLanguage: 'en', replyMode: 'text' }) });
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
  const bootstrapBucket = persisted.rateLimitBuckets.find((bucket) => bucket.quota === 'session-bootstrap-coarse-ip');
  assert.equal(bootstrapBucket.subjectHash, createHmac('sha256', 's'.repeat(32)).update('198.51.100.0/24').digest('hex'));
  assert.equal(bootstrapBucket.count, 1);
  assert.match(bootstrapBucket.windowStart, /^\d{4}-\d{2}-\d{2}T/);
});

test('security concurrent identical sends share one accepted record and one durable quota consumption', async (t) => {
  const { baseUrl, origin, directory } = await startApp(t, { V1_MESSAGE_LIMIT_5M: '1' });
  const bootstrap = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = bootstrap.response.headers.getSetCookie()[0].split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const payload = { clientMessageId: '88888888-8888-4888-8888-888888888888', text: '同一個請求', replyLanguage: 'en', replyMode: 'text' };
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
