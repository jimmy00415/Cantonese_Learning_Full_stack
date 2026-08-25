import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { rateLimitBucket } from '../src/services/rate-limiter.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import { exerciseDeletionGenerationContract } from './helpers/media-lifecycle-contract.js';

async function startSessionApp(t, configOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-voice-session-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://voice.example.test';
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_PUBLIC_ORIGIN: origin,
    V1_SESSION_SECRET: 'session-secret-that-is-never-public',
    ...configOverrides,
  });
  const server = createApp({ config, store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, origin };
}

async function startVoiceApp(t, {
  configOverrides = {},
  configTransform = (value) => value,
  asrProvider = { provider: 'azure', transcribe: async () => ({ transcript: '可編輯廣東話', provider: 'azure', latencyMs: 1, confidence: null }) },
  ttsProvider = { provider: 'azure', synthesize: async () => ({ buffer: Buffer.from([0x49, 0x44, 0x33, 0x04]), mimeType: 'audio/mpeg', provider: 'azure', latencyMs: 1 }) },
  providedMediaStore = null,
  mediaDeadlineMs = null,
  now = () => new Date(),
} = {}) {
  const { LocalMediaStore } = await import('../src/stores/local-media-store.js');
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-voice-http-'));
  const filePath = join(directory, 'store.json');
  const store = new AtomicFileStore({ filePath });
  await store.init();
  const mediaStore = providedMediaStore ?? new LocalMediaStore({ rootDirectory: join(directory, 'media') });
  await mediaStore.init?.();
  const origin = 'https://voice.example.test';
  const baseConfig = loadConfig({
    NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 'v'.repeat(32),
    V1_ASR_PROVIDER: 'azure', V1_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'fake-only', AZURE_SPEECH_REGION: 'eastasia',
    ...configOverrides,
  });
  const config = configTransform(baseConfig);
  const cleanupService = createMediaCleanupService({ store, mediaStore, now });
  let voiceService;
  if (mediaDeadlineMs !== null) {
    const { createVoiceService } = await import('../src/services/voice.js');
    voiceService = createVoiceService({
      config, store, mediaStore, asrProvider, ttsProvider, cleanupService, now,
      mediaDeadlineMs,
      spoolParentDirectory: join(directory, 'voice-spool'),
    });
  }
  const app = createApp({ config, store, mediaStore, asrProvider, ttsProvider, cleanupService, voiceService, now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await cleanupService.stop();
    await mediaStore.close?.();
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    origin,
    server,
    directory,
    filePath,
    store,
    mediaStore,
    cleanupService,
    config,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

function openHttpRequest(url, { method = 'GET', headers = {}, agent } = {}) {
  let receivedResponse = null;
  const request = httpRequest(url, { method, headers, agent }, (response) => {
    receivedResponse = response;
    response.resume();
  });
  request.on('error', () => undefined);
  const closed = new Promise((resolve) => request.once('close', resolve));
  return { request, closed, receivedResponse: () => receivedResponse };
}

function requestJsonOverHttp(url, { method = 'GET', headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, agent }, (response) => {
      const socket = response.socket;
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          body: bytes.length > 0 ? JSON.parse(bytes.toString('utf8')) : null,
          socket,
        });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function observeServerRequest(t, server, path) {
  let listener;
  const observed = new Promise((resolve) => {
    listener = (request) => {
      if (request.url !== path) return;
      server.off('request', listener);
      resolve(request);
    };
    server.prependListener('request', listener);
  });
  t.after(() => server.off('request', listener));
  return observed;
}

function canonicalWav(durationMs = 1_000) {
  const dataBytes = durationMs * 32;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function readableBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function settleWithin(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        void resolve;
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCondition(condition, {
  timeoutMs = 5_000,
  intervalMs = 10,
  message = 'condition did not become true before its diagnostic deadline',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await condition();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function createStore(t, prefix = 'hb-v1-voice-store-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const filePath = join(directory, 'store.json');
  const store = new AtomicFileStore({ filePath });
  await store.init();
  t.after(() => store.close());
  return { directory, filePath, store };
}

async function createDeliveredAssistant(store, session, conversation, {
  replyLanguage = 'yue-Hant-HK', replyMode = 'voice',
  clientMessageId = '12345678-1234-4234-8234-1234567890ab',
  requestHash = 'assistant-fixture-request',
} = {}) {
  const accepted = await store.acceptMessage({
    sessionId: session.id,
    conversationId: conversation.id,
    clientMessageId,
    requestHash,
    text: 'Tell me something useful',
    replyLanguage,
    replyMode,
    now: '2026-08-25T00:00:01.000Z',
  });
  const claimed = await store.claimNextTurn({
    workerId: 'turn-worker', leaseToken: 'turn-lease',
    now: new Date('2026-08-25T00:00:02.000Z'), leaseUntil: new Date('2026-08-25T00:01:00.000Z'),
  });
  await store.setTurnState({ turnId: claimed.id, leaseToken: 'turn-lease', state: 'retrieving', now: '2026-08-25T00:00:03.000Z' });
  await store.setTurnState({ turnId: claimed.id, leaseToken: 'turn-lease', state: 'generating', now: '2026-08-25T00:00:04.000Z' });
  const delivered = await store.deliverAssistant({
    turnId: accepted.turn.id,
    leaseToken: 'turn-lease',
    message: { text: 'Durable assistant text survives TTS.' },
    now: '2026-08-25T00:00:05.000Z',
  });
  return delivered.message;
}

function quotaBucket({ quota, limit = 10, expiresAt, now = '2026-08-25T00:00:00.000Z' }) {
  return {
    subjectHash: 'owned-session-rate-key', quota, limit,
    windowStart: now,
    expiresAt,
  };
}

test('voice schema migration upgrades schema 1 sessions with unique stable client scopes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-voice-migration-'));
  const filePath = join(directory, 'store.json');
  await writeFile(filePath, JSON.stringify({
    schemaVersion: 1,
    sessions: [
      { id: 'session-a', tokenHash: 'a'.repeat(64), createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
      { id: 'session-b', tokenHash: 'b'.repeat(64), createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
    ],
    conversations: [
      { id: 'conversation-a', sessionId: 'session-a', eventHighWater: 0, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
      { id: 'conversation-b', sessionId: 'session-b', eventHighWater: 0, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
    ],
    messages: [], turns: [], events: [], mediaAssets: [], rateLimitBuckets: [], serviceState: {},
  }), 'utf8');

  const store = new AtomicFileStore({ filePath });
  await store.init();
  t.after(() => store.close());

  const migrated = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(new Set(migrated.sessions.map((session) => session.clientScopeId)).size, 2);
  assert.ok(migrated.sessions.every((session) => /^[0-9a-f-]{36}$/i.test(session.clientScopeId)));
});

test('voice bootstrap exposes stable non-authorizing scope and server-owned build contracts only', async (t) => {
  const releaseCommitSha = 'a'.repeat(40);
  const { baseUrl, origin } = await startSessionApp(t, {
    V1_RELEASE_COMMIT_SHA: releaseCommitSha,
    AZURE_SPEECH_KEY: 'azure-secret-must-stay-private',
    AZURE_SPEECH_REGION: 'eastasia',
    V1_AZURE_SPEECH_CREDENTIAL_VERSION: 'rotation-private-to-config',
  });
  const clientOverride = `${baseUrl}/api/v1/session?releaseCommitSha=${'b'.repeat(40)}&normalizerContractVersion=unsafe`;
  const created = await fetchJson(clientOverride, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseCommitSha: 'c'.repeat(40), normalizerContractVersion: 'unsafe' }),
  });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const firstScope = created.body.data.clientSessionScope;
  assert.equal(created.response.status, 201);
  assert.match(firstScope, /^[0-9a-f-]{36}$/i);
  assert.equal(created.body.data.capabilities.releaseCommitSha, releaseCommitSha);
  assert.equal(created.body.data.capabilities.normalizerContractVersion, 'canonical-wav-v1');

  const resumed = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  const other = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(resumed.body.data.clientSessionScope, firstScope);
  assert.notEqual(other.body.data.clientSessionScope, firstScope);

  const scopeOnly = await fetchJson(`${baseUrl}/api/v1/messages?after=0`, {
    headers: { 'X-Client-Session-Scope': firstScope },
  });
  assert.equal(scopeOnly.response.status, 401);
  const serialized = JSON.stringify(created.body);
  for (const forbidden of ['azure-secret-must-stay-private', 'rotation-private-to-config', 'eastasia', 'speech.microsoft.com', 'V1_']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('WAV validator accepts only exact canonical PCM16LE bytes and enforces the 60-second boundary', async () => {
  const { validateCanonicalWav } = await import('../src/media/canonical-wav.js');
  const exact = canonicalWav(60_000);
  const accepted = validateCanonicalWav(exact);
  assert.deepEqual(
    { durationMs: accepted.durationMs, byteLength: accepted.byteLength, pcmBytes: accepted.pcmBytes },
    { durationMs: 60_000, byteLength: 1_920_044, pcmBytes: 1_920_000 },
  );

  const mutations = [
    ['RIFF', (value) => value.write('RIFX', 0, 'ascii')],
    ['RIFF length', (value) => value.writeUInt32LE(value.length - 7, 4)],
    ['WAVE', (value) => value.write('WVAE', 8, 'ascii')],
    ['fmt marker', (value) => value.write('fmt!', 12, 'ascii')],
    ['fmt length', (value) => value.writeUInt32LE(18, 16)],
    ['format', (value) => value.writeUInt16LE(3, 20)],
    ['channels', (value) => value.writeUInt16LE(2, 22)],
    ['sample rate', (value) => value.writeUInt32LE(44_100, 24)],
    ['byte rate', (value) => value.writeUInt32LE(64_000, 28)],
    ['block align', (value) => value.writeUInt16LE(4, 32)],
    ['bit depth', (value) => value.writeUInt16LE(8, 34)],
    ['data marker', (value) => value.write('DATA', 36, 'ascii')],
    ['data length', (value) => value.writeUInt32LE(value.length - 43, 40)],
  ];
  for (const [name, mutate] of mutations) {
    const value = canonicalWav(10);
    mutate(value);
    assert.throws(() => validateCanonicalWav(value), { code: 'VOICE_INVALID_WAV' }, name);
  }
  assert.throws(() => validateCanonicalWav(Buffer.concat([canonicalWav(10), Buffer.from([0])])), { code: 'VOICE_INVALID_WAV' });

  const odd = Buffer.alloc(47);
  canonicalWav(1).copy(odd, 0, 0, 44);
  odd.writeUInt32LE(39, 4);
  odd.writeUInt32LE(3, 40);
  assert.throws(() => validateCanonicalWav(odd), { code: 'VOICE_INVALID_WAV' });
  assert.throws(() => validateCanonicalWav(canonicalWav(60_001)), { code: 'VOICE_INVALID_WAV' });
});

test('WAV validator derives SHA from bytes and ignores browser duration or type claims', async () => {
  const { createHash } = await import('node:crypto');
  const { validateCanonicalWav } = await import('../src/media/canonical-wav.js');
  const bytes = canonicalWav(250);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(validateCanonicalWav(bytes, { expectedSha256: sha256, durationMs: 1, mimeType: 'video/mp4' }).durationMs, 250);
  assert.throws(
    () => validateCanonicalWav(bytes, { expectedSha256: '0'.repeat(64) }),
    { code: 'VOICE_HASH_MISMATCH' },
  );
});

test('media local adapter keeps opaque attempts private, bounded, range-readable, and deleteable', async (t) => {
  const { LocalMediaStore } = await import('../src/stores/local-media-store.js');
  const rootDirectory = await mkdtemp(join(tmpdir(), 'hb-v1-local-media-'));
  const mediaStore = new LocalMediaStore({ rootDirectory });
  await mediaStore.init();
  t.after(() => mediaStore.close());

  const storageKey = mediaStore.createAttemptKey({ kind: 'voice' });
  assert.match(storageKey, /^attempts\/voice\/[0-9a-f-]{36}$/i);
  const bytes = Buffer.from('private-media-bytes');
  const stored = await mediaStore.putAttempt({
    storageKey,
    readable: Readable.from([bytes]),
    maxBytes: bytes.length,
    contentType: 'audio/wav',
  });
  assert.equal(stored.byteLength, bytes.length);
  const storagePath = join(rootDirectory, ...storageKey.split('/'));
  const fixedModifiedAt = new Date('2026-08-24T00:00:00.000Z');
  await utimes(storagePath, fixedModifiedAt, fixedModifiedAt);
  const opened = await mediaStore.open({ storageKey, start: 2, end: 7 });
  assert.equal(opened.size, bytes.length);
  assert.deepEqual(await readableBuffer(opened.readable), bytes.subarray(2, 8));

  const listed = await mediaStore.listAttemptKeys({ prefix: 'attempts/voice/', before: new Date(Date.now() + 60_000), limit: 10 });
  assert.deepEqual(listed.keys.map((entry) => entry.storageKey), [storageKey]);
  assert.match(listed.keys[0].version, /^local:/, 'local sweeps receive a replacement-sensitive file identity');
  assert.deepEqual(await mediaStore.delete({ storageKey }), { deleted: true, notFound: false });
  await mediaStore.putAttempt({ storageKey, readable: Readable.from([bytes]), maxBytes: bytes.length, contentType: 'audio/wav' });
  await utimes(storagePath, fixedModifiedAt, fixedModifiedAt);
  const replaced = await mediaStore.listAttemptKeys({ prefix: 'attempts/voice/', before: new Date(Date.now() + 60_000), limit: 10 });
  assert.equal(replaced.keys[0].lastModified, listed.keys[0].lastModified);
  assert.equal(replaced.keys[0].byteLength, listed.keys[0].byteLength);
  assert.notEqual(replaced.keys[0].version, listed.keys[0].version, 'same-size same-time replacement has a new identity');
  assert.deepEqual(await mediaStore.delete({ storageKey }), { deleted: true, notFound: false });
  assert.deepEqual(await mediaStore.delete({ storageKey }), { deleted: false, notFound: true });
  await assert.rejects(mediaStore.open({ storageKey }), { code: 'MEDIA_NOT_FOUND' });
  await assert.rejects(mediaStore.open({ storageKey: '../outside' }), { code: 'INVALID_STORAGE_KEY' });
});

test('media local adapter aborts and removes a private attempt at 8 MiB plus one byte', async (t) => {
  const { LocalMediaStore } = await import('../src/stores/local-media-store.js');
  const rootDirectory = await mkdtemp(join(tmpdir(), 'hb-v1-local-media-cap-'));
  const mediaStore = new LocalMediaStore({ rootDirectory });
  await mediaStore.init();
  t.after(() => mediaStore.close());
  const storageKey = mediaStore.createAttemptKey({ kind: 'voice' });
  await assert.rejects(
    mediaStore.putAttempt({ storageKey, readable: Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)]), maxBytes: 8 * 1024 * 1024 }),
    { code: 'VOICE_UPLOAD_TOO_LARGE' },
  );
  assert.deepEqual((await mediaStore.listAttemptKeys({ prefix: 'attempts/voice/', before: new Date(Date.now() + 60_000), limit: 10 })).keys, []);
});

test('media local attempt listing rejects an already-aborted sweep before touching an absent prefix', async (t) => {
  const { LocalMediaStore } = await import('../src/stores/local-media-store.js');
  const rootDirectory = await mkdtemp(join(tmpdir(), 'hb-v1-local-media-list-abort-'));
  const mediaStore = new LocalMediaStore({ rootDirectory });
  await mediaStore.init();
  t.after(() => mediaStore.close());
  const controller = new AbortController();
  controller.abort(new Error('fake cleanup stop'));
  await assert.rejects(mediaStore.listAttemptKeys({
    prefix: 'attempts/tts/',
    before: new Date(Date.now() + 60_000),
    limit: 10,
    signal: controller.signal,
  }), { code: 'MEDIA_OPERATION_ABORTED' });
});

test('voice and chat multi-window quota blocks at the latest expiry without mutation or bucket-order dependence', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-max-window-');
  const owner = await store.createOrResumeSession({ tokenHash: 'quota-owner', now: '2026-08-25T00:00:00.000Z' });
  const short = quotaBucket({ quota: 'messages-5m', limit: 1, expiresAt: '2026-08-25T00:05:00.000Z' });
  const daily = quotaBucket({ quota: 'messages-day', limit: 1, expiresAt: '2026-08-26T00:00:00.000Z' });
  await store.consumeRateLimit(short);
  await store.consumeRateLimit(daily);
  const before = await readFile(filePath, 'utf8');
  const input = {
    sessionId: owner.session.id, conversationId: owner.conversation.id,
    clientMessageId: '22222222-2222-4222-8222-222222222222', requestHash: 'quota-test', text: 'blocked',
  };
  for (const rateLimits of [[short, daily], [daily, short]]) {
    await assert.rejects(
      store.acceptMessageWithRateLimits({ ...input, rateLimits }),
      (error) => error.code === 'RATE_LIMITED' && error.expiresAt === daily.expiresAt,
    );
  }
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('ASR and TTS fixed multi-window quotas block at the latest expiry without state mutation', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-voice-max-window-');
  const owner = await store.createOrResumeSession({ tokenHash: 'voice-quota-owner', now: '2026-08-25T00:00:00.000Z' });
  const assistant = await createDeliveredAssistant(store, owner.session, owner.conversation);
  const asrShort = quotaBucket({ quota: 'asr-10m', limit: 1, expiresAt: '2026-08-25T00:10:00.000Z' });
  const asrDaily = quotaBucket({ quota: 'asr-day', limit: 1, expiresAt: '2026-08-26T00:00:00.000Z' });
  const ttsShort = quotaBucket({ quota: 'tts-10m', limit: 1, expiresAt: '2026-08-25T00:10:00.000Z' });
  const ttsDaily = quotaBucket({ quota: 'tts-day', limit: 1, expiresAt: '2026-08-26T00:00:00.000Z' });
  for (const bucket of [asrShort, asrDaily, ttsShort, ttsDaily]) await store.consumeRateLimit(bucket);
  const before = await readFile(filePath, 'utf8');

  for (const rateLimits of [[asrShort, asrDaily], [asrDaily, asrShort]]) {
    const result = await store.claimVoiceUploadWithRateLimits({
      sessionId: owner.session.id,
      clientUploadId: '22222222-0000-4000-8000-000000000000',
      requestSha256: '2'.repeat(64),
      mimeType: 'audio/wav',
      rateLimits,
      leaseToken: 'asr-blocked-lease',
      attemptStorageKey: 'attempts/voice/22222222-2222-4222-8222-222222222222',
      leaseExpiresAt: '2026-08-25T00:00:20.000Z',
      attemptDeadlineAt: '2026-08-25T00:01:00.000Z',
      now: '2026-08-25T00:00:01.000Z',
    });
    assert.equal(result.status, 'rate_limited');
    assert.equal(result.blockingExpiresAt, asrDaily.expiresAt);
  }
  for (const rateLimits of [[ttsShort, ttsDaily], [ttsDaily, ttsShort]]) {
    const result = await store.claimAssistantAudioWithRateLimits({
      sessionId: owner.session.id,
      messageId: assistant.id,
      kind: 'assistant_voice',
      rateLimits,
      leaseToken: 'tts-blocked-lease',
      attemptStorageKey: 'attempts/tts/22222222-2222-4222-8222-222222222222',
      configVersion: 'fixed-config-v1',
      leaseExpiresAt: '2026-08-25T00:00:20.000Z',
      attemptDeadlineAt: '2026-08-25T00:00:30.000Z',
      now: '2026-08-25T00:00:01.000Z',
    });
    assert.equal(result.status, 'rate_limited');
    assert.equal(result.blockingExpiresAt, ttsDaily.expiresAt);
  }
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('voice upload claims are atomic, idempotent, fenced, and attach an owned draft exactly once', async (t) => {
  const { store } = await createStore(t);
  const owner = await store.createOrResumeSession({ tokenHash: 'voice-owner', now: '2026-08-25T00:00:00.000Z' });
  const base = {
    sessionId: owner.session.id,
    clientUploadId: '33333333-3333-4333-8333-333333333333',
    requestSha256: 'a'.repeat(64), mimeType: 'audio/wav',
    rateLimits: [quotaBucket({ quota: 'asr-10m', expiresAt: '2026-08-25T00:10:00.000Z' })],
    leaseToken: 'voice-token-one', attemptStorageKey: 'attempts/voice/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    leaseExpiresAt: '2026-08-25T00:00:20.000Z', attemptDeadlineAt: '2026-08-25T00:01:00.000Z',
    now: '2026-08-25T00:00:01.000Z',
  };
  const claimed = await store.claimVoiceUploadWithRateLimits(base);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.upload.state, 'uploading');
  assert.equal((await store.claimVoiceUploadWithRateLimits({ ...base, leaseToken: 'ignored', attemptStorageKey: 'attempts/voice/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status, 'live');
  assert.equal((await store.claimVoiceUploadWithRateLimits({ ...base, requestSha256: 'b'.repeat(64) })).status, 'conflict');

  const renewed = await store.renewVoiceUploadLease({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken,
    leaseExpiresAt: '2026-08-25T00:02:00.000Z', now: '2026-08-25T00:00:02.000Z',
  });
  assert.equal(renewed.leaseExpiresAt, base.attemptDeadlineAt);
  assert.equal((await store.setVoiceUploadTranscribing({ uploadId: claimed.upload.id, leaseToken: base.leaseToken, now: '2026-08-25T00:00:03.000Z' })).state, 'transcribing');
  const completed = await store.completeVoiceUpload({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken,
    mediaAsset: {
      storageKey: base.attemptStorageKey, mimeType: 'audio/wav', byteLength: 32_044,
      durationMs: 1_000, sha256: base.requestSha256,
    },
    transcript: '可編輯文字', now: '2026-08-25T00:00:04.000Z',
  });
  assert.equal(completed.mediaAsset.status, 'draft');
  assert.equal((await store.claimVoiceUploadWithRateLimits(base)).status, 'ready');

  const sent = await store.acceptMessage({
    sessionId: owner.session.id, conversationId: owner.conversation.id,
    clientMessageId: '44444444-4444-4444-8444-444444444444', requestHash: 'voice-send',
    text: '可編輯文字', voiceDraftId: completed.mediaAsset.id, now: '2026-08-25T00:00:05.000Z',
  });
  assert.equal(sent.message.mediaId, completed.mediaAsset.id);
  await assert.rejects(store.acceptMessage({
    sessionId: owner.session.id, conversationId: owner.conversation.id,
    clientMessageId: '55555555-5555-4555-8555-555555555555', requestHash: 'voice-reuse',
    text: 'reuse', voiceDraftId: completed.mediaAsset.id, now: '2026-08-25T00:00:06.000Z',
  }), { code: 'INVALID_VOICE_DRAFT' });
});

test('cancelling a live voice upload atomically tombstones its identity and fences late workers', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-voice-cancel-live-');
  const owner = await store.createOrResumeSession({ tokenHash: 'voice-cancel-live-owner', now: '2026-08-25T00:00:00.000Z' });
  const base = {
    sessionId: owner.session.id,
    clientUploadId: '51515151-5151-4151-8151-515151515151',
    requestSha256: 'a1'.repeat(32), mimeType: 'audio/wav', rateLimits: [],
    leaseToken: 'voice-cancel-live-lease',
    attemptStorageKey: 'attempts/voice/51515151-5151-4151-8151-515151515151',
    leaseExpiresAt: '2026-08-25T00:00:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:01:00.000Z',
    now: '2026-08-25T00:00:01.000Z',
  };
  const claimed = await store.claimVoiceUploadWithRateLimits(base);

  const cancelled = await store.cancelVoiceUpload({
    sessionId: owner.session.id, clientUploadId: base.clientUploadId,
    now: '2026-08-25T00:00:02.000Z', cleanupNotBefore: '2026-08-25T00:00:02.000Z',
  });
  assert.equal(cancelled.state, 'failed');
  assert.equal(cancelled.failureCode, 'VOICE_UPLOAD_CANCELLED');
  assert.equal(cancelled.failureHttpStatus, 410);
  assert.equal(cancelled.retryable, false);
  assert.equal(cancelled.requestSha256, base.requestSha256);
  assert.equal(cancelled.leaseToken, null);
  assert.equal(cancelled.leaseExpiresAt, null);
  assert.equal(cancelled.attemptStorageKey, null);
  assert.equal(cancelled.mediaAssetId, null);
  assert.equal(cancelled.transcript, null);

  await assert.rejects(store.setVoiceUploadTranscribing({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken, now: '2026-08-25T00:00:03.000Z',
  }), { code: 'LEASE_LOST' });
  await assert.rejects(store.completeVoiceUpload({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken,
    mediaAsset: {
      storageKey: base.attemptStorageKey, mimeType: 'audio/wav', byteLength: 32_044,
      durationMs: 1_000, sha256: base.requestSha256,
    },
    transcript: 'must not survive cancellation', now: '2026-08-25T00:00:03.000Z',
  }), { code: 'LEASE_LOST' });
  await assert.rejects(store.failVoiceUpload({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken,
    failureCode: 'VOICE_TRANSCRIPTION_FAILED', failureHttpStatus: 502, retryable: true,
    now: '2026-08-25T00:00:03.000Z',
  }), { code: 'LEASE_LOST' });

  const repeated = await store.cancelVoiceUpload({
    sessionId: owner.session.id, clientUploadId: base.clientUploadId,
    now: '2026-08-25T00:00:04.000Z',
  });
  assert.equal(repeated.failureCode, 'VOICE_UPLOAD_CANCELLED');
  const retry = await store.claimVoiceUploadWithRateLimits({
    ...base,
    leaseToken: 'voice-cancel-retry-lease',
    attemptStorageKey: 'attempts/voice/52525252-5252-4252-8252-525252525252',
    leaseExpiresAt: '2026-08-25T00:02:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:03:00.000Z',
    now: '2026-08-25T00:02:01.000Z',
  });
  assert.equal(retry.status, 'permanent_failure');
  assert.equal(retry.failureCode, 'VOICE_UPLOAD_CANCELLED');
  assert.equal(retry.failureHttpStatus, 410);

  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  const deletion = snapshot.mediaDeletionJobs.find((job) => job.storageKey === base.attemptStorageKey);
  assert.equal(deletion.state, 'pending');
  assert.equal(deletion.reason, 'voice-upload-cancelled-attempt');
  assert.equal(deletion.notBefore, '2026-08-25T00:02:00.000Z');
  assert.equal(snapshot.mediaAssets.length, 0);
});

test('cancelling a ready voice upload revokes its unattached draft and removes transcript data', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-voice-cancel-ready-');
  const owner = await store.createOrResumeSession({ tokenHash: 'voice-cancel-ready-owner', now: '2026-08-25T00:00:00.000Z' });
  const base = {
    sessionId: owner.session.id,
    clientUploadId: '53535353-5353-4353-8353-535353535353',
    requestSha256: 'b2'.repeat(32), mimeType: 'audio/wav', rateLimits: [],
    leaseToken: 'voice-cancel-ready-lease',
    attemptStorageKey: 'attempts/voice/53535353-5353-4353-8353-535353535353',
    leaseExpiresAt: '2026-08-25T00:00:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:01:00.000Z',
    now: '2026-08-25T00:00:01.000Z',
  };
  const claimed = await store.claimVoiceUploadWithRateLimits(base);
  await store.setVoiceUploadTranscribing({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken, now: '2026-08-25T00:00:02.000Z',
  });
  const completing = store.completeVoiceUpload({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken,
    mediaAsset: {
      storageKey: base.attemptStorageKey, mimeType: 'audio/wav', byteLength: 32_044,
      durationMs: 1_000, sha256: base.requestSha256,
    },
    transcript: 'sensitive transcript', now: '2026-08-25T00:00:03.000Z',
  });
  const cancelling = store.cancelVoiceUpload({
    sessionId: owner.session.id, clientUploadId: base.clientUploadId,
    now: '2026-08-25T00:00:04.000Z', cleanupNotBefore: '2026-08-25T00:00:04.000Z',
  });
  const [completedResult, cancelledResult] = await Promise.allSettled([completing, cancelling]);
  assert.equal(completedResult.status, 'fulfilled');
  assert.equal(cancelledResult.status, 'fulfilled');
  const completed = completedResult.value;
  const cancelled = cancelledResult.value;
  assert.equal(cancelled.failureCode, 'VOICE_UPLOAD_CANCELLED');
  assert.equal(cancelled.retryable, false);
  assert.equal(cancelled.mediaAssetId, null);
  assert.equal(cancelled.transcript, null);
  await assert.rejects(store.getMediaAsset({
    sessionId: owner.session.id, mediaId: completed.mediaAsset.id,
  }), { code: 'NOT_FOUND' });

  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(snapshot.mediaAssets.length, 0);
  const deletion = snapshot.mediaDeletionJobs.find((job) => job.storageKey === base.attemptStorageKey);
  assert.equal(deletion.state, 'pending');
  assert.equal(deletion.reason, 'voice-upload-cancelled-draft');
  assert.equal(deletion.notBefore, '2026-08-25T00:00:04.000Z');
});

test('an attached voice draft rejects upload cancellation without changing message or media ownership', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-voice-cancel-attached-');
  const owner = await store.createOrResumeSession({ tokenHash: 'voice-cancel-attached-owner', now: '2026-08-25T00:00:00.000Z' });
  const base = {
    sessionId: owner.session.id,
    clientUploadId: '54545454-5454-4454-8454-545454545454',
    requestSha256: 'c3'.repeat(32), mimeType: 'audio/wav', rateLimits: [],
    leaseToken: 'voice-cancel-attached-lease',
    attemptStorageKey: 'attempts/voice/54545454-5454-4454-8454-545454545454',
    leaseExpiresAt: '2026-08-25T00:00:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:01:00.000Z',
    now: '2026-08-25T00:00:01.000Z',
  };
  const claimed = await store.claimVoiceUploadWithRateLimits(base);
  await store.setVoiceUploadTranscribing({ uploadId: claimed.upload.id, leaseToken: base.leaseToken, now: '2026-08-25T00:00:02.000Z' });
  const completed = await store.completeVoiceUpload({
    uploadId: claimed.upload.id, leaseToken: base.leaseToken,
    mediaAsset: {
      storageKey: base.attemptStorageKey, mimeType: 'audio/wav', byteLength: 32_044,
      durationMs: 1_000, sha256: base.requestSha256,
    },
    transcript: 'attached transcript', now: '2026-08-25T00:00:03.000Z',
  });
  const accepting = store.acceptMessage({
    sessionId: owner.session.id, conversationId: owner.conversation.id,
    clientMessageId: '55555555-5555-4555-8555-555555555555', requestHash: 'attached-cancel-race',
    text: 'edited attached transcript', voiceDraftId: completed.mediaAsset.id,
    now: '2026-08-25T00:00:04.000Z',
  });
  const cancelling = store.cancelVoiceUpload({
    sessionId: owner.session.id, clientUploadId: base.clientUploadId,
    now: '2026-08-25T00:00:05.000Z',
  });
  const [acceptedResult, cancelledResult] = await Promise.allSettled([accepting, cancelling]);
  assert.equal(acceptedResult.status, 'fulfilled');
  assert.equal(cancelledResult.status, 'rejected');
  assert.equal(cancelledResult.reason.code, 'VOICE_DRAFT_ALREADY_ATTACHED');
  const accepted = acceptedResult.value;
  const asset = await store.getMediaAsset({ sessionId: owner.session.id, mediaId: completed.mediaAsset.id });
  assert.equal(asset.status, 'attached');
  assert.equal(asset.ownerMessageId, accepted.message.id);
  const upload = await store.getVoiceUploadStatus({ sessionId: owner.session.id, clientUploadId: base.clientUploadId });
  assert.equal(upload.state, 'ready');
  assert.equal(upload.mediaAssetId, completed.mediaAsset.id);
  assert.equal(upload.transcript, 'attached transcript');
  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(snapshot.mediaDeletionJobs.some((job) => job.storageKey === base.attemptStorageKey), false);
});

test('voice reclaim atomically outboxes the displaced attempt key and permanent failures never consume again', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-voice-reclaim-');
  const owner = await store.createOrResumeSession({ tokenHash: 'voice-reclaim-owner', now: '2026-08-25T00:00:00.000Z' });
  const firstKey = 'attempts/voice/66666666-6666-4666-8666-666666666666';
  const common = {
    sessionId: owner.session.id, clientUploadId: '77777777-7777-4777-8777-777777777777',
    requestSha256: 'c'.repeat(64), mimeType: 'audio/wav',
    rateLimits: [quotaBucket({ quota: 'asr-day', limit: 5, expiresAt: '2026-08-26T00:00:00.000Z' })],
  };
  const first = await store.claimVoiceUploadWithRateLimits({
    ...common, leaseToken: 'first-token', attemptStorageKey: firstKey,
    leaseExpiresAt: '2026-08-25T00:00:10.000Z', attemptDeadlineAt: '2026-08-25T00:00:20.000Z', now: '2026-08-25T00:00:01.000Z',
  });
  const nextKey = 'attempts/voice/88888888-8888-4888-8888-888888888888';
  const reclaimed = await store.claimVoiceUploadWithRateLimits({
    ...common, leaseToken: 'second-token', attemptStorageKey: nextKey,
    leaseExpiresAt: '2026-08-25T00:02:10.000Z', attemptDeadlineAt: '2026-08-25T00:03:00.000Z', now: '2026-08-25T00:02:00.000Z',
  });
  assert.equal(reclaimed.status, 'claimed');
  assert.equal(reclaimed.upload.attempt, 2);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  const displaced = persisted.mediaDeletionJobs.find((job) => job.storageKey === firstKey);
  assert.equal(displaced.state, 'pending');
  assert.ok(Date.parse(displaced.notBefore) >= Date.parse('2026-08-25T00:03:00.000Z'));

  await store.failVoiceUpload({
    uploadId: first.upload.id, leaseToken: 'second-token', failureCode: 'VOICE_INVALID_WAV',
    failureHttpStatus: 422, retryable: false, cleanupNotBefore: '2026-08-25T00:03:01.000Z', now: '2026-08-25T00:02:01.000Z',
  });
  const beforeRetry = await readFile(filePath, 'utf8');
  const permanent = await store.claimVoiceUploadWithRateLimits({
    ...common, leaseToken: 'third-token', attemptStorageKey: 'attempts/voice/99999999-9999-4999-8999-999999999999',
    leaseExpiresAt: '2026-08-25T00:04:00.000Z', attemptDeadlineAt: '2026-08-25T00:05:00.000Z', now: '2026-08-25T00:03:00.000Z',
  });
  assert.deepEqual({ status: permanent.status, failureCode: permanent.failureCode, failureHttpStatus: permanent.failureHttpStatus }, {
    status: 'permanent_failure', failureCode: 'VOICE_INVALID_WAV', failureHttpStatus: 422,
  });
  assert.equal(await readFile(filePath, 'utf8'), beforeRetry);
});

test('TTS concurrent claims create one generation and one quota mutation while stale fencing cannot attach', async (t) => {
  const { filePath, store } = await createStore(t, 'hb-v1-tts-claims-');
  const owner = await store.createOrResumeSession({ tokenHash: 'tts-owner', now: '2026-08-25T00:00:00.000Z' });
  const assistant = await createDeliveredAssistant(store, owner.session, owner.conversation);
  const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => store.claimAssistantAudioWithRateLimits({
    sessionId: owner.session.id, messageId: assistant.id, kind: 'assistant_voice',
    rateLimits: [quotaBucket({ quota: 'tts-10m', limit: 5, expiresAt: '2026-08-25T00:10:00.000Z' })],
    leaseToken: `tts-token-${index}`,
    attemptStorageKey: `attempts/tts/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    configVersion: 'tts-config-v1', leaseExpiresAt: '2026-08-25T00:00:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:00:30.000Z', now: '2026-08-25T00:00:06.000Z',
  })));
  assert.equal(claims.filter((result) => result.status === 'claimed').length, 1);
  assert.equal(claims.filter((result) => result.status === 'live').length, 19);
  const winner = claims.find((result) => result.status === 'claimed');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.mediaGenerations.length, 1);
  assert.equal(persisted.rateLimitBuckets.find((bucket) => bucket.quota === 'tts-10m').count, 1);

  await assert.rejects(store.completeMediaGeneration({
    generationId: winner.generation.id, leaseToken: 'stale-token',
    mediaAsset: { storageKey: winner.generation.attemptStorageKey, mimeType: 'audio/mpeg', byteLength: 4, sha256: 'd'.repeat(64) },
    now: '2026-08-25T00:00:07.000Z',
  }), { code: 'LEASE_LOST' });
  const completed = await store.completeMediaGeneration({
    generationId: winner.generation.id, leaseToken: winner.generation.leaseToken,
    mediaAsset: { storageKey: winner.generation.attemptStorageKey, mimeType: 'audio/mpeg', byteLength: 4, sha256: 'd'.repeat(64) },
    now: '2026-08-25T00:00:07.000Z',
  });
  assert.equal(completed.generation.state, 'attached');
  assert.equal(completed.event.type, 'audio.ready');
  assert.equal((await store.getAssistantAudioStatus({ sessionId: owner.session.id, messageId: assistant.id, kind: 'assistant_voice' })).state, 'attached');
  assert.equal((await store.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 })).at(-1).text, 'Durable assistant text survives TTS.');
});

test('media deletion outbox generation-rearms late writes and fences stale cleanup completion', async (t) => {
  const { store } = await createStore(t, 'hb-v1-media-outbox-');
  await exerciseDeletionGenerationContract({
    store,
    storageKey: 'attempts/voice/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    now: '2026-08-25T00:00:00.000Z',
  });
});

test('Azure ASR uses the exact fixed Cantonese contract once and returns only normalized transcript data', async () => {
  const { createAsrProvider, speechProviderLimits } = await import('../src/providers/asr.js');
  const calls = [];
  const logs = [];
  const provider = createAsrProvider({
    config: { provider: 'azure', settings: { apiKey: 'asr-secret-value', region: 'eastasia' } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ RecognitionStatus: 'Success', DisplayText: '早晨，同學。' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'apim-request-id': 'safe-request-id' },
      });
    },
    logger: { info: (entry) => logs.push(entry) },
  });
  const audio = canonicalWav(100);
  const result = await provider.transcribe(audio);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://eastasia.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['Ocp-Apim-Subscription-Key'], 'asr-secret-value');
  assert.equal(calls[0].options.headers['Content-Type'], 'audio/wav; codecs=audio/pcm; samplerate=16000');
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.deepEqual(Buffer.from(calls[0].options.body), audio);
  assert.deepEqual({ transcript: result.transcript, provider: result.provider, confidence: result.confidence }, {
    transcript: '早晨，同學。', provider: 'azure', confidence: null,
  });
  assert.equal(speechProviderLimits.deadlineMs, 15_000);
  assert.equal(speechProviderLimits.asrResponseBytes, 256 * 1024);
  assert.equal(JSON.stringify(logs).includes('asr-secret-value'), false);
  assert.equal(JSON.stringify(logs).includes('早晨'), false);
});

test('Azure ASR maps every fixed, transient, malformed, and deadline outcome without retry', async () => {
  const { createAsrProvider } = await import('../src/providers/asr.js');
  const cases = [
    { name: 'no match', response: () => new Response(JSON.stringify({ RecognitionStatus: 'NoMatch' }), { status: 200, headers: { 'Content-Type': 'application/json' } }), code: 'VOICE_SPEECH_NOT_RECOGNIZED', status: 422, retryable: false },
    { name: 'initial silence', response: () => new Response(JSON.stringify({ RecognitionStatus: 'InitialSilenceTimeout' }), { status: 200, headers: { 'Content-Type': 'application/json' } }), code: 'VOICE_SPEECH_NOT_RECOGNIZED', status: 422, retryable: false },
    { name: 'babble timeout', response: () => new Response(JSON.stringify({ RecognitionStatus: 'BabbleTimeout' }), { status: 200, headers: { 'Content-Type': 'application/json' } }), code: 'VOICE_SPEECH_NOT_RECOGNIZED', status: 422, retryable: false },
    { name: 'unknown recognition status drift', response: () => new Response(JSON.stringify({ RecognitionStatus: 'FutureProviderStatus' }), { status: 200, headers: { 'Content-Type': 'application/json' } }), code: 'VOICE_PROVIDER_INVALID_RESPONSE', status: 502, retryable: false },
    { name: 'auth', response: () => new Response('private', { status: 401 }), code: 'VOICE_PROVIDER_MISCONFIGURED', status: 503, retryable: false },
    { name: 'fixed 4xx', response: () => new Response('private', { status: 400 }), code: 'VOICE_TRANSCRIPTION_REJECTED', status: 502, retryable: false },
    { name: 'upstream timeout', response: () => new Response('private', { status: 408 }), code: 'VOICE_TRANSCRIPTION_FAILED', status: 502, retryable: true },
    { name: 'rate limit', response: () => new Response('private', { status: 429 }), code: 'VOICE_TRANSCRIPTION_FAILED', status: 502, retryable: true },
    { name: 'upstream failure', response: () => new Response('private', { status: 503 }), code: 'VOICE_TRANSCRIPTION_FAILED', status: 502, retryable: true },
    { name: 'malformed 2xx', response: () => new Response('{bad', { status: 200, headers: { 'Content-Type': 'application/json' } }), code: 'VOICE_PROVIDER_INVALID_RESPONSE', status: 502, retryable: false },
    { name: 'wrong type 2xx', response: () => new Response('{}', { status: 200, headers: { 'Content-Type': 'text/plain' } }), code: 'VOICE_PROVIDER_INVALID_RESPONSE', status: 502, retryable: false },
    { name: 'oversized 2xx', response: () => new Response(Buffer.alloc(256 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'application/json' } }), code: 'VOICE_PROVIDER_INVALID_RESPONSE', status: 502, retryable: false },
    { name: 'network', response: () => { throw new Error('fake transport failure'); }, code: 'VOICE_TRANSCRIPTION_FAILED', status: 502, retryable: true },
  ];
  for (const entry of cases) {
    let calls = 0;
    const provider = createAsrProvider({
      config: { provider: 'azure', settings: { apiKey: 'secret', region: 'eastasia' } },
      fetchImpl: async () => { calls += 1; return entry.response(); },
    });
    await assert.rejects(provider.transcribe(canonicalWav(10)), (error) => (
      error.code === entry.code && error.httpStatus === entry.status && error.retryable === entry.retryable
    ), entry.name);
    assert.equal(calls, 1, `${entry.name} has zero adapter retry`);
  }

  let deadlineCalls = 0;
  const deadlineProvider = createAsrProvider({
    config: { provider: 'azure', settings: { apiKey: 'secret', region: 'eastasia' } },
    totalDeadlineMs: 10,
    fetchImpl: async (url, { signal }) => {
      void url;
      deadlineCalls += 1;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await assert.rejects(deadlineProvider.transcribe(canonicalWav(10)), (error) => (
    error.code === 'VOICE_PROVIDER_TIMEOUT' && error.httpStatus === 504 && error.retryable === true
  ));
  assert.equal(deadlineCalls, 1);
});

test('Azure TTS serializes exact escaped server text and validates bounded MP3 output', async () => {
  const { createTtsProvider, escapeXml } = await import('../src/providers/tts.js');
  const calls = [];
  const provider = createTtsProvider({
    config: { provider: 'azure', settings: { apiKey: 'tts-secret-value', region: 'eastasia' } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(Buffer.from([0x49, 0x44, 0x33, 0x04]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    },
  });
  const text = `&<>"'`;
  const result = await provider.synthesize(text);
  assert.equal(escapeXml(text), '&amp;&lt;&gt;&quot;&apos;');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/ssml+xml');
  assert.equal(calls[0].options.headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3');
  assert.equal(calls[0].options.headers['User-Agent'], 'HongKongBuddy-ProductionV1/0.1');
  assert.equal(calls[0].options.body, '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-HK"><voice name="zh-HK-HiuMaanNeural">&amp;&lt;&gt;&quot;&apos;</voice></speak>');
  assert.deepEqual({ mimeType: result.mimeType, provider: result.provider, bytes: result.buffer.length }, { mimeType: 'audio/mpeg', provider: 'azure', bytes: 4 });
});

test('MiniMax TTS sends fixed fields, validates exact hex size and MP3 magic, and never accepts client voice overrides', async () => {
  const { createTtsProvider } = await import('../src/providers/tts.js');
  const calls = [];
  const config = {
    provider: 'minimax',
    settings: { apiKey: 'minimax-secret', baseUrl: 'https://api.minimax.test', model: 'speech-02-hd', voice: 'Cantonese_KindLady' },
  };
  const provider = createTtsProvider({
    config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 }, data: { status: 2, audio: '49443304' }, extra_info: { audio_size: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await provider.synthesize('伺服器文字', { voice_id: 'client-override', model: 'client-model' });
  assert.equal(calls[0].url, 'https://api.minimax.test/v1/t2a_v2');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer minimax-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'speech-02-hd', text: '伺服器文字', stream: false, output_format: 'hex', language_boost: 'Chinese,Yue',
    voice_setting: { voice_id: 'Cantonese_KindLady', speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
  });
  assert.equal(result.buffer.toString('hex'), '49443304');

  for (const payload of [
    { base_resp: { status_code: 1 }, data: { status: 2, audio: '49443304' } },
    { base_resp: { status_code: 0 }, data: { status: 1, audio: '49443304' } },
    { base_resp: { status_code: 0 }, data: { status: 2, audio: 'abc' } },
    { base_resp: { status_code: 0 }, data: { status: 2, audio: '00000000' } },
    { base_resp: { status_code: 0 }, data: { status: 2, audio: '49443304' }, extra_info: { audio_size: 99 } },
  ]) {
    const invalid = createTtsProvider({
      config,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    await assert.rejects(invalid.synthesize('文字'), { code: 'VOICE_PROVIDER_INVALID_RESPONSE', retryable: false });
  }
});

test('Azure and MiniMax TTS normalize auth, fixed, transient, malformed, and deadline outcomes with zero retry', async () => {
  const { createTtsProvider } = await import('../src/providers/tts.js');
  const providerConfigs = [
    { provider: 'azure', settings: { apiKey: 'fake-azure', region: 'eastasia' } },
    { provider: 'minimax', settings: { apiKey: 'fake-minimax', baseUrl: 'https://api.minimax.test', model: 'speech-02-hd', voice: 'Cantonese_KindLady' } },
  ];
  const cases = [
    { status: 401, contentType: 'text/plain', body: 'private', code: 'VOICE_PROVIDER_MISCONFIGURED', httpStatus: 503, retryable: false },
    { status: 400, contentType: 'text/plain', body: 'private', code: 'VOICE_SYNTHESIS_REJECTED', httpStatus: 502, retryable: false },
    { status: 408, contentType: 'text/plain', body: 'private', code: 'VOICE_SYNTHESIS_FAILED', httpStatus: 502, retryable: true },
    { status: 429, contentType: 'text/plain', body: 'private', code: 'VOICE_SYNTHESIS_FAILED', httpStatus: 502, retryable: true },
    { status: 503, contentType: 'text/plain', body: 'private', code: 'VOICE_SYNTHESIS_FAILED', httpStatus: 502, retryable: true },
    { status: 200, contentType: 'text/plain', body: 'not-a-provider-payload', code: 'VOICE_PROVIDER_INVALID_RESPONSE', httpStatus: 502, retryable: false },
    { status: 'network', code: 'VOICE_SYNTHESIS_FAILED', httpStatus: 502, retryable: true },
  ];
  for (const config of providerConfigs) {
    for (const entry of cases) {
      let calls = 0;
      const provider = createTtsProvider({
        config,
        fetchImpl: async () => {
          calls += 1;
          if (entry.status === 'network') throw new Error('fake transport failure');
          return new Response(entry.body, { status: entry.status, headers: { 'Content-Type': entry.contentType } });
        },
      });
      await assert.rejects(provider.synthesize('伺服器文字'), (error) => (
        error.code === entry.code && error.httpStatus === entry.httpStatus && error.retryable === entry.retryable
      ), `${config.provider} ${entry.status}`);
      assert.equal(calls, 1, `${config.provider} ${entry.status} has no adapter retry`);
    }
  }

  const oversizedResponses = [
    {
      config: providerConfigs[0],
      response: () => new Response(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4 * 1024 * 1024)]), {
        status: 200, headers: { 'Content-Type': 'audio/mpeg' },
      }),
    },
    {
      config: providerConfigs[1],
      response: () => new Response(`{"padding":"${'x'.repeat(9 * 1024 * 1024)}"}`, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    },
  ];
  for (const entry of oversizedResponses) {
    let calls = 0;
    const provider = createTtsProvider({
      config: entry.config,
      fetchImpl: async () => { calls += 1; return entry.response(); },
    });
    await assert.rejects(provider.synthesize('伺服器文字'), {
      code: 'VOICE_PROVIDER_INVALID_RESPONSE', httpStatus: 502, retryable: false,
    });
    assert.equal(calls, 1, `${entry.config.provider} oversized response has no adapter retry`);
  }

  let deadlineCalls = 0;
  const deadlineProvider = createTtsProvider({
    config: providerConfigs[0],
    totalDeadlineMs: 10,
    fetchImpl: async (url, { signal }) => {
      void url;
      deadlineCalls += 1;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await assert.rejects(deadlineProvider.synthesize('逾時'), (error) => (
    error.code === 'VOICE_PROVIDER_TIMEOUT' && error.httpStatus === 504 && error.retryable === true
  ));
  assert.equal(deadlineCalls, 1);
});

test('voice config is Azure-only for ASR, validates regions, and keeps all provider settings private', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'test', V1_ASR_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'secret', AZURE_SPEECH_REGION: 'eastasia.example.com',
  }), /region/i);
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_ASR_PROVIDER: 'minimax', MINIMAX_ASR_ENABLED: 'true', MINIMAX_API_KEY: 'private-minimax',
    MINIMAX_ASR_ENDPOINT: 'https://asr.example.test', MINIMAX_ASR_MODEL: 'legacy-asr',
    V1_TTS_PROVIDER: 'minimax', MINIMAX_BASE_URL: 'https://api.minimax.test',
    MINIMAX_TTS_MODEL: 'speech-02-hd', MINIMAX_TTS_VOICE: 'Cantonese_KindLady',
  });
  assert.equal(config.asr.available, false);
  assert.equal(config.tts.available, true);
  assert.equal(config.publicStatus.voiceInputPreview, false);
  assert.equal(config.publicStatus.voiceOutputPreview, true);
  assert.equal(JSON.stringify(config.publicStatus).includes('private-minimax'), false);
  assert.equal(JSON.stringify(config.publicStatus).includes('api.minimax.test'), false);

  const identityMedia = loadConfig({
    NODE_ENV: 'test',
    V1_MEDIA_DRIVER: 'azure-blob',
    V1_AZURE_BLOB_ACCOUNT_URL: 'https://privateaccount.blob.core.windows.net/',
  });
  assert.equal(identityMedia.mediaAuthMode, 'managed-identity');
  assert.equal(identityMedia.mediaConnectionString, undefined);
  assert.equal(identityMedia.mediaAccountUrl, 'https://privateaccount.blob.core.windows.net/');
  assert.throws(() => loadConfig({
    NODE_ENV: 'test',
    V1_AZURE_STORAGE_CONNECTION_STRING: 'fake-connection-mode',
    V1_AZURE_BLOB_ACCOUNT_URL: 'https://privateaccount.blob.core.windows.net/',
  }), /exactly one/i);
});

test('voice release evidence is artifact/config/commit bound and expires dynamically after startup', async (t) => {
  const { finalizeEvidenceRecord, providerConfigDigest } = await import('../src/services/voice-evidence.js');
  const {
    finalizeReleaseEvidenceRecord,
    gcsIdentitySha256,
    LLM_SMOKE_CONTRACT_VERSION,
    llmProviderConfigDigest,
    postgresIdentitySha256,
  } = await import('../src/services/release-evidence.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-speech-evidence-'));
  const asrPath = join(directory, 'asr.json');
  const ttsPath = join(directory, 'tts.json');
  const iosPath = join(directory, 'ios.json');
  const inventoryPath = join(directory, 'legacy-inventory.json');
  const dependencyPath = join(directory, 'dependency-acceptance.json');
  const llmPath = join(directory, 'llm-smoke.json');
  const commitSha = 'd'.repeat(40);
  const occurredAt = '2026-08-25T00:00:00.000Z';
  const databaseUrl = 'postgres://v1.example.test/v1';
  const gcsProjectId = 'hkbuddy-prod-v1-20260826';
  const gcsBucket = 'hkbuddy-prod-v1-20260826-media';
  const postgresResourceId = '/subscriptions/new/resourceGroups/v1/providers/Microsoft.DBforPostgreSQL/flexibleServers/v1';
  const gcsResourceId = '//storage.googleapis.com/projects/_/buckets/hkbuddy-prod-v1-20260826-media';
  const postgresIdentity = postgresIdentitySha256(databaseUrl);
  const gcsIdentity = gcsIdentitySha256({ projectId: gcsProjectId, bucket: gcsBucket });
  const inventoryRecord = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha,
    legacyApplicationIds: ['hkbuddy-pilot-0630'],
    legacyOrigins: ['https://hkbuddy-pilot-0630.azurewebsites.net'],
    postgresResources: [],
    blobResources: [],
    declaresNoLegacyPostgres: true,
    declaresNoLegacyBlob: true,
    reviewedAt: occurredAt,
    result: true,
  });
  const dependencyRecord = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha,
    legacyInventoryDigest: inventoryRecord.artifactSha256,
    postgresResourceId,
    postgresIdentitySha256: postgresIdentity,
    gcsResourceId,
    gcsIdentitySha256: gcsIdentity,
    schema: 'v1_accept_11111111111141118111111111111111',
    gcsPrefix: 'v1-accept/11111111-1111-4111-8111-111111111111/',
    checks: [
      { name: 'postgres-migration-health', status: 'pass', latencyMs: 1 },
      { name: 'postgres-concurrency-recovery', status: 'pass', latencyMs: 2 },
      { name: 'postgres-integrity-events', status: 'pass', latencyMs: 3 },
      { name: 'postgres-rate-window-fencing', status: 'pass', latencyMs: 4 },
      { name: 'gcs-private-full-range-head', status: 'pass', latencyMs: 5 },
      { name: 'postgres-media-fencing', status: 'pass', latencyMs: 6 },
    ],
    schemaAbsent: true,
    gcsPrefixObjectCount: 0,
    result: true,
    occurredAt,
  });
  const llmConfig = {
    provider: 'hkbu',
    credentialVersion: 'llm-rotation-2026-08',
    timeoutMs: 12_000,
    settings: {
      apiKey: 'llm-secret',
      baseUrl: 'https://llm.example.test',
      model: 'model',
      apiVersion: 'v1',
    },
  };
  const llmRecord = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha,
    capability: 'llm',
    provider: llmConfig.provider,
    contractVersion: LLM_SMOKE_CONTRACT_VERSION,
    providerConfigDigest: llmProviderConfigDigest(llmConfig),
    occurredAt,
    result: 'pass',
    httpClass: '2xx',
    normalizedSuccess: true,
    requestCount: 1,
    latencyMs: 100,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  });
  await writeFile(inventoryPath, JSON.stringify(inventoryRecord));
  await writeFile(dependencyPath, JSON.stringify(dependencyRecord));
  await writeFile(llmPath, JSON.stringify(llmRecord));
  const projectNumber = '123456789012';
  const baseEnvironment = {
    NODE_ENV: 'production',
    V1_PUBLIC_ORIGIN: `https://hkbuddy-api-${projectNumber}.asia-east2.run.app`,
    V1_CANDIDATE_ORIGIN: `https://candidate-${commitSha.slice(0, 12)}---hkbuddy-api-${projectNumber}.asia-east2.run.app`,
    V1_RUNTIME_SERVICE_ACCOUNT: 'hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com',
    V1_SESSION_SECRET: 's'.repeat(32),
    V1_TRUST_PROXY_HOPS: '1', V1_STORE_DRIVER: 'postgres', V1_DATABASE_URL: databaseUrl,
    V1_POSTGRES_RESOURCE_ID: postgresResourceId,
    V1_MEDIA_DRIVER: 'gcs', V1_GOOGLE_CLOUD_PROJECT: gcsProjectId,
    V1_GCS_BUCKET: gcsBucket, V1_GCS_RESOURCE_ID: gcsResourceId,
    V1_LLM_PROVIDER: 'hkbu', V1_LLM_CREDENTIAL_VERSION: llmConfig.credentialVersion,
    V1_HKBU_API_KEY: llmConfig.settings.apiKey, V1_HKBU_BASE_URL: llmConfig.settings.baseUrl,
    V1_HKBU_MODEL: llmConfig.settings.model, V1_HKBU_API_VERSION: llmConfig.settings.apiVersion,
    V1_LLM_SMOKE_EVIDENCE_FILE: llmPath, V1_LLM_SMOKE_EVIDENCE_VERSION: llmRecord.artifactSha256,
    V1_INSTANCE_POLICY: 'single', V1_PRIVACY_NOTICE_VERSION: 'notice-v1', V1_PRIVACY_NOTICE_APPROVED: 'true', V1_RETENTION_WORKER_ENABLED: 'true',
    V1_RELEASE_COMMIT_SHA: commitSha,
    V1_LEGACY_RESOURCE_INVENTORY_FILE: inventoryPath,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: inventoryRecord.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
    V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE: dependencyPath,
    V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION: dependencyRecord.artifactSha256,
    V1_ASR_PROVIDER: 'azure', V1_TTS_PROVIDER: 'azure', V1_AZURE_SPEECH_KEY: 'speech-secret', V1_AZURE_SPEECH_REGION: 'eastasia',
    V1_AZURE_SPEECH_CREDENTIAL_VERSION: 'speech-rotation-2026-08',
  };
  const unverified = loadConfig({ ...baseEnvironment, NODE_ENV: 'test' }, { now: () => new Date(occurredAt) });
  const asrRecord = finalizeEvidenceRecord({
    schemaVersion: 1, commitSha, capability: 'asr', provider: 'azure', contractVersion: 'azure-asr-v1',
    providerConfigDigest: providerConfigDigest(unverified.asr, 'asr'), occurredAt, result: 'pass', latencyMs: 120,
    fixtureSha256: 'a'.repeat(64), fixtureDurationMs: 1_000,
  });
  const ttsRecord = finalizeEvidenceRecord({
    schemaVersion: 1, commitSha, capability: 'tts', provider: 'azure', contractVersion: 'azure-tts-v1',
    providerConfigDigest: providerConfigDigest(unverified.tts, 'tts'), occurredAt, result: 'pass', latencyMs: 100,
  });
  const iosRecord = finalizeEvidenceRecord({
    schemaVersion: 1, commitSha, capability: 'ios-voice', normalizerContractVersion: 'canonical-wav-v1',
    deviceModelClass: 'real-iphone', iosVersion: '19.0', safariVersion: '19.0', captureMimeType: 'audio/mp4',
    fixtureSha256: 'b'.repeat(64), fixtureDurationMs: 55_000,
    assertions: {
      normalizedCanonicalWav: true, autoStop55Seconds: true, permissionCleanup: true, cancelCleanup: true,
      oneIdempotentUpload: true, editableTranscript: true, textFallback: true, noRawContainerUpload: true,
    },
    occurredAt, result: 'pass',
  });
  await writeFile(asrPath, JSON.stringify(asrRecord));
  await writeFile(ttsPath, JSON.stringify(ttsRecord));
  await writeFile(iosPath, JSON.stringify(iosRecord));
  t.after(() => undefined);

  const verified = loadConfig({
    ...baseEnvironment,
    V1_ASR_SMOKE_EVIDENCE_FILE: asrPath, V1_ASR_SMOKE_EVIDENCE_VERSION: asrRecord.artifactSha256,
    V1_TTS_SMOKE_EVIDENCE_FILE: ttsPath, V1_TTS_SMOKE_EVIDENCE_VERSION: ttsRecord.artifactSha256,
    V1_IOS_VOICE_ACCEPTANCE_FILE: iosPath, V1_IOS_VOICE_ACCEPTANCE_VERSION: iosRecord.artifactSha256,
  }, { now: () => new Date(occurredAt) });
  assert.equal(verified.publicStatus.voiceInput, true);
  assert.equal(verified.publicStatus.voiceOutput, true);
  assert.equal(verified.publicStatus.asrEvidenceVersion, asrRecord.artifactSha256);
  assert.equal(verified.publicStatus.ttsEvidenceVersion, ttsRecord.artifactSha256);
  const expired = verified.getPublicStatus(new Date('2026-09-25T00:00:01.000Z'));
  assert.equal(expired.voiceInput, false);
  assert.equal(expired.voiceOutput, false);

  const tampered = JSON.parse(await readFile(ttsPath, 'utf8'));
  tampered.latencyMs = 101;
  await writeFile(ttsPath, JSON.stringify(tampered));
  const rejected = loadConfig({
    ...baseEnvironment,
    V1_TTS_SMOKE_EVIDENCE_FILE: ttsPath, V1_TTS_SMOKE_EVIDENCE_VERSION: ttsRecord.artifactSha256,
  }, { now: () => new Date(occurredAt) });
  assert.equal(rejected.publicStatus.voiceOutput, false);
});

