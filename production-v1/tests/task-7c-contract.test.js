import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

import {
  LATENCY_ACCEPTANCE_CONTRACT,
  createLatencyHttpRequester,
  decodeCanonicalMp3,
  nearestRankP50,
  validateCanonicalMp3,
} from '../scripts/production-latency-workload.js';
import { runVoiceProviderSmoke } from '../scripts/voice-provider-smoke.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
import { createAcceptanceTimingRecorder } from '../src/telemetry/acceptance-timings.js';
import { createApp } from '../src/app.js';
import { loadConfig, loadVoiceSmokeConfiguration } from '../src/config.js';
import { createTtsProvider } from '../src/providers/tts.js';
import { validateCanonicalWav } from '../src/media/canonical-wav.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import {
  finalizeEvidenceRecord,
  validateSpeechEvidence,
  voiceEvidenceContracts,
} from '../src/services/voice-evidence.js';
import {
  CANONICAL_MP3_FIXTURE_SHA256,
  canonicalMp3Fixture,
} from './fixtures/canonical-mp3-fixture.js';

const COMMIT = '1'.repeat(40);
const PROJECT_NUMBER = '582852715831';
const STABLE_ORIGIN = `https://hkbuddy-v1-api-${PROJECT_NUMBER}.asia-east2.run.app`;
const CANDIDATE_ORIGIN = `https://candidate-${COMMIT.slice(0, 12)}---hkbuddy-v1-api-candidate-${PROJECT_NUMBER}.asia-east2.run.app`;
const executeFile = promisify(execFile);
const IOS_NORMALIZER_ARGUMENTS = Object.freeze([
  '-nostdin', '-hide_banner', '-loglevel', 'error',
  '-protocol_whitelist', 'file', '-i', 'capture.mp4',
  '-map', '0:a:0', '-map_metadata', '-1', '-vn',
  '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
  '-flags:a', '+bitexact', '-fflags', '+bitexact', '-f', 'wav', 'derived.wav',
]);

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mp4Box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function audioMp4Capture() {
  const ftyp = Buffer.alloc(16);
  ftyp.write('M4A ', 0, 'ascii');
  ftyp.writeUInt32BE(0, 4);
  ftyp.write('isom', 8, 'ascii');
  ftyp.write('mp42', 12, 'ascii');
  return Buffer.concat([
    mp4Box('ftyp', ftyp),
    mp4Box('moov', Buffer.from('test-track-handler-soun-codec-mp4a', 'ascii')),
    mp4Box('mdat', Buffer.from(Array.from({ length: 64 }, (_, index) => (index % 251) + 1))),
  ]);
}

async function generateDecodableMp4Fixture(directory) {
  const rawCapturePath = join(directory, 'generated-source.mp4');
  const wavPath = join(directory, 'generated-derived.wav');
  const options = { cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 };
  await executeFile(ffmpegInstaller.path, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '0.5', '-c:a', 'aac', '-b:a', '64k',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart',
    rawCapturePath,
  ], options);
  await executeFile(ffmpegInstaller.path, IOS_NORMALIZER_ARGUMENTS.map((argument) => {
    if (argument === 'capture.mp4') return rawCapturePath;
    if (argument === 'derived.wav') return wavPath;
    return argument;
  }), options);
  return {
    rawCapture: await readFile(rawCapturePath),
    wavBytes: await readFile(wavPath),
  };
}

function canonicalMp3() {
  return canonicalMp3Fixture();
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
  assert.deepEqual(LATENCY_ACCEPTANCE_CONTRACT.asr.wireLanguages, [
    'en', 'yue-Hant-HK', 'cmn-Hans-CN',
  ]);
  assert.equal(LATENCY_ACCEPTANCE_CONTRACT.text.voiceModeTurns, 31);
  assert.deepEqual(LATENCY_ACCEPTANCE_CONTRACT.tts, {
    requests: 31, successfulRequests: 30, controlledProviderFailures: 1, concurrency: 5,
  });
});

