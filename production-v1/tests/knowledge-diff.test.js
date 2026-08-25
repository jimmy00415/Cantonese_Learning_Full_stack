import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

const CANONICAL_URL = 'https://ito.hkbu.edu.hk/help/';
const SOURCE_ID = 'hkbu.ito.help';
const CHECKED_AT = '2026-08-26T04:00:00.000Z';
const BASELINE_PATH = resolve('reviewed-knowledge-baseline.json');
const URL_DIGEST = 'e61899ac1c76aa37e65f0ca8cd8cfdc3862ded83a9ce287ac792c9f3e58c5f26';
const NORMALIZED_DIGEST = '3fa149761c2994056da2ffc1cbee177b9fdf9885c036b3573775a91b4fda1d0d';
const SAFE_ROW_KEYS = [
  'change',
  'checkedAt',
  'errorCode',
  'normalizedContentSha256',
  'sourceId',
  'status',
  'urlDigest',
];
const REQUIRED_INTENT_GROUPS = [
  'student_card',
  'account_password',
  'duo',
  'it_help',
  'residence_check_in',
  'campus_ar_navigation',
  'library',
  'dining',
  'medical',
  'osa_counselling',
  'transport',
  'emergency',
  'hall_facilities',
  'hall_maintenance',
  'international_support',
  'orientation',
  'dining_inventory',
  'language_learning',
  'living_supplies',
];

const modulePromise = import('../scripts/knowledge-diff.js').catch(() => null);

async function knowledgeDiffModule() {
  const subject = await modulePromise;
  assert.equal(
    typeof subject?.runKnowledgeDiff,
    'function',
    'scripts/knowledge-diff.js must export runKnowledgeDiff',
  );
  return subject;
}

async function runKnowledgeDiff(options) {
  const subject = await knowledgeDiffModule();
  return subject.runKnowledgeDiff(options);
}

async function runKnowledgeDiffCli(options) {
  const subject = await knowledgeDiffModule();
  assert.equal(
    typeof subject.runKnowledgeDiffCli,
    'function',
    'scripts/knowledge-diff.js must export runKnowledgeDiffCli',
  );
  return subject.runKnowledgeDiffCli(options);
}

function validCorpus({ canonicalUrl = CANONICAL_URL, claim = {} } = {}) {
  const sourceLocator = 'Information Technology Office help page';
  const verifiedAt = '2026-08-25T12:00:00+08:00';
  const reviewAfter = claim.reviewAfter ?? '2026-09-25T12:00:00+08:00';
  const reviewHorizonDays = Math.max(
    1,
    Math.ceil((new Date(reviewAfter) - new Date(verifiedAt)) / (24 * 60 * 60 * 1_000)),
  );
  const sourceReviewCadence = reviewHorizonDays >= 31 ? 'monthly'
    : (reviewHorizonDays >= 14 ? 'biweekly' : (reviewHorizonDays >= 7 ? 'weekly' : 'daily'));
  const sourceEvidenceWindowDays = { daily: 1, weekly: 7, biweekly: 14, monthly: 31 }[
    sourceReviewCadence
  ];
  return {
    schemaVersion: '1.0.0',
    snapshotAt: '2026-08-25T12:00:00+08:00',
    governance: {
      owner: 'Hong Kong Buddy knowledge owner',
      reviewCadence: 'Weekly',
      timeZone: 'Asia/Hong_Kong',
    },
    sources: [{
      id: SOURCE_ID,
      title: 'Information Technology Office help',
      publisher: 'Hong Kong Baptist University Information Technology Office',
      canonicalUrl,
      verifiedAt,
      risk: 'normal',
      sourceGovernance: {
        ownerOffice: 'HKBU Office of Information Technology',
        categories: [...REQUIRED_INTENT_GROUPS],
        languages: ['en'],
        volatility: sourceReviewCadence,
        reviewCadence: sourceReviewCadence,
        evidenceWindowDays: sourceEvidenceWindowDays,
        reviewAttestation: {
          reviewer: 'knowledge-owner',
          reviewedAt: '2026-08-25T12:00:00+08:00',
          captureMethod: 'manual_review',
          sourceHash: null,
        },
      },
      intentGroups: [...REQUIRED_INTENT_GROUPS],
      tags: [],
      exampleQuestions: [],
      claims: [{
        id: 'evidence.ito.help',
        text: {
          en: 'Use the official help page.',
          zhHant: '請使用官方支援頁面。',
          zhHans: '请使用官方支持页面。',
        },
        sourceId: SOURCE_ID,
        sourceLocator,
        evidenceNote: 'Manually reviewed official support route.',
        verifiedAt,
        validFrom: null,
        validUntil: null,
        reviewAfter,
        volatility: 'monthly',
        verificationStatus: 'official_verified',
        reviewAttestation: {
          reviewer: 'knowledge-owner',
          reviewedAt: '2026-08-25T12:00:00+08:00',
          sourceLocator,
          captureMethod: 'manual_review',
          sourceHash: null,
        },
        ...claim,
      }],
    }],
  };
}

