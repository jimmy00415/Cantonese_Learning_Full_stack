import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateClaimFreshness,
  loadDefaultCorpus,
  validateCorpus,
} from '../src/knowledge/corpus.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BASELINE_TEXT_LENGTH = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'text/plain',
]);

function monitorError(code) {
  const error = new Error(code);
  error.monitorCode = code;
  return error;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeContent(value) {
  return value
    .replace(/^\uFEFF/u, '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function boundedInteger(value, fallback, maximum, field) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`${field} must be a positive bounded integer`);
  }
  return candidate;
}

function baselineFor(baselineDigests, sourceId) {
  let value;
  if (baselineDigests instanceof Map) {
    value = baselineDigests.get(sourceId);
  } else if (baselineDigests && typeof baselineDigests === 'object' && !Array.isArray(baselineDigests)) {
    value = Object.hasOwn(baselineDigests, sourceId) ? baselineDigests[sourceId] : undefined;
  } else if (baselineDigests !== undefined && baselineDigests !== null) {
    throw new Error('baselineDigests must be a map or object');
  }
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`baseline digest for ${sourceId} must be lowercase SHA-256`);
  }
  return value;
}

function evidenceState(source, instant) {
  const states = source.claims.map((claim) => evaluateClaimFreshness(claim, instant));
  if (states.includes('conflicted')) {
    return { status: 'conflicted', errorCode: 'EVIDENCE_CONFLICTED' };
  }
  if (states.some((state) => state === 'unverified' || state === 'not_yet_valid')) {
    return { status: 'unverified', errorCode: 'EVIDENCE_UNVERIFIED' };
  }
  if (states.includes('expired')) {
    return { status: 'stale', errorCode: 'EVIDENCE_EXPIRED' };
  }
  if (states.includes('review_overdue')) {
    return { status: 'stale', errorCode: 'REVIEW_OVERDUE' };
  }
  return { status: 'verified', errorCode: null };
}

function responseHeader(response, name) {
  return response?.headers && typeof response.headers.get === 'function'
    ? response.headers.get(name)
    : null;
}

function cancelBestEffort(cancel) {
  if (typeof cancel !== 'function') return;
  try {
    Promise.resolve(cancel()).catch(() => {});
  } catch {
    // Cancellation is best-effort; only normalized monitor codes are public.
  }
}

