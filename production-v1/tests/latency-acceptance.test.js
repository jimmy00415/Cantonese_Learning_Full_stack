import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import {
  LATENCY_ACCEPTANCE_CONTRACT,
  createLatencyHttpRequester,
  finalizeLatencyAcceptanceRecord,
  inspectGitState,
  nearestRankP95,
  runLatencyAcceptance,
} from '../scripts/production-latency-workload.js';

const COMMIT = '1'.repeat(40);
const ORIGIN = 'https://v1-candidate.example.com';
const MANIFEST_PATH = resolve('latency-asr-fixtures.json');
const CWD = resolve('..');
const NOW = new Date('2026-08-25T12:00:00.000Z');

function exactArgv(origin = ORIGIN, manifestPath = MANIFEST_PATH) {
  return [
    '--candidate-origin', origin,
    '--asr-manifest', manifestPath,
    '--confirm-approved-candidate',
  ];
}

function fixtureSet() {
  const samples = [];
  for (const durationBucketSeconds of [10, 30, 55]) {
    for (const language of ['cantonese', 'english']) {
      for (let index = 0; index < 5; index += 1) {
        const id = `${language}-${durationBucketSeconds}-${index + 1}`;
        const bytes = Buffer.from(`${id}-canonical-wav`.padEnd(64, 'x'));
        samples.push({
          id,
          language,
          durationBucketSeconds,
          durationMs: durationBucketSeconds * 1_000,
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        });
      }
    }
  }
  return samples;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function flushAsyncWork() {
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  await Promise.resolve();
}

function observeSettlement(promise) {
  const observation = { settled: false, status: null, value: null, error: null };
  promise.then(
    (value) => Object.assign(observation, { settled: true, status: 'fulfilled', value }),
    (error) => Object.assign(observation, { settled: true, status: 'rejected', error }),
  );
  return observation;
}

function createHarness({
  environment = { V1_LOAD_TEST_CONFIRM: 'true', V1_RELEASE_COMMIT_SHA: COMMIT },
  argv = exactArgv(),
  gitState = { head: COMMIT, clean: true },
  fixtures = fixtureSet(),
  resultFor,
  requester: requesterOverride,
  writeArtifact: writeArtifactOverride,
  now = () => NOW,
} = {}) {
  const calls = [];
  const outputs = [];
  const artifacts = [];
  const active = { bootstrap: 0, verifyCandidate: 0, text: 0, asr: 0, tts: 0 };
  const maximum = { bootstrap: 0, verifyCandidate: 0, text: 0, asr: 0, tts: 0 };

  const defaultResult = (input) => {
    if (['bootstrap', 'verifyCandidate'].includes(input.operation)) {
      return {
        ok: true,
        session: { sessionIndex: input.sessionIndex },
        capabilities: {
          productionReady: true,
          releaseCommitSha: COMMIT,
          voiceInput: true,
          voiceOutput: true,
        },
      };
    }
    if (input.operation === 'text') {
      return {
        acknowledged: true,
        ackMs: 200,
        processingVisible: true,
        processingVisibleMs: 400,
        delivered: true,
        finalAnswerMs: 7_000,
        messageLost: false,
        assistantReplyCount: 1,
        unsupportedVerifiedClaimCount: 0,
        assistantMessageId: `assistant-${input.sessionIndex}-${input.turnIndex}`,
        providerLatencyMs: 5_500,
        serverLatencyMs: 250,
        privateBody: 'must-not-enter-artifact',
      };
    }
    if (input.operation === 'asr') {
      return {
        ready: true,
        transcriptMs: 5_000,
        providerLatencyMs: 4_400,
        serverLatencyMs: 300,
        transcript: 'private transcript must not enter artifact',
      };
    }
    return {
      ready: true,
      readyMs: 4_000,
      textAvailable: true,
      providerLatencyMs: 3_500,
      serverLatencyMs: 200,
      audio: 'private audio must not enter artifact',
    };
  };

  const requester = requesterOverride ?? (async (input) => {
    calls.push(['request', input]);
    active[input.operation] += 1;
    maximum[input.operation] = Math.max(maximum[input.operation], active[input.operation]);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    active[input.operation] -= 1;
    return resultFor?.(input, defaultResult(input)) ?? defaultResult(input);
  });

  const run = (overrides = {}) => runLatencyAcceptance({
    argv,
    environment,
    cwd: CWD,
    artifactDirectory: resolve('reports', 'latency-test'),
    now,
    inspectGit: async (gitCwd) => {
      calls.push(['git', gitCwd]);
      return gitState;
    },
    loadAsrFixtures: async (manifestPath) => {
      calls.push(['fixtures', manifestPath]);
      return fixtures;
    },
    requester,
    randomUUID: (() => {
      let value = 0;
      return () => `00000000-0000-4000-8000-${String(value += 1).padStart(12, '0')}`;
    })(),
    writeArtifact: writeArtifactOverride ?? (async (input) => {
      calls.push(['write', input.filePath]);
      artifacts.push(input);
    }),
    writeOutput: (line) => outputs.push(line),
    ...overrides,
  });

  return { active, artifacts, calls, maximum, outputs, run };
}

test('nearest-rank P95 is deterministic and the acceptance contract fixes every workload and threshold', () => {
  assert.equal(nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.equal(nearestRankP95(Array.from({ length: 30 }, (_, index) => index + 1)), 29);
  assert.equal(nearestRankP95([300]), 300);
  assert.equal(nearestRankP95([]), null);
  assert.throws(() => nearestRankP95([1, Number.NaN]), /finite/i);

  assert.deepEqual(LATENCY_ACCEPTANCE_CONTRACT, {
    schemaVersion: 1,
    text: {
      sessions: 20,
      turns: 200,
      turnsPerSession: 10,
      concurrency: 5,
      promptMix: { grounded: 80, abstention: 60, casual: 60 },
    },
    asr: {
      requests: 30,
      concurrency: 5,
      durationBucketsSeconds: { 10: 10, 30: 10, 55: 10 },
      languages: { cantonese: 15, english: 15 },
    },
    tts: { requests: 30, concurrency: 5 },
    thresholdsMs: {
      sendAck: 300,
      processingVisible: 500,
      groundedResponse: 8_000,
      asrTranscript: 6_000,
      ttsReady: 5_000,
    },
  });
});

test('command is inert unless exact arguments, explicit load confirmation, frozen SHA, and safe candidate are present', async (t) => {
  const cases = [
    ['missing arguments', { argv: [] }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['missing approval flag', { argv: exactArgv().slice(0, -1) }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['extra argument', { argv: [...exactArgv(), '--force'] }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['relative fixture manifest', { argv: exactArgv(ORIGIN, 'fixtures.json') }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['confirmation absent', { environment: { V1_RELEASE_COMMIT_SHA: COMMIT } }, 'LOAD_TEST_CONFIRMATION_REQUIRED'],
    ['confirmation is not exact lowercase true', { environment: { V1_LOAD_TEST_CONFIRM: 'TRUE', V1_RELEASE_COMMIT_SHA: COMMIT } }, 'LOAD_TEST_CONFIRMATION_REQUIRED'],
    ['release commit missing', { environment: { V1_LOAD_TEST_CONFIRM: 'true' } }, 'RELEASE_COMMIT_INVALID'],
    ['release commit uppercase', { environment: { V1_LOAD_TEST_CONFIRM: 'true', V1_RELEASE_COMMIT_SHA: 'A'.repeat(40) } }, 'RELEASE_COMMIT_INVALID'],
    ['http origin', { argv: exactArgv('http://v1-candidate.example.com') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['origin contains path', { argv: exactArgv(`${ORIGIN}/private`) }, 'CANDIDATE_ORIGIN_INVALID'],
    ['origin contains credentials', { argv: exactArgv('https://user:pass@v1-candidate.example.com') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['origin has explicit port', { argv: exactArgv('https://v1-candidate.example.com:8443') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['localhost', { argv: exactArgv('https://localhost') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['known legacy target', { argv: exactArgv('https://hkbuddy-pilot-0630.azurewebsites.net') }, 'CANDIDATE_ORIGIN_INVALID'],
  ];

  for (const [name, overrides, code] of cases) {
    await t.test(name, async () => {
      const fixture = createHarness(overrides);
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.publicReport, { status: 'not-run', code });
      assert.deepEqual(fixture.calls, []);
      assert.deepEqual(fixture.outputs, [`${JSON.stringify(result.publicReport)}\n`]);
    });
  }
});

test('clean current HEAD must equal the frozen release SHA before fixture or network access', async (t) => {
  for (const [name, gitState] of [
    ['dirty', { head: COMMIT, clean: false }],
    ['different head', { head: '2'.repeat(40), clean: true }],
    ['malformed result', { head: COMMIT, clean: 'true' }],
  ]) {
    await t.test(name, async () => {
      const fixture = createHarness({ gitState });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'RELEASE_GIT_STATE_INVALID');
      assert.deepEqual(fixture.calls, [['git', CWD]]);
    });
  }
});

test('fixture set must contain exactly five Cantonese and five English samples in every 10/30/55 second bucket before network', async (t) => {
  const cases = [
    ['missing sample', (samples) => samples.pop()],
    ['duplicate id', (samples) => { samples[1].id = samples[0].id; }],
    ['wrong language', (samples) => { samples[0].language = 'zh-Hant'; }],
    ['wrong bucket', (samples) => { samples[0].durationBucketSeconds = 12; }],
    ['duration outside approximate bucket', (samples) => { samples[0].durationMs = 12_001; }],
    ['bad lowercase digest', (samples) => { samples[0].sha256 = 'A'.repeat(64); }],
    ['byte length mismatch', (samples) => { samples[0].byteLength += 1; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const samples = fixtureSet();
      mutate(samples);
      const fixture = createHarness({ fixtures: samples });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'ASR_FIXTURE_SET_INVALID');
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['git', 'fixtures']);
    });
  }
});

test('candidate preflight uses the first of exactly 20 sessions and fences a mismatched or unavailable release', async (t) => {
  const cases = [
    ['wrong release', { releaseCommitSha: '2'.repeat(40), productionReady: true, voiceInput: true, voiceOutput: true }, 'CANDIDATE_RELEASE_MISMATCH'],
    ['not production ready', { releaseCommitSha: COMMIT, productionReady: false, voiceInput: true, voiceOutput: true }, 'CANDIDATE_NOT_READY'],
    ['voice input unavailable', { releaseCommitSha: COMMIT, productionReady: true, voiceInput: false, voiceOutput: true }, 'CANDIDATE_NOT_READY'],
    ['voice output unavailable', { releaseCommitSha: COMMIT, productionReady: true, voiceInput: true, voiceOutput: false }, 'CANDIDATE_NOT_READY'],
  ];

  for (const [name, capabilities, code] of cases) {
    await t.test(name, async () => {
      const fixture = createHarness({
        resultFor(input, fallback) {
          return input.operation === 'bootstrap' ? { ...fallback, capabilities } : fallback;
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, code);
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['git', 'fixtures', 'request']);
      assert.equal(fixture.calls.at(-1)[1].operation, 'bootstrap');
      assert.equal(fixture.calls.at(-1)[1].sessionIndex, 0);
    });
  }
});

test('passing run executes the exact workload at concurrency five and writes one safe immutable digest-bound artifact', async () => {
  const fixture = createHarness();
  const result = await fixture.run();

  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.status, 'recorded');
  assert.equal(result.publicReport.code, 'LATENCY_ACCEPTANCE_PASSED');
  assert.match(result.publicReport.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.artifacts.length, 1);

  const requests = fixture.calls.filter(([kind]) => kind === 'request').map(([, input]) => input);
  assert.equal(requests.filter(({ operation }) => operation === 'bootstrap').length, 20);
  assert.equal(requests.filter(({ operation }) => operation === 'text').length, 200);
  assert.equal(requests.filter(({ operation }) => operation === 'asr').length, 30);
  assert.equal(requests.filter(({ operation }) => operation === 'tts').length, 30);
  assert.equal(requests.filter(({ operation }) => operation === 'verifyCandidate').length, 1);
  assert.deepEqual(
    Object.fromEntries(['grounded', 'abstention', 'casual'].map((kind) => [kind, requests.filter((item) => item.operation === 'text' && item.promptClass === kind).length])),
    { grounded: 80, abstention: 60, casual: 60 },
  );
  assert.deepEqual(
    Object.fromEntries([10, 30, 55].map((seconds) => [seconds, requests.filter((item) => item.operation === 'asr' && item.sample.durationBucketSeconds === seconds).length])),
    { 10: 10, 30: 10, 55: 10 },
  );
  assert.deepEqual(
    Object.fromEntries(['cantonese', 'english'].map((language) => [language, requests.filter((item) => item.operation === 'asr' && item.sample.language === language).length])),
    { cantonese: 15, english: 15 },
  );
  const ttsBySession = new Map();
  for (const request of requests.filter(({ operation }) => operation === 'tts')) {
    ttsBySession.set(request.sessionIndex, (ttsBySession.get(request.sessionIndex) ?? 0) + 1);
  }
  assert.equal(Math.max(...ttsBySession.values()), 2, 'TTS requests must stay below the per-session five-per-10-minute quota');
  for (const operation of ['bootstrap', 'text', 'asr', 'tts']) {
    assert.ok(fixture.maximum[operation] <= 5, `${operation} must not exceed concurrency 5`);
  }
  assert.equal(fixture.maximum.text, 5);
  assert.equal(fixture.maximum.asr, 5);
  assert.equal(fixture.maximum.tts, 5);

  const { filePath, record, contents } = fixture.artifacts[0];
  assert.equal(basename(filePath), `${COMMIT}-${record.artifactSha256}.json`);
  assert.deepEqual(record.workload, LATENCY_ACCEPTANCE_CONTRACT);
  assert.deepEqual(record.metrics, {
    sendAck: { sampleCount: 200, p95Ms: 200, thresholdMs: 300, pass: true },
    processingVisible: { sampleCount: 200, p95Ms: 400, thresholdMs: 500, pass: true },
    groundedResponse: { sampleCount: 80, p95Ms: 7_000, thresholdMs: 8_000, pass: true },
    asrTranscript: { sampleCount: 30, p95Ms: 5_000, thresholdMs: 6_000, pass: true },
    ttsReady: { sampleCount: 30, p95Ms: 4_000, thresholdMs: 5_000, pass: true },
  });
  assert.deepEqual(record.invariants, {
    acknowledgedMessageLossCount: 0,
    duplicateAssistantReplyCount: 0,
    unsupportedVerifiedClaimCount: 0,
    ttsFailureTextLossCount: 0,
  });
  assert.deepEqual(record.observations, {
    provider: {
      text: { available: false, sampleCount: 0, p95Ms: null },
      asr: { available: false, sampleCount: 0, p95Ms: null },
      tts: { available: false, sampleCount: 0, p95Ms: null },
    },
    server: {
      text: { available: false, sampleCount: 0, p95Ms: null },
      asr: { available: false, sampleCount: 0, p95Ms: null },
      tts: { available: false, sampleCount: 0, p95Ms: null },
    },
  }, 'fake requester timing fields cannot masquerade as timings exposed by the real public API');
  assert.deepEqual(record.counts, {
    sessionsCreated: 20,
    textTurnsAttempted: 200,
    textTurnsAcknowledged: 200,
    textTurnsDelivered: 200,
    asrRequestsAttempted: 30,
    asrReady: 30,
    ttsRequestsAttempted: 30,
    ttsReady: 30,
  });
  assert.equal(record.commitSha, COMMIT);
  assert.equal(record.candidateOrigin, ORIGIN);
  assert.equal(record.occurredAt, NOW.toISOString());
  assert.equal(record.result, true);
  assert.match(record.fixtureSetSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(finalizeLatencyAcceptanceRecord(record), record);
  assert.equal(record.artifactSha256, createHash('sha256').update(canonicalJson(
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'artifactSha256')),
  )).digest('hex'));
  assert.deepEqual(JSON.parse(contents), record);
  assert.equal(contents.endsWith('\n'), true);

  const publicText = fixture.outputs.join('');
  assert.deepEqual(JSON.parse(publicText), result.publicReport);
  for (const forbidden of [ORIGIN, MANIFEST_PATH, 'private', 'transcript', 'audio', 'canonical-wav']) {
    assert.equal(publicText.includes(forbidden), false);
  }
  const artifactText = JSON.stringify(record);
  for (const forbidden of ['must-not-enter-artifact', 'private transcript', 'private audio', MANIFEST_PATH]) {
    assert.equal(artifactText.includes(forbidden), false);
  }
});

test('nearest-rank threshold overflow or any invariant/count failure records a failed artifact', async (t) => {
  const cases = [
    ['send P95 above 300 ms', (input, result) => input.operation === 'text' ? { ...result, ackMs: 301 } : result],
    ['duplicate assistant reply', (input, result) => input.operation === 'text' && input.turnIndex === 0 ? { ...result, assistantReplyCount: 2 } : result],
    ['unsupported verified claim', (input, result) => input.operation === 'text' && input.turnIndex === 0 ? { ...result, unsupportedVerifiedClaimCount: 1 } : result],
    ['acknowledged message lost', (input, result) => input.operation === 'text' && input.turnIndex === 0 ? { ...result, messageLost: true } : result],
    ['ASR not ready', (input, result) => input.operation === 'asr' && input.sampleIndex === 0 ? { ...result, ready: false, transcriptMs: null } : result],
    ['TTS failure loses text', (input, result) => input.operation === 'tts' && input.requestIndex === 0 ? { ...result, ready: false, readyMs: null, textAvailable: false } : result],
  ];

  for (const [name, resultFor] of cases) {
    await t.test(name, async () => {
      const fixture = createHarness({ resultFor });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.status, 'recorded');
      assert.equal(result.publicReport.code, 'LATENCY_ACCEPTANCE_FAILED');
      assert.equal(fixture.artifacts.length, 1);
      assert.equal(fixture.artifacts[0].record.result, false);
      assert.equal(fixture.artifacts[0].record.artifactSha256, result.publicReport.artifactSha256);
    });
  }
});

test('a release SHA or tracked-cleanliness change during the workload blocks artifact publication', async () => {
  const fixture = createHarness();
  let inspections = 0;
  const result = await fixture.run({
    inspectGit: async (gitCwd) => {
      fixture.calls.push(['git', gitCwd]);
      inspections += 1;
      return inspections === 1 ? { head: COMMIT, clean: true } : { head: COMMIT, clean: false };
    },
  });

  assert.equal(inspections, 2);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.publicReport, { status: 'failed', code: 'RELEASE_GIT_STATE_CHANGED' });
  assert.equal(fixture.artifacts.length, 0);
});

test('a candidate redeploy during the workload is detected with the existing session before artifact publication', async () => {
  const fixture = createHarness({
    resultFor(input, fallback) {
      if (input.operation !== 'verifyCandidate') return fallback;
      return {
        ...fallback,
        capabilities: {
          ...fallback.capabilities,
          releaseCommitSha: '2'.repeat(40),
        },
      };
    },
  });
  const result = await fixture.run();

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.publicReport, { status: 'failed', code: 'CANDIDATE_RELEASE_CHANGED' });
  assert.equal(fixture.calls.filter(([, input]) => input?.operation === 'verifyCandidate').length, 1);
  assert.equal(fixture.artifacts.length, 0);
});

test('real HTTP requester measures ASR after body consumption and stops TTS timing before the text-survival GET', async () => {
  let clock = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/voice/transcriptions') {
      for await (const ignored of options.body) {
        void ignored;
        clock += 1_000;
      }
      clock += 5_000;
      return new Response(JSON.stringify({ data: { state: 'ready' }, error: null }), { status: 201 });
    }
    if (path.endsWith('/audio')) {
      clock += 4_000;
      return new Response(JSON.stringify({ data: { state: 'ready' }, error: null }), { status: 201 });
    }
    if (path === '/api/v1/messages') {
      clock += 2_000;
      return new Response(JSON.stringify({
        data: { messages: [{ id: 'assistant-1', role: 'assistant', status: 'delivered', text: 'Text survives.' }] },
        error: null,
      }), { status: 200 });
    }
    throw new Error(`unexpected fake URL ${url}`);
  };
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchImpl,
    monotonicNow: () => clock,
    sleep: async () => {},
  });
  const bytes = Buffer.alloc(64, 1);
  const asr = await requester({
    operation: 'asr',
    session: { cookie: 'hb_v1_session=fake-local-cookie' },
    clientUploadId: '11111111-1111-4111-8111-111111111111',
    sample: {
      bytes,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  assert.equal(asr.transcriptMs, 5_000, 'the 1-second upload must not enter ASR provider-to-transcript timing');

  clock = 0;
  const tts = await requester({
    operation: 'tts',
    session: { cookie: 'hb_v1_session=fake-local-cookie' },
    assistantMessageId: 'assistant-1',
  });
  assert.equal(tts.readyMs, 4_000, 'the 2-second text-survival GET must not enter TTS-ready timing');
  assert.equal(tts.textAvailable, true);
});

test('real HTTP requester stops and cancels an oversized streamed JSON body before buffering it all', async () => {
  const chunkBytes = 256 * 1_024;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      if (pulls === 10) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'set-cookie': 'hb_v1_session=fake-local-cookie; HttpOnly' },
    }),
  });

  await assert.rejects(
    requester({ operation: 'bootstrap', sessionIndex: 0 }),
    /response too large/,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 6, `expected a bounded read, observed ${pulls} chunks`);
});