function response(body, {
  status = 200,
  contentType = 'text/html; charset=utf-8',
  headers = {},
  url = CANONICAL_URL,
} = {}) {
  const value = new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      ...headers,
    },
  });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}

function trackedResponse(body, { stall = false, ...options } = {}) {
  let cancellationCount = 0;
  const stream = new ReadableStream({
    start(controller) {
      if (body) controller.enqueue(new TextEncoder().encode(body));
      if (!stall) controller.close();
    },
    cancel() {
      cancellationCount += 1;
    },
  });
  return {
    response: response(stream, options),
    cancellationCount: () => cancellationCount,
  };
}

function assertSafeRow(row) {
  assert.deepEqual(Object.keys(row).sort(), SAFE_ROW_KEYS);
  assert.equal(typeof row.sourceId, 'string');
  assert.match(row.urlDigest, /^[0-9a-f]{64}$/);
  assert.match(row.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(['changed', 'unchanged', 'unknown'].includes(row.change));
  assert.ok(['verified', 'stale', 'unverified', 'conflicted'].includes(row.status));
  assert.ok(row.normalizedContentSha256 === null
    || /^[0-9a-f]{64}$/.test(row.normalizedContentSha256));
  assert.ok(row.errorCode === null || /^[A-Z][A-Z0-9_]+$/.test(row.errorCode));
}

test('monitor reads the validated canonical URL and emits only an unchanged safe hash row', async () => {
  const calls = [];
  const corpus = validCorpus();
  const before = structuredClone(corpus);
  const rows = await runKnowledgeDiff({
    corpus,
    baselineDigests: { [SOURCE_ID]: NORMALIZED_DIGEST },
    now: () => new Date(CHECKED_AT),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response('  HKBU\r\n support \t hours  ', {
        headers: { 'set-cookie': 'private-session=must-not-leak' },
      });
    },
  });

  assert.deepEqual(rows, [{
    sourceId: SOURCE_ID,
    urlDigest: URL_DIGEST,
    status: 'verified',
    checkedAt: CHECKED_AT,
    normalizedContentSha256: NORMALIZED_DIGEST,
    change: 'unchanged',
    errorCode: null,
  }]);
  assertSafeRow(rows[0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CANONICAL_URL);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  const requestHeaders = new Headers(calls[0].options.headers);
  assert.equal(requestHeaders.has('cookie'), false);
  assert.match(requestHeaders.get('accept') ?? '', /text\/html/);
  assert.deepEqual(corpus, before);
  assert.equal(JSON.stringify(rows).includes('private-session'), false);
  assert.equal(JSON.stringify(rows).includes(CANONICAL_URL), false);
});

test('content changes become unverified human-review candidates without mutating governance data', async () => {
  const corpus = validCorpus();
  const before = structuredClone(corpus);
  const rows = await runKnowledgeDiff({
    corpus,
    baselineDigests: { [SOURCE_ID]: '0'.repeat(64) },
    now: () => new Date(CHECKED_AT),
    fetchImpl: async () => response('Changed official page'),
  });

  assert.deepEqual(rows, [{
    sourceId: SOURCE_ID,
    urlDigest: URL_DIGEST,
    status: 'unverified',
    checkedAt: CHECKED_AT,
    normalizedContentSha256: '2da049063e478e54588e1ce033e97eb7d16e2b7104540a5716874efc6b49664e',
    change: 'changed',
    errorCode: 'CONTENT_CHANGE_REVIEW_REQUIRED',
  }]);
  assert.deepEqual(corpus, before);
  assertSafeRow(rows[0]);
});

test('a missing baseline is reported as unknown without inventing a content decision', async () => {
  const rows = await runKnowledgeDiff({
    corpus: validCorpus(),
    now: () => new Date(CHECKED_AT),
    fetchImpl: async () => response('private-password raw-body-excerpt'),
  });

  assert.equal(rows[0].status, 'verified');
  assert.equal(rows[0].change, 'unknown');
  assert.equal(rows[0].errorCode, null);
  assertSafeRow(rows[0]);
  const publicText = JSON.stringify(rows);
  assert.equal(publicText.includes('private-password'), false);
  assert.equal(publicText.includes('raw-body-excerpt'), false);
});

test('invalid or polluted corpus URLs fail validation before any network access', async (t) => {
  const cases = [
    ['non-HTTPS', 'http://ito.hkbu.edu.hk/help/', /must use HTTPS/i],
    ['unapproved exact host', 'https://www.ito.hkbu.edu.hk/help/', /approved HKBU host/i],
    ['credentials', 'https://user:pass@ito.hkbu.edu.hk/help/', /credentials/i],
    ['query', 'https://ito.hkbu.edu.hk/help/?student=private', /query or fragment/i],
  ];

  for (const [name, canonicalUrl, expected] of cases) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      await assert.rejects(
        runKnowledgeDiff({
          corpus: validCorpus({ canonicalUrl }),
          now: () => new Date(CHECKED_AT),
          fetchImpl: async () => {
            fetchCalls += 1;
            return response('must not run');
          },
        }),
        expected,
      );
      assert.equal(fetchCalls, 0);
    });
  }
});