test('speech evidence requires exact ASR fixture facts and keeps TTS free of ASR fixture fields', async () => {
  const { finalizeEvidenceRecord, validateSpeechEvidence } = await import('../src/services/voice-evidence.js');
  const commitSha = '9'.repeat(40);
  const configDigest = '8'.repeat(64);
  const now = new Date('2026-08-25T00:00:00.000Z');
  const base = {
    schemaVersion: 1,
    commitSha,
    provider: 'azure',
    providerConfigDigest: configDigest,
    occurredAt: now.toISOString(),
    result: 'pass',
    latencyMs: 10,
  };
  const validate = (record, capability, contractVersion) => validateSpeechEvidence(record, {
    expectedVersion: record.artifactSha256,
    commitSha,
    capability,
    provider: 'azure',
    contractVersion,
    configDigest,
    now,
  });
  const validAsrPayload = {
    ...base,
    capability: 'asr',
    contractVersion: 'azure-asr-v1',
    fixtureSha256: '7'.repeat(64),
    fixtureDurationMs: 1_000,
  };
  assert.equal(validate(finalizeEvidenceRecord(validAsrPayload), 'asr', 'azure-asr-v1'), true);

  const invalidAsrMutations = [
    (value) => { delete value.fixtureSha256; },
    (value) => { value.fixtureSha256 = '7'.repeat(63); },
    (value) => { delete value.fixtureDurationMs; },
    (value) => { value.fixtureDurationMs = 0; },
    (value) => { value.fixtureDurationMs = -1; },
    (value) => { value.fixtureDurationMs = Number.POSITIVE_INFINITY; },
    (value) => { value.fixtureDurationMs = '1000'; },
  ];
  for (const mutate of invalidAsrMutations) {
    const payload = { ...validAsrPayload };
    mutate(payload);
    const record = finalizeEvidenceRecord(payload);
    assert.equal(validate(record, 'asr', 'azure-asr-v1'), false);
  }

  const ttsPayload = { ...base, capability: 'tts', contractVersion: 'azure-tts-v1' };
  assert.equal(validate(finalizeEvidenceRecord(ttsPayload), 'tts', 'azure-tts-v1'), true);
  assert.equal(validate(finalizeEvidenceRecord({
    ...ttsPayload,
    fixtureSha256: '7'.repeat(64),
    fixtureDurationMs: 1_000,
  }), 'tts', 'azure-tts-v1'), false);
});

