import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateCanonicalWav } from '../src/media/canonical-wav.js';

const execFileAsync = promisify(execFile);
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAMPLE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const LEGACY_HOST = 'hkbuddy-pilot-0630.azurewebsites.net';
const DEFAULT_OPERATION_DEADLINE_MS = 30_000;
const DEFAULT_FETCH_DEADLINE_MS = 30_000;
const DEFAULT_POLL_DEADLINE_MS = 30_000;
const DEFAULT_REQUEST_DEADLINE_MS = 45_000;
const DEFAULT_COMMAND_DEADLINE_MS = 20 * 60_000;
const MAX_DEADLINE_MS = 60 * 60_000;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultArtifactDirectory = join(productionRoot, 'reports', 'latency');

export const LATENCY_ACCEPTANCE_CONTRACT = Object.freeze({
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

const PROMPTS = Object.freeze([
  { promptClass: 'grounded', text: 'How do I activate my SSOid?' },
  { promptClass: 'grounded', text: 'What food options are available at HKBU?' },
  { promptClass: 'grounded', text: 'Where can I use my student e-Card?' },
  { promptClass: 'grounded', text: 'How do I set up Duo on a new phone?' },
  { promptClass: 'abstention', text: 'Where can I rent a purple submarine on campus?' },
  { promptClass: 'abstention', text: 'Does HKBU provide free helicopter rides?' },
  { promptClass: 'abstention', text: 'What is the exact queue length at every canteen right now?' },
  { promptClass: 'casual', text: 'Hello, what can you help me with?' },
  { promptClass: 'casual', text: 'Thank you for helping me.' },
  { promptClass: 'casual', text: 'Tell me a short study tip.' },
]);

function deadlineValue(value, fallback) {
  const selected = value === undefined ? fallback : value;
  return Number.isSafeInteger(selected) && selected > 0 && selected <= MAX_DEADLINE_MS
    ? selected
    : null;
}

function deadlineError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deadlineReason(signal, fallbackCode) {
  return signal?.reason instanceof Error ? signal.reason : deadlineError(fallbackCode);
}

function createDeadlineSignal({ timeoutMs, code, parentSignal = null }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deadlineReason(parentSignal, code));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = controller.signal.aborted ? null : setTimeout(() => {
    controller.abort(deadlineError(code));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function withDeadline(operation, { timeoutMs, code, parentSignal = null } = {}) {
  const deadline = createDeadlineSignal({ timeoutMs, code, parentSignal });
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(deadlineReason(deadline.signal, code));
    if (deadline.signal.aborted) rejectOnAbort();
    else deadline.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(deadline.signal)),
      aborted,
    ]);
  } finally {
    deadline.signal.removeEventListener('abort', rejectOnAbort);
    deadline.dispose();
  }
}