test('preboot voice smoke configuration has no dependency or prior-evidence circularity', () => {
  const config = loadVoiceSmokeConfiguration({
    V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_RUNTIME_SERVICE_ACCOUNT: 'hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    V1_GOOGLE_CLOUD_PROJECT: 'motion-expert-hk-ltd-webpage',
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
              url: 'https://ito.hkbu.edu.hk/services/account-password.html',
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
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'voice',
    expectedGrounding: {
      claimId: 'evidence.ito.account.student-activation',
      evidenceId: 'evidence.ito.account.student-activation',
      sourceId: 'hkbu.ito.account',
      url: 'https://ito.hkbu.edu.hk/services/account-password.html',
    },
    acceptanceWindowId: 'a'.repeat(64),
    correlationId: '22222222-2222-4222-8222-222222222222',
    controlledTtsFailure: true,
  });

  const posted = requests.find(({ options }) => options.method === 'POST');
  assert.deepEqual(JSON.parse(posted.options.body), {
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    text: 'How do I activate my SSOid?',
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'voice',
  });
  assert.equal(posted.options.headers['X-Acceptance-Window-Id'], 'a'.repeat(64));
  assert.equal(posted.options.headers['X-Acceptance-Correlation-Id'], '22222222-2222-4222-8222-222222222222');
  assert.equal(posted.options.headers['X-Acceptance-Controlled-TTS-Failure'], 'provider-rejection-v1');
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
    expectedGrounding: {
      claimId: 'evidence.ito.account.student-activation',
      evidenceId: 'evidence.ito.account.student-activation', sourceId: 'hkbu.ito.account',
      url: 'https://ito.hkbu.edu.hk/services/account-password.html',
    },
  });
  assert.equal(result.unsupportedVerifiedClaimCount, 1);
});

test('grounding oracle rejects extra verified claims and every citation on non-grounded responses', async (t) => {
  const correct = {
    evidenceId: 'evidence.ito.account.student-activation', sourceId: 'hkbu.ito.account',
    status: 'verified', url: 'https://ito.hkbu.edu.hk/services/account-password.html',
  };
  const expectedGrounding = {
    claimId: correct.evidenceId, evidenceId: correct.evidenceId,
    sourceId: correct.sourceId, url: correct.url,
  };
  const evaluate = async ({ promptClass, groundingStatus, citations }) => {
    const fetchImpl = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/messages' && options.method === 'POST') {
        return new Response(JSON.stringify({ data: {
          message: { clientMessageId: '11111111-1111-4111-8111-111111111111' }, turn: { id: 'turn-1' },
        } }), { status: 202 });
      }
      return new Response(JSON.stringify({ data: { messages: [
        { role: 'user', clientMessageId: '11111111-1111-4111-8111-111111111111' },
        {
          id: 'assistant-1', turnId: 'turn-1', role: 'assistant', status: 'delivered', text: 'Visible response.',
          groundingStatus, citations,
        },
      ] } }), { status: 200 });
    };
    return createLatencyHttpRequester({ candidateOrigin: CANDIDATE_ORIGIN, fetchImpl, sleep: async () => {} })({
      operation: 'text', session: { cookie: 'hb_v1_session=fake' },
      clientMessageId: '11111111-1111-4111-8111-111111111111', prompt: 'test',
      promptClass, replyLanguage: 'en', replyMode: 'text', expectedGrounding,
    });
  };

  await t.test('one correct citation plus one extra verified citation fails', async () => {
    const result = await evaluate({
      promptClass: 'grounded', groundingStatus: 'verified',
      citations: [correct, {
        evidenceId: 'evidence.ito.duo.new-phone', sourceId: 'hkbu.ito.duo', status: 'verified',
        url: 'https://ito.hkbu.edu.hk/services/it-security/mfa.html',
      }],
    });
    assert.equal(result.unsupportedVerifiedClaimCount, 1);
  });
  await t.test('an unverified abstention with an official citation fails', async () => {
    const result = await evaluate({
      promptClass: 'abstention', groundingStatus: 'unverified',
      citations: [{ ...correct, status: 'unverified' }],
    });
    assert.equal(result.unsupportedVerifiedClaimCount, 1);
  });
  await t.test('an uncited unverified casual response passes the non-grounded oracle', async () => {
    const result = await evaluate({ promptClass: 'casual', groundingStatus: 'unverified', citations: [] });
    assert.equal(result.unsupportedVerifiedClaimCount, 0);
  });
});