test('voice evidence rejects unknown top-level and assertion fields', async () => {
  const {
    canonicalJson,
    finalizeEvidenceRecord,
    validateIosVoiceEvidence,
    validateSpeechEvidence,
  } = await import('../src/services/voice-evidence.js');
  const commitSha = '9'.repeat(40);
  const configDigest = '8'.repeat(64);
  const now = new Date('2026-08-25T00:00:00.000Z');
  const speechPayload = {
    schemaVersion: 1,
    commitSha,
    capability: 'tts',
    provider: 'azure',
    contractVersion: 'azure-tts-v1',
    providerConfigDigest: configDigest,
    occurredAt: now.toISOString(),
    result: 'pass',
    latencyMs: 10,
  };
  const validateSpeech = (payload) => {
    const record = finalizeEvidenceRecord(payload);
    return validateSpeechEvidence(record, {
      expectedVersion: record.artifactSha256,
      commitSha,
      capability: 'tts',
      provider: 'azure',
      contractVersion: 'azure-tts-v1',
      configDigest,
      now,
    });
  };
  assert.equal(validateSpeech(speechPayload), true);
  assert.equal(validateSpeech({ ...speechPayload, privateUrl: 'https://private.example.test/object' }), false);
  assert.equal(validateSpeech({ ...speechPayload, transcript: 'must-not-be-accepted' }), false);

  const assertions = {
    normalizedCanonicalWav: true,
    autoStop55Seconds: true,
    permissionCleanup: true,
    cancelCleanup: true,
    oneIdempotentUpload: true,
    editableTranscript: true,
    textFallback: true,
    noRawContainerUpload: true,
  };
  const iosPayload = {
    schemaVersion: 1,
    commitSha,
    capability: 'ios-voice',
    normalizerContractVersion: 'canonical-wav-v1',
    deviceModelClass: 'real-iphone',
    iosVersion: '19.0',
    safariVersion: '19.0',
    captureMimeType: 'audio/mp4',
    fixtureSha256: '7'.repeat(64),
    fixtureDurationMs: 1_000,
    assertions,
    occurredAt: now.toISOString(),
    result: 'pass',
  };
  const validateIos = (payload) => {
    const record = finalizeEvidenceRecord(payload);
    return validateIosVoiceEvidence(record, {
      expectedVersion: record.artifactSha256,
      commitSha,
      normalizerContractVersion: 'canonical-wav-v1',
      now,
    });
  };
  assert.equal(validateIos(iosPayload), false);

  const verifiedStepIds = [
    'permission-prompt-granted', 'recording-auto-stopped-55s',
    'permission-tracks-stopped', 'cancel-stops-tracks',
    'single-idempotent-upload', 'transcript-editable-before-send',
    'text-fallback-after-denial', 'raw-container-not-uploaded',
  ];
  const binding = {
    deviceRunId: '88888888-8888-4888-8888-888888888888',
    normalizerContractVersion: 'canonical-wav-v1',
    rawCaptureSha256: '1'.repeat(64), rawCaptureByteLength: 4_096,
    fixtureSha256: '2'.repeat(64), fixtureByteLength: 32_044, fixtureDurationMs: 1_000,
    normalizationStepsSha256: '3'.repeat(64), normalizationStepsByteLength: 2_048,
    normalizerPackage: '@ffmpeg-installer/ffmpeg@1.1.0',
    normalizerPlatform: 'win32-x64',
    normalizerBinarySha256: 'c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e',
    normalizerVersion: 'ffmpeg version N-92722-gf22fcd4483 Copyright (c) 2000-2018 the FFmpeg developers',
    normalizerArguments: [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file', '-i', 'capture.mp4',
      '-map', '0:a:0', '-map_metadata', '-1', '-vn',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-flags:a', '+bitexact', '-fflags', '+bitexact', '-f', 'wav', 'derived.wav',
    ],
    normalizerExitCode: 0,
  };
  const iosV4Payload = {
    schemaVersion: 4,
    commitSha,
    capability: 'ios-voice',
    normalizerContractVersion: binding.normalizerContractVersion,
    reportSource: 'real-iphone-safari-manual-v2',
    deviceReportSha256: '4'.repeat(64), deviceReportByteLength: 1_024,
    deviceRunId: binding.deviceRunId,
    deviceModelIdentifier: 'iPhone16,1',
    iosVersion: '19.0', safariVersion: '19.0', captureMimeType: 'audio/mp4',
    deviceObservedAt: now.toISOString(), rawCaptureFormat: 'iso-bmff-audio-v1',
    rawCaptureSha256: binding.rawCaptureSha256, rawCaptureByteLength: binding.rawCaptureByteLength,
    fixtureSha256: binding.fixtureSha256, fixtureDurationMs: binding.fixtureDurationMs,
    fixtureByteLength: binding.fixtureByteLength,
    normalizationStepsSha256: binding.normalizationStepsSha256,
    normalizationStepsByteLength: binding.normalizationStepsByteLength,
    normalizerPackage: binding.normalizerPackage,
    normalizerPlatform: binding.normalizerPlatform,
    normalizerBinarySha256: binding.normalizerBinarySha256,
    normalizerVersion: binding.normalizerVersion,
    normalizerArguments: binding.normalizerArguments,
    normalizerExitCode: binding.normalizerExitCode,
    normalizationBindingSha256: createHash('sha256').update(canonicalJson(binding)).digest('hex'),
    verifiedStepIds,
    occurredAt: now.toISOString(),
    result: 'pass',
  };
  assert.equal(validateIos(iosV4Payload), true);
  assert.equal(validateIos({ ...iosV4Payload, secret: 'must-not-be-accepted' }), false);
  assert.equal(validateIos({ ...iosV4Payload, rawCaptureSha256: '5'.repeat(64) }), false);
  assert.equal(validateIos({ ...iosV4Payload, normalizerBinarySha256: '5'.repeat(64) }), false);
  assert.equal(validateIos({ ...iosV4Payload, normalizerVersion: 'ffmpeg version forged' }), false);
  assert.equal(validateIos({ ...iosV4Payload, verifiedStepIds: [...verifiedStepIds].reverse() }), false);
});