function defaultPollSleep(milliseconds, { signal } = {}) {
  return new Promise((resolveSleep, rejectSleep) => {
    let timer = null;
    const abort = () => {
      if (timer !== null) clearTimeout(timer);
      rejectSleep(deadlineReason(signal, 'LATENCY_POLL_DEADLINE_EXCEEDED'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveSleep();
    }, milliseconds);
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function finalizeLatencyAcceptanceRecord(record) {
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return {
    ...payload,
    artifactSha256: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  };
}

export function nearestRankP95(values) {
  if (!Array.isArray(values)) throw new TypeError('latency samples must be an array');
  if (values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('latency samples must contain finite non-negative numbers');
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(0.95 * ordered.length) - 1];
}

function exactArguments(argv) {
  if (!Array.isArray(argv)
    || argv.length !== 5
    || argv[0] !== '--candidate-origin'
    || typeof argv[1] !== 'string'
    || argv[2] !== '--asr-manifest'
    || typeof argv[3] !== 'string'
    || !isAbsolute(argv[3])
    || extname(argv[3]).toLowerCase() !== '.json'
    || argv[4] !== '--confirm-approved-candidate') return null;
  return { candidateOrigin: argv[1], asrManifestPath: argv[3] };
}

function safeCandidateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:'
    || value !== url.origin
    || url.username || url.password || url.port
    || !host || isIP(host) !== 0
    || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')
    || host === LEGACY_HOST
    || !host.includes('.')
    || !/^[a-z0-9.-]+$/.test(host)
    || host.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  return url.origin;
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'));
}

function fixtureDescriptor(sample) {
  return {
    byteLength: sample.byteLength,
    durationBucketSeconds: sample.durationBucketSeconds,
    durationMs: sample.durationMs,
    id: sample.id,
    language: sample.language,
    sha256: sample.sha256,
  };
}

function validateFixtureSet(samples) {
  if (!Array.isArray(samples) || samples.length !== LATENCY_ACCEPTANCE_CONTRACT.asr.requests) return null;
  const ids = new Set();
  const combinations = new Map();
  const safeSamples = [];
  for (const sample of samples) {
    const bytes = sample?.bytes;
    const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : -1;
    if (!SAMPLE_ID.test(String(sample?.id ?? '')) || ids.has(sample.id)
      || !['cantonese', 'english'].includes(sample?.language)
      || ![10, 30, 55].includes(sample?.durationBucketSeconds)
      || !Number.isFinite(sample?.durationMs)
      || Math.abs(sample.durationMs - sample.durationBucketSeconds * 1_000) > 1_000
      || !SHA256.test(String(sample?.sha256 ?? ''))
      || !Number.isSafeInteger(sample?.byteLength) || sample.byteLength <= 44
      || byteLength !== sample.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== sample.sha256) return null;
    ids.add(sample.id);
    const combination = `${sample.durationBucketSeconds}:${sample.language}`;
    combinations.set(combination, (combinations.get(combination) ?? 0) + 1);
    safeSamples.push({ ...fixtureDescriptor(sample), bytes });
  }
  for (const duration of [10, 30, 55]) {
    for (const language of ['cantonese', 'english']) {
      if (combinations.get(`${duration}:${language}`) !== 5) return null;
    }
  }
  const descriptors = safeSamples.map(fixtureDescriptor).sort((left, right) => left.id.localeCompare(right.id));
  return {
    samples: safeSamples,
    fixtureSetSha256: createHash('sha256').update(canonicalJson(descriptors)).digest('hex'),
  };
}

async function defaultLoadAsrFixtures(manifestPath, { signal } = {}) {
  const raw = await readFile(manifestPath, { encoding: 'utf8', signal });
  if (raw.length > 128 * 1_024) throw new Error('fixture manifest too large');
  const manifest = JSON.parse(raw);
  if (!exactKeys(manifest, ['samples', 'schemaVersion'])
    || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.samples)
    || manifest.samples.length !== LATENCY_ACCEPTANCE_CONTRACT.asr.requests) {
    throw new Error('invalid fixture manifest');
  }
  const samples = [];
  for (const entry of manifest.samples) {
    if (signal?.aborted) throw deadlineReason(signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    if (!exactKeys(entry, ['durationBucketSeconds', 'filePath', 'id', 'language', 'sha256'])
      || !isAbsolute(entry.filePath)
      || extname(entry.filePath).toLowerCase() !== '.wav') throw new Error('invalid fixture entry');
    const bytes = await readFile(entry.filePath, { signal });
    const wav = validateCanonicalWav(bytes, { expectedSha256: entry.sha256 });
    samples.push({
      id: entry.id,
      language: entry.language,
      durationBucketSeconds: entry.durationBucketSeconds,
      durationMs: wav.durationMs,
      byteLength: wav.byteLength,
      sha256: wav.sha256,
      bytes: wav.buffer,
    });
  }
  return samples;
}

export async function inspectGitState(cwd, { signal, executeFile = execFileAsync } = {}) {
  const headResult = await executeFile('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1_024, signal,
  });
  const statusResult = await executeFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1_024, signal,
  });
  return {
    head: headResult.stdout.replace(/[\r\n]+$/, ''),
    clean: statusResult.stdout.length === 0,
  };
}