test('acceptance timing recorder is revision/window/session correlated and content-free', () => {
  const recorder = createAcceptanceTimingRecorder({ releaseCommitSha: COMMIT, now: () => 1_000 });
  const context = {
    windowId: 'b'.repeat(64), sessionId: 'session-1',
    correlationId: '33333333-3333-4333-8333-333333333333',
  };
  recorder.record({
    ...context, bindingId: 'upload-1', durationMs: 10_000,
    operation: 'asr', layer: 'provider', latencyMs: 420, outcome: 'success', failureCode: null,
  });
  recorder.record({
    ...context, bindingId: 'upload-1', durationMs: 10_000,
    operation: 'asr', layer: 'server', latencyMs: 500, outcome: 'success', failureCode: null,
  });
  const queried = recorder.query({ windowId: context.windowId, sessionId: context.sessionId });

  assert.equal(queried.releaseCommitSha, COMMIT);
  assert.match(queried.queryDigest, /^[0-9a-f]{64}$/);
  assert.equal(queried.schemaVersion, 2);
  assert.deepEqual(queried.samples, [
    { correlationId: context.correlationId, bindingId: 'upload-1', durationMs: 10_000, operation: 'asr', layer: 'provider', latencyMs: 420, outcome: 'success', failureCode: null },
    { correlationId: context.correlationId, bindingId: 'upload-1', durationMs: 10_000, operation: 'asr', layer: 'server', latencyMs: 500, outcome: 'success', failureCode: null },
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
  assert.equal(recorder.bindTurn({ turnId: 'turn-1', ...context, controlledTtsFailure: true }), true);
  clock += 2_200;
  assert.equal(recorder.completeText({ turnId: 'turn-1', messageId: 'message-1', providerLatencyMs: 1_700 }), true);
  assert.deepEqual(recorder.contextForMessage('message-1'), { ...context, controlledTtsFailure: true });
  clock += 300;
  assert.deepEqual(recorder.beginTts('message-1'), {
    ...context, controlledTtsFailure: true, requestedAtMs: 12_500,
  });
  const samples = recorder.query({ windowId: context.windowId, sessionId: context.sessionId }).samples;
  assert.deepEqual(samples.map(({ bindingId, durationMs, operation, layer, latencyMs, outcome, failureCode }) => ({ bindingId, durationMs, operation, layer, latencyMs, outcome, failureCode })), [
    { bindingId: 'message-1', durationMs: null, operation: 'text', layer: 'server', latencyMs: 2_200, outcome: 'success', failureCode: null },
    { bindingId: 'message-1', durationMs: null, operation: 'text', layer: 'provider', latencyMs: 1_700, outcome: 'success', failureCode: null },
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
    bindingId: 'message-owned', durationMs: null,
    operation: 'text', layer: 'server', latencyMs: 321, outcome: 'success', failureCode: null,
  });
  recorder.record({
    windowId, sessionId: 'foreign-session',
    correlationId: '66666666-6666-4666-8666-666666666666',
    bindingId: 'message-foreign', durationMs: null,
    operation: 'text', layer: 'server', latencyMs: 999, outcome: 'success', failureCode: null,
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

test('canonical MP3 validation traverses every frame and rejects magic-only, pseudo-frame, and truncated bytes', async () => {
  assert.throws(() => validateCanonicalMp3(Buffer.from([0x49, 0x44, 0x33])), /MP3/i);
  const zeroPseudoFrames = Buffer.alloc(834, 0);
  zeroPseudoFrames.set([0xff, 0xfb, 0x90, 0x64], 0);
  zeroPseudoFrames.set([0xff, 0xfb, 0x90, 0x64], 417);
  assert.throws(() => validateCanonicalMp3(zeroPseudoFrames), /payload|pseudo/i);

  const fixture = canonicalMp3Fixture();
  assert.throws(() => validateCanonicalMp3(fixture.subarray(0, -1)), /truncated|frame/i);
  const validated = validateCanonicalMp3(fixture);
  assert.equal(validated.byteLength, 940);
  assert.equal(validated.sha256, CANONICAL_MP3_FIXTURE_SHA256);
  assert.equal(validated.frameCount, 3);
  assert.equal(validated.sampleRate, 44_100);
  assert.equal(validated.channelCount, 1);
  assert.ok(validated.durationMs > 75 && validated.durationMs < 80);

  const decoded = await decodeCanonicalMp3(fixture);
  assert.equal(decoded.decoder, 'mpg123-decoder@1.0.3');
  assert.equal(decoded.decodedSampleCount, 1_199);
  assert.equal(decoded.decodedChannelCount, 2);
  assert.equal(decoded.decodedSampleRate, 44_100);
  assert.ok(decoded.decodedDurationMs > 25 && decoded.decodedDurationMs < 30);
  assert.ok(decoded.durationDeltaMs < 55);
  assert.equal(decoded.sha256, createHash('sha256').update(fixture).digest('hex'));
});

test('independent MP3 decode rejects silent PCM planes but retains bounded low-amplitude audio', async () => {
  const fixture = canonicalMp3Fixture();
  class TestDecoder {
    constructor() { this.ready = Promise.resolve(); }

    decode() {
      return {
        errors: [], samplesDecoded: 1_199, sampleRate: 44_100,
        channelData: [this.left, this.right],
      };
    }

    free() {}
  }

  class SilentDecoder extends TestDecoder {
    constructor() {
      super();
      this.left = new Float32Array(1_199);
      this.right = new Float32Array(1_199);
    }
  }
  await assert.rejects(
    decodeCanonicalMp3(fixture, { Decoder: SilentDecoder }),
    /silent|energy|amplitude/i,
  );

  class LowAmplitudeDecoder extends TestDecoder {
    constructor() {
      super();
      this.left = new Float32Array(1_199).fill(0.000_001);
      this.right = new Float32Array(1_199).fill(-0.000_001);
    }
  }
  const quiet = await decodeCanonicalMp3(fixture, { Decoder: LowAmplitudeDecoder });
  assert.equal(quiet.decodedSampleCount, 1_199);
  assert.equal(quiet.decodedChannelCount, 2);
});

test('pinned Google TTS can generate canonical LINEAR16 fixtures separately from product MP3', async () => {
  const requests = [];
  const wav = canonicalWav();
  const provider = createTtsProvider({
    config: { provider: 'google-tts', settings: {
      projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1',
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
  const runtimeIdentity = 'hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com';
  const occurredAt = '2026-08-26T00:00:00.000Z';
  const definitions = [
    ['yue-Hant-HK', 'yue-Hant-HK', 'voice-smoke-yue-v1', 'yue-HK-Chirp3-HD-Achernar'],
    ['en', 'en-US', 'voice-smoke-en-v1', 'en-US-Chirp3-HD-Achernar'],
    ['cmn-Hans-CN', 'cmn-Hans-CN', 'voice-smoke-cmn-v1', 'cmn-CN-Chirp3-HD-Achernar'],
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
      audioSha256: String(index + 4).repeat(64), audioByteLength: 940,
      decoder: 'mpg123-decoder@1.0.3', decodedSampleCount: 1_199,
      decodedSampleRate: 44_100, decodedChannelCount: 2,
      decodedDurationMs: (1_199 / 44_100) * 1_000, decodable: true,
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
  const fakeDecode = finalizeEvidenceRecord({
    ...tts,
    samples: tts.samples.map((sample, index) => (index === 0
      ? { ...sample, decodedSampleCount: 0, decodedDurationMs: 0 }
      : sample)),
  });
  assert.equal(validateSpeechEvidence(fakeDecode, {
    ...common, expectedVersion: fakeDecode.artifactSha256, capability: 'tts', provider: 'google-tts',
    contractVersion: voiceEvidenceContracts.googleTts, configDigest: 'b'.repeat(64),
  }), false);
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
  const runtimeIdentity = GCP_IDENTITY.serviceAccounts.runtime;
  const environment = {
    NODE_ENV: 'test', V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_GOOGLE_CLOUD_PROJECT: 'motion-expert-hk-ltd-webpage',
    V1_ASR_PROVIDER: 'google-stt-v2', V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2', V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts', V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
  };
  const references = {
    'yue-Hant-HK': '我想知道點樣申請學生證',
    en: 'How do I apply for my student card',
    'cmn-Hans-CN': '我想知道怎样申请学生证',
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
  assert.deepEqual(generated.map(({ responseLanguage }) => responseLanguage), ['yue-Hant-HK', 'en', 'cmn-Hans-CN']);
  assert.deepEqual(transcribed, ['yue-Hant-HK', 'en', 'cmn-Hans-CN']);
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
  assert.deepEqual(ttsLanguages, ['yue-Hant-HK', 'en', 'cmn-Hans-CN']);
  assert.equal(ttsWritten.samples.every((sample) => sample.decodable === true), true);
  assert.equal(ttsWritten.samples.every((sample) => (
    sample.decoder === 'mpg123-decoder@1.0.3'
      && sample.decodedSampleCount === 1_199
      && sample.decodedSampleRate === 44_100
      && sample.decodedChannelCount === 2
      && sample.decodedDurationMs > 0
  )), true);
});

test('candidate URL shape is SHA bound rather than an arbitrary HTTPS or run.app tag', () => {
  assert.equal(CANDIDATE_ORIGIN, 'https://candidate-111111111111---hkbuddy-v1-api-candidate-582852715831.asia-east2.run.app');
  assert.equal(STABLE_ORIGIN, 'https://hkbuddy-v1-api-582852715831.asia-east2.run.app');
});

test('iOS evidence generator derives a decodable AAC fixture with its pinned offline normalizer and rejects forged bindings', async (t) => {
  const { runIosVoiceEvidence } = await import('../scripts/ios-voice-evidence.js');
  const normalizerTempsBefore = (await readdir(tmpdir()))
    .filter((name) => name.startsWith('hkbuddy-ios-normalizer-')).sort();
  const directory = await mkdtemp(join(tmpdir(), 'hb-ios-synthetic-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRunId = '88888888-8888-4888-8888-888888888888';
  const observedAt = '2026-08-26T00:00:00.000Z';
  const stepIds = [
    'permission-prompt-granted', 'recording-auto-stopped-55s',
    'permission-tracks-stopped', 'cancel-stops-tracks',
    'single-idempotent-upload', 'transcript-editable-before-send',
    'text-fallback-after-denial', 'raw-container-not-uploaded',
  ];
  const writeBundle = async ({ label, rawCapture, wavBytes, extraStepFields = {} }) => {
    const wav = validateCanonicalWav(wavBytes);
    const steps = {
      schemaVersion: 2,
      source: 'real-iphone-safari-normalization-v2',
      deviceRunId,
      rawCapture: { sha256: sha256(rawCapture), byteLength: rawCapture.length, mimeType: 'audio/mp4' },
      normalizedWav: {
        sha256: sha256(wavBytes), byteLength: wavBytes.length, durationMs: wav.durationMs,
        normalizerContractVersion: 'canonical-wav-v1',
      },
      ...extraStepFields,
      steps: stepIds.map((id) => ({ id, outcome: 'pass', observedAt })),
    };
    const stepsBytes = Buffer.from(JSON.stringify(steps));
    const report = {
      schemaVersion: 2,
      reportSource: 'real-iphone-safari-manual-v2',
      deviceRunId,
      deviceModelIdentifier: 'iPhone16,1', iosVersion: '19.0', safariVersion: '19.0',
      captureMimeType: 'audio/mp4', observedAt,
      rawCapture: { sha256: sha256(rawCapture), byteLength: rawCapture.length },
      normalizedWav: {
        sha256: sha256(wavBytes), byteLength: wavBytes.length, durationMs: wav.durationMs,
        normalizerContractVersion: 'canonical-wav-v1',
      },
      normalizationSteps: { sha256: sha256(stepsBytes), byteLength: stepsBytes.length },
    };
    const reportBytes = Buffer.from(JSON.stringify(report));
    const reportPath = join(directory, `${label}-report.json`);
    const rawCapturePath = join(directory, `${label}-capture.mp4`);
    const wavPath = join(directory, `${label}-canonical.wav`);
    const stepsPath = join(directory, `${label}-steps.json`);
    await writeFile(rawCapturePath, rawCapture);
    await writeFile(wavPath, wavBytes);
    await writeFile(stepsPath, stepsBytes);
    await writeFile(reportPath, reportBytes);
    return { reportPath, rawCapturePath, wavPath, stepsPath, reportBytes, stepsBytes };
  };
  const invoke = (bundle, dependencies) => runIosVoiceEvidence({
    argv: [
      '--device-report', bundle.reportPath,
      '--raw-capture', bundle.rawCapturePath,
      '--canonical-wav', bundle.wavPath,
      '--normalization-steps', bundle.stepsPath,
      '--confirm-real-iphone-safari',
    ],
    ...dependencies,
  });
  const { rawCapture, wavBytes } = await generateDecodableMp4Fixture(directory);
  const validBundle = await writeBundle({ label: 'valid', rawCapture, wavBytes });
  let gitCalls = 0;
  const written = [];
  const dependencies = {
    environment: { V1_RELEASE_COMMIT_SHA: COMMIT },
    inspectGit: async () => { gitCalls += 1; return { commitSha: COMMIT, clean: true }; },
    writeEvidence: async (record) => { written.push(record); },
    writeOutput: () => undefined,
    now: () => new Date('2026-08-26T00:01:00.000Z'),
  };
  const inert = await runIosVoiceEvidence({ argv: [], ...dependencies });
  assert.equal(inert.exitCode, 2);
  assert.equal(gitCalls, 0);
  const legacyArguments = await runIosVoiceEvidence({
    argv: [
      '--device-report', validBundle.reportPath,
      '--canonical-wav', validBundle.wavPath,
      '--confirm-real-iphone-safari',
    ],
    ...dependencies,
  });
  assert.equal(legacyArguments.exitCode, 2);
  assert.equal(gitCalls, 0);
  const result = await invoke(validBundle, dependencies);
  assert.equal(result.exitCode, 0);
  assert.equal(gitCalls, 2);
  assert.equal(written.length, 1);
  assert.equal(written[0].schemaVersion, 4);
  assert.equal(written[0].deviceRunId, deviceRunId);
  assert.equal(written[0].deviceReportSha256, sha256(validBundle.reportBytes));
  assert.equal(written[0].rawCaptureSha256, sha256(rawCapture));
  assert.equal(written[0].rawCaptureByteLength, rawCapture.length);
  assert.equal(written[0].fixtureSha256, sha256(wavBytes));
  assert.equal(written[0].fixtureByteLength, wavBytes.length);
  assert.equal(written[0].normalizationStepsSha256, sha256(validBundle.stepsBytes));
  assert.deepEqual(written[0].verifiedStepIds, stepIds);
  assert.equal(written[0].normalizerPackage, '@ffmpeg-installer/ffmpeg@1.1.0');
  assert.equal(written[0].normalizerPlatform, `${process.platform}-${process.arch}`);
  assert.equal(
    written[0].normalizerBinarySha256,
    'c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e',
  );
  assert.equal(
    written[0].normalizerVersion,
    'ffmpeg version N-92722-gf22fcd4483 Copyright (c) 2000-2018 the FFmpeg developers',
  );
  assert.deepEqual(written[0].normalizerArguments, IOS_NORMALIZER_ARGUMENTS);
  assert.equal(written[0].normalizerExitCode, 0);
  assert.match(written[0].normalizationBindingSha256, /^[0-9a-f]{64}$/);

  const unrelatedBundle = await writeBundle({
    label: 'unrelated', rawCapture, wavBytes: canonicalWav(2_000),
  });
  const unrelated = await invoke(unrelatedBundle, dependencies);
  assert.equal(unrelated.exitCode, 1);
  assert.equal(unrelated.errorCode, 'IOS_VOICE_EVIDENCE_INVALID');
  assert.equal(written.length, 1);

  const fakeBundle = await writeBundle({
    label: 'marker-only-fake', rawCapture: audioMp4Capture(), wavBytes: canonicalWav(1_000),
  });
  const fake = await invoke(fakeBundle, dependencies);
  assert.equal(fake.exitCode, 1);
  assert.equal(fake.errorCode, 'IOS_VOICE_EVIDENCE_INVALID');
  assert.equal(written.length, 1);

  const selfAttestedNormalizerBundle = await writeBundle({
    label: 'self-attested-normalizer', rawCapture, wavBytes,
    extraStepFields: { normalizer: { tool: 'ffmpeg', exitCode: 0 } },
  });
  const selfAttestedNormalizer = await invoke(selfAttestedNormalizerBundle, dependencies);
  assert.equal(selfAttestedNormalizer.exitCode, 1);
  assert.equal(selfAttestedNormalizer.errorCode, 'IOS_VOICE_EVIDENCE_INVALID');
  assert.equal(written.length, 1);
  const normalizerTempsAfter = (await readdir(tmpdir()))
    .filter((name) => name.startsWith('hkbuddy-ios-normalizer-')).sort();
  assert.deepEqual(normalizerTempsAfter, normalizerTempsBefore);
});

test('smoke evidence upload is immutable, generation-bound, and returns only a content digest receipt', async () => {
  const { writeImmutableGcsEvidence } = await import('../src/services/gcs-evidence-writer.js');
  let request;
  const record = { schemaVersion: 1, artifactSha256: 'a'.repeat(64), result: 'pass' };
  const receipt = await writeImmutableGcsEvidence({
    bucket: 'hkbuddy-v1-582852715831-media',
    objectName: `release-evidence/${COMMIT}/voice-smoke/asr-99999999-9999-4999-8999-999999999999.json`,
    record,
    googleAuthProvider: { fetch: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        bucket: 'hkbuddy-v1-582852715831-media',
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