test('real HTTP requester aborts and cancels a hung response body at the fetch deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchDeadlineMs: 25,
    fetchImpl: async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }), { status: 200 }),
  });
  const pending = requester({ operation: 'bootstrap', sessionIndex: 0 });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  t.mock.timers.tick(25);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'rejected');
  assert.equal(observation.error?.code, 'LATENCY_HTTP_DEADLINE_EXCEEDED');
  assert.equal(cancelled, true);
});

test('Git inspection is sequential so an early failure cannot orphan a sibling subprocess', async () => {
  const calls = [];
  const executeFile = async (_command, args, options) => {
    calls.push({ args, signal: options.signal });
    if (args[0] === 'rev-parse') throw new Error('safe fake failure');
    return new Promise(() => {});
  };

  await assert.rejects(inspectGitState(CWD, { executeFile }), /safe fake failure/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['rev-parse', '--verify', 'HEAD']);
});

test('real HTTP requester aborts a hung fetch at its operation deadline without exposing the private candidate URL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const privateOrigin = 'https://private-token@v1-candidate.example.com';
  let fetchSignal = null;
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchDeadlineMs: 25,
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      return new Promise(() => {});
    },
  });
  const pending = requester({ operation: 'bootstrap', sessionIndex: 0 });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(fetchSignal instanceof AbortSignal);
  t.mock.timers.tick(25);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'rejected');
  assert.equal(observation.error?.code, 'LATENCY_HTTP_DEADLINE_EXCEEDED');
  assert.equal(fetchSignal.aborted, true);
  assert.equal(String(observation.error).includes(privateOrigin), false);
  assert.equal(String(observation.error).includes(ORIGIN), false);
});