test('voice provider smoke is inert without exact confirmations and invokes only the selected fake capability once', async () => {
  const { runVoiceProviderSmoke } = await import('../scripts/voice-provider-smoke.js');
  const environment = {
    NODE_ENV: 'test', V1_RELEASE_COMMIT_SHA: 'e'.repeat(40),
    V1_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'smoke-secret', AZURE_SPEECH_REGION: 'eastasia',
    V1_AZURE_SPEECH_CREDENTIAL_VERSION: 'rotation-v1',
  };
  let ttsCalls = 0;
  let asrCalls = 0;
  let written = null;
  const dependencies = {
    createTts: () => ({ synthesize: async () => { ttsCalls += 1; return { buffer: Buffer.from([0x49, 0x44, 0x33]), provider: 'azure', latencyMs: 12 }; } }),
    createAsr: () => ({ transcribe: async () => { asrCalls += 1; return { transcript: 'must-not-print', provider: 'azure', latencyMs: 12 }; } }),
    inspectGit: async () => ({ commitSha: 'e'.repeat(40), clean: true }),
    writeEvidence: async (record) => { written = record; },
    writeOutput: () => undefined,
  };
  assert.equal((await runVoiceProviderSmoke({ argv: ['--capability', 'tts'], environment, ...dependencies })).exitCode, 2);
  assert.equal((await runVoiceProviderSmoke({ argv: ['--capability', 'tts', '--confirm-real-voice-provider', '--extra'], environment, ...dependencies })).exitCode, 2);
  assert.equal(ttsCalls, 0);
  assert.equal(asrCalls, 0);

  const success = await runVoiceProviderSmoke({
    argv: ['--capability', 'tts', '--confirm-real-voice-provider'], environment, ...dependencies,
  });
  assert.equal(success.exitCode, 0);
  assert.equal(ttsCalls, 1);
  assert.equal(asrCalls, 0);
  assert.equal(written.capability, 'tts');
  assert.equal(written.result, 'pass');
  assert.match(written.artifactSha256, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify({ success, written });
  assert.equal(serialized.includes('smoke-secret'), false);
  assert.equal(serialized.includes('must-not-print'), false);
});

test('voice provider smoke rejects dirty or moving Git state before publishing evidence', async (t) => {
  const { runVoiceProviderSmoke } = await import('../scripts/voice-provider-smoke.js');
  const commitSha = 'e'.repeat(40);
  const environment = {
    NODE_ENV: 'test', V1_RELEASE_COMMIT_SHA: commitSha,
    V1_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'smoke-secret', AZURE_SPEECH_REGION: 'eastasia',
    V1_AZURE_SPEECH_CREDENTIAL_VERSION: 'rotation-v1',
  };
  const cases = [
    ['dirty before request', [{ commitSha, clean: false }], 0, 2],
    ['wrong commit before request', [{ commitSha: 'd'.repeat(40), clean: true }], 0, 2],
    ['dirty after request', [{ commitSha, clean: true }, { commitSha, clean: false }], 1, 1],
    ['commit moved after request', [{ commitSha, clean: true }, { commitSha: 'd'.repeat(40), clean: true }], 1, 1],
  ];

  for (const [name, states, expectedProviderCalls, expectedExitCode] of cases) {
    await t.test(name, async () => {
      let providerCalls = 0;
      let writes = 0;
      const output = [];
      const result = await runVoiceProviderSmoke({
        argv: ['--capability', 'tts', '--confirm-real-voice-provider'],
        environment,
        inspectGit: async () => states.shift(),
        createTts: () => ({
          synthesize: async () => {
            providerCalls += 1;
            return { buffer: Buffer.from('ID3fixture'), provider: 'azure', latencyMs: 12 };
          },
        }),
        writeEvidence: async () => { writes += 1; },
        writeOutput: (line) => output.push(line),
      });

      assert.equal(result.exitCode, expectedExitCode);
      assert.equal(providerCalls, expectedProviderCalls);
      assert.equal(writes, 0);
      assert.equal(JSON.parse(output.at(-1)).errorCode, 'VOICE_RELEASE_GIT_STATE_INVALID');
    });
  }
});

test('media Azure Blob adapter requires a private container and mediates bounded upload/range/delete with no URL', async () => {
  const { AzureBlobMediaStore } = await import('../src/stores/azure-blob-media-store.js');
  const blobs = new Map();
  const metadata = new Map();
  let listOptions = null;
  const containerClient = {
    getProperties: async () => ({ etag: 'safe' }),
    getAccessPolicy: async () => ({ blobPublicAccess: undefined }),
    getBlockBlobClient(storageKey) {
      return {
        uploadStream: async (readable, bufferSize, concurrency, options) => {
          void bufferSize;
          void concurrency;
          const bytes = await readableBuffer(readable);
          blobs.set(storageKey, bytes);
          metadata.set(storageKey, { options });
        },
        setMetadata: async (value) => metadata.set(storageKey, { ...metadata.get(storageKey), value }),
        getProperties: async () => {
          if (!blobs.has(storageKey)) { const error = new Error('missing'); error.statusCode = 404; throw error; }
          return { contentLength: blobs.get(storageKey).length };
        },
        download: async (offset = 0, count) => {
          const bytes = blobs.get(storageKey);
          if (!bytes) { const error = new Error('missing'); error.statusCode = 404; throw error; }
          const selected = bytes.subarray(offset, count === undefined ? undefined : offset + count);
          return { readableStreamBody: Readable.from([selected]), contentLength: selected.length };
        },
        deleteIfExists: async () => ({ succeeded: blobs.delete(storageKey) }),
      };
    },
    async *listBlobsFlat(options) {
      listOptions = options;
      const { prefix } = options;
      for (const [name, value] of [...blobs.entries()].sort()) {
        if (name.startsWith(prefix)) {
          yield {
            name,
            properties: {
              contentLength: value.length,
              lastModified: new Date('2026-08-24T00:00:00.000Z'),
              etag: '"fake-etag-1"',
            },
          };
        }
      }
    },
  };
  const mediaStore = new AzureBlobMediaStore({ containerClient, containerName: 'private-v1-media' });
  await mediaStore.init();
  const storageKey = mediaStore.createAttemptKey({ kind: 'tts' });
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
  const stored = await mediaStore.putAttempt({ storageKey, readable: Readable.from([bytes]), maxBytes: 10, contentType: 'audio/mpeg' });
  assert.equal(stored.byteLength, 4);
  assert.equal(metadata.get(storageKey).options.blobHTTPHeaders.blobContentType, 'audio/mpeg');
  assert.deepEqual(metadata.get(storageKey).value, { sha256: stored.sha256, byte_length: '4' });
  const opened = await mediaStore.open({ storageKey, start: 1, end: 2 });
  assert.deepEqual(await readableBuffer(opened.readable), bytes.subarray(1, 3));
  assert.equal(Object.hasOwn(opened, 'url'), false);
  const listController = new AbortController();
  const listed = await mediaStore.listAttemptKeys({
    prefix: 'attempts/tts/', before: new Date('2026-08-25T00:00:00.000Z'), limit: 10,
    signal: listController.signal,
  });
  assert.deepEqual(listed.keys.map((entry) => entry.storageKey), [storageKey]);
  assert.equal(listed.keys[0].version, '"fake-etag-1"');
  assert.equal(listOptions.abortSignal, listController.signal);
  assert.deepEqual(await mediaStore.delete({ storageKey }), { deleted: true, notFound: false });
  assert.deepEqual(await mediaStore.delete({ storageKey }), { deleted: false, notFound: true });

  const publicContainer = { ...containerClient, getAccessPolicy: async () => ({ blobPublicAccess: 'blob' }) };
  await assert.rejects(new AzureBlobMediaStore({ containerClient: publicContainer, containerName: 'unsafe' }).init(), { code: 'MEDIA_CONTAINER_NOT_PRIVATE' });
  assert.doesNotThrow(() => new AzureBlobMediaStore({
    containerName: 'private-v1-media',
    accountUrl: 'https://privateaccount.blob.core.windows.net/',
    credential: { getToken: async () => ({ token: 'fake-only', expiresOnTimestamp: Date.now() + 60_000 }) },
  }));
});

test('media cleanup worker durably completes not-found/deletes, retries failures, and never sweeps a live key', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { LocalMediaStore } = await import('../src/stores/local-media-store.js');
  const { store } = await createStore(t, 'hb-v1-cleanup-store-');
  const rootDirectory = await mkdtemp(join(tmpdir(), 'hb-v1-cleanup-media-'));
  const mediaStore = new LocalMediaStore({ rootDirectory });
  await mediaStore.init();
  t.after(() => mediaStore.close());
  const now = () => new Date('2026-08-25T02:00:00.000Z');
  const cleanup = createMediaCleanupService({ store, mediaStore, now, retryDelayMs: 1_000 });

  const orphanKey = mediaStore.createAttemptKey({ kind: 'voice' });
  await mediaStore.putAttempt({ storageKey: orphanKey, readable: Readable.from([Buffer.from('orphan')]), maxBytes: 10, contentType: 'audio/wav' });
  await store.enqueueMediaDeletion({ storageKey: orphanKey, reason: 'orphan', notBefore: now(), now: now() });
  assert.equal((await cleanup.drainOnce()).completed, true);
  await assert.rejects(mediaStore.open({ storageKey: orphanKey }), { code: 'MEDIA_NOT_FOUND' });

  const missingKey = mediaStore.createAttemptKey({ kind: 'tts' });
  await store.enqueueMediaDeletion({ storageKey: missingKey, reason: 'already-missing', notBefore: now(), now: now() });
  assert.equal((await cleanup.drainOnce()).completed, true);

  const owner = await store.createOrResumeSession({ tokenHash: 'cleanup-live-owner', now: now() });
  const liveKey = mediaStore.createAttemptKey({ kind: 'voice' });
  await mediaStore.putAttempt({ storageKey: liveKey, readable: Readable.from([Buffer.from('live')]), maxBytes: 10, contentType: 'audio/wav' });
  await store.claimVoiceUploadWithRateLimits({
    sessionId: owner.session.id, clientUploadId: 'aaaaaaaa-0000-4000-8000-000000000000',
    requestSha256: 'f'.repeat(64), mimeType: 'audio/wav', rateLimits: [],
    leaseToken: 'cleanup-live-token', attemptStorageKey: liveKey,
    leaseExpiresAt: '2026-08-25T02:00:20.000Z', attemptDeadlineAt: '2026-08-25T02:01:00.000Z', now: now(),
  });
  const swept = await cleanup.sweepAttemptPrefix({ prefix: 'attempts/voice/', before: new Date('2026-08-25T03:00:00.000Z'), limit: 10 });
  assert.equal(swept.enqueued, 0);
  assert.deepEqual(await readableBuffer((await mediaStore.open({ storageKey: liveKey })).readable), Buffer.from('live'));
  await cleanup.stop();
});

test('crashed voice and TTS attempt keys stop being live after hard deadline plus cleanup grace', async (t) => {
  const { store } = await createStore(t, 'hb-v1-expired-attempt-liveness-');
  const owner = await store.createOrResumeSession({ tokenHash: 'expired-attempt-owner', now: '2026-08-25T03:00:00.000Z' });
  const assistant = await createDeliveredAssistant(store, owner.session, owner.conversation);
  const voiceKey = 'attempts/voice/11111111-1111-4111-8111-111111111111';
  const ttsKey = 'attempts/tts/22222222-2222-4222-8222-222222222222';
  const assetKey = 'attempts/voice/33333333-3333-4333-8333-333333333333';
  await store.claimVoiceUploadWithRateLimits({
    sessionId: owner.session.id,
    clientUploadId: '11111111-0000-4000-8000-000000000000',
    requestSha256: '1'.repeat(64),
    mimeType: 'audio/wav',
    leaseToken: 'voice-expired-lease',
    attemptStorageKey: voiceKey,
    leaseExpiresAt: '2026-08-25T03:00:15.000Z',
    attemptDeadlineAt: '2026-08-25T03:01:00.000Z',
    now: '2026-08-25T03:00:00.000Z',
  });
  await store.claimAssistantAudioWithRateLimits({
    sessionId: owner.session.id,
    messageId: assistant.id,
    kind: 'assistant_voice',
    leaseToken: 'tts-expired-lease',
    attemptStorageKey: ttsKey,
    configVersion: 'tts-test-v1',
    leaseExpiresAt: '2026-08-25T03:00:15.000Z',
    attemptDeadlineAt: '2026-08-25T03:00:30.000Z',
    now: '2026-08-25T03:00:00.000Z',
  });
  const ready = await store.claimVoiceUploadWithRateLimits({
    sessionId: owner.session.id,
    clientUploadId: '33333333-0000-4000-8000-000000000000',
    requestSha256: '3'.repeat(64),
    mimeType: 'audio/wav',
    leaseToken: 'voice-ready-lease',
    attemptStorageKey: assetKey,
    leaseExpiresAt: '2026-08-25T03:00:15.000Z',
    attemptDeadlineAt: '2026-08-25T03:01:00.000Z',
    now: '2026-08-25T03:00:00.000Z',
  });
  await store.setVoiceUploadTranscribing({ uploadId: ready.upload.id, leaseToken: 'voice-ready-lease', now: '2026-08-25T03:00:01.000Z' });
  await store.completeVoiceUpload({
    uploadId: ready.upload.id,
    leaseToken: 'voice-ready-lease',
    mediaAsset: { storageKey: assetKey, mimeType: 'audio/wav', byteLength: 44, durationMs: 0, sha256: '3'.repeat(64) },
    transcript: 'current asset',
    now: '2026-08-25T03:00:02.000Z',
  });

  assert.equal(await store.isStorageKeyLive({ storageKey: voiceKey, now: '2026-08-25T03:01:59.999Z' }), true);
  assert.equal(await store.isStorageKeyLive({ storageKey: ttsKey, now: '2026-08-25T03:01:29.999Z' }), true);
  assert.equal(await store.isStorageKeyLive({ storageKey: voiceKey, now: '2026-08-25T03:02:00.001Z' }), false);
  assert.equal(await store.isStorageKeyLive({ storageKey: ttsKey, now: '2026-08-25T03:01:30.001Z' }), false);
  assert.equal(await store.isStorageKeyLive({ storageKey: assetKey, now: '2027-08-25T03:00:00.000Z' }), true);
});

test('scheduled media cleanup bounds and paginates both attempt-prefix sweeps until orphans are deleted', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { store } = await createStore(t, 'hb-v1-scheduled-attempt-sweep-');
  const oldModified = '2026-08-25T03:00:00.000Z';
  const objects = new Map([
    ['attempts/voice/11111111-1111-4111-8111-111111111111', { lastModified: oldModified }],
    ['attempts/voice/22222222-2222-4222-8222-222222222222', { lastModified: oldModified }],
    ['attempts/tts/33333333-3333-4333-8333-333333333333', { lastModified: oldModified }],
  ]);
  const listCalls = [];
  const mediaStore = {
    listAttemptKeys: async ({ prefix, before, limit, cursor }) => {
      listCalls.push({ prefix, before: new Date(before).toISOString(), limit, cursor: cursor ?? null });
      const keys = [...objects.entries()]
        .filter(([storageKey, entry]) => storageKey.startsWith(prefix)
          && (!cursor || storageKey > cursor)
          && new Date(entry.lastModified) < new Date(before))
        .map(([storageKey, entry]) => ({ storageKey, lastModified: entry.lastModified, byteLength: 1 }))
        .sort((left, right) => left.storageKey.localeCompare(right.storageKey))
        .slice(0, limit);
      return { keys, cursor: keys.length === limit ? keys.at(-1).storageKey : null };
    },
    delete: async ({ storageKey }) => {
      const deleted = objects.delete(storageKey);
      return { deleted, notFound: !deleted };
    },
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date('2026-08-25T04:00:00.000Z'),
    pollMs: 5,
    sweepLimit: 1,
    sweepMinimumAgeMs: 120_000,
  });
  t.after(() => cleanup.stop());
  cleanup.start();
  const deadline = Date.now() + 500;
  while (objects.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await cleanup.stop();

  assert.equal(objects.size, 0);
  assert.deepEqual(new Set(listCalls.map((call) => call.prefix)), new Set(['attempts/voice/', 'attempts/tts/']));
  assert.ok(listCalls.every((call) => call.limit === 1));
  assert.ok(listCalls.every((call) => call.before === '2026-08-25T03:58:00.000Z'));
  assert.ok(listCalls.some((call) => call.prefix === 'attempts/voice/'
    && call.cursor === 'attempts/voice/11111111-1111-4111-8111-111111111111'));
});

test('media cleanup stop aborts and releases a never-settling attempt listing', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { store } = await createStore(t, 'hb-v1-cleanup-stop-list-');
  let listingStartedResolve;
  const listingStarted = new Promise((resolve) => { listingStartedResolve = resolve; });
  let releaseListing;
  const stalledListing = new Promise((resolve) => { releaseListing = resolve; });
  let listingSignal = null;
  let listCalls = 0;
  const mediaStore = {
    delete: async () => ({ deleted: false, notFound: true }),
    listAttemptKeys: ({ signal }) => {
      listCalls += 1;
      listingSignal = signal;
      listingStartedResolve();
      return listCalls === 1 ? stalledListing : Promise.resolve({ keys: [], cursor: null });
    },
  };
  const cleanup = createMediaCleanupService({ store, mediaStore, pollMs: 60_000 });
  cleanup.start();
  await settleWithin(listingStarted, 250, 'cleanup never entered its scheduled attempt listing');
  const stopping = cleanup.stop();
  try {
    await settleWithin(stopping, 100, 'cleanup stop waited indefinitely for attempt listing');
  } finally {
    releaseListing({ keys: [], cursor: null });
    await stopping;
  }
  assert.equal(listingSignal.aborted, true);
});

test('media cleanup sweep deadline bounds a provider listing that ignores abort', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { store } = await createStore(t, 'hb-v1-cleanup-list-deadline-');
  let listingStartedResolve;
  const listingStarted = new Promise((resolve) => { listingStartedResolve = resolve; });
  let releaseListing;
  const stalledListing = new Promise((resolve) => { releaseListing = resolve; });
  let listingSignal = null;
  let listCalls = 0;
  const mediaStore = {
    delete: async () => ({ deleted: false, notFound: true }),
    listAttemptKeys: ({ signal }) => {
      listCalls += 1;
      listingSignal = signal;
      listingStartedResolve();
      return listCalls === 1 ? stalledListing : Promise.resolve({ keys: [], cursor: null });
    },
  };
  const cleanup = createMediaCleanupService({ store, mediaStore, sweepDeadlineMs: 10 });
  const cycle = cleanup.runScheduledCycle();
  await settleWithin(listingStarted, 250, 'cleanup never entered its deadline-bound attempt listing');
  let result;
  try {
    result = await settleWithin(cycle, 200, 'cleanup sweep deadline did not release stalled listing');
  } finally {
    releaseListing({ keys: [], cursor: null });
    await cycle;
    await cleanup.stop();
  }
  assert.equal(listingSignal.aborted, true);
  assert.equal(result.sweeps[0].failed, true);
  assert.equal(listCalls, 1, 'an aborted cycle does not start another prefix listing');
});

