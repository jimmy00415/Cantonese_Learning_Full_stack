import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LATENCY_ACCEPTANCE_CONTRACT,
  createLatencyHttpRequester,
  nearestRankP50,
  validateCanonicalMp3,
} from '../scripts/production-latency-workload.js';
import { runVoiceProviderSmoke } from '../scripts/voice-provider-smoke.js';
import { createAcceptanceTimingRecorder } from '../src/telemetry/acceptance-timings.js';
import { createApp } from '../src/app.js';
import { loadConfig, loadVoiceSmokeConfiguration } from '../src/config.js';
import { createTtsProvider } from '../src/providers/tts.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import {
  finalizeEvidenceRecord,
  validateSpeechEvidence,
  voiceEvidenceContracts,
} from '../src/services/voice-evidence.js';

const COMMIT = '1'.repeat(40);
const PROJECT_NUMBER = '123456789012';
const STABLE_ORIGIN = `https://hkbuddy-api-${PROJECT_NUMBER}.asia-east2.run.app`;
const CANDIDATE_ORIGIN = `https://candidate-${COMMIT.slice(0, 12)}---hkbuddy-api-${PROJECT_NUMBER}.asia-east2.run.app`;

function canonicalWav(durationMs = 100) {
  const pcmBytes = durationMs * 32;
  const buffer = Buffer.alloc(44 + pcmBytes);
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
  buffer.writeUInt32LE(pcmBytes, 40);
  return buffer;
}

function canonicalMp3(marker = 0) {
  const frame = Buffer.alloc(417, marker);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  return frame;
}

test('Task 7C freezes the exact percentile SLOs and multilingual workload', () => {
  assert.equal(nearestRankP50([1, 2, 3, 4]), 2);
  assert.equal(nearestRankP50([]), null);
  assert.deepEqual(LATENCY_ACCEPTANCE_CONTRACT.thresholdsMs, {
    sendAckP95: 300,
    processingVisibleP95: 500,
    groundedResponseP50: 2_500,
    groundedResponseP95: 6_000,
    asr10P50: 2_500,
    asr10P95: 4_000,
    asr30P95: 6_000,
    asr55P95: 6_000,
    ttsReadyP50: 2_500,
    ttsReadyP95: 5_000,
  });
  assert.deepEqual(LATENCY_ACCEPTANCE_CONTRACT.asr.languages, {
    cantonese: 10,
    english: 10,
    mandarin: 10,
  });
  assert.equal(LATENCY_ACCEPTANCE_CONTRACT.text.voiceModeTurns, 30);
});

test('preboot voice smoke configuration has no dependency or prior-evidence circularity', () => {
  const config = loadVoiceSmokeConfiguration({
    V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_RUNTIME_SERVICE_ACCOUNT: 'hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com',
    V1_GOOGLE_CLOUD_PROJECT: 'hkbuddy-prod-v1-20260826',
    V1_ASR_PROVIDER: 'google-stt-v2', V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2', V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts', V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
  });
  assert.equal(config.releaseCommitSha, COMMIT);
  assert.equal(config.asr.provider, 'google-stt-v2');
  assert.equal(config.tts.provider, 'google-tts');
  assert.equal(Object.hasOwn(config, 'databaseUrl'), false);
  assert.equal(Object.hasOwn(config, 'speechEvidence'), false);
});

