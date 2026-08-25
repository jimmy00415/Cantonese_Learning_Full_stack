import assert from 'node:assert/strict';
import test from 'node:test';

import * as releaseEvidence from '../src/services/release-evidence.js';

const COMMIT = '1'.repeat(40);
const NOW = new Date('2026-08-25T12:00:00.000Z');
const CONFIG_DIGEST = 'b14e23a2593170a9749a66ecbcb31229dc2cfe1554dbd3e173661b187602d70b';
const ARTIFACT_DIGEST = 'b6529894d1667eacc6e2d04e097c59bed9cd5144acee7b087f830dbaae086f81';

function validLlmEvidence() {
  return {
    schemaVersion: 1,
    commitSha: COMMIT,
    capability: 'llm',
    provider: 'azure-openai',
    contractVersion: 'llm-connectivity-json-v1',
    providerConfigDigest: CONFIG_DIGEST,
    occurredAt: '2026-08-25T12:00:00.000Z',
    result: 'pass',
    httpClass: '2xx',
    normalizedSuccess: true,
    requestCount: 1,
    latencyMs: 123,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    artifactSha256: ARTIFACT_DIGEST,
  };
}

function rehash(record) {
  return releaseEvidence.finalizeReleaseEvidenceRecord(record);
}

function azureLlmConfig(overrides = {}) {
  return {
    provider: 'azure-openai',
    credentialVersion: 'credential-v7',
    timeoutMs: 12_000,
    settings: {
      apiKey: 'never-persist-this-key',
      endpoint: 'https://azure.test/',
      deployment: 'neutral-production-slot',
      apiVersion: '2024-10-21',
      requestProfile: 'reasoning',
      minCompletionTokens: 1_600,
    },
    ...overrides,
  };
}

test('LLM config digest binds every effective non-secret Azure setting and credential version', () => {
  assert.equal(typeof releaseEvidence.llmProviderConfigDigest, 'function');
  const digest = releaseEvidence.llmProviderConfigDigest(azureLlmConfig());

  assert.equal(digest, 'b14e23a2593170a9749a66ecbcb31229dc2cfe1554dbd3e173661b187602d70b');
  assert.equal(releaseEvidence.llmProviderConfigDigest(azureLlmConfig({
    settings: { ...azureLlmConfig().settings, apiKey: 'rotated-secret-same-version' },
  })), digest, 'API key bytes are never part of the persisted digest');

  const changes = [
    { credentialVersion: 'credential-v8' },
    { timeoutMs: 11_999 },
    { settings: { ...azureLlmConfig().settings, endpoint: 'https://other-azure.test' } },
    { settings: { ...azureLlmConfig().settings, deployment: 'another-slot' } },
    { settings: { ...azureLlmConfig().settings, apiVersion: '2025-01-01' } },
    { settings: { ...azureLlmConfig().settings, requestProfile: 'standard' } },
    { settings: { ...azureLlmConfig().settings, minCompletionTokens: 1_601 } },
  ];
  for (const change of changes) {
    assert.notEqual(releaseEvidence.llmProviderConfigDigest(azureLlmConfig(change)), digest);
  }
});

test('LLM config digest canonicalizes the effective HKBU and MiniMax transports', () => {
  const hkbu = {
    provider: 'hkbu',
    credentialVersion: 'credential-v1',
    timeoutMs: 12_000,
    settings: {
      apiKey: 'private-hkbu-key',
      baseUrl: 'https://genai.test/api/v0/rest/',
      model: 'gpt-4o-mini',
      apiVersion: '2024-10-21',
    },
  };
  const minimax = {
    provider: 'minimax',
    credentialVersion: 'credential-v2',
    timeoutMs: 12_000,
    settings: {
      apiKey: 'private-minimax-key',
      baseUrl: 'https://api.minimax.test/',
      anthropicBaseUrl: 'https://api.minimax.test/anthropic/',
      model: 'MiniMax-M2.1',
    },
  };

  assert.equal(
    releaseEvidence.llmProviderConfigDigest(hkbu),
    '3580543d3ed737e073d5332b2586888bb5b3e66790e76ae13ceccba38c0be571',
  );
  assert.equal(
    releaseEvidence.llmProviderConfigDigest(minimax),
    '15026500e14371978516867619ab924078653f7b46079d9acd06fa6378565318',
  );
});

test('strict LLM smoke validator accepts one fresh commit/config-bound pass artifact', () => {
  assert.equal(typeof releaseEvidence.validateLlmSmokeEvidence, 'function');
  const record = validLlmEvidence();

  assert.deepEqual(releaseEvidence.validateLlmSmokeEvidence(record, {
    expectedVersion: ARTIFACT_DIGEST,
    commitSha: COMMIT,
    provider: 'azure-openai',
    configDigest: CONFIG_DIGEST,
    now: NOW,
  }), {
    valid: true,
    code: null,
    record,
  });
});

