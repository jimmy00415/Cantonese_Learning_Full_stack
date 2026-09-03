import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const RELEASE_SHA = 'a'.repeat(40);
const NOW = new Date('2026-09-03T08:00:00.000Z');
const EXPIRES_AT = '2026-09-10T08:00:00.000Z';
const OWNER = 'admin@motionexp.com';

function waiverPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    commitSha: RELEASE_SHA,
    capability: 'ios-voice',
    decision: 'waived',
    scope: 'real-iphone-safari',
    approvedBy: OWNER,
    approvedAt: NOW.toISOString(),
    expiresAt: EXPIRES_AT,
    reasonCode: 'product-owner-deferred-device-test',
    limitations: ['not-real-ios-tested'],
    result: 'waived',
    ...overrides,
  };
}

test('release-only iOS validator accepts the exact current owner waiver while runtime certification rejects it', async () => {
  const {
    finalizeEvidenceRecord,
    iosVoiceWaiverContract,
    validateIosVoiceEvidence,
    validateIosVoiceReleaseEvidence,
  } = await import('../src/services/voice-evidence.js');
  const record = finalizeEvidenceRecord(waiverPayload());
  const options = {
    expectedVersion: record.artifactSha256,
    commitSha: RELEASE_SHA,
    normalizerContractVersion: 'canonical-wav-v1',
    now: NOW,
  };

  assert.deepEqual(iosVoiceWaiverContract.limitations, ['not-real-ios-tested']);
  assert.equal(Object.isFrozen(iosVoiceWaiverContract), true);
  assert.equal(Object.isFrozen(iosVoiceWaiverContract.limitations), true);
  assert.equal(validateIosVoiceReleaseEvidence(record, options), true);
  assert.equal(validateIosVoiceEvidence(record, options), false);
});

test('release-only iOS validator rejects every mutated owner-waiver boundary', async (t) => {
  const { finalizeEvidenceRecord, validateIosVoiceReleaseEvidence } = await import('../src/services/voice-evidence.js');
  const validate = (payload, { now = NOW, commitSha = RELEASE_SHA, expectedVersion } = {}) => {
    const record = finalizeEvidenceRecord(payload);
    return validateIosVoiceReleaseEvidence(record, {
      expectedVersion: expectedVersion ?? record.artifactSha256,
      commitSha,
      normalizerContractVersion: 'canonical-wav-v1',
      now,
    });
  };
  const cases = [
    ['expired', waiverPayload(), { now: new Date(EXPIRES_AT) }],
    ['future beyond skew', waiverPayload({ approvedAt: '2026-09-03T08:05:00.001Z', expiresAt: '2026-09-10T08:05:00.001Z' })],
    ['shortened window', waiverPayload({ expiresAt: '2026-09-10T07:59:59.999Z' })],
    ['overlong window', waiverPayload({ expiresAt: '2026-09-10T08:00:00.001Z' })],
    ['wrong owner', waiverPayload({ approvedBy: 'other@example.com' })],
    ['wrong record SHA', waiverPayload({ commitSha: 'b'.repeat(40) })],
    ['uppercase record SHA', waiverPayload({ commitSha: RELEASE_SHA.toUpperCase() })],
    ['wrong scope', waiverPayload({ scope: 'mobile-safari' })],
    ['wrong reason', waiverPayload({ reasonCode: 'operator-convenience' })],
    ['wrong result', waiverPayload({ result: 'pass' })],
    ['wrong decision', waiverPayload({ decision: 'approved' })],
    ['wrong limitations', waiverPayload({ limitations: [] })],
    ['extra limitation', waiverPayload({ limitations: ['not-real-ios-tested', 'provider-not-tested'] })],
    ['extra key', waiverPayload({ note: 'not permitted' })],
    ['noncanonical approval time', waiverPayload({ approvedAt: '2026-09-03T08:00:00Z' })],
    ['noncanonical expiry time', waiverPayload({ expiresAt: '2026-09-10T08:00:00Z' })],
  ];
  for (const [name, payload, options] of cases) {
    await t.test(name, () => assert.equal(validate(payload, options), false));
  }

  const valid = finalizeEvidenceRecord(waiverPayload());
  assert.equal(validateIosVoiceReleaseEvidence({ ...valid, artifactSha256: 'f'.repeat(64) }, {
    expectedVersion: 'f'.repeat(64), commitSha: RELEASE_SHA,
    normalizerContractVersion: 'canonical-wav-v1', now: NOW,
  }), false, 'self-hash tampering');
  assert.equal(validate(waiverPayload(), { expectedVersion: 'e'.repeat(64) }), false, 'wrong expected digest');
  assert.equal(validate(waiverPayload(), { commitSha: 'b'.repeat(40) }), false, 'wrong release SHA');
});