test('media cleanup sweep deadline bounds a liveness lookup that ignores abort and consumes its late rejection', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { store } = await createStore(t, 'hb-v1-cleanup-live-deadline-');
  const storageKey = 'attempts/voice/66666666-6666-4666-8666-666666666666';
  let livenessStartedResolve;
  const livenessStarted = new Promise((resolve) => { livenessStartedResolve = resolve; });
  let rejectLiveness;
  const stalledLiveness = new Promise((resolve, reject) => {
    void resolve;
    rejectLiveness = reject;
  });
  store.isStorageKeyLive = () => {
    livenessStartedResolve();
    return stalledLiveness;
  };
  let listCalls = 0;
  const mediaStore = {
    delete: async () => ({ deleted: false, notFound: true }),
    listAttemptKeys: async () => {
      listCalls += 1;
      return {
        keys: listCalls === 1
          ? [{ storageKey, lastModified: '2026-08-25T03:00:00.000Z', byteLength: 12, version: 'late-live-read' }]
          : [],
        cursor: null,
      };
    },
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date('2026-08-25T04:00:00.000Z'),
    sweepDeadlineMs: 10,
  });
  const cycle = cleanup.runScheduledCycle();
  await settleWithin(livenessStarted, 250, 'cleanup never entered its deadline-bound liveness lookup');
  let result;
  try {
    result = await settleWithin(cycle, 200, 'cleanup sweep deadline did not release stalled liveness lookup');
  } finally {
    const lateError = new Error('late liveness failure after sweep cancellation');
    lateError.code = 'LATE_LIVENESS_FAILURE';
    rejectLiveness(lateError);
    await cycle;
    await cleanup.stop();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(result.sweeps[0].failed, true);
  assert.equal(result.aborted, true);
  assert.equal(listCalls, 1, 'an aborted liveness lookup does not start another prefix sweep');
});

test('media cleanup stop aborts after liveness and before starting a new durable rearm', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { store } = await createStore(t, 'hb-v1-cleanup-stop-before-rearm-');
  const storageKey = 'attempts/voice/77777777-7777-4777-8777-777777777777';
  let cleanup;
  let stopping;
  let rearmCalls = 0;
  const originalRearm = store.rearmMediaDeletionFromSweep.bind(store);
  store.rearmMediaDeletionFromSweep = async (input) => {
    rearmCalls += 1;
    return originalRearm(input);
  };
  store.isStorageKeyLive = async () => {
    stopping = cleanup.stop();
    return false;
  };
  const mediaStore = {
    delete: async () => ({ deleted: false, notFound: true }),
    listAttemptKeys: async ({ prefix }) => ({
      keys: prefix === 'attempts/voice/'
        ? [{ storageKey, lastModified: '2026-08-25T03:00:00.000Z', byteLength: 13, version: 'stop-before-rearm' }]
        : [],
      cursor: null,
    }),
  };
  cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date('2026-08-25T04:00:00.000Z'),
  });
  const result = await settleWithin(cleanup.runScheduledCycle(), 250, 'cleanup did not stop after liveness cancellation');
  await settleWithin(stopping, 250, 'cleanup stop did not settle after liveness cancellation');
  assert.equal(result.sweeps[0].failed, true);
  assert.equal(result.aborted, true);
  assert.equal(rearmCalls, 0, 'sweep cancellation fences a not-yet-started durable rearm');
});

test('media cleanup stop awaits an already-started durable rearm before shutdown completes', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-stop-durable-rearm-');
  const storageKey = 'attempts/voice/88888888-8888-4888-8888-888888888888';
  let rearmStartedResolve;
  const rearmStarted = new Promise((resolve) => { rearmStartedResolve = resolve; });
  let releaseRearm;
  const rearmGate = new Promise((resolve) => { releaseRearm = resolve; });
  const originalRearm = store.rearmMediaDeletionFromSweep.bind(store);
  store.isStorageKeyLive = async () => false;
  store.rearmMediaDeletionFromSweep = async (input) => {
    rearmStartedResolve();
    await rearmGate;
    return originalRearm(input);
  };
  const mediaStore = {
    delete: async () => ({ deleted: false, notFound: true }),
    listAttemptKeys: async ({ prefix }) => ({
      keys: prefix === 'attempts/voice/'
        ? [{ storageKey, lastModified: '2026-08-25T03:00:00.000Z', byteLength: 14, version: 'durable-rearm' }]
        : [],
      cursor: null,
    }),
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date('2026-08-25T04:00:00.000Z'),
  });
  void cleanup.runScheduledCycle();
  await settleWithin(rearmStarted, 250, 'cleanup never began the durable rearm');
  let stopped = false;
  const stopping = cleanup.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'shutdown awaits the already-started durable rearm');
  releaseRearm();
  await settleWithin(stopping, 250, 'cleanup did not finish after durable rearm persisted');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  const job = persisted.mediaDeletionJobs.find((entry) => entry.storageKey === storageKey);
  assert.equal(job.state, 'pending');
  assert.equal(job.reason, 'orphan-attempt-sweep');
});

test('media cleanup stop does not abort a claimed deletion before durable completion', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-stop-delete-');
  const storageKey = 'attempts/voice/55555555-5555-4555-8555-555555555555';
  const current = new Date('2026-08-25T04:00:00.000Z');
  await store.enqueueMediaDeletion({ storageKey, reason: 'shutdown-delete', notBefore: current, now: current });
  let deletionStartedResolve;
  const deletionStarted = new Promise((resolve) => { deletionStartedResolve = resolve; });
  let releaseDeletion;
  const deletion = new Promise((resolve) => { releaseDeletion = resolve; });
  let deletionSignal = null;
  const mediaStore = {
    delete: ({ signal }) => {
      deletionSignal = signal;
      deletionStartedResolve();
      return deletion;
    },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanup = createMediaCleanupService({ store, mediaStore, now: () => current });
  void cleanup.runScheduledCycle();
  await settleWithin(deletionStarted, 250, 'cleanup never claimed the durable deletion');
  let stopped = false;
  const stopping = cleanup.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'shutdown waits for the claimed deletion outcome');
  assert.equal(deletionSignal.aborted, false, 'sweep cancellation is isolated from deletion lease cancellation');
  releaseDeletion({ deleted: true, notFound: false });
  await settleWithin(stopping, 250, 'cleanup did not persist the claimed deletion outcome');
  await store.close();
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.mediaDeletionJobs.find((job) => job.storageKey === storageKey).state, 'completed');
});

test('media cleanup live-key retry rechecks the durable lease after its liveness lookup', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-live-clock-fence-');
  const storageKey = 'attempts/voice/ffffffff-9999-4999-8999-999999999999';
  const claimedAt = new Date('2026-08-25T03:15:00.000Z');
  let current = claimedAt;
  await store.enqueueMediaDeletion({ storageKey, reason: 'clock-fenced-live-key', notBefore: current, now: current });
  store.isStorageKeyLive = async () => {
    current = new Date(claimedAt.getTime() + 26);
    return true;
  };
  const mediaStore = {
    delete: async () => { throw new Error('a live key must not be deleted'); },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date(current),
    leaseMs: 25,
  });
  const result = await cleanup.drainOnce();
  assert.equal(result.completed, false);
  assert.equal(result.fenced, true);
  const persisted = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(persisted.state, 'deleting');
  assert.equal(persisted.lastErrorCode, null);
});

test('media cleanup completion rechecks the durable lease at the mutation clock boundary', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-complete-clock-fence-');
  const storageKey = 'attempts/voice/dddddddd-9999-4999-8999-999999999999';
  const claimedAt = new Date('2026-08-25T03:30:00.000Z');
  let current = claimedAt;
  await store.enqueueMediaDeletion({ storageKey, reason: 'clock-fenced-complete', notBefore: current, now: current });
  const mediaStore = {
    delete: async () => {
      current = new Date(claimedAt.getTime() + 26);
      return { deleted: true, notFound: false };
    },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date(current),
    leaseMs: 25,
  });
  const result = await cleanup.drainOnce();
  assert.equal(result.completed, false);
  assert.equal(result.fenced, true);
  const persisted = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(persisted.state, 'deleting');
  assert.ok(persisted.leaseToken);
});

test('media cleanup failure rechecks the durable lease before persisting a retry', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-fail-clock-fence-');
  const storageKey = 'attempts/tts/eeeeeeee-9999-4999-8999-999999999999';
  const claimedAt = new Date('2026-08-25T03:45:00.000Z');
  let current = claimedAt;
  await store.enqueueMediaDeletion({ storageKey, reason: 'clock-fenced-failure', notBefore: current, now: current });
  const mediaStore = {
    delete: async () => {
      current = new Date(claimedAt.getTime() + 26);
      const error = new Error('delete failed after the durable lease boundary');
      error.code = 'MEDIA_DELETE_FAILED';
      throw error;
    },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date(current),
    leaseMs: 25,
  });
  const result = await cleanup.drainOnce();
  assert.equal(result.completed, false);
  assert.equal(result.fenced, true);
  const persisted = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(persisted.state, 'deleting');
  assert.equal(persisted.lastErrorCode, null);
});

test('media cleanup stop is lease-bounded when delete ignores abort and leaves the durable job reclaimable', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-stop-stalled-delete-');
  const storageKey = 'attempts/voice/99999999-9999-4999-8999-999999999999';
  let current = new Date('2026-08-25T04:00:00.000Z');
  await store.enqueueMediaDeletion({ storageKey, reason: 'stalled-delete', notBefore: current, now: current });
  let deletionStartedResolve;
  const deletionStarted = new Promise((resolve) => { deletionStartedResolve = resolve; });
  let releaseDeletion;
  const deletion = new Promise((resolve) => { releaseDeletion = resolve; });
  let deletionSignal = null;
  const mediaStore = {
    delete: ({ signal }) => {
      deletionSignal = signal;
      deletionStartedResolve();
      return deletion;
    },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date(current),
    leaseMs: 25,
    pollMs: 60_000,
  });
  t.after(() => cleanup.stop());
  cleanup.start();
  await settleWithin(deletionStarted, 250, 'cleanup never claimed the stalled deletion');
  const stopping = cleanup.stop();
  let stoppedWithinLease = false;
  try {
    await settleWithin(stopping, 300, 'cleanup stop waited forever for a delete adapter that ignored abort');
    stoppedWithinLease = true;
  } finally {
    if (!stoppedWithinLease) {
      releaseDeletion({ deleted: true, notFound: false });
      await stopping;
    }
  }
  assert.equal(deletionSignal.aborted, true, 'the adapter received the expired deletion lease signal');
  const expired = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(expired.state, 'deleting');
  assert.ok(expired.leaseToken, 'the timed-out claim remains durably fenced until its lease expires');

  current = new Date(current.getTime() + 26);
  const reclaimed = await store.claimNextMediaDeletion({
    workerId: 'replacement-cleanup-worker',
    leaseToken: 'replacement-delete-token',
    leaseExpiresAt: new Date(current.getTime() + 25),
    now: current,
  });
  assert.equal(reclaimed.id, expired.id);
  assert.equal(reclaimed.attempt, 2);
  assert.equal(reclaimed.leaseToken, 'replacement-delete-token');

  releaseDeletion({ deleted: true, notFound: false });
  await new Promise((resolve) => setImmediate(resolve));
  const afterLateSuccess = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(afterLateSuccess.state, 'deleting');
  assert.equal(afterLateSuccess.leaseToken, 'replacement-delete-token');
  assert.equal(afterLateSuccess.attempt, 2);
});

test('late rejection from an expired delete lease is observed and cannot fail its replacement claim', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-cleanup-late-delete-reject-');
  const storageKey = 'attempts/tts/aaaaaaaa-9999-4999-8999-999999999999';
  let current = new Date('2026-08-25T04:30:00.000Z');
  await store.enqueueMediaDeletion({ storageKey, reason: 'late-reject-delete', notBefore: current, now: current });
  let deletionStartedResolve;
  const deletionStarted = new Promise((resolve) => { deletionStartedResolve = resolve; });
  let rejectDeletion;
  const deletion = new Promise((resolve, reject) => {
    void resolve;
    rejectDeletion = reject;
  });
  let deletionSignal = null;
  const mediaStore = {
    delete: ({ signal }) => {
      deletionSignal = signal;
      deletionStartedResolve();
      return deletion;
    },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date(current),
    leaseMs: 25,
  });
  const draining = cleanup.drainOnce();
  await settleWithin(deletionStarted, 250, 'cleanup never began the late-reject deletion');
  let boundedResult;
  try {
    boundedResult = await settleWithin(draining, 300, 'cleanup drain waited forever for a late-rejecting delete adapter');
  } finally {
    if (!boundedResult) {
      const cleanupError = new Error('release current implementation after RED');
      cleanupError.code = 'MEDIA_DELETE_FAILED';
      rejectDeletion(cleanupError);
      await draining;
    }
  }
  assert.equal(boundedResult.completed, false);
  assert.equal(boundedResult.leaseExpired, true);
  assert.equal(deletionSignal.aborted, true);

  current = new Date(current.getTime() + 26);
  const reclaimed = await store.claimNextMediaDeletion({
    workerId: 'late-reject-replacement-worker',
    leaseToken: 'late-reject-replacement-token',
    leaseExpiresAt: new Date(current.getTime() + 25),
    now: current,
  });
  assert.equal(reclaimed.attempt, 2);
  const lateError = new Error('provider rejected after its deletion lease expired');
  lateError.code = 'MEDIA_DELETE_FAILED';
  rejectDeletion(lateError);
  await new Promise((resolve) => setImmediate(resolve));
  const persisted = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(persisted.state, 'deleting');
  assert.equal(persisted.leaseToken, 'late-reject-replacement-token');
  assert.equal(persisted.lastErrorCode, null);
});

test('server shutdown aborts a stalled cleanup listing and closes within a bounded window', async (t) => {
  const { startServer } = await import('../src/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-server-cleanup-stop-'));
  let listingStartedResolve;
  const listingStarted = new Promise((resolve) => { listingStartedResolve = resolve; });
  let releaseListing;
  const stalledListing = new Promise((resolve) => { releaseListing = resolve; });
  let listingSignal = null;
  let listCalls = 0;
  const mediaStore = {
    init: async () => undefined,
    close: async () => undefined,
    createAttemptKey: () => 'attempts/voice/66666666-6666-4666-8666-666666666666',
    delete: async () => ({ deleted: false, notFound: true }),
    listAttemptKeys: ({ signal }) => {
      listCalls += 1;
      listingSignal = signal;
      listingStartedResolve();
      return listCalls === 1 ? stalledListing : Promise.resolve({ keys: [], cursor: null });
    },
  };
  const server = await startServer({
    environment: {
      NODE_ENV: 'test',
      V1_PUBLIC_ORIGIN: 'https://voice.example.test',
      V1_SESSION_SECRET: 's'.repeat(32),
      V1_ATOMIC_FILE_PATH: join(directory, 'store.json'),
      V1_LOCAL_MEDIA_PATH: join(directory, 'media'),
      V1_LLM_PROVIDER: 'deterministic',
    },
    host: '127.0.0.1',
    port: 0,
    mediaStore,
    llmProvider: { provider: 'shutdown-list-test', generate: async () => { throw new Error('must not run'); } },
  });
  t.after(() => server.shutdown());
  await settleWithin(listingStarted, 250, 'server cleanup never entered attempt listing');
  const shutdown = server.shutdown();
  try {
    await settleWithin(shutdown, 150, 'server shutdown waited indefinitely for cleanup listing');
  } finally {
    releaseListing({ keys: [], cursor: null });
    await shutdown;
  }
  assert.equal(listingSignal.aborted, true);
});

test('server shutdown is lease-bounded when the media delete adapter ignores abort', async (t) => {
  const { startServer } = await import('../src/server.js');
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-server-cleanup-delete-stop-'));
  const filePath = join(directory, 'store.json');
  const store = new AtomicFileStore({ filePath });
  await store.init();
  const current = new Date('2026-08-25T05:00:00.000Z');
  const storageKey = 'attempts/voice/bbbbbbbb-9999-4999-8999-999999999999';
  await store.enqueueMediaDeletion({ storageKey, reason: 'server-shutdown-delete', notBefore: current, now: current });
  let deletionStartedResolve;
  const deletionStarted = new Promise((resolve) => { deletionStartedResolve = resolve; });
  let releaseDeletion;
  const deletion = new Promise((resolve) => { releaseDeletion = resolve; });
  let deletionSignal = null;
  const mediaStore = {
    init: async () => undefined,
    close: async () => undefined,
    createAttemptKey: () => 'attempts/voice/cccccccc-9999-4999-8999-999999999999',
    delete: ({ signal }) => {
      deletionSignal = signal;
      deletionStartedResolve();
      return deletion;
    },
    listAttemptKeys: async () => ({ keys: [], cursor: null }),
  };
  const cleanupService = createMediaCleanupService({
    store,
    mediaStore,
    now: () => current,
    leaseMs: 25,
    pollMs: 60_000,
  });
  const server = await startServer({
    environment: {
      NODE_ENV: 'test',
      V1_PUBLIC_ORIGIN: 'https://voice.example.test',
      V1_SESSION_SECRET: 's'.repeat(32),
      V1_ATOMIC_FILE_PATH: filePath,
      V1_LOCAL_MEDIA_PATH: join(directory, 'media'),
      V1_LLM_PROVIDER: 'deterministic',
    },
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    llmProvider: { provider: 'shutdown-delete-test', generate: async () => { throw new Error('must not run'); } },
    now: () => current,
  });
  t.after(() => server.shutdown());
  await settleWithin(deletionStarted, 250, 'server cleanup never claimed the stalled deletion');
  const shutdown = server.shutdown();
  let shutdownWithinLease = false;
  try {
    await settleWithin(shutdown, 300, 'server shutdown waited forever for a delete adapter that ignored abort');
    shutdownWithinLease = true;
  } finally {
    if (!shutdownWithinLease) {
      releaseDeletion({ deleted: true, notFound: false });
      await shutdown;
    }
  }
  assert.equal(deletionSignal.aborted, true);
  const persisted = JSON.parse(await readFile(filePath, 'utf8')).mediaDeletionJobs
    .find((job) => job.storageKey === storageKey);
  assert.equal(persisted.state, 'deleting');
  releaseDeletion({ deleted: true, notFound: false });
  await new Promise((resolve) => setImmediate(resolve));
});

test('orphan sweep evidence reopens a completed deletion exactly once across cleanup workers', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { filePath, store } = await createStore(t, 'hb-v1-sweep-rearm-evidence-');
  const storageKey = 'attempts/voice/44444444-4444-4444-8444-444444444444';
  const current = new Date('2026-08-25T04:00:00.000Z');
  const objects = new Map();
  const mediaStore = {
    listAttemptKeys: async ({ prefix, before, limit }) => ({
      keys: [...objects.entries()]
        .filter(([key, value]) => key.startsWith(prefix) && new Date(value.lastModified) < new Date(before))
        .slice(0, limit)
        .map(([key, value]) => ({ storageKey: key, ...value })),
      cursor: null,
    }),
    delete: async ({ storageKey: key }) => {
      const deleted = objects.delete(key);
      return { deleted, notFound: !deleted };
    },
  };
  const cleanupOne = createMediaCleanupService({ store, mediaStore, now: () => current, workerId: 'sweep-worker-one' });
  const cleanupTwo = createMediaCleanupService({ store, mediaStore, now: () => current, workerId: 'sweep-worker-two' });
  t.after(async () => { await cleanupOne.stop(); await cleanupTwo.stop(); });

  await store.enqueueMediaDeletion({ storageKey, reason: 'pre-write-cleanup', notBefore: current, now: current });
  assert.equal((await cleanupOne.drainOnce()).completed, true, 'generation one completes against not-found');
  objects.set(storageKey, { lastModified: '2026-08-25T03:00:00.000Z', byteLength: 91, version: 'fake-etag-a' });

  const before = new Date('2026-08-25T03:30:00.000Z');
  const [firstSweep, secondSweep] = await Promise.all([
    cleanupOne.sweepAttemptPrefix({ prefix: 'attempts/voice/', before, limit: 10 }),
    cleanupTwo.sweepAttemptPrefix({ prefix: 'attempts/voice/', before, limit: 10 }),
  ]);
  assert.equal(firstSweep.enqueued, 1);
  assert.equal(secondSweep.enqueued, 1);
  const afterSweeps = JSON.parse(await readFile(filePath, 'utf8'));
  const rearmed = afterSweeps.mediaDeletionJobs.find((entry) => entry.storageKey === storageKey);
  assert.equal(rearmed.generation, 2, 'the same observed object must not continuously rearm and fence workers');
  assert.equal(rearmed.state, 'pending');

  objects.set(storageKey, { lastModified: '2026-08-25T03:00:00.000Z', byteLength: 91, version: 'fake-etag-b' });
  await cleanupOne.sweepAttemptPrefix({ prefix: 'attempts/voice/', before, limit: 10 });
  const afterPendingEvidence = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(afterPendingEvidence.mediaDeletionJobs.find((entry) => entry.storageKey === storageKey).generation, 3);
  const claimed = await store.claimNextMediaDeletion({
    workerId: 'stale-sweep-worker',
    leaseToken: 'stale-sweep-lease',
    leaseExpiresAt: new Date(current.getTime() + 15_000),
    now: current,
  });
  assert.equal(claimed.generation, 3);

  objects.set(storageKey, { lastModified: '2026-08-25T03:00:00.000Z', byteLength: 91, version: 'fake-etag-c' });
  await cleanupTwo.sweepAttemptPrefix({ prefix: 'attempts/voice/', before, limit: 10 });
  await assert.rejects(store.completeMediaDeletion({
    jobId: claimed.id,
    generation: claimed.generation,
    leaseToken: 'stale-sweep-lease',
    now: current,
  }), { code: 'LEASE_LOST' });
  await cleanupOne.sweepAttemptPrefix({ prefix: 'attempts/voice/', before, limit: 10 });
  const afterDeletingEvidence = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(afterDeletingEvidence.mediaDeletionJobs.find((entry) => entry.storageKey === storageKey).generation, 4);

  assert.equal((await cleanupOne.drainOnce()).completed, true);
  assert.equal(objects.size, 0, 'positive sweep evidence eventually deletes the post-completion object');
});