async function defaultWriteArtifact({ filePath, contents }, { signal } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', signal });
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function finiteLatency(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function latencyMetric(values, expectedCount, thresholdMs) {
  const samples = values.filter((value) => finiteLatency(value) !== null);
  const p95Ms = nearestRankP95(samples);
  return {
    sampleCount: samples.length,
    p95Ms,
    thresholdMs,
    pass: samples.length === expectedCount && p95Ms !== null && p95Ms <= thresholdMs,
  };
}

function normalizeTextResult(value) {
  const acknowledged = value?.acknowledged === true;
  const processingVisible = value?.processingVisible === true;
  const delivered = value?.delivered === true;
  return {
    acknowledged,
    ackMs: acknowledged ? finiteLatency(value?.ackMs) : null,
    processingVisible,
    processingVisibleMs: processingVisible ? finiteLatency(value?.processingVisibleMs) : null,
    delivered,
    finalAnswerMs: delivered ? finiteLatency(value?.finalAnswerMs) : null,
    messageLost: acknowledged && value?.messageLost === true,
    duplicateAssistantReplyCount: Math.max(0, nonNegativeInteger(value?.assistantReplyCount, 0) - 1),
    unsupportedVerifiedClaimCount: nonNegativeInteger(value?.unsupportedVerifiedClaimCount, 0),
    assistantMessageId: delivered && typeof value?.assistantMessageId === 'string' && value.assistantMessageId
      ? value.assistantMessageId : null,
  };
}

function normalizeAsrResult(value) {
  const ready = value?.ready === true;
  return {
    ready,
    transcriptMs: ready ? finiteLatency(value?.transcriptMs) : null,
  };
}

function normalizeTtsResult(value) {
  const ready = value?.ready === true;
  return {
    ready,
    readyMs: ready ? finiteLatency(value?.readyMs) : null,
    textAvailable: value?.textAvailable === true,
  };
}

async function safeRequest(requester, input, {
  parentSignal = null,
  requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS,
} = {}) {
  try {
    const result = await withDeadline(
      (signal) => requester(input, { signal }),
      {
        timeoutMs: requestDeadlineMs,
        code: 'LATENCY_REQUEST_DEADLINE_EXCEEDED',
        parentSignal,
      },
    );
    return result && typeof result === 'object' ? result : null;
  } catch {
    if (parentSignal?.aborted) {
      throw deadlineReason(parentSignal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    return null;
  }
}

function exactCapabilities(value, commitSha) {
  return Boolean(value && typeof value === 'object'
    && value.releaseCommitSha === commitSha
    && value.productionReady === true
    && value.voiceInput === true
    && value.voiceOutput === true);
}

function releaseMatches(value, commitSha) {
  return value?.releaseCommitSha === commitSha;
}

function acceptanceRecord({
  commitSha, candidateOrigin, fixtureSetSha256, occurredAt,
  sessions, textResults, asrResults, ttsResults,
}) {
  const thresholds = LATENCY_ACCEPTANCE_CONTRACT.thresholdsMs;
  const metrics = {
    sendAck: latencyMetric(textResults.map((item) => item.ackMs), 200, thresholds.sendAck),
    processingVisible: latencyMetric(textResults.map((item) => item.processingVisibleMs), 200, thresholds.processingVisible),
    groundedResponse: latencyMetric(
      textResults.filter((item) => item.promptClass === 'grounded').map((item) => item.finalAnswerMs),
      LATENCY_ACCEPTANCE_CONTRACT.text.promptMix.grounded,
      thresholds.groundedResponse,
    ),
    asrTranscript: latencyMetric(asrResults.map((item) => item.transcriptMs), 30, thresholds.asrTranscript),
    ttsReady: latencyMetric(ttsResults.map((item) => item.readyMs), 30, thresholds.ttsReady),
  };
  const invariants = {
    acknowledgedMessageLossCount: textResults.filter((item) => item.messageLost).length,
    duplicateAssistantReplyCount: textResults.reduce((sum, item) => sum + item.duplicateAssistantReplyCount, 0),
    unsupportedVerifiedClaimCount: textResults.reduce((sum, item) => sum + item.unsupportedVerifiedClaimCount, 0),
    ttsFailureTextLossCount: ttsResults.filter((item) => !item.ready && !item.textAvailable).length,
  };
  const counts = {
    sessionsCreated: sessions.filter(Boolean).length,
    textTurnsAttempted: 200,
    textTurnsAcknowledged: textResults.filter((item) => item.acknowledged).length,
    textTurnsDelivered: textResults.filter((item) => item.delivered).length,
    asrRequestsAttempted: 30,
    asrReady: asrResults.filter((item) => item.ready).length,
    ttsRequestsAttempted: 30,
    ttsReady: ttsResults.filter((item) => item.ready).length,
  };
  const unavailable = () => ({ available: false, sampleCount: 0, p95Ms: null });
  const observations = {
    provider: {
      text: unavailable(),
      asr: unavailable(),
      tts: unavailable(),
    },
    server: {
      text: unavailable(),
      asr: unavailable(),
      tts: unavailable(),
    },
  };
  const result = Object.values(metrics).every((metric) => metric.pass)
    && Object.values(invariants).every((count) => count === 0)
    && counts.sessionsCreated === 20
    && counts.textTurnsAcknowledged === 200
    && counts.textTurnsDelivered === 200
    && counts.asrReady === 30
    && counts.ttsReady === 30;
  return finalizeLatencyAcceptanceRecord({
    schemaVersion: 1,
    commitSha,
    candidateOrigin,
    fixtureSetSha256,
    workload: LATENCY_ACCEPTANCE_CONTRACT,
    counts,
    metrics,
    invariants,
    observations,
    occurredAt,
    result,
  });
}

function sameOriginUrl(origin, path) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('cross-origin request refused');
  return url;
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = values.map((value) => value.split(';', 1)[0]).find((value) => value.startsWith('hb_v1_session='));
  return cookie ?? null;
}

function cancelResponseReader(reader) {
  try {
    const cancellation = reader?.cancel?.('bounded response reader stopped');
    void Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best effort; the enclosing operation deadline remains authoritative.
  }
}

async function responseJson(response, { signal = null } = {}) {
  const declaredLength = response?.headers?.get?.('content-length');
  if (/^\d+$/.test(String(declaredLength ?? '').trim())
    && Number(declaredLength) > MAX_RESPONSE_BODY_BYTES) {
    cancelResponseReader(response?.body);
    throw new Error('response too large');
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new Error('response body unavailable');
  }

  const reader = response.body.getReader();
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => {
      cancelResponseReader(reader);
      reject(deadlineReason(signal, 'LATENCY_HTTP_DEADLINE_EXCEEDED'));
    };
    if (signal?.aborted) rejectOnAbort();
    else signal?.addEventListener('abort', rejectOnAbort, { once: true });
  });
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        cancelResponseReader(reader);
        throw new Error('invalid response body');
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        cancelResponseReader(reader);
        throw new Error('response too large');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    signal?.removeEventListener('abort', rejectOnAbort);
    try { reader.releaseLock(); } catch { /* A pending read owns the lock until cancellation settles. */ }
  }
  const text = Buffer.concat(chunks, totalBytes).toString('utf8');
  const value = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function officialCitation(citation) {
  try {
    const url = new URL(citation?.url);
    const host = url.hostname.toLowerCase();
    return citation?.status === 'verified'
      && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (host === 'hkbu.edu.hk' || host.endsWith('.hkbu.edu.hk'));
  } catch {
    return false;
  }
}

function retryDelay(response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(50, Math.min(1_000, seconds * 1_000)) : 100;
}

export function createLatencyHttpRequester({
  candidateOrigin,
  fetchImpl = globalThis.fetch,
  monotonicNow = () => performance.now(),
  sleep = defaultPollSleep,
  fetchDeadlineMs = DEFAULT_FETCH_DEADLINE_MS,
  pollDeadlineMs = DEFAULT_POLL_DEADLINE_MS,
} = {}) {
  fetchDeadlineMs = deadlineValue(fetchDeadlineMs, DEFAULT_FETCH_DEADLINE_MS);
  pollDeadlineMs = deadlineValue(pollDeadlineMs, DEFAULT_POLL_DEADLINE_MS);
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function'
    || fetchDeadlineMs === null || pollDeadlineMs === null) throw new Error('fetch unavailable');

  const fetchJson = (path, options = {}, parentSignal = null) => withDeadline(async (signal) => {
    const response = await fetchImpl(sameOriginUrl(candidateOrigin, path), {
      ...options,
      redirect: 'error',
      signal,
    });
    return { response, body: await responseJson(response, { signal }) };
  }, {
    timeoutMs: fetchDeadlineMs,
    code: 'LATENCY_HTTP_DEADLINE_EXCEEDED',
    parentSignal,
  });

  const poll = async ({ path, session, inspect, parentSignal = null }) => {
    try {
      return await withDeadline(async (pollSignal) => {
        const startedAt = monotonicNow();
        while (monotonicNow() - startedAt <= pollDeadlineMs) {
          const result = await fetchJson(path, { headers: { Cookie: session.cookie } }, pollSignal);
          const inspected = inspect(result);
          if (inspected?.done) return inspected;
          await sleep(retryDelay(result.response), { signal: pollSignal });
        }
        return { done: true, failed: true };
      }, {
        timeoutMs: pollDeadlineMs,
        code: 'LATENCY_POLL_DEADLINE_EXCEEDED',
        parentSignal,
      });
    } catch (error) {
      if (parentSignal?.aborted) throw deadlineReason(parentSignal, 'LATENCY_REQUEST_DEADLINE_EXCEEDED');
      if (error?.code === 'LATENCY_POLL_DEADLINE_EXCEEDED') return { done: true, failed: true };
      throw error;
    }
  };

  return async function request(input, { signal = null } = {}) {
    if (input.operation === 'bootstrap') {
      const { response, body } = await fetchJson('/api/v1/session', {
        method: 'POST', headers: { Origin: candidateOrigin },
      }, signal);
      const cookie = cookieFrom(response);
      return {
        ok: [200, 201].includes(response.status) && Boolean(cookie) && Boolean(body?.data?.session),
        session: cookie ? { cookie, sessionIndex: input.sessionIndex } : null,
        capabilities: body?.data?.capabilities ?? null,
      };
    }

    if (input.operation === 'verifyCandidate') {
      const { response, body } = await fetchJson('/api/v1/session', {
        method: 'POST',
        headers: { Origin: candidateOrigin, Cookie: input.session?.cookie ?? '' },
      }, signal);
      return {
        ok: response.status === 200,
        capabilities: body?.data?.capabilities ?? null,
      };
    }

    if (!input.session?.cookie) return null;
    if (input.operation === 'text') {
      const startedAt = monotonicNow();
      const posted = await fetchJson('/api/v1/messages', {
        method: 'POST',
        headers: { Origin: candidateOrigin, Cookie: input.session.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientMessageId: input.clientMessageId, text: input.prompt }),
      }, signal);
      const acknowledgedAt = monotonicNow();
      const accepted = posted.response.status === 202
        && posted.body?.data?.message?.clientMessageId === input.clientMessageId;
      if (!accepted) return { acknowledged: false };
      const turnId = posted.body.data.turn?.id;
      let processingVisibleMs = null;
      let canonicalUserSeen = false;
      let finalAnswerMs = null;
      let finalMessages = [];
      const final = await poll({
        path: '/api/v1/messages?after=0',
        session: input.session,
        parentSignal: signal,
        inspect({ body }) {
          const data = body?.data;
          const messages = Array.isArray(data?.messages) ? data.messages : [];
          canonicalUserSeen ||= messages.some((message) => message.clientMessageId === input.clientMessageId && message.role === 'user');
          const assistants = messages.filter((message) => message.turnId === turnId && message.role === 'assistant');
          if (processingVisibleMs === null && (data?.activeTurn?.id === turnId || assistants.length > 0)) {
            processingVisibleMs = monotonicNow() - acknowledgedAt;
          }
          if (assistants.some((message) => message.status === 'delivered')) {
            finalAnswerMs = monotonicNow() - acknowledgedAt;
            finalMessages = assistants;
            return { done: true };
          }
          if (data?.activeTurn?.id === turnId && data.activeTurn.state === 'failed') return { done: true, failed: true };
          return { done: false };
        },
      });
      const assistant = finalMessages.find((message) => message.status === 'delivered') ?? null;
      const unsupportedVerifiedClaimCount = assistant?.groundingStatus === 'verified'
        && !(assistant.citations ?? []).some(officialCitation) ? 1 : 0;
      return {
        acknowledged: true,
        ackMs: acknowledgedAt - startedAt,
        processingVisible: processingVisibleMs !== null,
        processingVisibleMs,
        delivered: Boolean(assistant) && !final.failed,
        finalAnswerMs,
        messageLost: !canonicalUserSeen,
        assistantReplyCount: finalMessages.length,
        unsupportedVerifiedClaimCount,
        assistantMessageId: assistant?.id ?? null,
      };
    }

    if (input.operation === 'asr') {
      let uploadCompletedAt = null;
      const bytes = input.sample.bytes;
      const body = (async function* measuredUpload() {
        yield bytes;
        uploadCompletedAt = monotonicNow();
      }());
      const posted = await fetchJson('/api/v1/voice/transcriptions', {
        method: 'POST', duplex: 'half', body,
        headers: {
          Origin: candidateOrigin,
          Cookie: input.session.cookie,
          'Content-Type': 'audio/wav',
          'Content-Length': String(input.sample.byteLength),
          'X-Client-Upload-Id': input.clientUploadId,
          'X-Content-SHA256': input.sample.sha256,
        },
      }, signal);
      const inspect = ({ response, body: value }) => {
        if ([200, 201].includes(response.status) && value?.data?.state === 'ready') {
          return { done: true, ready: true };
        }
        if (response.status !== 202) return { done: true, ready: false };
        return { done: false };
      };
      let outcome = inspect(posted);
      if (!outcome.done) {
        outcome = await poll({
          path: `/api/v1/voice/uploads/${input.clientUploadId}`,
          session: input.session,
          inspect,
          parentSignal: signal,
        });
      }
      return {
        ready: outcome.ready === true && uploadCompletedAt !== null,
        transcriptMs: outcome.ready && uploadCompletedAt !== null ? monotonicNow() - uploadCompletedAt : null,
      };
    }

    if (input.operation === 'tts') {
      const startedAt = monotonicNow();
      const posted = await fetchJson(`/api/v1/messages/${input.assistantMessageId}/audio`, {
        method: 'POST', headers: { Origin: candidateOrigin, Cookie: input.session.cookie },
      }, signal);
      const inspect = ({ response, body }) => {
        if ([200, 201].includes(response.status) && body?.data?.state === 'ready') return { done: true, ready: true };
        if (response.status !== 202) return { done: true, ready: false };
        return { done: false };
      };
      let outcome = inspect(posted);
      if (!outcome.done) {
        outcome = await poll({
          path: `/api/v1/messages/${input.assistantMessageId}/audio/status`,
          session: input.session,
          inspect,
          parentSignal: signal,
        });
      }
      const readyAt = outcome.ready ? monotonicNow() : null;
      const canonical = await fetchJson(
        '/api/v1/messages?after=0',
        { headers: { Cookie: input.session.cookie } },
        signal,
      );
      const textAvailable = canonical.body?.data?.messages?.some((message) => (
        message.id === input.assistantMessageId && message.role === 'assistant'
        && message.status === 'delivered' && typeof message.text === 'string' && message.text.length > 0
      )) === true;
      return {
        ready: outcome.ready === true,
        readyMs: readyAt === null ? null : readyAt - startedAt,
        textAvailable,
      };
    }
    return null;
  };
}