test('waiver generator creates canonical create-only JSON and prints only its safe summary', async () => {
  const { canonicalJson, validateIosVoiceReleaseEvidence } = await import('../src/services/voice-evidence.js');
  const { runIosVoiceWaiver } = await import('../scripts/ios-voice-waiver.js');
  const destination = resolve('release-evidence', 'ios-owner-waiver.json');
  const writes = [];
  const output = [];
  const result = await runIosVoiceWaiver({
    argv: [
      `--release-sha=${RELEASE_SHA}`,
      `--destination=${destination}`,
      `--confirm-owner=${OWNER}`,
    ],
    now: () => NOW,
    writeArtifact: async (value) => writes.push(value),
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filePath, destination);
  assert.equal(writes[0].contents, `${canonicalJson(writes[0].record)}\n`);
  assert.equal(Buffer.from(writes[0].contents, 'utf8').toString('utf8'), writes[0].contents);
  assert.equal(validateIosVoiceReleaseEvidence(writes[0].record, {
    expectedVersion: writes[0].record.artifactSha256,
    commitSha: RELEASE_SHA,
    normalizerContractVersion: 'canonical-wav-v1',
    now: NOW,
  }), true);
  assert.deepEqual(result.publicReport, {
    destination,
    artifactSha256: writes[0].record.artifactSha256,
    approvedAt: NOW.toISOString(),
    expiresAt: EXPIRES_AT,
    decision: 'waived',
  });
  assert.deepEqual(output, [`${JSON.stringify(result.publicReport)}\n`]);
  assert.deepEqual(Object.keys(result.publicReport).sort(), [
    'approvedAt', 'artifactSha256', 'decision', 'destination', 'expiresAt',
  ]);
});

test('waiver generator is inert for missing confirmation, relative paths, duplicates, extras, and invalid SHA', async (t) => {
  const { runIosVoiceWaiver } = await import('../scripts/ios-voice-waiver.js');
  const destination = resolve('release-evidence', 'ios-owner-waiver.json');
  const exact = [
    `--release-sha=${RELEASE_SHA}`,
    `--destination=${destination}`,
    `--confirm-owner=${OWNER}`,
  ];
  const cases = [
    ['missing confirmation', exact.slice(0, 2)],
    ['relative destination', [exact[0], '--destination=waiver.json', exact[2]]],
    ['non-json destination', [exact[0], `--destination=${resolve('waiver.txt')}`, exact[2]]],
    ['duplicate argument', [...exact, exact[0]]],
    ['extra argument', [...exact, '--credential=must-not-read']],
    ['wrong owner', [exact[0], exact[1], '--confirm-owner=other@example.com']],
    ['uppercase SHA', [`--release-sha=${RELEASE_SHA.toUpperCase()}`, exact[1], exact[2]]],
  ];
  for (const [name, argv] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const result = await runIosVoiceWaiver({
        argv,
        now: () => { calls.push('clock'); return NOW; },
        writeArtifact: async () => calls.push('write'),
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 2);
      assert.deepEqual(calls, []);
    });
  }
});

test('waiver generator refuses to overwrite an existing destination', async (t) => {
  const { canonicalJson } = await import('../src/services/voice-evidence.js');
  const { runIosVoiceWaiver } = await import('../scripts/ios-voice-waiver.js');
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-ios-waiver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'waiver.json');
  const invocation = {
    argv: [
      `--release-sha=${RELEASE_SHA}`,
      `--destination=${destination}`,
      `--confirm-owner=${OWNER}`,
    ],
    now: () => NOW,
    writeOutput: () => undefined,
  };
  const created = await runIosVoiceWaiver(invocation);
  const original = await readFile(destination, 'utf8');
  const result = await runIosVoiceWaiver(invocation);

  assert.equal(created.exitCode, 0);
  assert.equal(original, `${canonicalJson(JSON.parse(original))}\n`);
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'IOS_VOICE_WAIVER_DESTINATION_EXISTS');
  assert.equal(await readFile(destination, 'utf8'), original);
});

test('package exposes the waiver command and syntax-checks its entrypoint', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['acceptance:ios-waiver'], 'node scripts/ios-voice-waiver.js');
  assert.match(packageJson.scripts.check, /node --check scripts\/ios-voice-waiver\.js/);
});