test('server restart recovers only bounded stale private ingress spools and preserves recent and nonmatching paths', async (t) => {
  const { startServer } = await import('../src/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-spool-restart-'));
  const spoolRoot = join(directory, 'private-spool-root');
  await mkdir(spoolRoot, { recursive: true });
  const staleDirectories = [
    join(spoolRoot, 'voice-ingress-aaaaaa'),
    join(spoolRoot, 'voice-ingress-bbbbbb'),
  ];
  const recentDirectory = join(spoolRoot, 'voice-ingress-cccccc');
  const nonmatchingDirectory = join(spoolRoot, 'other-ingress-dddddd');
  for (const candidate of [...staleDirectories, recentDirectory, nonmatchingDirectory]) {
    await mkdir(candidate);
    await writeFile(join(candidate, 'body.wav'), Buffer.from('private-spool-fixture'));
  }
  const staleAt = new Date('2026-08-25T04:50:00.000Z');
  const recentAt = new Date('2026-08-25T04:59:30.000Z');
  for (const candidate of [...staleDirectories, nonmatchingDirectory]) {
    await utimes(join(candidate, 'body.wav'), staleAt, staleAt);
    await utimes(candidate, staleAt, staleAt);
  }
  await utimes(join(recentDirectory, 'body.wav'), recentAt, recentAt);
  await utimes(recentDirectory, recentAt, recentAt);

  const mediaStore = {
    init: async () => undefined,
    close: async () => undefined,
    createAttemptKey: () => 'attempts/voice/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  const cleanupService = {
    start: () => undefined,
    stop: async () => undefined,
    drainOnce: async () => ({ idle: true }),
  };
  const server = await startServer({
    environment: {
      NODE_ENV: 'test',
      V1_PUBLIC_ORIGIN: 'https://voice.example.test',
      V1_SESSION_SECRET: 'r'.repeat(32),
      V1_ATOMIC_FILE_PATH: join(directory, 'store.json'),
      V1_LOCAL_MEDIA_PATH: join(directory, 'media'),
      V1_LLM_PROVIDER: 'deterministic',
    },
    host: '127.0.0.1',
    port: 0,
    mediaStore,
    cleanupService,
    llmProvider: { provider: 'restart-test', generate: async () => { throw new Error('must not run'); } },
    now: () => new Date('2026-08-25T05:00:00.000Z'),
    spoolParentDirectory: spoolRoot,
    spoolRecoveryLimit: 1,
    spoolStaleAfterMs: 5 * 60_000,
  });
  t.after(() => server.shutdown());

  const staleSurvivors = (await Promise.all(staleDirectories.map(pathExists))).filter(Boolean).length;
  assert.equal(staleSurvivors, 1, 'startup recovery is bounded to one stale matching spool');
  assert.equal(await pathExists(join(recentDirectory, 'body.wav')), true);
  assert.equal(await pathExists(join(nonmatchingDirectory, 'body.wav')), true);
  await server.shutdown();
});

test('voice ingress idle and absolute deadlines release the source with the stable retryable 408 outcome', async () => {
  const { withIngressDeadlines } = await import('../src/services/voice.js');
  for (const limits of [{ idleMs: 10, absoluteMs: 100 }, { idleMs: 100, absoluteMs: 10 }]) {
    let released = false;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => undefined),
          return: async () => { released = true; return { done: true }; },
        };
      },
    };
    const bounded = withIngressDeadlines(source, limits);
    await assert.rejects(readableBuffer(Readable.from(bounded)), (error) => (
      error.code === 'VOICE_UPLOAD_TIMEOUT' && error.status === 408 && error.retryable === true
    ));
    assert.equal(released, true);
  }
});

test('active ingress is spooled under its own idle and absolute clocks before the media-write deadline starts', async (t) => {
  const { createVoiceService } = await import('../src/services/voice.js');
  const { directory, store } = await createStore(t, 'hb-v1-ingress-spool-');
  const owner = await store.createOrResumeSession({ tokenHash: 'ingress-spool-owner', now: '2026-08-25T02:15:00.000Z' });
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_SESSION_SECRET: 'i'.repeat(32),
    V1_ASR_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'fake-only',
    AZURE_SPEECH_REGION: 'eastasia',
  });
  const keys = [
    'attempts/voice/cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    'attempts/voice/efefefef-efef-4fef-8fef-efefefefefef',
  ];
  const objects = new Map();
  let keyIndex = 0;
  let putCalls = 0;
  const mediaStore = {
    createAttemptKey: () => keys[keyIndex++],
    putAttempt: async ({ storageKey, readable, signal }) => {
      putCalls += 1;
      const chunks = [];
      for await (const chunk of readable) {
        if (signal.aborted) throw signal.reason;
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      objects.set(storageKey, bytes);
      return {
        storageKey,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    open: async ({ storageKey }) => {
      const bytes = objects.get(storageKey);
      return { readable: Readable.from([bytes]), size: bytes.length, contentLength: bytes.length };
    },
  };
  let asrCalls = 0;
  const service = createVoiceService({
    config,
    store,
    mediaStore,
    asrProvider: {
      transcribe: async (bytes) => {
        asrCalls += 1;
        assert.deepEqual(bytes, canonicalWav(100));
        return { transcript: '慢速但有效', provider: 'azure', latencyMs: 1 };
      },
    },
    now: () => new Date('2026-08-25T02:15:00.000Z'),
    mediaDeadlineMs: 15,
    spoolParentDirectory: directory,
  });

  const audio = canonicalWav(100);
  let finiteReleased = false;
  async function* slowFiniteBody() {
    try {
      for (let index = 0; index < 8; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 6));
        const start = Math.floor((audio.length * index) / 8);
        const end = Math.floor((audio.length * (index + 1)) / 8);
        yield audio.subarray(start, end);
      }
    } finally { finiteReleased = true; }
  }
  const completed = await service.transcribe({
    sessionId: owner.session.id,
    clientUploadId: 'cdcdcdcd-0000-4000-8000-000000000000',
    requestSha256: createHash('sha256').update(audio).digest('hex'),
    mimeType: 'audio/wav',
    readable: slowFiniteBody(),
    idleMs: 50,
    absoluteMs: 300,
  });
  assert.equal(completed.httpStatus, 201);
  assert.equal(completed.data.transcript, '慢速但有效');
  assert.equal(finiteReleased, true);
  assert.equal(asrCalls, 1);
  assert.equal(putCalls, 1);

  let activeReleased = false;
  async function* activeUntilAbsoluteDeadline() {
    try {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield Buffer.from([0, 0]);
      }
    } finally { activeReleased = true; }
  }
  await assert.rejects(service.transcribe({
    sessionId: owner.session.id,
    clientUploadId: 'efefefef-0000-4000-8000-000000000000',
    requestSha256: '0'.repeat(64),
    mimeType: 'audio/wav',
    readable: activeUntilAbsoluteDeadline(),
    idleMs: 15,
    absoluteMs: 40,
  }), (error) => error.code === 'VOICE_UPLOAD_TIMEOUT' && error.status === 408 && error.retryable === true);
  assert.equal(activeReleased, true);
  assert.equal(asrCalls, 1);
  assert.equal(putCalls, 1, 'absolute ingress failure occurs before media-store work');
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('voice-ingress-')), []);
});

test('voice media writes have an independent deadline and persist retryable 503 without calling ASR', async (t) => {
  const { createVoiceService } = await import('../src/services/voice.js');
  const { store } = await createStore(t, 'hb-v1-media-deadline-');
  const owner = await store.createOrResumeSession({ tokenHash: 'media-deadline-owner', now: '2026-08-25T02:30:00.000Z' });
  const audio = canonicalWav(100);
  let asrCalls = 0;
  let mediaAborted = false;
  const mediaStore = {
    createAttemptKey: () => 'attempts/voice/abababab-abab-4bab-8bab-abababababab',
    putAttempt: async ({ signal }) => new Promise((resolve, reject) => {
      void resolve;
      signal.addEventListener('abort', () => {
        mediaAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_SESSION_SECRET: 'm'.repeat(32),
    V1_ASR_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'fake-only',
    AZURE_SPEECH_REGION: 'eastasia',
  });
  const service = createVoiceService({
    config,
    store,
    mediaStore,
    asrProvider: { transcribe: async () => { asrCalls += 1; return { transcript: 'must-not-run' }; } },
    now: () => new Date('2026-08-25T02:30:00.000Z'),
    mediaDeadlineMs: 10,
  });
  const work = service.transcribe({
    sessionId: owner.session.id,
    clientUploadId: 'abababab-0000-4000-8000-000000000000',
    requestSha256: createHash('sha256').update(audio).digest('hex'),
    mimeType: 'audio/wav',
    readable: Readable.from([audio]),
  });
  await assert.rejects(Promise.race([
    work,
    new Promise((resolve, reject) => {
      void resolve;
      setTimeout(() => reject(new Error('media deadline was not enforced')), 200).unref?.();
    }),
  ]), (error) => error.code === 'VOICE_MEDIA_UNAVAILABLE' && error.status === 503 && error.retryable === true);
  assert.equal(mediaAborted, true);
  assert.equal(asrCalls, 0);
  const status = await store.getVoiceUploadStatus({
    sessionId: owner.session.id,
    clientUploadId: 'abababab-0000-4000-8000-000000000000',
  });
  assert.equal(status.state, 'failed');
  assert.equal(status.failureCode, 'VOICE_MEDIA_UNAVAILABLE');
  assert.equal(status.retryable, true);
});

test('abort-ignoring ASR and TTS media writes rearm completed cleanup after timeout and leave no orphan', async (t) => {
  const { createMediaCleanupService } = await import('../src/services/media-cleanup.js');
  const { createVoiceService } = await import('../src/services/voice.js');
  const { directory, filePath, store } = await createStore(t, 'hb-v1-late-media-write-');
  const durablyCompletedCleanupKeys = new Set();
  const completeMediaDeletion = store.completeMediaDeletion.bind(store);
  store.completeMediaDeletion = async (input) => {
    const completed = await completeMediaDeletion(input);
    if (completed.generation >= 2) durablyCompletedCleanupKeys.add(completed.storageKey);
    return completed;
  };
  const owner = await store.createOrResumeSession({ tokenHash: 'late-media-owner', now: '2026-08-25T02:45:00.000Z' });
  const assistant = await createDeliveredAssistant(store, owner.session, owner.conversation);
  const keys = {
    voice: 'attempts/voice/bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
    tts: 'attempts/tts/cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
  };
  const objects = new Map();
  const pendingWrites = [];
  const mediaStore = {
    createAttemptKey: ({ kind }) => keys[kind],
    putAttempt: ({ storageKey, readable }) => new Promise((resolve) => {
      pendingWrites.push({
        storageKey,
        finish: async () => {
          const bytes = await readableBuffer(Readable.from(readable));
          objects.set(storageKey, bytes);
          resolve({
            storageKey,
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        },
      });
    }),
    delete: async ({ storageKey }) => {
      const deleted = objects.delete(storageKey);
      return { deleted, notFound: !deleted };
    },
  };
  const now = () => new Date('2026-08-25T02:45:00.000Z');
  const cleanupService = createMediaCleanupService({ store, mediaStore, now, retryDelayMs: 1 });
  t.after(() => cleanupService.stop());
  let asrCalls = 0;
  const service = createVoiceService({
    config: loadConfig({
      NODE_ENV: 'test', V1_SESSION_SECRET: 'l'.repeat(32),
      V1_ASR_PROVIDER: 'azure', V1_TTS_PROVIDER: 'azure',
      AZURE_SPEECH_KEY: 'fake-only', AZURE_SPEECH_REGION: 'eastasia',
    }),
    store,
    mediaStore,
    cleanupService,
    asrProvider: { transcribe: async () => { asrCalls += 1; return { transcript: 'must not run' }; } },
    ttsProvider: { synthesize: async () => ({ buffer: Buffer.from([0x49, 0x44, 0x33, 0x04]), mimeType: 'audio/mpeg' }) },
    now,
    mediaDeadlineMs: 10,
    spoolParentDirectory: join(directory, 'voice-spool'),
  });
  const audio = canonicalWav(10);
  const operations = [
    service.transcribe({
      sessionId: owner.session.id,
      clientUploadId: 'bcbcbcbc-0000-4000-8000-000000000000',
      requestSha256: createHash('sha256').update(audio).digest('hex'),
      mimeType: 'audio/wav',
      readable: Readable.from([audio]),
    }),
    service.generateAssistantAudio({ sessionId: owner.session.id, messageId: assistant.id }),
  ];
  const promptFailures = Promise.all(operations.map((operation) => assert.rejects(operation, (error) => (
    error.code === 'VOICE_MEDIA_UNAVAILABLE' && error.status === 503 && error.retryable === true
  )))).then(
    () => ({ accepted: true }),
    (error) => ({ accepted: false, error }),
  );
  await waitForCondition(() => {
    const startedKeys = new Set(pendingWrites.map((entry) => entry.storageKey));
    return Object.values(keys).every((storageKey) => startedKeys.has(storageKey));
  }, {
    message: 'both target putAttempt operations did not start before the diagnostic deadline',
  });
  const promptOutcome = await settleWithin(
    promptFailures,
    2_000,
    'target putAttempt operations started but bounded 503 service responses did not arrive',
  );
  if (!promptOutcome.accepted) throw promptOutcome.error;
  assert.equal(asrCalls, 0);
  assert.deepEqual(pendingWrites.map((entry) => entry.storageKey).sort(), Object.values(keys).sort());

  await Promise.all(pendingWrites.map((entry) => entry.finish()));
  await waitForCondition(() => (
    objects.size === 0
    && Object.values(keys).every((storageKey) => durablyCompletedCleanupKeys.has(storageKey))
  ), {
    timeoutMs: 10_000,
    message: 'late successful writes did not reach durable generation-2 cleanup completion',
  });
  assert.equal(objects.size, 0, 'late successful writes are durably rearmed and deleted');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  for (const storageKey of Object.values(keys)) {
    const job = persisted.mediaDeletionJobs.find((entry) => entry.storageKey === storageKey);
    assert.equal(job?.state, 'completed', storageKey);
    assert.ok(job?.generation >= 2, storageKey);
  }
});

test('late-rejecting ASR and TTS writes return bounded HTTP 503 and rearm cleanup after post-write failure', async (t) => {
  const keys = {
    voice: 'attempts/voice/dededede-dede-4ded-8ded-dededededede',
    tts: 'attempts/tts/efefefef-efef-4fef-8fef-efefefefefef',
  };
  const objects = new Map();
  const pendingWrites = [];
  const mediaStore = {
    init: async () => undefined,
    close: async () => undefined,
    createAttemptKey: ({ kind }) => keys[kind],
    putAttempt: ({ storageKey, readable }) => new Promise((resolve, reject) => {
      void resolve;
      pendingWrites.push({
        storageKey,
        finishAndReject: async () => {
          const bytes = await readableBuffer(Readable.from(readable));
          objects.set(storageKey, bytes);
          reject(Object.assign(new Error('fake post-write metadata failure'), { code: 'MEDIA_UNAVAILABLE' }));
        },
      });
    }),
    delete: async ({ storageKey }) => {
      const deleted = objects.delete(storageKey);
      return { deleted, notFound: !deleted };
    },
  };
  let asrCalls = 0;
  const now = () => new Date('2026-08-25T02:50:00.000Z');
  const { baseUrl, origin, store, filePath } = await startVoiceApp(t, {
    providedMediaStore: mediaStore,
    mediaDeadlineMs: 10,
    now,
    asrProvider: { provider: 'azure', transcribe: async () => { asrCalls += 1; return { transcript: 'must not run' }; } },
    ttsProvider: { provider: 'azure', synthesize: async () => ({ buffer: Buffer.from([0x49, 0x44, 0x33, 0x04]), mimeType: 'audio/mpeg' }) },
  });
  const durablyCompletedCleanupKeys = new Set();
  const completeMediaDeletion = store.completeMediaDeletion.bind(store);
  store.completeMediaDeletion = async (input) => {
    const completed = await completeMediaDeletion(input);
    if (completed.generation >= 2) durablyCompletedCleanupKeys.add(completed.storageKey);
    return completed;
  };
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const audio = canonicalWav(10);
  const operations = [
    fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.length),
        'X-Client-Upload-Id': 'dededede-0000-4000-8000-000000000000',
        'X-Content-SHA256': createHash('sha256').update(audio).digest('hex'),
        'X-ASR-Language': 'yue-Hant-HK',
      },
      body: audio,
    }),
    fetchJson(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie },
    }),
  ];
  const responsesPromise = Promise.all(operations).then(
    (responses) => ({ accepted: true, responses }),
    (error) => ({ accepted: false, error }),
  );
  await waitForCondition(() => {
    const startedKeys = new Set(pendingWrites.map((entry) => entry.storageKey));
    return Object.values(keys).every((storageKey) => startedKeys.has(storageKey));
  }, {
    message: 'both target late-rejecting putAttempt operations did not start before the diagnostic deadline',
  });
  const responsesOutcome = await settleWithin(
    responsesPromise,
    2_000,
    'target late-rejecting putAttempt operations started but bounded HTTP 503 responses did not arrive',
  );
  if (!responsesOutcome.accepted) throw responsesOutcome.error;
  const { responses } = responsesOutcome;
  for (const result of responses) {
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, 'VOICE_MEDIA_UNAVAILABLE');
  }
  assert.equal(asrCalls, 0);
  assert.deepEqual(pendingWrites.map((entry) => entry.storageKey).sort(), Object.values(keys).sort());

  await Promise.all(pendingWrites.map((entry) => entry.finishAndReject()));
  await waitForCondition(() => (
    objects.size === 0
    && Object.values(keys).every((storageKey) => durablyCompletedCleanupKeys.has(storageKey))
  ), {
    timeoutMs: 10_000,
    message: 'late rejected writes did not reach durable generation-2 cleanup completion',
  });
  assert.equal(objects.size, 0, 'late rejected writes are durably rearmed and deleted');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  for (const storageKey of Object.values(keys)) {
    const job = persisted.mediaDeletionJobs.find((entry) => entry.storageKey === storageKey);
    assert.equal(job?.state, 'completed', storageKey);
    assert.ok(job?.generation >= 2, storageKey);
  }
});