test('LLM smoke evidence keeps a fixed usage shape when a provider omits token counts', () => {
  const record = rehash({
    ...validLlmEvidence(),
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  });

  assert.equal(releaseEvidence.validateLlmSmokeEvidence(record, {
    expectedVersion: record.artifactSha256,
    commitSha: COMMIT,
    provider: 'azure-openai',
    configDigest: CONFIG_DIGEST,
    now: NOW,
  }).valid, true);
});

test('LLM smoke evidence file wrapper reads once and applies every runtime binding', () => {
  const record = validLlmEvidence();
  let reads = 0;
  const result = releaseEvidence.validateLlmSmokeEvidenceFile({
    evidenceFile: 'reports/llm/evidence.json',
    evidenceVersion: ARTIFACT_DIGEST,
    commitSha: COMMIT,
    provider: 'azure-openai',
    configDigest: CONFIG_DIGEST,
    now: NOW,
    readRecord(filePath) {
      reads += 1;
      assert.equal(filePath, 'reports/llm/evidence.json');
      return record;
    },
  });

  assert.equal(reads, 1);
  assert.deepEqual(result, { valid: true, code: null, record });
});

test('LLM smoke evidence file wrapper distinguishes unreadable evidence and fails closed', async (t) => {
  for (const [name, readRecord] of [
    ['missing', () => null],
    ['read exception', () => { throw new Error('private path detail'); }],
    ['invalid reader', null],
  ]) {
    await t.test(name, () => {
      assert.deepEqual(releaseEvidence.validateLlmSmokeEvidenceFile({
        evidenceFile: 'reports/llm/evidence.json',
        evidenceVersion: ARTIFACT_DIGEST,
        commitSha: COMMIT,
        provider: 'azure-openai',
        configDigest: CONFIG_DIGEST,
        now: NOW,
        readRecord,
      }), { valid: false, code: 'LLM_SMOKE_EVIDENCE_UNREADABLE', record: null });
    });
  }
});