test('poll deadline aborts an in-flight fetch instead of waiting for the fetch deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  let requestCount = 0;
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchDeadlineMs: 1_000,
    pollDeadlineMs: 40,
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ data: { state: 'processing' }, error: null }), { status: 202 });
      }
      return new Promise(() => {});
    },
    sleep: async () => {},
  });
  const bytes = Buffer.alloc(64, 1);
  const pending = requester({
    operation: 'asr',
    session: { cookie: 'hb_v1_session=fake-local-cookie' },
    clientUploadId: '11111111-1111-4111-8111-111111111111',
    sample: {
      bytes,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.equal(requestCount, 2);
  t.mock.timers.tick(40);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'fulfilled');
  assert.deepEqual(observation.value, { ready: false, transcriptMs: null });
  assert.equal(signals[1].aborted, true);
});

test('total latency command deadline aborts a hung custom requester and emits only a safe bounded failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal = null;
  const fixture = createHarness({
    requester: async (_input, context) => {
      requestSignal = context?.signal ?? null;
      return new Promise(() => {});
    },
  });
  const pending = fixture.run({ commandDeadlineMs: 50, requestDeadlineMs: 1_000 });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(requestSignal instanceof AbortSignal);
  t.mock.timers.tick(50);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'fulfilled');
  assert.deepEqual(observation.value.publicReport, {
    status: 'failed',
    code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(fixture.artifacts.length, 0);
  const serialized = fixture.outputs.join('');
  assert.equal(serialized.includes(ORIGIN), false);
  assert.equal(serialized.includes('private-token'), false);
});