test('post-body ASR client disconnect aborts provider work and durably fails without attaching a draft', async (t) => {
  let providerStartedResolve;
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
  let providerAbortedResolve;
  const providerAborted = new Promise((resolve) => { providerAbortedResolve = resolve; });
  let rejectProvider;
  const providerWork = new Promise((resolve, reject) => {
    void resolve;
    rejectProvider = reject;
  });
  let providerSignal = null;
  let providerContinued = false;
  const uploadId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const { baseUrl, origin, server, store, filePath } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'azure',
      transcribe: async (bytes, { signal }) => {
        assert.deepEqual(bytes, canonicalWav(10));
        providerSignal = signal;
        const abort = () => {
          providerAbortedResolve();
          rejectProvider(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        providerStartedResolve();
        await providerWork;
        providerContinued = true;
        return { transcript: 'must not attach after disconnect', provider: 'azure', latencyMs: 1 };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(10);
  const serverRequest = observeServerRequest(t, server, '/api/v1/voice/transcriptions');
  const client = openHttpRequest(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'X-Client-Upload-Id': uploadId,
      'X-Content-SHA256': createHash('sha256').update(audio).digest('hex'),
      'X-ASR-Language': 'yue-Hant-HK',
    },
  });
  client.request.end(audio);
  await settleWithin(providerStarted, 2_000, 'ASR provider did not start after the canonical body completed');
  assert.equal((await serverRequest).complete, true, 'ASR disconnect occurs only after the server parsed the full body');
  let observedAbort = false;
  try {
    client.request.destroy();
    await settleWithin(providerAborted, 1_000, 'post-body ASR disconnect did not abort the provider signal');
    observedAbort = true;
  } finally {
    if (!observedAbort) {
      rejectProvider(Object.assign(new Error('release ASR provider after RED'), {
        code: 'VOICE_UPLOAD_ABORTED', status: 408, retryable: true,
      }));
    }
    await settleWithin(client.closed, 1_000, 'destroyed ASR client request did not close');
  }
  assert.equal(providerSignal.aborted, true);
  assert.equal(providerSignal.reason.code, 'VOICE_UPLOAD_ABORTED');
  assert.equal(providerContinued, false, 'paid ASR work does not continue after disconnect');
  assert.equal(client.receivedResponse(), null, 'a destroyed client receives no late error response');

  const failed = await waitForCondition(async () => {
    const status = await store.getVoiceUploadStatus({
      sessionId: session.body.data.session.id,
      clientUploadId: uploadId,
    });
    return status.state === 'failed' ? status : false;
  }, { message: 'ASR disconnect did not durably fail the upload' });
  assert.equal(failed.failureCode, 'VOICE_UPLOAD_ABORTED');
  assert.equal(failed.failureHttpStatus, 408);
  assert.equal(failed.retryable, true);
  await store.close();
  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  const upload = snapshot.voiceUploads.find((entry) => entry.clientUploadId === uploadId);
  assert.equal(upload.mediaAssetId, null);
  assert.equal(snapshot.mediaAssets.some((asset) => asset.kind === 'user_voice'), false);
});

test('post-body TTS client disconnect aborts provider work and durably fails without audio delivery', async (t) => {
  let providerStartedResolve;
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
  let providerAbortedResolve;
  const providerAborted = new Promise((resolve) => { providerAbortedResolve = resolve; });
  let rejectProvider;
  const providerWork = new Promise((resolve, reject) => {
    void resolve;
    rejectProvider = reject;
  });
  let providerSignal = null;
  let providerContinued = false;
  const { baseUrl, origin, server, store, filePath } = await startVoiceApp(t, {
    ttsProvider: {
      provider: 'azure',
      synthesize: async (text, { signal }) => {
        assert.equal(text, 'Durable assistant text survives TTS.');
        providerSignal = signal;
        const abort = () => {
          providerAbortedResolve();
          rejectProvider(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        providerStartedResolve();
        await providerWork;
        providerContinued = true;
        return { buffer: Buffer.from([0x49, 0x44, 0x33, 0x04]), mimeType: 'audio/mpeg', provider: 'azure', latencyMs: 1 };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const audioPath = `/api/v1/messages/${assistant.id}/audio`;
  const serverRequest = observeServerRequest(t, server, audioPath);
  const client = openHttpRequest(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  });
  client.request.end();
  await settleWithin(providerStarted, 2_000, 'TTS provider did not start after the POST body completed');
  const completedRequest = await serverRequest;
  const requestEnded = completedRequest.readableEnded
    ? Promise.resolve()
    : new Promise((resolve) => completedRequest.once('end', resolve));
  completedRequest.resume();
  await settleWithin(requestEnded, 1_000, 'TTS disconnect test never observed the request end event');
  assert.equal(completedRequest.complete, true, 'TTS disconnect occurs only after the server parsed the full body');
  let observedAbort = false;
  try {
    client.request.destroy();
    await settleWithin(providerAborted, 1_000, 'post-body TTS disconnect did not abort the provider signal');
    observedAbort = true;
  } finally {
    if (!observedAbort) {
      rejectProvider(Object.assign(new Error('release TTS provider after RED'), {
        code: 'VOICE_UPLOAD_ABORTED', status: 408, retryable: true,
      }));
    }
    await settleWithin(client.closed, 1_000, 'destroyed TTS client request did not close');
  }
  assert.equal(providerSignal.aborted, true);
  assert.equal(providerSignal.reason.code, 'VOICE_UPLOAD_ABORTED');
  assert.equal(providerContinued, false, 'paid TTS work does not continue after disconnect');
  assert.equal(client.receivedResponse(), null, 'a destroyed client receives no late error response');

  const failed = await waitForCondition(async () => {
    const generation = await store.getAssistantAudioStatus({
      sessionId: session.body.data.session.id,
      messageId: assistant.id,
      kind: 'assistant_voice',
    });
    return generation.state === 'failed' ? generation : false;
  }, { message: 'TTS disconnect did not durably fail the generation' });
  assert.equal(failed.failureCode, 'VOICE_UPLOAD_ABORTED');
  assert.equal(failed.failureHttpStatus, 408);
  assert.equal(failed.retryable, true);
  assert.equal(failed.mediaAssetId, null);
  const ownedMessage = await store.getOwnedAssistantMessage({
    sessionId: session.body.data.session.id,
    messageId: assistant.id,
  });
  assert.equal(ownedMessage.mediaId ?? null, null);
  await store.close();
  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(snapshot.mediaAssets.some((asset) => asset.kind === 'assistant_voice'), false);
  assert.equal(snapshot.events.some((event) => event.type === 'audio.ready' && event.messageId === assistant.id), false);
});

test('normal canonical ASR and TTS responses reuse keep-alive without false provider aborts', async (t) => {
  const providerSignals = [];
  const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x05]);
  const { baseUrl, origin, store } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'azure',
      transcribe: async (bytes, { signal }) => {
        assert.deepEqual(bytes, canonicalWav(10));
        providerSignals.push(signal);
        return { transcript: '正常完成', provider: 'azure', latencyMs: 1, confidence: null };
      },
    },
    ttsProvider: {
      provider: 'azure',
      synthesize: async (text, { signal }) => {
        assert.equal(text, 'Durable assistant text survives TTS.');
        providerSignals.push(signal);
        return { buffer: audioBytes, mimeType: 'audio/mpeg', provider: 'azure', latencyMs: 1 };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const audio = canonicalWav(10);
  const transcription = await requestJsonOverHttp(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    agent,
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'X-Client-Upload-Id': 'aaaaaaaa-2222-4222-8222-222222222222',
      'X-Content-SHA256': createHash('sha256').update(audio).digest('hex'),
      'X-ASR-Language': 'yue-Hant-HK',
    },
    body: audio,
  });
  const synthesis = await requestJsonOverHttp(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, {
    method: 'POST', agent, headers: { Origin: origin, Cookie: cookie },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transcription.status, 201);
  assert.equal(transcription.body.data.transcript, '正常完成');
  assert.equal(synthesis.status, 201);
  assert.equal(synthesis.body.data.state, 'attached');
  assert.equal(synthesis.socket, transcription.socket, 'both normal responses reuse one keep-alive socket');
  assert.equal(providerSignals.length, 2);
  assert.equal(providerSignals.some((signal) => signal.aborted), false);
});

test('mid-body ASR disconnect remains a durable retryable abort without provider or spool continuation', async (t) => {
  let asrCalls = 0;
  const uploadId = 'aaaaaaaa-3333-4333-8333-333333333333';
  const { baseUrl, origin, directory, store, filePath } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'azure',
      transcribe: async () => {
        asrCalls += 1;
        return { transcript: 'must not run', provider: 'azure', latencyMs: 1 };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(100);
  const client = openHttpRequest(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'X-Client-Upload-Id': uploadId,
      'X-Content-SHA256': createHash('sha256').update(audio).digest('hex'),
      'X-ASR-Language': 'yue-Hant-HK',
    },
  });
  client.request.write(audio.subarray(0, 44));
  await waitForCondition(async () => {
    try {
      const status = await store.getVoiceUploadStatus({
        sessionId: session.body.data.session.id,
        clientUploadId: uploadId,
      });
      return status.state === 'uploading';
    } catch (error) {
      if (error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }, { message: 'mid-body ASR request did not enter durable uploading state' });
  client.request.destroy();
  await settleWithin(client.closed, 1_000, 'destroyed mid-body ASR request did not close');

  const failed = await waitForCondition(async () => {
    const status = await store.getVoiceUploadStatus({
      sessionId: session.body.data.session.id,
      clientUploadId: uploadId,
    });
    return status.state === 'failed' ? status : false;
  }, { message: 'mid-body ASR disconnect did not durably fail the upload' });
  assert.equal(failed.failureCode, 'VOICE_UPLOAD_ABORTED');
  assert.equal(failed.failureHttpStatus, 408);
  assert.equal(failed.retryable, true);
  assert.equal(asrCalls, 0);
  assert.equal(client.receivedResponse(), null);
  const spoolEntries = await readdir(join(directory, 'voice-spool')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(spoolEntries.filter((name) => name.startsWith('voice-ingress-')), []);
  await store.close();
  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(snapshot.mediaAssets.some((asset) => asset.kind === 'user_voice'), false);
});

test('voice HTTP transcription is owned, idempotent, editable, status-recoverable, and permanent failures do no ASR retry', async (t) => {
  let asrCalls = 0;
  const { baseUrl, origin, directory } = await startVoiceApp(t, {
    asrProvider: { provider: 'azure', transcribe: async () => { asrCalls += 1; return { transcript: '可編輯廣東話', provider: 'azure', latencyMs: 1, confidence: null }; } },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(1_000);
  const uploadId = 'bbbbbbbb-0000-4000-8000-000000000000';
  const requestSha256 = createHash('sha256').update(audio).digest('hex');
  const headers = {
    Origin: origin, Cookie: cookie, 'Content-Type': 'audio/wav',
    'X-Client-Upload-Id': uploadId,
    'X-Content-SHA256': requestSha256,
    'X-ASR-Language': 'yue-Hant-HK',
    'Content-Length': String(audio.length),
  };
  const created = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, { method: 'POST', headers, body: audio });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.transcript, '可編輯廣東話');
  assert.equal(created.body.data.requestSha256, requestSha256);
  assert.match(created.body.data.voiceDraftId, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(created.body.data, 'mediaId'), false, 'ASR drafts expose only voiceDraftId');
  const retry = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, { method: 'POST', headers, body: audio });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.data.voiceDraftId, created.body.data.voiceDraftId);
  assert.equal(retry.body.data.requestSha256, requestSha256);
  assert.equal(Object.hasOwn(retry.body.data, 'mediaId'), false, 'idempotent replay keeps the same narrow draft contract');
  assert.equal(asrCalls, 1);
  const status = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${uploadId}`, { headers: { Cookie: cookie } });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.data.state, 'ready');
  assert.equal(status.body.data.requestSha256, requestSha256);
  assert.equal(Object.hasOwn(status.body.data, 'mediaId'), false, 'status recovery keeps the same narrow draft contract');

  const invalid = Buffer.from('not-a-wave');
  const invalidId = 'cccccccc-0000-4000-8000-000000000000';
  const invalidHeaders = {
    ...headers,
    'X-Client-Upload-Id': invalidId,
    'X-Content-SHA256': createHash('sha256').update(invalid).digest('hex'),
    'Content-Length': String(invalid.length),
  };
  const rejected = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, { method: 'POST', headers: invalidHeaders, body: invalid });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.body.error.code, 'VOICE_INVALID_WAV');
  const rejectedRetry = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, { method: 'POST', headers: invalidHeaders, body: invalid });
  assert.equal(rejectedRetry.response.status, 422);
  const rejectedStatus = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${invalidId}`, { headers: { Cookie: cookie } });
  assert.equal(rejectedStatus.response.status, 200);
  assert.equal(rejectedStatus.body.data.requestSha256, invalidHeaders['X-Content-SHA256']);
  assert.equal(rejectedStatus.body.data.failureCode, 'VOICE_INVALID_WAV');
  assert.equal(asrCalls, 1);
  const mediaFiles = await import('node:fs/promises').then(({ readdir }) => readdir(join(directory, 'media', 'attempts', 'voice')).catch(() => []));
  assert.equal(mediaFiles.length, 1, 'only the ready draft object remains');
});

test('voice HTTP binds Cantonese English and Mandarin selection to the durable claim and provider call', async (t) => {
  const observed = [];
  const { baseUrl, origin } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'google-stt-v2',
      transcribe: async (_audio, options) => {
        observed.push(options.responseLanguage);
        return { transcript: `safe-${options.responseLanguage}`, provider: 'google-stt-v2', latencyMs: 1, confidence: null };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(25);
  const requestSha256 = createHash('sha256').update(audio).digest('hex');
  const results = [];
  for (const [index, asrLanguage] of ['yue-Hant-HK', 'en', 'cmn-Hans-CN'].entries()) {
    const clientUploadId = `d${index + 1}d${index + 1}d${index + 1}d${index + 1}-0000-4000-8000-000000000000`;
    results.push(await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
      method: 'POST',
      headers: {
        Origin: origin, Cookie: cookie, 'Content-Type': 'audio/wav',
        'Content-Length': String(audio.length), 'X-Client-Upload-Id': clientUploadId,
        'X-Content-SHA256': requestSha256, 'X-ASR-Language': asrLanguage,
      },
      body: audio,
    }));
  }
  assert.deepEqual(results.map(({ response }) => response.status), [201, 201, 201]);
  assert.deepEqual(observed, ['yue-Hant-HK', 'en', 'cmn-Hans-CN']);

  const rejected = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: {
      Origin: origin, Cookie: cookie, 'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length), 'X-Client-Upload-Id': 'eeeeeeee-0000-4000-8000-000000000000',
      'X-Content-SHA256': requestSha256, 'X-ASR-Language': 'auto',
    },
    body: audio,
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.error.code, 'INVALID_REQUEST');
  assert.deepEqual(observed, ['yue-Hant-HK', 'en', 'cmn-Hans-CN']);
});

test('missing ASR provider durably records one permanent upload failure for POST replay and GET recovery', async (t) => {
  const { baseUrl, origin, store } = await startVoiceApp(t, { asrProvider: null });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(25);
  const clientUploadId = 'c1c1c1c1-0000-4000-8000-000000000000';
  const requestSha256 = createHash('sha256').update(audio).digest('hex');
  const headers = {
    Origin: origin,
    Cookie: cookie,
    'Content-Type': 'audio/wav',
    'Content-Length': String(audio.length),
    'X-Client-Upload-Id': clientUploadId,
    'X-Content-SHA256': requestSha256,
    'X-ASR-Language': 'yue-Hant-HK',
  };

  const first = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST', headers, body: audio,
  });
  assert.equal(first.response.status, 503);
  assert.equal(first.body.error.code, 'VOICE_PROVIDER_MISCONFIGURED');

  const durable = await store.getVoiceUploadStatus({
    sessionId: session.body.data.session.id,
    clientUploadId,
  });
  assert.equal(durable.state, 'failed');
  assert.equal(durable.failureCode, 'VOICE_PROVIDER_MISCONFIGURED');
  assert.equal(durable.failureHttpStatus, 503);
  assert.equal(durable.retryable, false);
  assert.equal(durable.requestSha256, requestSha256);
  assert.equal(durable.mediaAssetId, null);
  assert.equal(durable.transcript, null);

  const recovered = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.body.data, {
    clientUploadId,
    requestSha256,
    state: 'failed',
    failureCode: 'VOICE_PROVIDER_MISCONFIGURED',
    retryable: false,
  });

  const replay = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST', headers, body: audio,
  });
  assert.equal(replay.response.status, 503);
  assert.equal(replay.body.error.code, 'VOICE_PROVIDER_MISCONFIGURED');
});

test('voice transcription rejects missing or malformed upload identity headers before claim, body, and ASR work', async (t) => {
  let asrCalls = 0;
  const { baseUrl, origin, filePath } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'azure',
      transcribe: async () => {
        asrCalls += 1;
        return { transcript: 'must not run', provider: 'azure', latencyMs: 1, confidence: null };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(10);
  const requestSha256 = createHash('sha256').update(audio).digest('hex');
  const baseHeaders = {
    Origin: origin,
    Cookie: cookie,
    'Content-Type': 'audio/wav',
    'Content-Length': String(audio.length),
    'X-ASR-Language': 'yue-Hant-HK',
  };
  const cases = [
    ['missing X-Client-Upload-Id', { ...baseHeaders, 'X-Content-SHA256': requestSha256 }],
    ['malformed X-Client-Upload-Id', { ...baseHeaders, 'X-Client-Upload-Id': 'not-a-uuid', 'X-Content-SHA256': requestSha256 }],
    ['missing X-Content-SHA256', { ...baseHeaders, 'X-Client-Upload-Id': 'c2c2c2c2-0000-4000-8000-000000000000' }],
    ['non-lowercase X-Content-SHA256', { ...baseHeaders, 'X-Client-Upload-Id': 'c3c3c3c3-0000-4000-8000-000000000000', 'X-Content-SHA256': requestSha256.toUpperCase() }],
  ];
  const before = await readFile(filePath, 'utf8');

  for (const [name, headers] of cases) {
    const result = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
      method: 'POST', headers, body: audio,
    });
    assert.equal(result.response.status, 400, name);
    assert.equal(result.body.error.code, 'INVALID_REQUEST', name);
  }

  assert.equal(asrCalls, 0);
  assert.equal(await readFile(filePath, 'utf8'), before, 'invalid upload identity never creates a claim');
});

test('oversized chunked voice upload exposes one public 413 code and keeps its durable terminal reason', async (t) => {
  let asrCalls = 0;
  const { baseUrl, origin, store } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'azure',
      transcribe: async () => {
        asrCalls += 1;
        return { transcript: 'must not run', provider: 'azure', latencyMs: 1, confidence: null };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const bytes = Buffer.alloc((8 * 1024 * 1024) + 1, 0x61);
  const clientUploadId = 'c4c4c4c4-0000-4000-8000-000000000000';
  const requestSha256 = createHash('sha256').update(bytes).digest('hex');
  const headers = {
    Origin: origin,
    Cookie: cookie,
    'Content-Type': 'audio/wav',
    'X-Client-Upload-Id': clientUploadId,
    'X-Content-SHA256': requestSha256,
    'X-ASR-Language': 'yue-Hant-HK',
  };
  const upload = () => fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST', headers, body: Readable.from([bytes]), duplex: 'half',
  });

  const first = await upload();
  assert.equal(first.response.status, 413);
  assert.equal(first.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(asrCalls, 0);

  const durable = await store.getVoiceUploadStatus({
    sessionId: session.body.data.session.id,
    clientUploadId,
  });
  assert.equal(durable.state, 'failed');
  assert.equal(durable.failureCode, 'VOICE_UPLOAD_TOO_LARGE');
  assert.equal(durable.failureHttpStatus, 413);
  assert.equal(durable.retryable, false);

  const recovered = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.data.failureCode, 'VOICE_UPLOAD_TOO_LARGE');
  assert.equal(recovered.body.data.retryable, false);

  const replay = await upload();
  assert.equal(replay.response.status, 413);
  assert.equal(replay.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(asrCalls, 0);
});

test('voice upload DELETE is owned, capability-independent, idempotent, and permanently fences live work', async (t) => {
  let voiceInputEnabled = true;
  let asrCalls = 0;
  let markProviderStarted;
  let resolveProvider;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const providerResult = new Promise((resolve) => { resolveProvider = resolve; });
  const { baseUrl, origin, store, mediaStore } = await startVoiceApp(t, {
    configTransform: (config) => ({
      ...config,
      nodeEnv: 'production',
      getPublicStatus: () => ({
        ...config.publicStatus,
        voiceInput: voiceInputEnabled,
        voiceInputPreview: voiceInputEnabled,
      }),
    }),
    asrProvider: {
      provider: 'azure',
      transcribe: async () => {
        asrCalls += 1;
        markProviderStarted();
        return providerResult;
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(100);
  const clientUploadId = '56565656-5656-4656-8656-565656565656';
  const requestSha256 = createHash('sha256').update(audio).digest('hex');
  const headers = {
    Origin: origin,
    Cookie: cookie,
    'Content-Type': 'audio/wav',
    'Content-Length': String(audio.length),
    'X-Client-Upload-Id': clientUploadId,
    'X-Content-SHA256': requestSha256,
    'X-ASR-Language': 'yue-Hant-HK',
  };
  const posting = fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST', headers, body: audio,
  });
  await providerStarted;
  const liveUpload = await store.getVoiceUploadStatus({
    sessionId: session.body.data.session.id,
    clientUploadId,
  });
  assert.equal(liveUpload.state, 'transcribing');
  const attemptStorageKey = liveUpload.attemptStorageKey;

  const liveStatus = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    headers: { Cookie: cookie },
  });
  voiceInputEnabled = false;
  const cancelled = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  const repeated = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  const other = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const otherCookie = other.response.headers.getSetCookie()[0].split(';')[0];
  const crossSession = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: otherCookie },
  });
  const malformed = await fetchJson(`${baseUrl}/api/v1/voice/uploads/not-a-uuid`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  voiceInputEnabled = true;
  const retryAfterCancel = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST', headers, body: audio,
  });
  resolveProvider({ transcript: 'must never become a draft', provider: 'azure', latencyMs: 1, confidence: null });
  const originalAfterCancel = await posting;

  assert.equal(liveStatus.response.status, 202);
  assert.equal(liveStatus.body.data.requestSha256, requestSha256);
  assert.equal(cancelled.response.status, 200);
  assert.deepEqual(cancelled.body.data, {
    clientUploadId,
    requestSha256,
    state: 'failed',
    failureCode: 'VOICE_UPLOAD_CANCELLED',
    retryable: false,
  });
  assert.equal(JSON.stringify(cancelled.body).includes('must never become a draft'), false);
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(repeated.body.data, cancelled.body.data);
  assert.equal(crossSession.response.status, 404);
  assert.equal(crossSession.body.error.code, 'NOT_FOUND');
  assert.equal(malformed.response.status, 404);
  assert.equal(malformed.body.error.code, 'NOT_FOUND');
  assert.equal(retryAfterCancel.response.status, 410);
  assert.equal(retryAfterCancel.body.error.code, 'VOICE_UPLOAD_CANCELLED');
  assert.equal(asrCalls, 1, 'a cancelled upload identity never invokes ASR again');
  assert.equal(originalAfterCancel.body.data, null);
  assert.equal(JSON.stringify(originalAfterCancel.body).includes('must never become a draft'), false);

  const finalStatus = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(finalStatus.response.status, 200);
  assert.deepEqual(finalStatus.body.data, cancelled.body.data);
  await waitForCondition(async () => {
    try {
      await mediaStore.open({ storageKey: attemptStorageKey });
      return false;
    } catch (error) {
      if (error.code === 'MEDIA_NOT_FOUND') return true;
      throw error;
    }
  }, { message: 'cancelled in-flight upload media was not reclaimed' });
});

test('expired upload status keeps the exact lowercase request hash binding', async (t) => {
  let clock = new Date('2026-08-25T00:00:00.000Z');
  const now = () => new Date(clock);
  const { baseUrl, origin, store } = await startVoiceApp(t, { now });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const clientUploadId = '57575757-5757-4757-8757-575757575757';
  await store.claimVoiceUploadWithRateLimits({
    sessionId: session.body.data.session.id,
    clientUploadId,
    requestSha256: 'D4'.repeat(32),
    mimeType: 'audio/wav',
    rateLimits: [],
    leaseToken: 'expired-upload-lease',
    attemptStorageKey: 'attempts/voice/57575757-5757-4757-8757-575757575757',
    leaseExpiresAt: '2026-08-25T00:00:10.000Z',
    attemptDeadlineAt: '2026-08-25T00:00:20.000Z',
    now: '2026-08-25T00:00:01.000Z',
  });
  clock = new Date('2026-08-25T00:00:21.000Z');

  const status = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${clientUploadId}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.body.data, {
    clientUploadId,
    requestSha256: 'd4'.repeat(32),
    state: 'failed',
    failureCode: 'VOICE_ATTEMPT_EXPIRED',
    retryable: true,
  });
});

test('voice upload DELETE removes a ready draft but returns 409 when message attachment wins', async (t) => {
  const { baseUrl, origin, store, mediaStore } = await startVoiceApp(t, {
    asrProvider: {
      provider: 'azure',
      transcribe: async () => ({ transcript: 'private draft transcript', provider: 'azure', latencyMs: 1, confidence: null }),
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(50);
  const requestSha256 = createHash('sha256').update(audio).digest('hex');
  const upload = (clientUploadId) => fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'X-Client-Upload-Id': clientUploadId,
      'X-Content-SHA256': requestSha256,
      'X-ASR-Language': 'yue-Hant-HK',
    },
    body: audio,
  });

  const disposableId = '58585858-5858-4858-8858-585858585858';
  const disposable = await upload(disposableId);
  const disposableAsset = await store.getMediaAsset({
    sessionId: session.body.data.session.id,
    mediaId: disposable.body.data.voiceDraftId,
  });
  const removed = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${disposableId}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.data, {
    clientUploadId: disposableId,
    requestSha256,
    state: 'failed',
    failureCode: 'VOICE_UPLOAD_CANCELLED',
    retryable: false,
  });
  assert.equal(JSON.stringify(removed.body).includes('private draft transcript'), false);
  const removedStatus = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${disposableId}`, {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(removedStatus.body.data, removed.body.data);
  await waitForCondition(async () => {
    try {
      await mediaStore.open({ storageKey: disposableAsset.storageKey });
      return false;
    } catch (error) {
      if (error.code === 'MEDIA_NOT_FOUND') return true;
      throw error;
    }
  }, { message: 'cancelled ready draft media was not reclaimed' });

  const attachedId = '59595959-5959-4959-8959-595959595959';
  const attached = await upload(attachedId);
  const accepted = await store.acceptMessage({
    sessionId: session.body.data.session.id,
    conversationId: session.body.data.conversation.id,
    clientMessageId: '60606060-6060-4060-8060-606060606060',
    requestHash: 'http-attach-before-cancel',
    text: 'edited voice message',
    voiceDraftId: attached.body.data.voiceDraftId,
    now: '2026-08-25T00:10:00.000Z',
  });
  const attachedAsset = await store.getMediaAsset({
    sessionId: session.body.data.session.id,
    mediaId: attached.body.data.voiceDraftId,
  });
  const rejected = await fetchJson(`${baseUrl}/api/v1/voice/uploads/${attachedId}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'VOICE_DRAFT_ALREADY_ATTACHED');
  const preserved = await store.getMediaAsset({
    sessionId: session.body.data.session.id,
    mediaId: attached.body.data.voiceDraftId,
  });
  assert.equal(preserved.status, 'attached');
  assert.equal(preserved.ownerMessageId, accepted.message.id);
  assert.deepEqual(await readableBuffer((await mediaStore.open({ storageKey: attachedAsset.storageKey })).readable), audio);
});