test('redirects, response bounds, and network failures fail closed with redacted output', async (t) => {
  const cases = [
    {
      name: 'cross-host redirect',
      fetchImpl: async () => response('redirect-body-secret', {
        status: 302,
        headers: { location: 'https://accounts.example.test/private?token=secret' },
      }),
      errorCode: 'CROSS_HOST_REDIRECT',
    },
    {
      name: 'unsupported content type',
      fetchImpl: async () => response('{"password":"secret"}', { contentType: 'application/json' }),
      errorCode: 'CONTENT_TYPE_UNSUPPORTED',
    },
    {
      name: 'oversized streamed body',
      fetchImpl: async () => response('x'.repeat(17)),
      maxBodyBytes: 16,
      errorCode: 'BODY_TOO_LARGE',
    },
    {
      name: 'HTTP failure',
      fetchImpl: async () => response('private upstream body', { status: 503 }),
      errorCode: 'HTTP_STATUS_REJECTED',
    },
    {
      name: 'redacted fetch failure',
      fetchImpl: async () => { throw new Error('private-password https://secret.example.test'); },
      errorCode: 'FETCH_FAILED',
    },
    {
      name: 'bounded timeout',
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true });
      }),
      timeoutMs: 10,
      errorCode: 'FETCH_TIMEOUT',
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const rows = await runKnowledgeDiff({
        corpus: validCorpus(),
        baselineDigests: { [SOURCE_ID]: NORMALIZED_DIGEST },
        now: () => new Date(CHECKED_AT),
        fetchImpl: candidate.fetchImpl,
        timeoutMs: candidate.timeoutMs,
        maxBodyBytes: candidate.maxBodyBytes,
      });

      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        sourceId: SOURCE_ID,
        urlDigest: URL_DIGEST,
        status: 'unverified',
        checkedAt: CHECKED_AT,
        normalizedContentSha256: null,
        change: 'unknown',
        errorCode: candidate.errorCode,
      });
      assertSafeRow(rows[0]);
      const publicText = JSON.stringify(rows);
      for (const forbidden of ['password', 'secret.example', 'redirect-body', 'upstream body', 'accounts.example']) {
        assert.equal(publicText.includes(forbidden), false);
      }
    });
  }
});