function assertResponseBoundary(response, canonicalUrl) {
  if (!response || !Number.isInteger(response.status)) throw monitorError('FETCH_RESPONSE_INVALID');
  const canonical = new URL(canonicalUrl);
  if (response.status >= 300 && response.status < 400) {
    const location = responseHeader(response, 'location');
    if (location) {
      try {
        const target = new URL(location, canonical);
        if (target.protocol !== canonical.protocol || target.hostname !== canonical.hostname) {
          throw monitorError('CROSS_HOST_REDIRECT');
        }
      } catch (error) {
        if (error?.monitorCode) throw error;
      }
    }
    throw monitorError('REDIRECT_BLOCKED');
  }
  if (response.url && response.url !== canonicalUrl) {
    let target;
    try {
      target = new URL(response.url);
    } catch {
      throw monitorError('REDIRECT_BLOCKED');
    }
    if (target.protocol !== canonical.protocol || target.hostname !== canonical.hostname) {
      throw monitorError('CROSS_HOST_REDIRECT');
    }
    throw monitorError('REDIRECT_BLOCKED');
  }
  if (response.status < 200 || response.status >= 300) {
    throw monitorError('HTTP_STATUS_REJECTED');
  }
  const contentType = (responseHeader(response, 'content-type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw monitorError('CONTENT_TYPE_UNSUPPORTED');
  }
}

async function readBoundedUtf8(response, maxBodyBytes, registerCancellation) {
  const contentLength = responseHeader(response, 'content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBodyBytes) {
    throw monitorError('BODY_TOO_LARGE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw monitorError('FETCH_RESPONSE_INVALID');
  }

  const reader = response.body.getReader();
  registerCancellation(() => reader.cancel());
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw monitorError('FETCH_RESPONSE_INVALID');
      total += value.byteLength;
      if (total > maxBodyBytes) throw monitorError('BODY_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    cancelBestEffort(() => reader.cancel());
    registerCancellation(null);
    throw error;
  }
  registerCancellation(null);

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw monitorError('CONTENT_ENCODING_INVALID');
  }
}

async function fetchNormalizedDigest({ canonicalUrl, fetchImpl, timeoutMs, maxBodyBytes }) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  let cancelActiveBody = null;
  const registerCancellation = (cancel) => {
    cancelActiveBody = typeof cancel === 'function' ? cancel : null;
  };
  const cancelActiveBodyBestEffort = () => {
    const cancel = cancelActiveBody;
    cancelActiveBody = null;
    cancelBestEffort(cancel);
  };
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(monitorError('FETCH_TIMEOUT'));
      controller.abort();
      cancelActiveBodyBestEffort();
    }, timeoutMs);
  });
  const operation = (async () => {
    const response = await fetchImpl(canonicalUrl, {
      credentials: 'omit',
      headers: {
        accept: 'text/html, application/xhtml+xml, text/plain;q=0.8',
        'user-agent': 'HongKongBuddy-KnowledgeMonitor/1.0',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    registerCancellation(() => response?.body?.cancel());
    try {
      assertResponseBoundary(response, canonicalUrl);
      const body = await readBoundedUtf8(response, maxBodyBytes, registerCancellation);
      const normalized = normalizeContent(body);
      if (normalized === '') throw monitorError('CONTENT_EMPTY');
      return digest(normalized);
    } catch (error) {
      cancelActiveBodyBestEffort();
      throw error;
    }
  })();

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    cancelActiveBodyBestEffort();
    if (timedOut) throw monitorError('FETCH_TIMEOUT');
    if (error?.monitorCode) throw error;
    throw monitorError('FETCH_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

export async function runKnowledgeDiff({
  corpus,
  baselineDigests = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs,
  maxBodyBytes,
} = {}) {
  const validated = validateCorpus(corpus);
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  if (typeof now !== 'function') throw new Error('now must be an injected clock function');
  const requestTimeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  const responseMaxBytes = boundedInteger(
    maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    MAX_BODY_BYTES,
    'maxBodyBytes',
  );
  const instant = new Date(now());
  if (Number.isNaN(instant.getTime())) throw new Error('injected clock returned an invalid instant');
  const checkedAt = instant.toISOString();
  const baselines = new Map(validated.sources.map((source) => [
    source.id,
    baselineFor(baselineDigests, source.id),
  ]));

  const rows = [];
  for (const source of validated.sources) {
    const state = evidenceState(source, instant);
    const baseRow = {
      sourceId: source.id,
      urlDigest: digest(source.canonicalUrl),
      status: state.status,
      checkedAt,
      normalizedContentSha256: null,
      change: 'unknown',
      errorCode: state.errorCode,
    };
    try {
      const normalizedContentSha256 = await fetchNormalizedDigest({
        canonicalUrl: source.canonicalUrl,
        fetchImpl,
        timeoutMs: requestTimeoutMs,
        maxBodyBytes: responseMaxBytes,
      });
      const baseline = baselines.get(source.id);
      const change = baseline === null
        ? 'unknown'
        : baseline === normalizedContentSha256 ? 'unchanged' : 'changed';
      rows.push({
        ...baseRow,
        status: change === 'changed' && state.status === 'verified' ? 'unverified' : state.status,
        normalizedContentSha256,
        change,
        errorCode: change === 'changed' && state.errorCode === null
          ? 'CONTENT_CHANGE_REVIEW_REQUIRED'
          : state.errorCode,
      });
    } catch (error) {
      const governanceFailure = state.status !== 'verified';
      rows.push({
        ...baseRow,
        status: governanceFailure ? state.status : 'unverified',
        errorCode: governanceFailure ? state.errorCode : error?.monitorCode ?? 'FETCH_FAILED',
      });
    }
  }
  return rows;
}

function exactBaselinePath(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--baseline-file') return null;
  const filePath = argv[1];
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.json')) {
    return null;
  }
  return filePath;
}

function parseReviewedBaseline(text, corpus) {
  if (typeof text !== 'string' || text.length < 2 || text.length > MAX_BASELINE_TEXT_LENGTH) {
    throw new Error('reviewed baseline is invalid');
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('reviewed baseline is invalid');
  }
  const expectedSourceIds = corpus.sources.map((source) => source.id).sort();
  const suppliedSourceIds = Object.keys(parsed).sort();
  if (expectedSourceIds.length !== suppliedSourceIds.length
    || expectedSourceIds.some((sourceId, index) => sourceId !== suppliedSourceIds[index])) {
    throw new Error('reviewed baseline source set is invalid');
  }
  for (const sourceId of expectedSourceIds) {
    if (typeof parsed[sourceId] !== 'string' || !SHA256.test(parsed[sourceId])) {
      throw new Error('reviewed baseline digest is invalid');
    }
  }
  return parsed;
}

export async function runKnowledgeDiffCli({
  argv = process.argv.slice(2),
  loadCorpus = loadDefaultCorpus,
  readTextFile = (filePath) => readFile(filePath, 'utf8'),
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  writeOutput = (line) => process.stdout.write(line),
  writeError = (line) => process.stderr.write(line),
} = {}) {
  const baselinePath = exactBaselinePath(argv);
  if (!baselinePath) {
    writeError('KNOWLEDGE_DIFF_NOT_RUN\n');
    return { exitCode: 2, rows: null };
  }

  try {
    const corpus = validateCorpus(await loadCorpus());
    const baselineDigests = parseReviewedBaseline(await readTextFile(baselinePath), corpus);
    const rows = await runKnowledgeDiff({ corpus, baselineDigests, fetchImpl, now });
    writeOutput(`${JSON.stringify(rows)}\n`);
    const passed = rows.every((row) => (
      row.status === 'verified'
      && row.change === 'unchanged'
      && row.errorCode === null
    ));
    return { exitCode: passed ? 0 : 1, rows };
  } catch {
    writeError('KNOWLEDGE_DIFF_FAILED\n');
    return { exitCode: 1, rows: null };
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runKnowledgeDiffCli();
  process.exitCode = result.exitCode;
}