test('total latency command deadline is not downgraded to a Git-state error when Git inspection hangs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let gitSignal = null;
  let fixturesRead = false;
  const outputs = [];
  const pending = runLatencyAcceptance({
    argv: exactArgv(),
    environment: { V1_LOAD_TEST_CONFIRM: 'true', V1_RELEASE_COMMIT_SHA: COMMIT },
    cwd: CWD,
    artifactDirectory: resolve('reports', 'latency-test'),
    commandDeadlineMs: 40,
    operationDeadlineMs: 1_000,
    inspectGit: async (_cwd, context) => {
      gitSignal = context?.signal ?? null;
      return new Promise(() => {});
    },
    loadAsrFixtures: async () => {
      fixturesRead = true;
      return fixtureSet();
    },
    requester: async () => { throw new Error('requester must not be reached'); },
    writeOutput: (line) => outputs.push(line),
  });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(gitSignal instanceof AbortSignal);
  t.mock.timers.tick(40);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.deepEqual(observation.value.publicReport, {
    status: 'failed',
    code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  assert.equal(gitSignal.aborted, true);
  assert.equal(fixturesRead, false);
  assert.equal(outputs.join('').includes(ORIGIN), false);
});

test('request failures and artifact failures are fail-closed and never print raw errors, URLs, or fixture paths', async (t) => {
  await t.test('request failure becomes a safe failed measurement', async () => {
    const fixture = createHarness({
      requester: async (input) => {
        fixture.calls.push(['request', input]);
        if (['bootstrap', 'verifyCandidate'].includes(input.operation)) {
          return {
            ok: true,
            session: { sessionIndex: input.sessionIndex },
            capabilities: { productionReady: true, releaseCommitSha: COMMIT, voiceInput: true, voiceOutput: true },
          };
        }
        throw new Error(`private-token at ${ORIGIN}${MANIFEST_PATH}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'LATENCY_ACCEPTANCE_FAILED');
    assert.equal(fixture.artifacts.length, 1);
    const output = fixture.outputs.join('');
    assert.equal(output.includes('private-token'), false);
    assert.equal(output.includes(ORIGIN), false);
    assert.equal(output.includes(MANIFEST_PATH), false);
  });

  await t.test('artifact write failure is safely normalized', async () => {
    const fixture = createHarness({
      writeArtifact: async ({ filePath }) => {
        throw new Error(`private-token ${filePath}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.publicReport, { status: 'failed', code: 'LATENCY_ARTIFACT_WRITE_FAILED' });
    assert.equal(fixture.outputs.join('').includes('private-token'), false);
    assert.equal(fixture.outputs.join('').includes(ORIGIN), false);
  });
});

test('default artifact publication is immutable and cannot overwrite the same frozen-run record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hk-buddy-latency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = createHarness();
  const input = { artifactDirectory: directory };

  const first = await fixture.run({ ...input, writeArtifact: undefined });
  assert.equal(first.exitCode, 0);
  const files = await readdir(directory);
  assert.deepEqual(files, [`${COMMIT}-${first.publicReport.artifactSha256}.json`]);
  const filePath = join(directory, files[0]);
  const original = await readFile(filePath, 'utf8');

  const second = await fixture.run({ ...input, writeArtifact: undefined });
  assert.equal(second.exitCode, 1);
  assert.deepEqual(second.publicReport, { status: 'failed', code: 'LATENCY_ARTIFACT_EXISTS' });
  assert.equal(await readFile(filePath, 'utf8'), original);
});