test('rejected response bodies and a timed-out reader are canceled best-effort', async (t) => {
  const cases = [
    [
      'redirect',
      () => trackedResponse('private redirect body', {
        status: 302,
        headers: { location: 'https://other.example.test/private' },
      }),
      'CROSS_HOST_REDIRECT',
      undefined,
    ],
    [
      'HTTP status',
      () => trackedResponse('private HTTP body', { status: 503 }),
      'HTTP_STATUS_REJECTED',
      undefined,
    ],
    [
      'content type',
      () => trackedResponse('{"private":"body"}', { contentType: 'application/json' }),
      'CONTENT_TYPE_UNSUPPORTED',
      undefined,
    ],
    [
      'timeout after response',
      () => trackedResponse('', { stall: true }),
      'FETCH_TIMEOUT',
      10,
    ],
  ];

  for (const [name, makeResponse, errorCode, timeoutMs] of cases) {
    await t.test(name, async () => {
      const tracked = makeResponse();
      const rows = await runKnowledgeDiff({
        corpus: validCorpus(),
        baselineDigests: { [SOURCE_ID]: NORMALIZED_DIGEST },
        now: () => new Date(CHECKED_AT),
        timeoutMs,
        fetchImpl: async () => tracked.response,
      });

      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      assert.equal(rows[0].errorCode, errorCode);
      assert.equal(tracked.cancellationCount(), 1);
      assertSafeRow(rows[0]);
    });
  }
});

test('conflict, expiry, review overdue, and unverified evidence remain non-verified candidates', async (t) => {
  const cases = [
    ['conflict', { verificationStatus: 'conflicted' }, 'conflicted', 'EVIDENCE_CONFLICTED'],
    [
      'expiry',
      { validUntil: '2026-08-25T20:00:00+08:00' },
      'stale',
      'EVIDENCE_EXPIRED',
    ],
    [
      'review overdue',
      { reviewAfter: '2026-08-25T20:00:00+08:00' },
      'stale',
      'REVIEW_OVERDUE',
    ],
    ['unverified', { verificationStatus: 'unverified' }, 'unverified', 'EVIDENCE_UNVERIFIED'],
  ];

  for (const [name, claim, status, errorCode] of cases) {
    await t.test(name, async () => {
      const rows = await runKnowledgeDiff({
        corpus: validCorpus({ claim }),
        baselineDigests: { [SOURCE_ID]: NORMALIZED_DIGEST },
        now: () => new Date(CHECKED_AT),
        fetchImpl: async () => response('HKBU support hours'),
      });

      assert.equal(rows[0].status, status);
      assert.equal(rows[0].change, 'unchanged');
      assert.equal(rows[0].errorCode, errorCode);
      assertSafeRow(rows[0]);
    });
  }
});

test('governance failures keep their status and reason when the fetch also fails', async (t) => {
  const cases = [
    ['conflict', { verificationStatus: 'conflicted' }, 'conflicted', 'EVIDENCE_CONFLICTED'],
    ['expiry', { validUntil: '2026-08-25T20:00:00+08:00' }, 'stale', 'EVIDENCE_EXPIRED'],
    ['review overdue', { reviewAfter: '2026-08-25T20:00:00+08:00' }, 'stale', 'REVIEW_OVERDUE'],
    ['unverified', { verificationStatus: 'unverified' }, 'unverified', 'EVIDENCE_UNVERIFIED'],
  ];

  for (const [name, claim, status, errorCode] of cases) {
    await t.test(name, async () => {
      const rows = await runKnowledgeDiff({
        corpus: validCorpus({ claim }),
        baselineDigests: { [SOURCE_ID]: NORMALIZED_DIGEST },
        now: () => new Date(CHECKED_AT),
        fetchImpl: async () => { throw new Error('private simultaneous fetch failure'); },
      });

      assert.deepEqual(rows[0], {
        sourceId: SOURCE_ID,
        urlDigest: URL_DIGEST,
        status,
        checkedAt: CHECKED_AT,
        normalizedContentSha256: null,
        change: 'unknown',
        errorCode,
      });
      assertSafeRow(rows[0]);
    });
  }
});