test('real requester serializes immutable reply tuple and exact grounding IDs', async () => {
  const requests = [];
  let clock = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    clock += 10;
    const path = new URL(url).pathname;
    if (path === '/api/v1/messages' && options.method === 'POST') {
      return new Response(JSON.stringify({
        data: {
          message: { clientMessageId: '11111111-1111-4111-8111-111111111111' },
          turn: { id: 'turn-1' },
        },
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/v1/messages') {
      return new Response(JSON.stringify({ data: {
        activeTurn: { id: 'turn-1', state: 'generating' },
        messages: [
          { role: 'user', clientMessageId: '11111111-1111-4111-8111-111111111111' },
          {
            id: 'assistant-1', turnId: 'turn-1', role: 'assistant', status: 'delivered', text: 'Use the official activation flow.',
            groundingStatus: 'verified',
            citations: [{
              evidenceId: 'evidence.ito.account.student-activation',
              sourceId: 'hkbu.ito.account',
              status: 'verified',
              url: 'https://ito.hkbu.edu.hk/services/account/student-activation',
            }],
          },
        ],
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected path ${path}`);
  };
  const requester = createLatencyHttpRequester({
    candidateOrigin: CANDIDATE_ORIGIN,
    fetchImpl,
    monotonicNow: () => clock,
    sleep: async () => {},
  });

  const result = await requester({
    operation: 'text',
    session: { cookie: 'hb_v1_session=fake' },
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    prompt: 'How do I activate my SSOid?',
    promptClass: 'grounded',
    replyLanguage: 'zhHant',
    replyMode: 'voice',
    expectedGrounding: {
      evidenceId: 'evidence.ito.account.student-activation',
      sourceId: 'hkbu.ito.account',
    },
    acceptanceWindowId: 'a'.repeat(64),
    correlationId: '22222222-2222-4222-8222-222222222222',
  });

  const posted = requests.find(({ options }) => options.method === 'POST');
  assert.deepEqual(JSON.parse(posted.options.body), {
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    text: 'How do I activate my SSOid?',
    replyLanguage: 'zhHant',
    replyMode: 'voice',
  });
  assert.equal(posted.options.headers['X-Acceptance-Window-Id'], 'a'.repeat(64));
  assert.equal(posted.options.headers['X-Acceptance-Correlation-Id'], '22222222-2222-4222-8222-222222222222');
  assert.equal(result.unsupportedVerifiedClaimCount, 0);
});

test('unrelated official citation cannot satisfy the prompt-specific grounding contract', async () => {
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/messages' && options.method === 'POST') {
      return new Response(JSON.stringify({ data: {
        message: { clientMessageId: '11111111-1111-4111-8111-111111111111' }, turn: { id: 'turn-1' },
      } }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { messages: [
      { role: 'user', clientMessageId: '11111111-1111-4111-8111-111111111111' },
      {
        id: 'assistant-1', turnId: 'turn-1', role: 'assistant', status: 'delivered', text: 'Wrong.', groundingStatus: 'verified',
        citations: [{ evidenceId: 'evidence.ito.duo.new-phone', sourceId: 'hkbu.ito.duo', status: 'verified', url: 'https://ito.hkbu.edu.hk/duo' }],
      },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const requester = createLatencyHttpRequester({ candidateOrigin: CANDIDATE_ORIGIN, fetchImpl, sleep: async () => {} });
  const result = await requester({
    operation: 'text', session: { cookie: 'hb_v1_session=fake' },
    clientMessageId: '11111111-1111-4111-8111-111111111111', prompt: 'How do I activate my SSOid?',
    replyLanguage: 'en', replyMode: 'text',
    expectedGrounding: { evidenceId: 'evidence.ito.account.student-activation', sourceId: 'hkbu.ito.account' },
  });
  assert.equal(result.unsupportedVerifiedClaimCount, 1);
});

test('acceptance timing recorder is revision/window/session correlated and content-free', () => {
  const recorder = createAcceptanceTimingRecorder({ releaseCommitSha: COMMIT, now: () => 1_000 });
  const context = {
    windowId: 'b'.repeat(64), sessionId: 'session-1',
    correlationId: '33333333-3333-4333-8333-333333333333',
  };
  recorder.record({ ...context, operation: 'asr', layer: 'provider', latencyMs: 420 });
  recorder.record({ ...context, operation: 'asr', layer: 'server', latencyMs: 500 });
  const queried = recorder.query({ windowId: context.windowId, sessionId: context.sessionId });

  assert.equal(queried.releaseCommitSha, COMMIT);
  assert.match(queried.queryDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(queried.samples.map(({ operation, layer, latencyMs }) => ({ operation, layer, latencyMs })), [
    { operation: 'asr', layer: 'provider', latencyMs: 420 },
    { operation: 'asr', layer: 'server', latencyMs: 500 },
  ]);
  const serialized = JSON.stringify(queried);
  for (const forbidden of ['prompt', 'transcript', 'audio', 'token', 'secret']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
  assert.equal(recorder.query({ windowId: 'c'.repeat(64), sessionId: context.sessionId }).samples.length, 0);
});

test('turn timing binds one acceptance context through delivery to asynchronous TTS', () => {
  let clock = 10_000;
  const recorder = createAcceptanceTimingRecorder({ releaseCommitSha: COMMIT, now: () => clock });
  const context = {
    windowId: 'e'.repeat(64), sessionId: 'session-turn',
    correlationId: '77777777-7777-4777-8777-777777777777',
  };
  assert.equal(recorder.bindTurn({ turnId: 'turn-1', ...context }), true);
  clock += 2_200;
  assert.equal(recorder.completeText({ turnId: 'turn-1', messageId: 'message-1', providerLatencyMs: 1_700 }), true);
  assert.deepEqual(recorder.contextForMessage('message-1'), context);
  const samples = recorder.query({ windowId: context.windowId, sessionId: context.sessionId }).samples;
  assert.deepEqual(samples.map(({ operation, layer, latencyMs }) => ({ operation, layer, latencyMs })), [
    { operation: 'text', layer: 'server', latencyMs: 2_200 },
    { operation: 'text', layer: 'provider', latencyMs: 1_700 },
  ]);
});

test('timing endpoint returns only the authenticated session exact window with a verifiable digest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-task-7c-timing-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://timing.example.test';
  const config = loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 't'.repeat(32) });
  config.releaseCommitSha = COMMIT;
  const recorder = createAcceptanceTimingRecorder({ releaseCommitSha: COMMIT, now: () => 1_000 });
  const app = createApp({ config, store, acceptanceTimingRecorder: recorder });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${baseUrl}/api/v1/session`, {
    method: 'POST', headers: { Origin: origin, 'X-Client-Instance-Id': '44444444-4444-4444-8444-444444444444' },
  });
  const body = await bootstrap.json();
  const cookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  const windowId = 'd'.repeat(64);
  recorder.record({
    windowId, sessionId: body.data.session.id,
    correlationId: '55555555-5555-4555-8555-555555555555',
    operation: 'text', layer: 'server', latencyMs: 321,
  });
  recorder.record({
    windowId, sessionId: 'foreign-session',
    correlationId: '66666666-6666-4666-8666-666666666666',
    operation: 'text', layer: 'server', latencyMs: 999,
  });

  const response = await fetch(`${baseUrl}/api/v1/acceptance/timings?windowId=${windowId}`, { headers: { Cookie: cookie } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.samples.length, 1);
  assert.equal(result.data.samples[0].latencyMs, 321);
  assert.match(result.data.queryDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes('foreign-session'), false);
  const invalid = await fetch(`${baseUrl}/api/v1/acceptance/timings?windowId=wrong`, { headers: { Cookie: cookie } });
  assert.equal(invalid.status, 400);
});

test('canonical MP3 validation rejects magic-only bytes and accepts a complete MPEG frame', () => {
  assert.throws(() => validateCanonicalMp3(Buffer.from([0x49, 0x44, 0x33])), /MP3/i);
  const frame = Buffer.alloc(417, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  const validated = validateCanonicalMp3(frame);
  assert.equal(validated.byteLength, 417);
  assert.equal(validated.sha256, createHash('sha256').update(frame).digest('hex'));
});

test('pinned Google TTS can generate canonical LINEAR16 fixtures separately from product MP3', async () => {
  const requests = [];
  const wav = canonicalWav();
  const provider = createTtsProvider({
    config: { provider: 'google-tts', settings: {
      projectId: 'hkbuddy-prod-v1-20260826', location: 'asia-southeast1',
      credentialVersion: 'runtime-sa-rotation-v1',
      voices: {
        en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
        yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
        zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
      },
    } },
    googleAuthProvider: { fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ audioContent: wav.toString('base64') }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    } },
  });
  const result = await provider.synthesizeLinear16('Non-sensitive fixture', { responseLanguage: 'en' });
  assert.deepEqual(requests[0].audioConfig, { audioEncoding: 'LINEAR16', sampleRateHertz: 16_000 });
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.buffer.equals(wav), true);
});

test('Google speech evidence v2 requires three locales, content-free metrics, decodable audio, and runtime identity', () => {
  const runtimeIdentity = 'hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com';
  const occurredAt = '2026-08-26T00:00:00.000Z';
  const definitions = [
    ['yueHant', 'yue-Hant-HK', 'voice-smoke-yue-v1', 'yue-HK-Chirp3-HD-Achernar'],
    ['en', 'en-US', 'voice-smoke-en-v1', 'en-US-Chirp3-HD-Achernar'],
    ['zhHans', 'cmn-Hans-CN', 'voice-smoke-cmn-v1', 'cmn-CN-Chirp3-HD-Achernar'],
  ];
  const asr = finalizeEvidenceRecord({
    schemaVersion: 2, commitSha: COMMIT, capability: 'asr', provider: 'google-stt-v2',
    contractVersion: voiceEvidenceContracts.googleAsr, providerConfigDigest: 'a'.repeat(64),
    runtimeIdentity, occurredAt, result: 'pass',
    samples: definitions.map(([responseLanguage, locale, referenceId, fixtureVoiceName], index) => ({
      responseLanguage, locale, referenceId, fixtureOrigin: 'google-tts-linear16-v1', fixtureVoiceName,
      fixtureGeneratorContractVersion: 'google-tts-linear16-v1', fixtureGeneratorConfigDigest: 'b'.repeat(64),
      fixtureTtsLatencyMs: 100 + index, fixtureSha256: String(index + 1).repeat(64),
      fixtureDurationMs: 1_000, fixtureByteLength: 32_044,
      transcriptUtf8Bytes: 20, transcriptCodePointCount: 10,
      normalizedReferenceCodePointCount: 10, normalizedEditDistance: 1, normalizedErrorRate: 0.1,
      asrLatencyMs: 200 + index,
    })),
  });
  const tts = finalizeEvidenceRecord({
    schemaVersion: 2, commitSha: COMMIT, capability: 'tts', provider: 'google-tts',
    contractVersion: voiceEvidenceContracts.googleTts, providerConfigDigest: 'b'.repeat(64),
    runtimeIdentity, occurredAt, result: 'pass',
    samples: definitions.map(([responseLanguage, locale, , voiceName], index) => ({
      responseLanguage, locale, voiceName, latencyMs: 100 + index,
      audioSha256: String(index + 4).repeat(64), audioByteLength: 417, decodable: true,
    })),
  });
  const common = { commitSha: COMMIT, runtimeIdentity, now: new Date(occurredAt) };
  assert.equal(validateSpeechEvidence(asr, {
    ...common, expectedVersion: asr.artifactSha256, capability: 'asr', provider: 'google-stt-v2',
    contractVersion: voiceEvidenceContracts.googleAsr, configDigest: 'a'.repeat(64),
    fixtureGeneratorConfigDigest: 'b'.repeat(64),
  }), true);
  assert.equal(validateSpeechEvidence(tts, {
    ...common, expectedVersion: tts.artifactSha256, capability: 'tts', provider: 'google-tts',
    contractVersion: voiceEvidenceContracts.googleTts, configDigest: 'b'.repeat(64),
  }), true);
  const leaked = finalizeEvidenceRecord({ ...asr, samples: asr.samples.map((sample, index) => (
    index === 0 ? { ...sample, transcript: 'must not enter evidence' } : sample
  )) });
  assert.equal(validateSpeechEvidence(leaked, {
    ...common, expectedVersion: leaked.artifactSha256, capability: 'asr', provider: 'google-stt-v2',
    contractVersion: voiceEvidenceContracts.googleAsr, configDigest: 'a'.repeat(64),
    fixtureGeneratorConfigDigest: 'b'.repeat(64),
  }), false);
});

test('Google ASR smoke generates three pinned non-sensitive LINEAR16 fixtures before locale-bound transcription', async () => {
  const runtimeIdentity = 'hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com';
  const environment = {
    NODE_ENV: 'test', V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_GOOGLE_CLOUD_PROJECT: 'hkbuddy-prod-v1-20260826',
    V1_ASR_PROVIDER: 'google-stt-v2', V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2', V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts', V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
  };
  const references = {
    yueHant: '我想知道點樣申請學生證',
    en: 'How do I apply for my student card',
    zhHans: '我想知道怎样申请学生证',
  };
  const generated = [];
  const transcribed = [];
  let written;
  const result = await runVoiceProviderSmoke({
    argv: [
      '--capability', 'asr', '--generate-asr-fixtures-with-pinned-tts',
      '--confirm-real-voice-provider', '--confirm-asr-audio-nonsensitive',
    ],
    environment,
    createTts: () => ({
      synthesizeLinear16: async (text, { responseLanguage }) => {
        generated.push({ text, responseLanguage });
        return { buffer: canonicalWav(100), latencyMs: 10, mimeType: 'audio/wav', provider: 'google-tts' };
      },
    }),
    createAsr: () => ({
      transcribe: async (_bytes, { responseLanguage }) => {
        transcribed.push(responseLanguage);
        return { transcript: references[responseLanguage], latencyMs: 20, provider: 'google-stt-v2' };
      },
    }),
    resolveRuntimeIdentity: async () => runtimeIdentity,
    inspectGit: async () => ({ commitSha: COMMIT, clean: true }),
    writeEvidence: async (record) => { written = record; },
    writeOutput: () => undefined,
    now: () => new Date('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(generated.map(({ responseLanguage }) => responseLanguage), ['yueHant', 'en', 'zhHans']);
  assert.deepEqual(transcribed, ['yueHant', 'en', 'zhHans']);
  assert.equal(written.schemaVersion, 2);
  assert.equal(written.runtimeIdentity, runtimeIdentity);
  assert.equal(written.samples.length, 3);
  const serialized = JSON.stringify({ result, written });
  assert.equal(serialized.includes('"transcript":'), false);
  for (const phrase of Object.values(references)) assert.equal(serialized.includes(phrase), false);

  const ttsLanguages = [];
  let ttsWritten;
  const ttsResult = await runVoiceProviderSmoke({
    argv: ['--capability', 'tts', '--confirm-real-voice-provider'],
    environment,
    createTts: () => ({
      synthesize: async (_text, { responseLanguage }) => {
        ttsLanguages.push(responseLanguage);
        return { buffer: canonicalMp3(ttsLanguages.length), latencyMs: 15, provider: 'google-tts' };
      },
    }),
    resolveRuntimeIdentity: async () => runtimeIdentity,
    inspectGit: async () => ({ commitSha: COMMIT, clean: true }),
    writeEvidence: async (record) => { ttsWritten = record; },
    writeOutput: () => undefined,
    now: () => new Date('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(ttsResult.exitCode, 0);
  assert.deepEqual(ttsLanguages, ['yueHant', 'en', 'zhHans']);
  assert.equal(ttsWritten.samples.every((sample) => sample.decodable === true), true);
});

test('candidate URL shape is SHA bound rather than an arbitrary HTTPS or run.app tag', () => {
  assert.equal(CANDIDATE_ORIGIN, 'https://candidate-111111111111---hkbuddy-api-123456789012.asia-east2.run.app');
  assert.equal(STABLE_ORIGIN, 'https://hkbuddy-api-123456789012.asia-east2.run.app');
});

test('iOS evidence generator is inert without confirmation and only signs a real-device report plus canonical WAV', async (t) => {
  const { runIosVoiceEvidence } = await import('../scripts/ios-voice-evidence.js');
  const directory = await mkdtemp(join(tmpdir(), 'hb-ios-real-device-'));
  const reportPath = join(directory, 'real-device-report.json');
  const wavPath = join(directory, 'captured-canonical.wav');
  const assertions = {
    normalizedCanonicalWav: true, autoStop55Seconds: true, permissionCleanup: true,
    cancelCleanup: true, oneIdempotentUpload: true, editableTranscript: true,
    textFallback: true, noRawContainerUpload: true,
  };
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: 1,
    reportSource: 'real-iphone-safari-manual-v1',
    deviceRunId: '88888888-8888-4888-8888-888888888888',
    deviceModelClass: 'iPhone 15 Pro', iosVersion: '19.0', safariVersion: '19.0',
    captureMimeType: 'audio/mp4', observedAt: '2026-08-26T00:00:00.000Z', assertions,
  }));
  await writeFile(wavPath, canonicalWav(1_000));
  let gitCalls = 0;
  let written;
  const dependencies = {
    environment: { V1_RELEASE_COMMIT_SHA: COMMIT },
    inspectGit: async () => { gitCalls += 1; return { commitSha: COMMIT, clean: true }; },
    writeEvidence: async (record) => { written = record; },
    writeOutput: () => undefined,
    now: () => new Date('2026-08-26T00:01:00.000Z'),
  };
  const inert = await runIosVoiceEvidence({ argv: [], ...dependencies });
  assert.equal(inert.exitCode, 2);
  assert.equal(gitCalls, 0);
  const result = await runIosVoiceEvidence({
    argv: ['--device-report', reportPath, '--canonical-wav', wavPath, '--confirm-real-iphone-safari'],
    ...dependencies,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(gitCalls, 2);
  assert.equal(written.schemaVersion, 2);
  assert.equal(written.deviceRunId, '88888888-8888-4888-8888-888888888888');
  assert.match(written.deviceReportSha256, /^[0-9a-f]{64}$/);
  assert.equal(written.fixtureByteLength, canonicalWav(1_000).length);
  t.after(() => undefined);
});

test('smoke evidence upload is immutable, generation-bound, and returns only a content digest receipt', async () => {
  const { writeImmutableGcsEvidence } = await import('../src/services/gcs-evidence-writer.js');
  let request;
  const record = { schemaVersion: 1, artifactSha256: 'a'.repeat(64), result: 'pass' };
  const receipt = await writeImmutableGcsEvidence({
    bucket: 'hkbuddy-prod-v1-20260826-media',
    objectName: `release-evidence/${COMMIT}/voice-smoke/asr-99999999-9999-4999-8999-999999999999.json`,
    record,
    googleAuthProvider: { fetch: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        bucket: 'hkbuddy-prod-v1-20260826-media',
        name: `release-evidence/${COMMIT}/voice-smoke/asr-99999999-9999-4999-8999-999999999999.json`,
        generation: '123456789',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  assert.equal(new URL(request.url).searchParams.get('ifGenerationMatch'), '0');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(receipt.evidenceGeneration, '123456789');
  assert.equal(receipt.evidenceObjectSha256, createHash('sha256').update(request.init.body).digest('hex'));
  assert.equal(JSON.stringify(receipt).includes(JSON.stringify(record)), false);
});