test('dedicated LLM evidence reader uses one bounded regular-file descriptor and closes it', async (t) => {
  const record = validLlmEvidence();
  const json = Buffer.from(JSON.stringify(record));
  const fileConstants = { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x200 };
  const regularStat = ({ size = json.length, dev = 7, ino = 11 } = {}) => ({
    dev,
    ino,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const dependenciesFor = (source = json, overrides = {}) => {
    let cursor = 0;
    const state = { closes: 0, opens: 0, readLengths: [] };
    return {
      state,
      dependencies: {
        fileConstants,
        lstatFile: () => regularStat({ size: source.length }),
        openFile(filePath, flags) {
          state.opens += 1;
          assert.equal(filePath, 'evidence.json');
          assert.equal(flags, 0x300);
          return 41;
        },
        fstatFile: () => regularStat({ size: source.length }),
        readBytes(fd, target, offset, length, position) {
          assert.equal(fd, 41);
          assert.equal(position, null);
          state.readLengths.push(length);
          const count = Math.min(length, 7, source.length - cursor);
          if (count <= 0) return 0;
          source.copy(target, offset, cursor, cursor + count);
          cursor += count;
          return count;
        },
        closeFile(fd) {
          assert.equal(fd, 41);
          state.closes += 1;
        },
        ...overrides,
      },
    };
  };

  const valid = dependenciesFor();
  assert.deepEqual(
    releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', valid.dependencies),
    record,
  );
  assert.equal(valid.state.opens, 1);
  assert.equal(valid.state.closes, 1);
  assert.equal(valid.state.readLengths[0], 65_537);
  assert.equal(valid.state.readLengths.every((length) => length > 0 && length <= 65_537), true);

  await t.test('empty path', () => {
    const attempt = dependenciesFor();
    assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('', attempt.dependencies), null);
    assert.deepEqual(attempt.state, { closes: 0, opens: 0, readLengths: [] });
  });

  for (const [name, lstat] of [
    ['symbolic link', { ...regularStat(), isSymbolicLink: () => true }],
    ['FIFO or other non-regular file', { ...regularStat(), isFile: () => false }],
  ]) {
    await t.test(name, () => {
      const attempt = dependenciesFor(json, {
        lstatFile: () => lstat,
        // These legacy path-based doubles make the previous implementation
        // accept the fixture, proving the descriptor/lstat contract is tested.
        statFile: () => regularStat(),
        readFile: () => json.toString('utf8'),
      });
      assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', attempt.dependencies), null);
      assert.equal(attempt.state.opens, 0);
      assert.equal(attempt.state.closes, 0);
    });
  }

  await t.test('empty file', () => {
    const attempt = dependenciesFor(Buffer.alloc(0));
    assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', attempt.dependencies), null);
    assert.equal(attempt.state.opens, 1);
    assert.equal(attempt.state.closes, 1);
  });

  await t.test('oversize descriptor stat', () => {
    const attempt = dependenciesFor(json, {
      fstatFile: () => regularStat({ size: 65_537 }),
    });
    assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', attempt.dependencies), null);
    assert.equal(attempt.state.opens, 1);
    assert.equal(attempt.state.closes, 1);
    assert.deepEqual(attempt.state.readLengths, []);
  });

  await t.test('growth race reads at most MAX plus one byte and rejects the result', () => {
    const prefix = JSON.stringify(record);
    const oversized = Buffer.from(`${prefix}${' '.repeat(65_536 - Buffer.byteLength(prefix))}X`);
    const attempt = dependenciesFor(oversized, {
      lstatFile: () => regularStat({ size: 1 }),
      fstatFile: () => regularStat({ size: 1 }),
      // The old path reader would accept the first MAX bytes as valid JSON.
      statFile: () => regularStat({ size: 1 }),
      readFile: () => oversized.subarray(0, 65_536).toString('utf8'),
    });
    assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', attempt.dependencies), null);
    assert.equal(attempt.state.closes, 1);
    assert.equal(attempt.state.readLengths[0], 65_537);
    assert.equal(attempt.state.readLengths.at(-1) >= 1, true);
  });

  await t.test('non-object or malformed JSON', () => {
    for (const source of [Buffer.from('[]'), Buffer.from('{secret')]) {
      const attempt = dependenciesFor(source);
      assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', attempt.dependencies), null);
      assert.equal(attempt.state.closes, 1);
    }
  });

  await t.test('read exception still closes the descriptor', () => {
    const attempt = dependenciesFor(json, {
      readBytes: () => { throw new Error('private detail'); },
      readFile: () => { throw new Error('private detail'); },
      statFile: () => regularStat(),
    });
    assert.equal(releaseEvidence.readLlmSmokeEvidenceRecord('evidence.json', attempt.dependencies), null);
    assert.equal(attempt.state.opens, 1);
    assert.equal(attempt.state.closes, 1);
  });
});

test('strict LLM smoke validator rejects rehashed semantic mutations and unbound expectations', async (t) => {
  const recordCases = [
    ['extra field', (record) => { record.prompt = 'must never persist'; }],
    ['schema', (record) => { record.schemaVersion = 2; }],
    ['commit', (record) => { record.commitSha = '2'.repeat(40); }],
    ['capability', (record) => { record.capability = 'chat'; }],
    ['provider', (record) => { record.provider = 'hkbu'; }],
    ['contract', (record) => { record.contractVersion = 'llm-connectivity-json-v2'; }],
    ['config digest', (record) => { record.providerConfigDigest = 'a'.repeat(64); }],
    ['result', (record) => { record.result = 'fail'; }],
    ['HTTP class', (record) => { record.httpClass = '3xx'; }],
    ['normalization', (record) => { record.normalizedSuccess = 1; }],
    ['request count', (record) => { record.requestCount = 2; }],
    ['negative latency', (record) => { record.latencyMs = -1; }],
    ['fractional latency', (record) => { record.latencyMs = 1.5; }],
    ['excessive latency', (record) => { record.latencyMs = 60_001; }],
    ['missing usage key', (record) => { delete record.usage.totalTokens; }],
    ['extra usage key', (record) => { record.usage.cachedTokens = 1; }],
    ['negative usage', (record) => { record.usage.inputTokens = -1; }],
    ['fractional usage', (record) => { record.usage.outputTokens = 1.5; }],
    ['string usage', (record) => { record.usage.totalTokens = '14'; }],
    ['stale time', (record) => { record.occurredAt = '2026-08-18T11:59:59.999Z'; }],
    ['future time', (record) => { record.occurredAt = '2026-08-25T12:05:00.001Z'; }],
    ['noncanonical time', (record) => { record.occurredAt = '2026-08-25T20:00:00+08:00'; }],
  ];
  for (const [name, mutate] of recordCases) {
    await t.test(name, () => {
      const record = structuredClone(validLlmEvidence());
      mutate(record);
      const selfConsistent = rehash(record);
      assert.deepEqual(releaseEvidence.validateLlmSmokeEvidence(selfConsistent, {
        expectedVersion: selfConsistent.artifactSha256,
        commitSha: COMMIT,
        provider: 'azure-openai',
        configDigest: CONFIG_DIGEST,
        now: NOW,
      }), { valid: false, code: 'LLM_SMOKE_EVIDENCE_INVALID', record: null });
    });
  }

  const expectationCases = [
    ['version', { expectedVersion: 'a'.repeat(64) }],
    ['commit', { commitSha: '2'.repeat(40) }],
    ['provider', { provider: 'hkbu' }],
    ['config digest', { configDigest: 'a'.repeat(64) }],
    ['clock', { now: new Date('invalid') }],
  ];
  for (const [name, override] of expectationCases) {
    await t.test(`wrong expected ${name}`, () => {
      assert.equal(releaseEvidence.validateLlmSmokeEvidence(validLlmEvidence(), {
        expectedVersion: ARTIFACT_DIGEST,
        commitSha: COMMIT,
        provider: 'azure-openai',
        configDigest: CONFIG_DIGEST,
        now: NOW,
        ...override,
      }).valid, false);
    });
  }
});