test('CLI requires a reviewed exact baseline and can report unchanged or changed without live network', async (t) => {
  const cases = [
    ['unchanged', NORMALIZED_DIGEST, 0, 'unchanged'],
    ['changed', '0'.repeat(64), 1, 'changed'],
  ];

  for (const [name, baseline, exitCode, change] of cases) {
    await t.test(name, async () => {
      const output = [];
      const errors = [];
      const calls = [];
      const result = await runKnowledgeDiffCli({
        argv: ['--baseline-file', BASELINE_PATH],
        loadCorpus: async () => validCorpus(),
        readTextFile: async (filePath) => {
          calls.push(['read', filePath]);
          return JSON.stringify({ [SOURCE_ID]: baseline });
        },
        fetchImpl: async (url) => {
          calls.push(['fetch', url]);
          return response('HKBU support hours');
        },
        now: () => new Date(CHECKED_AT),
        writeOutput: (line) => output.push(line),
        writeError: (line) => errors.push(line),
      });

      assert.equal(result.exitCode, exitCode);
      assert.equal(result.rows[0].change, change);
      assert.deepEqual(calls, [['read', BASELINE_PATH], ['fetch', CANONICAL_URL]]);
      assert.deepEqual(output, [`${JSON.stringify(result.rows)}\n`]);
      assert.deepEqual(errors, []);
      assertSafeRow(JSON.parse(output[0])[0]);
    });
  }
});

test('CLI rejects missing, unreadable, malformed, unsafe, or incomplete baselines before fetch', async (t) => {
  const invalidBaselines = [
    ['malformed JSON', '{'],
    ['array', '[]'],
    ['missing source', '{}'],
    ['unknown extra source', JSON.stringify({ [SOURCE_ID]: NORMALIZED_DIGEST, 'hkbu.unknown': NORMALIZED_DIGEST })],
    ['uppercase digest', JSON.stringify({ [SOURCE_ID]: NORMALIZED_DIGEST.toUpperCase() })],
    ['nested digest', JSON.stringify({ [SOURCE_ID]: { sha256: NORMALIZED_DIGEST } })],
    ['unsafe extra field', JSON.stringify({ [SOURCE_ID]: NORMALIZED_DIGEST, password: 'private-secret' })],
  ];

  await t.test('missing exact arguments', async () => {
    let loadCalls = 0;
    const errors = [];
    const result = await runKnowledgeDiffCli({
      argv: [],
      loadCorpus: async () => {
        loadCalls += 1;
        return validCorpus();
      },
      writeError: (line) => errors.push(line),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(loadCalls, 0);
    assert.deepEqual(errors, ['KNOWLEDGE_DIFF_NOT_RUN\n']);
  });

  await t.test('unreadable absolute file', async () => {
    let fetchCalls = 0;
    const errors = [];
    const result = await runKnowledgeDiffCli({
      argv: ['--baseline-file', BASELINE_PATH],
      loadCorpus: async () => validCorpus(),
      readTextFile: async () => { throw new Error(`private-password ${BASELINE_PATH}`); },
      fetchImpl: async () => {
        fetchCalls += 1;
        return response('must not fetch');
      },
      writeError: (line) => errors.push(line),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(errors, ['KNOWLEDGE_DIFF_FAILED\n']);
    assert.equal(errors.join('').includes(BASELINE_PATH), false);
    assert.equal(errors.join('').includes('password'), false);
  });

  for (const [name, baselineText] of invalidBaselines) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const output = [];
      const errors = [];
      const result = await runKnowledgeDiffCli({
        argv: ['--baseline-file', BASELINE_PATH],
        loadCorpus: async () => validCorpus(),
        readTextFile: async () => baselineText,
        fetchImpl: async () => {
          fetchCalls += 1;
          return response('must not fetch');
        },
        writeOutput: (line) => output.push(line),
        writeError: (line) => errors.push(line),
      });

      assert.equal(result.exitCode, 1);
      assert.equal(fetchCalls, 0);
      assert.deepEqual(output, []);
      assert.deepEqual(errors, ['KNOWLEDGE_DIFF_FAILED\n']);
      assert.equal(errors.join('').includes('private-secret'), false);
    });
  }
});