export async function runLatencyAcceptance({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = productionRoot,
  artifactDirectory = defaultArtifactDirectory,
  now = () => new Date(),
  inspectGit = inspectGitState,
  loadAsrFixtures = defaultLoadAsrFixtures,
  requester = null,
  fetchImpl = globalThis.fetch,
  randomUUID = systemRandomUUID,
  writeArtifact = defaultWriteArtifact,
  writeOutput = (line) => process.stdout.write(line),
  operationDeadlineMs = DEFAULT_OPERATION_DEADLINE_MS,
  fetchDeadlineMs = DEFAULT_FETCH_DEADLINE_MS,
  pollDeadlineMs = DEFAULT_POLL_DEADLINE_MS,
  requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS,
  commandDeadlineMs = DEFAULT_COMMAND_DEADLINE_MS,
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) return publish(writeOutput, 2, { status: 'not-run', code: 'LATENCY_ARGUMENTS_REQUIRED' });
  if (environment?.V1_LOAD_TEST_CONFIRM !== 'true') {
    return publish(writeOutput, 2, { status: 'not-run', code: 'LOAD_TEST_CONFIRMATION_REQUIRED' });
  }
  const commitSha = environment?.V1_RELEASE_COMMIT_SHA;
  if (!RELEASE_SHA.test(String(commitSha ?? ''))) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'RELEASE_COMMIT_INVALID' });
  }
  const candidateOrigin = safeCandidateOrigin(selection.candidateOrigin);
  if (!candidateOrigin) return publish(writeOutput, 2, { status: 'not-run', code: 'CANDIDATE_ORIGIN_INVALID' });
  operationDeadlineMs = deadlineValue(operationDeadlineMs, DEFAULT_OPERATION_DEADLINE_MS);
  fetchDeadlineMs = deadlineValue(fetchDeadlineMs, DEFAULT_FETCH_DEADLINE_MS);
  pollDeadlineMs = deadlineValue(pollDeadlineMs, DEFAULT_POLL_DEADLINE_MS);
  requestDeadlineMs = deadlineValue(requestDeadlineMs, DEFAULT_REQUEST_DEADLINE_MS);
  commandDeadlineMs = deadlineValue(commandDeadlineMs, DEFAULT_COMMAND_DEADLINE_MS);
  if (typeof cwd !== 'string' || !isAbsolute(cwd)
    || typeof artifactDirectory !== 'string' || !isAbsolute(artifactDirectory)
    || operationDeadlineMs === null || fetchDeadlineMs === null
    || pollDeadlineMs === null || requestDeadlineMs === null || commandDeadlineMs === null) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'COMMAND_CONTEXT_INVALID' });
  }

  const commandBudget = createDeadlineSignal({
    timeoutMs: commandDeadlineMs,
    code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  const commandOperation = (operation) => withDeadline(operation, {
    timeoutMs: operationDeadlineMs,
    code: 'LATENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: commandBudget.signal,
  });

  try {

  let gitState;
  try {
    gitState = await commandOperation((signal) => inspectGit(cwd, { signal }));
  } catch {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    gitState = null;
  }
  if (!gitState || gitState.head !== commitSha || gitState.clean !== true) {
    return publish(writeOutput, 1, { status: 'failed', code: 'RELEASE_GIT_STATE_INVALID' });
  }

  let fixtureSet;
  try {
    fixtureSet = validateFixtureSet(await commandOperation(
      (signal) => loadAsrFixtures(selection.asrManifestPath, { signal }),
    ));
  } catch {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    fixtureSet = null;
  }
  if (!fixtureSet) return publish(writeOutput, 1, { status: 'failed', code: 'ASR_FIXTURE_SET_INVALID' });

  let occurredAt;
  try {
    const instant = new Date(now());
    if (!Number.isFinite(instant.getTime())) throw new Error('invalid clock');
    occurredAt = instant.toISOString();
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'ACCEPTANCE_TIME_INVALID' });
  }

  let selectedRequester = requester;
  try {
    selectedRequester ??= createLatencyHttpRequester({
      candidateOrigin,
      fetchImpl,
      fetchDeadlineMs,
      pollDeadlineMs,
    });
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'REQUESTER_UNAVAILABLE' });
  }

  const bootstrapInput = (sessionIndex) => ({
    operation: 'bootstrap', candidateOrigin, releaseCommitSha: commitSha, sessionIndex,
  });
  const requestContext = { parentSignal: commandBudget.signal, requestDeadlineMs };
  const firstBootstrap = await safeRequest(selectedRequester, bootstrapInput(0), requestContext);
  if (!firstBootstrap?.ok || !firstBootstrap.session) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_REQUEST_FAILED' });
  }
  if (!releaseMatches(firstBootstrap.capabilities, commitSha)) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_RELEASE_MISMATCH' });
  }
  if (!exactCapabilities(firstBootstrap.capabilities, commitSha)) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_NOT_READY' });
  }

  const remainingIndexes = Array.from({ length: 19 }, (_, index) => index + 1);
  const remaining = await mapConcurrent(remainingIndexes, 5, async (sessionIndex) => {
    const value = await safeRequest(selectedRequester, bootstrapInput(sessionIndex), requestContext);
    return value?.ok && value.session && exactCapabilities(value.capabilities, commitSha) ? value.session : null;
  });
  const sessions = [firstBootstrap.session, ...remaining];

  const textOperational = (await mapConcurrent(sessions.map((session, sessionIndex) => ({ session, sessionIndex })), 5, async ({ session, sessionIndex }) => {
    const turns = [];
    for (let turnIndex = 0; turnIndex < PROMPTS.length; turnIndex += 1) {
      const prompt = PROMPTS[turnIndex];
      const raw = session ? await safeRequest(selectedRequester, {
        operation: 'text', candidateOrigin, releaseCommitSha: commitSha,
        session, sessionIndex, turnIndex,
        prompt: prompt.text, promptClass: prompt.promptClass,
        clientMessageId: randomUUID(),
      }, requestContext) : null;
      turns.push({
        session,
        sessionIndex,
        turnIndex,
        normalized: { ...normalizeTextResult(raw), promptClass: prompt.promptClass },
      });
    }
    return turns;
  })).flat();
  const textResults = textOperational.map((item) => item.normalized);

  const asrResults = await mapConcurrent(fixtureSet.samples, 5, async (sample, sampleIndex) => {
    const sessionIndex = sampleIndex % sessions.length;
    const session = sessions[sessionIndex];
    const raw = session ? await safeRequest(selectedRequester, {
      operation: 'asr', candidateOrigin, releaseCommitSha: commitSha,
      session, sessionIndex, sample, sampleIndex, clientUploadId: randomUUID(),
    }, requestContext) : null;
    return normalizeAsrResult(raw);
  });

  const ttsCandidates = [];
  for (let turnIndex = 0; turnIndex < PROMPTS.length && ttsCandidates.length < 30; turnIndex += 1) {
    for (let sessionIndex = 0; sessionIndex < sessions.length && ttsCandidates.length < 30; sessionIndex += 1) {
      const candidate = textOperational.find((item) => (
        item.sessionIndex === sessionIndex
        && item.turnIndex === turnIndex
        && item.normalized.assistantMessageId
      ));
      if (candidate) ttsCandidates.push(candidate);
    }
  }
  const ttsItems = Array.from({ length: 30 }, (_, requestIndex) => ({ requestIndex, candidate: ttsCandidates[requestIndex] ?? null }));
  const ttsResults = await mapConcurrent(ttsItems, 5, async ({ requestIndex, candidate }) => {
    const raw = candidate ? await safeRequest(selectedRequester, {
      operation: 'tts', candidateOrigin, releaseCommitSha: commitSha,
      session: candidate.session, sessionIndex: candidate.sessionIndex, requestIndex,
      assistantMessageId: candidate.normalized.assistantMessageId,
    }, requestContext) : null;
    return normalizeTtsResult(raw);
  });

  const finalCandidate = await safeRequest(selectedRequester, {
    operation: 'verifyCandidate',
    candidateOrigin,
    releaseCommitSha: commitSha,
    session: sessions[0],
    sessionIndex: 0,
  }, requestContext);
  if (!finalCandidate?.ok || !exactCapabilities(finalCandidate.capabilities, commitSha)) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_RELEASE_CHANGED' });
  }

  const record = acceptanceRecord({
    commitSha, candidateOrigin, fixtureSetSha256: fixtureSet.fixtureSetSha256,
    occurredAt, sessions, textResults, asrResults, ttsResults,
  });
  let finalGitState;
  try {
    finalGitState = await commandOperation((signal) => inspectGit(cwd, { signal }));
  } catch {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    finalGitState = null;
  }
  if (!finalGitState || finalGitState.head !== commitSha || finalGitState.clean !== true) {
    return publish(writeOutput, 1, { status: 'failed', code: 'RELEASE_GIT_STATE_CHANGED' });
  }
  const filePath = join(artifactDirectory, `${commitSha}-${record.artifactSha256}.json`);
  try {
    await commandOperation((signal) => writeArtifact(
      { filePath, contents: `${JSON.stringify(record, null, 2)}\n`, record },
      { signal },
    ));
  } catch (error) {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    const code = error?.code === 'EEXIST' ? 'LATENCY_ARTIFACT_EXISTS' : 'LATENCY_ARTIFACT_WRITE_FAILED';
    return publish(writeOutput, 1, { status: 'failed', code });
  }
  return publish(writeOutput, record.result ? 0 : 1, {
    status: 'recorded',
    code: record.result ? 'LATENCY_ACCEPTANCE_PASSED' : 'LATENCY_ACCEPTANCE_FAILED',
    artifactSha256: record.artifactSha256,
  });
  } catch {
    if (commandBudget.signal.aborted) {
      return publish(writeOutput, 1, {
        status: 'failed',
        code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
      });
    }
    return publish(writeOutput, 1, { status: 'failed', code: 'LATENCY_COMMAND_FAILED' });
  } finally {
    commandBudget.dispose();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runLatencyAcceptance();
  process.exitCode = result.exitCode;
}