test('voice capability failure precedes malformed headers, MIME, declared size, claim, body, and provider work', async (t) => {
  let asrCalls = 0;
  const { baseUrl, origin, filePath } = await startVoiceApp(t, {
    asrProvider: { provider: 'azure', transcribe: async () => { asrCalls += 1; throw new Error('must not run'); } },
    configTransform: (config) => ({
      ...config,
      nodeEnv: 'production',
      publicStatus: { ...config.publicStatus, voiceInputPreview: false, voiceInput: false },
      getPublicStatus: () => ({ ...config.publicStatus, voiceInputPreview: false, voiceInput: false }),
    }),
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const before = await readFile(filePath, 'utf8');
  const response = await fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Client-Upload-Id': 'bad', 'X-Content-SHA256': 'bad' },
    body: JSON.stringify({ unsafe: true }),
  });
  assert.equal(response.response.status, 503);
  assert.equal(response.body.error.code, 'VOICE_NOT_RELEASE_VERIFIED');
  assert.equal(asrCalls, 0);
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('missing TTS provider durably records one permanent generation for POST replay and GET recovery', async (t) => {
  const { baseUrl, origin, store, filePath } = await startVoiceApp(t, { ttsProvider: null });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const audioPath = `/api/v1/messages/${assistant.id}/audio`;

  const first = await fetchJson(`${baseUrl}${audioPath}`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(first.response.status, 503);
  assert.equal(first.body.error.code, 'VOICE_PROVIDER_MISCONFIGURED');

  const durable = await store.getAssistantAudioStatus({
    sessionId: session.body.data.session.id,
    messageId: assistant.id,
    kind: 'assistant_voice',
  });
  assert.equal(durable.state, 'failed');
  assert.equal(durable.failureCode, 'VOICE_PROVIDER_MISCONFIGURED');
  assert.equal(durable.failureHttpStatus, 503);
  assert.equal(durable.retryable, false);
  assert.equal(durable.mediaAssetId, null);

  const recovered = await fetchJson(`${baseUrl}${audioPath}/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.body.data, {
    messageId: assistant.id,
    state: 'failed',
    mediaId: null,
    failureCode: 'VOICE_PROVIDER_MISCONFIGURED',
    retryable: false,
  });

  const afterFirst = JSON.parse(await readFile(filePath, 'utf8'));
  const generations = afterFirst.mediaGenerations.filter((entry) => (
    entry.ownerMessageId === assistant.id && entry.kind === 'assistant_voice'
  ));
  assert.equal(generations.length, 1);
  assert.equal(generations[0].attempt, 1);
  assert.equal(afterFirst.mediaAssets.some((asset) => asset.kind === 'assistant_voice'), false);
  assert.equal(afterFirst.events.some((event) => event.type === 'audio.ready' && event.messageId === assistant.id), false);
  const ttsBuckets = afterFirst.rateLimitBuckets
    .filter((bucket) => bucket.quota === 'tts-10m' || bucket.quota === 'tts-day')
    .map((bucket) => [bucket.quota, bucket.count])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(ttsBuckets, [['tts-10m', 1], ['tts-day', 1]]);
  const ownedMessage = await store.getOwnedAssistantMessage({
    sessionId: session.body.data.session.id,
    messageId: assistant.id,
  });
  assert.equal(ownedMessage.mediaId ?? null, null);

  const beforeReplay = await readFile(filePath, 'utf8');
  const replay = await fetchJson(`${baseUrl}${audioPath}`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(replay.response.status, 503);
  assert.equal(replay.body.error.code, 'VOICE_PROVIDER_MISCONFIGURED');
  assert.equal(await readFile(filePath, 'utf8'), beforeReplay, 'permanent replay never reclaims quota or creates another generation');
});

test('candidate-controlled TTS provider rejection preserves canonical text and emits paired failure timing', async (t) => {
  const {
    baseUrl, origin, store, mediaStore, cleanupService, config,
  } = await startVoiceApp(t);
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const { createTtsProvider } = await import('../src/providers/tts.js');
  const { createVoiceService } = await import('../src/services/voice.js');
  const { createAcceptanceTimingRecorder } = await import('../src/telemetry/acceptance-timings.js');
  let clock = new Date('2026-08-25T00:00:10.000Z').getTime();
  let providerFetches = 0;
  const recorder = createAcceptanceTimingRecorder({ releaseCommitSha: 'a'.repeat(40), now: () => clock });
  const provider = createTtsProvider({
    config: config.tts,
    now: () => { clock += 5; return clock; },
    fetchImpl: async () => { providerFetches += 1; throw new Error('must reject before transport'); },
  });
  const service = createVoiceService({
    config, store, mediaStore, cleanupService, ttsProvider: provider,
    now: () => new Date(clock += 5),
    acceptanceTimingRecorder: recorder,
    spoolParentDirectory: join((await mkdtemp(join(tmpdir(), 'hb-controlled-tts-'))), 'voice-spool'),
  });
  const timingContext = {
    windowId: 'c'.repeat(64), sessionId: session.body.data.session.id,
    correlationId: '99999999-9999-4999-8999-999999999999',
    controlledTtsFailure: true, requestedAtMs: clock,
  };

  await assert.rejects(
    service.generateAssistantAudio({
      sessionId: session.body.data.session.id, messageId: assistant.id, acceptanceContext: timingContext,
    }),
    (error) => error.code === 'VOICE_SYNTHESIS_REJECTED',
  );
  assert.equal(providerFetches, 0, 'the real provider adapter must reject the controlled empty input before transport');
  const canonical = await store.getOwnedAssistantMessage({ sessionId: session.body.data.session.id, messageId: assistant.id });
  assert.equal(canonical.status, 'delivered');
  assert.equal(canonical.text, 'Durable assistant text survives TTS.');
  const status = await service.getAssistantAudioStatus({ sessionId: session.body.data.session.id, messageId: assistant.id });
  assert.deepEqual(status.data, {
    messageId: assistant.id, state: 'failed', mediaId: null,
    failureCode: 'VOICE_SYNTHESIS_REJECTED', retryable: false,
  });
  assert.deepEqual(
    recorder.query({ windowId: timingContext.windowId, sessionId: timingContext.sessionId }).samples
      .filter(({ operation }) => operation === 'tts')
      .map(({ bindingId, durationMs, layer, outcome, failureCode }) => ({ bindingId, durationMs, layer, outcome, failureCode })),
    [
      { bindingId: assistant.id, durationMs: null, layer: 'provider', outcome: 'failure', failureCode: 'VOICE_SYNTHESIS_REJECTED' },
      { bindingId: assistant.id, durationMs: null, layer: 'server', outcome: 'failure', failureCode: 'VOICE_SYNTHESIS_REJECTED' },
    ],
  );
});

test('text-mode assistant audio is rejected before HTTP provider work and by the atomic claim fence', async (t) => {
  let ttsCalls = 0;
  const { baseUrl, origin, store, mediaStore } = await startVoiceApp(t, {
    ttsProvider: {
      provider: 'azure',
      synthesize: async () => {
        ttsCalls += 1;
        return { buffer: Buffer.from([0x49, 0x44, 0x33, 0x04]), mimeType: 'audio/mpeg', provider: 'azure', latencyMs: 1 };
      },
    },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const assistant = await createDeliveredAssistant(
    store, session.body.data.session, session.body.data.conversation,
    { replyLanguage: 'en', replyMode: 'text' },
  );

  const response = await fetchJson(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(response.response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
  const claim = await store.claimAssistantAudioWithRateLimits({
    sessionId: session.body.data.session.id,
    messageId: assistant.id,
    kind: 'assistant_voice',
    rateLimits: [],
    leaseToken: 'text-mode-lease',
    attemptStorageKey: mediaStore.createAttemptKey({ kind: 'tts' }),
    configVersion: 'test',
    leaseExpiresAt: new Date(Date.now() + 30_000),
    attemptDeadlineAt: new Date(Date.now() + 60_000),
    now: new Date(),
  });
  assert.equal(claim.status, 'conflict');
  assert.equal(ttsCalls, 0);
});

test('durable voice recovery after store restart is bounded and does not duplicate attached TTS', async (t) => {
  const { LocalMediaStore } = await import('../src/stores/local-media-store.js');
  const { createVoiceService } = await import('../src/services/voice.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-voice-recovery-'));
  const filePath = join(directory, 'store.json');
  const firstStore = new AtomicFileStore({ filePath });
  await firstStore.init();
  const owner = await firstStore.createOrResumeSession({
    tokenHash: 'd'.repeat(64), now: '2026-08-25T00:00:00.000Z',
  });
  const assistant = await createDeliveredAssistant(
    firstStore, owner.session, owner.conversation,
    { replyLanguage: 'yue-Hant-HK', replyMode: 'voice' },
  );
  await firstStore.close();

  const store = new AtomicFileStore({ filePath });
  const mediaStore = new LocalMediaStore({ rootDirectory: join(directory, 'media') });
  await store.init();
  await mediaStore.init();
  t.after(async () => { await mediaStore.close(); await store.close(); });
  const config = loadConfig({
    NODE_ENV: 'test', V1_PUBLIC_ORIGIN: 'https://voice.example.test', V1_SESSION_SECRET: 'v'.repeat(32),
    V1_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'fake-only', AZURE_SPEECH_REGION: 'eastasia',
  });
  let ttsCalls = 0;
  const service = createVoiceService({
    config,
    store,
    mediaStore,
    ttsProvider: {
      provider: 'azure',
      async synthesize() {
        ttsCalls += 1;
        return { buffer: Buffer.from([0x49, 0x44, 0x33, 0x04]), mimeType: 'audio/mpeg', provider: 'azure', latencyMs: 1 };
      },
    },
  });

  const recovered = await service.recoverAssistantAudio({ limit: 1 });
  assert.deepEqual(recovered, { scanned: 1, attempted: 1, attached: 1, limit: 1 });
  const message = await store.getOwnedAssistantMessage({ sessionId: owner.session.id, messageId: assistant.id });
  assert.match(message.mediaId, /^[0-9a-f-]{36}$/i);
  assert.equal(ttsCalls, 1);
  assert.deepEqual(
    await service.recoverAssistantAudio({ limit: 1 }),
    { scanned: 0, attempted: 0, attached: 0, limit: 1 },
  );
  assert.equal(ttsCalls, 1);
});

test('assistant audio recovery candidates defer a live generation until its lease expires', async (t) => {
  const { store } = await createStore(t, 'hb-v1-live-voice-recovery-');
  const owner = await store.createOrResumeSession({
    tokenHash: 'e'.repeat(64), now: '2026-08-25T00:00:00.000Z',
  });
  const assistant = await createDeliveredAssistant(store, owner.session, owner.conversation);
  const claimed = await store.claimAssistantAudioWithRateLimits({
    sessionId: owner.session.id,
    messageId: assistant.id,
    kind: 'assistant_voice',
    rateLimits: [],
    leaseToken: 'dead-worker-lease',
    attemptStorageKey: 'attempts/tts/dead-worker.mp3',
    configVersion: 'test',
    leaseExpiresAt: '2026-08-25T00:00:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:00:35.000Z',
    now: '2026-08-25T00:00:06.000Z',
  });
  assert.equal(claimed.status, 'claimed');

  assert.deepEqual(await store.listAssistantAudioRecoveryCandidates({
    limit: 1, now: '2026-08-25T00:00:10.000Z',
  }), []);
  assert.deepEqual(
    (await store.listAssistantAudioRecoveryCandidates({
      limit: 1, now: '2026-08-25T00:00:21.000Z',
    })).map((candidate) => candidate.id),
    [assistant.id],
  );
});

test('assistant audio recovery excludes permanent failures so newer voice messages remain eligible', async (t) => {
  const { store } = await createStore(t, 'hb-v1-terminal-voice-recovery-');
  const owner = await store.createOrResumeSession({
    tokenHash: 'f'.repeat(64), now: '2026-08-25T00:00:00.000Z',
  });
  const terminal = await createDeliveredAssistant(store, owner.session, owner.conversation);
  const claim = await store.claimAssistantAudioWithRateLimits({
    sessionId: owner.session.id,
    messageId: terminal.id,
    kind: 'assistant_voice',
    rateLimits: [],
    leaseToken: 'permanent-failure-lease',
    attemptStorageKey: 'attempts/tts/permanent-failure.mp3',
    configVersion: 'test',
    leaseExpiresAt: '2026-08-25T00:00:20.000Z',
    attemptDeadlineAt: '2026-08-25T00:00:35.000Z',
    now: '2026-08-25T00:00:06.000Z',
  });
  await store.failMediaGeneration({
    generationId: claim.generation.id,
    leaseToken: 'permanent-failure-lease',
    failureCode: 'VOICE_SYNTHESIS_REJECTED',
    failureHttpStatus: 502,
    retryable: false,
    now: '2026-08-25T00:00:07.000Z',
  });
  const newer = await createDeliveredAssistant(store, owner.session, owner.conversation, {
    clientMessageId: '87654321-4321-4321-8321-ba0987654321',
    requestHash: 'newer-assistant-fixture-request',
  });

  const candidates = await store.listAssistantAudioRecoveryCandidates({
    limit: 25, now: '2026-08-25T00:00:08.000Z',
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), [newer.id]);
});

test('durable voice recovery checks release evidence before scanning storage or provider readiness', async () => {
  const { createVoiceService } = await import('../src/services/voice.js');
  const config = loadConfig({
    NODE_ENV: 'test', V1_PUBLIC_ORIGIN: 'https://voice.example.test', V1_SESSION_SECRET: 'v'.repeat(32),
    V1_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'fake-only', AZURE_SPEECH_REGION: 'eastasia',
  });
  config.publicStatus = { ...config.publicStatus, voiceOutputPreview: false };
  config.getPublicStatus = () => ({ ...config.publicStatus });
  let scans = 0;
  let providerCalls = 0;
  const service = createVoiceService({
    config,
    store: {
      async listAssistantAudioRecoveryCandidates() { scans += 1; return []; },
    },
    mediaStore: {},
    ttsProvider: { async synthesize() { providerCalls += 1; } },
  });

  await assert.rejects(
    service.recoverAssistantAudio(),
    (error) => error.code === 'VOICE_NOT_RELEASE_VERIFIED',
  );
  await assert.rejects(
    service.generateAssistantAudio({ sessionId: 'owned-session', messageId: 'owned-assistant' }),
    (error) => error.code === 'VOICE_NOT_RELEASE_VERIFIED',
  );
  assert.equal(scans, 0);
  assert.equal(providerCalls, 0);
});

test('voice HTTP opt-in TTS keeps text, generates once, and media GET Range HEAD 416 and ownership stay private', async (t) => {
  let ttsCalls = 0;
  const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x05, 0x06]);
  const { baseUrl, origin, store, mediaStore } = await startVoiceApp(t, {
    ttsProvider: { provider: 'azure', synthesize: async () => { ttsCalls += 1; return { buffer: audioBytes, mimeType: 'audio/mpeg', provider: 'azure', latencyMs: 1 }; } },
  });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const created = await fetchJson(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'client override', voice: 'unsafe' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.state, 'attached');
  const reused = await fetchJson(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(reused.response.status, 200);
  assert.equal(ttsCalls, 1);
  const mediaId = created.body.data.mediaId;
  const status = await fetchJson(`${baseUrl}/api/v1/messages/${assistant.id}/audio/status`, { headers: { Cookie: cookie } });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.data.state, 'attached');

  const full = await fetch(`${baseUrl}/api/v1/media/${mediaId}`, { headers: { Cookie: cookie } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(audioBytes.length));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), audioBytes);
  for (const [range, expected] of [['bytes=1-3', audioBytes.subarray(1, 4)], ['bytes=2-', audioBytes.subarray(2)], ['bytes=-2', audioBytes.subarray(-2)]]) {
    const partial = await fetch(`${baseUrl}/api/v1/media/${mediaId}`, { headers: { Cookie: cookie, Range: range } });
    assert.equal(partial.status, 206, range);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected, range);
  }
  const unsatisfiable = await fetchJson(`${baseUrl}/api/v1/media/${mediaId}`, { headers: { Cookie: cookie, Range: 'bytes=99-100' } });
  assert.equal(unsatisfiable.response.status, 416);
  assert.equal(unsatisfiable.response.headers.get('content-range'), `bytes */${audioBytes.length}`);
  for (const range of ['bytes=0-1,2-3', 'items=0-1', 'bytes=-0', 'bytes=4-2', 'bytes=999999999999999999999999-']) {
    const invalid = await fetchJson(`${baseUrl}/api/v1/media/${mediaId}`, { headers: { Cookie: cookie, Range: range } });
    assert.equal(invalid.response.status, 416, range);
    assert.equal(invalid.response.headers.get('content-range'), `bytes */${audioBytes.length}`, range);
  }
  const head = await fetch(`${baseUrl}/api/v1/media/${mediaId}`, { method: 'HEAD', headers: { Cookie: cookie, Range: 'bytes=1-2' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(audioBytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const other = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const otherCookie = other.response.headers.getSetCookie()[0].split(';')[0];
  const originalOpen = mediaStore.open.bind(mediaStore);
  let opens = 0;
  mediaStore.open = async (...arguments_) => { opens += 1; return originalOpen(...arguments_); };
  const denied = await fetchJson(`${baseUrl}/api/v1/media/${mediaId}`, { headers: { Cookie: otherCookie, Range: 'bytes=0-1' } });
  assert.equal(denied.response.status, 404);
  assert.equal(denied.response.headers.get('accept-ranges'), null);
  assert.equal(denied.response.headers.get('content-range'), null);
  assert.equal(opens, 0);
  assert.equal((await store.listMessages({ sessionId: session.body.data.session.id, conversationId: session.body.data.conversation.id, after: 0 })).at(-1).text, 'Durable assistant text survives TTS.');
});

test('voice draft and session deletion revoke ownership first and durably delete media after the safety horizon', async (t) => {
  let clock = new Date('2026-08-25T03:00:00.000Z');
  const now = () => new Date(clock);
  const { baseUrl, origin, store, mediaStore, cleanupService } = await startVoiceApp(t, { now });
  const session = await fetchJson(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  const audio = canonicalWav(250);
  const upload = async (clientUploadId) => fetchJson(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'audio/wav',
      'X-Client-Upload-Id': clientUploadId,
      'X-Content-SHA256': createHash('sha256').update(audio).digest('hex'),
      'X-ASR-Language': 'yue-Hant-HK',
      'Content-Length': String(audio.length),
    },
    body: audio,
  });

  const disposable = await upload('dddddddd-0000-4000-8000-000000000000');
  assert.equal(disposable.response.status, 201);
  const disposableAsset = await store.getMediaAsset({
    sessionId: session.body.data.session.id,
    mediaId: disposable.body.data.voiceDraftId,
  });
  const draftDeleted = await fetchJson(`${baseUrl}/api/v1/voice/drafts/${disposable.body.data.voiceDraftId}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(draftDeleted.response.status, 200);
  const deletedRetry = await upload('dddddddd-0000-4000-8000-000000000000');
  assert.equal(deletedRetry.response.status, 404);
  assert.equal(deletedRetry.body.error.code, 'VOICE_DRAFT_DELETED');
  await assert.rejects(mediaStore.open({ storageKey: disposableAsset.storageKey }), { code: 'MEDIA_NOT_FOUND' });

  const retainedDraft = await upload('eeeeeeee-0000-4000-8000-000000000000');
  assert.equal(retainedDraft.response.status, 201);
  const retainedDraftAsset = await store.getMediaAsset({
    sessionId: session.body.data.session.id,
    mediaId: retainedDraft.body.data.voiceDraftId,
  });
  const assistant = await createDeliveredAssistant(store, session.body.data.session, session.body.data.conversation);
  const generated = await fetchJson(`${baseUrl}/api/v1/messages/${assistant.id}/audio`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(generated.response.status, 201);
  const generatedAsset = await store.getMediaAsset({
    sessionId: session.body.data.session.id,
    mediaId: generated.body.data.mediaId,
  });

  const deleted = await fetchJson(`${baseUrl}/api/v1/session`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.body.data, { deleted: true });
  const revoked = await fetchJson(`${baseUrl}/api/v1/voice/uploads/eeeeeeee-0000-4000-8000-000000000000`, {
    headers: { Cookie: cookie },
  });
  assert.equal(revoked.response.status, 401);
  assert.deepEqual(await readableBuffer((await mediaStore.open({ storageKey: retainedDraftAsset.storageKey })).readable), audio);

  clock = new Date(clock.getTime() + 61_000);
  for (let index = 0; index < 4; index += 1) await cleanupService.drainOnce();
  assert.deepEqual(await readableBuffer((await mediaStore.open({ storageKey: retainedDraftAsset.storageKey })).readable), audio);
  clock = new Date(clock.getTime() + 60_000);
  for (let index = 0; index < 4; index += 1) await cleanupService.drainOnce();
  await assert.rejects(mediaStore.open({ storageKey: retainedDraftAsset.storageKey }), { code: 'MEDIA_NOT_FOUND' });
  await assert.rejects(mediaStore.open({ storageKey: generatedAsset.storageKey }), { code: 'MEDIA_NOT_FOUND' });
});
