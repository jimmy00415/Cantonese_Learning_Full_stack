import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireReleaseStateLock,
  canonicalJson,
  finalizeJournalRecord,
  journalFileName,
  openReleaseStateStore,
  readBoundedOrdinaryFile,
  readReleaseJournalRecords,
  recoverJournalTemp,
  validateJournalRecords,
  writeAtomicCreateOnly,
} from '../scripts/release-state-store.js';
import { containsForbiddenPersistedSecret } from '../scripts/persisted-secret-contract.js';
import {
  classifyReconciliation,
  classifyRestartDisposition,
  createFinalMutationGuard,
  recoverTerminalFromReceipt,
  reconcileMutation,
  validateReconciliationPrefix,
} from '../scripts/release-reconciliation.js';

const RELEASE_SHA = 'a'.repeat(40);
const RELEASE_IDENTITY = 'b'.repeat(64);
const PLAN_SHA = 'c'.repeat(64);
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';
const OPERATION_ATTEMPT_ID = 'd'.repeat(32);
const RECEIPT_HEAD = 'e'.repeat(64);
const CREATED_AT = '2026-08-26T01:02:03.000Z';

function common(overrides = {}) {
  return {
    schemaVersion: 1,
    recordType: 'intent',
    generation: 1,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'candidate',
    phasePlanSha256: PLAN_SHA,
    attemptId: ATTEMPT_ID,
    operationId: 'candidate-deploy',
    receiptHeadSha256: RECEIPT_HEAD,
    previousRecordSha256: null,
    createdAt: CREATED_AT,
    payload: {
      mutationOrdinal: 1,
      operationAttemptId: OPERATION_ATTEMPT_ID,
      commandSha256: 'f'.repeat(64),
      reconcileKind: 'cloud-run-service-replace',
      beforeSha256: '1'.repeat(64),
      afterSha256: '2'.repeat(64),
    },
    ...overrides,
  };
}

function threeRecordJournal() {
  const intent = finalizeJournalRecord(common());
  const checkpoint = finalizeJournalRecord(common({
    recordType: 'checkpoint',
    generation: 2,
    previousRecordSha256: intent.recordSha256,
    payload: {
      intentRecordSha256: intent.recordSha256,
      classification: 'after',
      outcome: 'applied',
      observationSha256: '2'.repeat(64),
      safeResult: {
        kind: 'resource', state: 'present',
        identitySha256: '3'.repeat(64), valueSha256: '2'.repeat(64),
      },
    },
  }));
  const terminalState = { candidate: 'private-100', mutationCount: 1 };
  const terminal = finalizeJournalRecord(common({
    recordType: 'terminal',
    generation: 3,
    operationId: null,
    previousRecordSha256: checkpoint.recordSha256,
    payload: {
      status: 'phase-complete',
      checkpointRecordSha256: checkpoint.recordSha256,
      receiptSha256: '4'.repeat(64),
      terminalState,
      terminalStateSha256: '7'.repeat(64),
      mutationCount: 1,
      responseLossOperationIds: [],
    },
  }), { terminalState });
  return [intent, checkpoint, terminal];
}

async function stateFixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptDirectory = join(root, 'receipts');
  const stateDirectory = join(receiptDirectory, 'state');
  await mkdir(stateDirectory, { recursive: true });
  return { root, receiptDirectory, stateDirectory };
}

function canonicalLockBytes({
  attemptId = '323e4567-e89b-42d3-a456-426614174000',
  pid = 2_147_483_647,
  createdAt = CREATED_AT,
} = {}) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1, attemptId, host: hostname(), pid, createdAt,
  }, null, 2)}\n`);
}

function pathnameReplacementReader(shouldReplace) {
  const calls = [];
  return {
    calls,
    reader: async (filePath, options) => {
      calls.push({ filePath, maximumBytes: options?.maximumBytes });
      return readBoundedOrdinaryFile(filePath, {
        ...options,
        afterOpen: async () => {
          if (!shouldReplace(filePath, calls)) return;
          const original = `${filePath}.displaced`;
          const bytes = await readFile(filePath);
          await rename(filePath, original);
          await writeFile(filePath, bytes);
        },
      });
    },
  };
}

test('journal records are canonical, exact, secret-free, and hash chained', () => {
  const records = threeRecordJournal();
  assert.equal(validateJournalRecords(records), true);
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(journalFileName(records[0]), '00000001-intent.json');
  assert.equal(journalFileName(records[2]), '00000003-terminal.json');

  for (const mutate of [
    (value) => { value[1].generation = 4; },
    (value) => { value[1].previousRecordSha256 = '0'.repeat(64); },
    (value) => { value[0].payload.extra = true; },
    (value) => { value[1].payload.classification = 'before'; },
    (value) => { value[1].payload.safeResult = { kind: 'resource', token: `Bearer ${'x'.repeat(40)}` }; },
    (value) => { value[2].payload.mutationCount = 2; },
    (value) => { value[0].phasePlanSha256 = '9'.repeat(64); },
  ]) {
    const changed = structuredClone(records);
    mutate(changed);
    assert.throws(() => validateJournalRecords(changed), /journal/i);
  }
});

test('journal operation identity preserves a colon-qualified release operation id', () => {
  const operationId = 'inventory-publish:legacyInventory';
  const record = finalizeJournalRecord(common({
    phase: 'inventory',
    operationId,
  }));
  assert.equal(record.operationId, operationId);
  assert.equal(validateReconciliationPrefix({ operationIds: [operationId], records: [] }), true);
  assert.equal(createFinalMutationGuard({
    finalOperationId: operationId,
    mutationOperationIds: [operationId],
  }).beforeOperation(operationId), true);
});

test('atomic create-only writer publishes exact bytes privately and refuses replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-state-writer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  const filePath = join(stateDirectory, '00000001-intent.json');
  const bytes = Buffer.from('exact journal bytes\n');
  await writeAtomicCreateOnly(filePath, bytes, { tempId: '1'.repeat(32) });
  assert.deepEqual(await readFile(filePath), bytes);
  if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  await assert.rejects(
    () => writeAtomicCreateOnly(filePath, bytes, { tempId: '2'.repeat(32) }),
    /exists/i,
  );

  const outside = join(root, 'outside');
  await mkdir(outside);
  const linked = join(root, 'linked-state');
  try {
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => writeAtomicCreateOnly(join(linked, '00000002-intent.json'), bytes, { tempId: '3'.repeat(32) }),
      /parent|symlink/i,
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
  }
});

test('bounded ordinary-file adoption binds intended length and rejects a same-byte pathname swap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-bounded-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'artifact.json');
  const displaced = join(root, 'artifact.original.json');
  const intended = Buffer.from('{"safe":true}\n');
  await writeFile(filePath, intended);

  assert.deepEqual(await readBoundedOrdinaryFile(filePath, {
    expectedByteLength: intended.length, maximumBytes: 1024,
  }), intended);
  await assert.rejects(() => readBoundedOrdinaryFile(filePath, {
    expectedByteLength: intended.length + 1, maximumBytes: 1024,
  }), /ordinary file|length|size/i);

  await assert.rejects(() => readBoundedOrdinaryFile(filePath, {
    expectedByteLength: intended.length,
    maximumBytes: 1024,
    afterOpen: async () => {
      await rename(filePath, displaced);
      await writeFile(filePath, intended);
    },
  }), /ordinary file|changed|identity/i);
  assert.deepEqual(await readFile(filePath), intended);
});

test('bounded ordinary-file adoption rejects pre-existing and post-open hard links', async (t) => {
  const fixture = await stateFixture(t, 'hkbuddy-bounded-hard-link-');
  const source = join(fixture.root, 'source.json');
  const linked = join(fixture.stateDirectory, '00000001-intent.json');
  const bytes = Buffer.from('{"safe":true}\n');
  await writeFile(source, bytes);
  await link(source, linked);
  await assert.rejects(
    () => readBoundedOrdinaryFile(linked, { maximumBytes: 1024 }),
    /ordinary|link|identity|changed/i,
  );

  const raced = join(fixture.stateDirectory, '00000002-intent.json');
  const racedAlias = join(fixture.root, 'raced-alias.json');
  await writeFile(raced, bytes);
  await assert.rejects(() => readBoundedOrdinaryFile(raced, {
    maximumBytes: 1024,
    afterOpen: () => link(raced, racedAlias),
  }), /ordinary|link|identity|changed/i);
});

test('every reserved journal, temp, active, stale, moved, and release read rejects hard links', async (t) => {
  const record = threeRecordJournal()[0];
  const recordName = journalFileName(record);
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const cases = [
    ['journal', recordName, recordBytes,
      ({ receiptDirectory }) => readReleaseJournalRecords(receiptDirectory)],
    ['temporary journal', `${recordName}.tmp-${'1'.repeat(32)}`, recordBytes,
      ({ stateDirectory }) => recoverJournalTemp(stateDirectory)],
    ['active lock', '.release-state.lock', canonicalLockBytes(),
      ({ stateDirectory }) => acquireReleaseStateLock(stateDirectory, {
        attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
        isPidAlive: () => false, staleAfterMs: 60_000,
      })],
    ['stale lock', `.release-state.lock.stale-${'2'.repeat(32)}`, canonicalLockBytes(),
      ({ stateDirectory }) => acquireReleaseStateLock(stateDirectory, {
        attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
        isPidAlive: () => false, staleAfterMs: 60_000,
      })],
  ];
  for (const [label, entryName, bytes, action] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = await stateFixture(subtest, `hkbuddy-state-hard-link-${label.replace(' ', '-')}-`);
      const source = join(fixture.root, 'outside-source');
      await writeFile(source, bytes);
      await link(source, join(fixture.stateDirectory, entryName));
      await assert.rejects(() => action(fixture), /ordinary|link|identity|changed|journal|temporary|lock/i);
    });
  }

  await t.test('moved lock after takeover rename', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-hard-link-moved-lock-');
    await writeFile(join(fixture.stateDirectory, '.release-state.lock'), canonicalLockBytes());
    let aliasCreated = false;
    const reader = async (filePath, options) => {
      if (!aliasCreated && filePath.includes('.release-state.lock.stale-')) {
        aliasCreated = true;
        await link(filePath, join(fixture.root, 'moved-lock-alias'));
      }
      return readBoundedOrdinaryFile(filePath, options);
    };
    await assert.rejects(() => acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
      isPidAlive: () => false, staleAfterMs: 60_000, fileReader: reader,
    }), /ordinary|link|identity|changed|lock|takeover/i);
    assert.equal(aliasCreated, true);
  });

  await t.test('release-time ownership read', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-hard-link-release-lock-');
    const activePath = join(fixture.stateDirectory, '.release-state.lock');
    let releaseRead = false;
    const reader = async (filePath, options) => {
      if (releaseRead && filePath === activePath) {
        await link(filePath, join(fixture.root, 'release-lock-alias'));
      }
      return readBoundedOrdinaryFile(filePath, options);
    };
    const lock = await acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date(CREATED_AT), fileReader: reader,
    });
    releaseRead = true;
    await assert.rejects(() => lock.release(), /ordinary|link|identity|changed|lock|ownership/i);
  });
});

test('atomic create-only publication rejects parent replacement after temp durability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-publication-parent-swap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  const displacedDirectory = join(root, 'state.displaced');
  const filePath = join(stateDirectory, 'artifact.json');
  await mkdir(stateDirectory);

  await assert.rejects(() => writeAtomicCreateOnly(filePath, Buffer.from('{"safe":true}\n'), {
    tempId: '4'.repeat(32),
    afterTempSync: async () => {
      await rename(stateDirectory, displacedDirectory);
      await mkdir(stateDirectory);
    },
  }), /parent|identity|changed/i);
  await assert.rejects(() => readFile(filePath), { code: 'ENOENT' });
});

test('one valid contiguous crash temp is recovered and every ambiguous temp set is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-state-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = threeRecordJournal();
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  const firstPath = join(stateDirectory, journalFileName(records[0]));
  await writeFile(firstPath, `${JSON.stringify(records[0], null, 2)}\n`);
  const secondName = journalFileName(records[1]);
  await writeFile(
    join(stateDirectory, `${secondName}.tmp-${'1'.repeat(32)}`),
    `${JSON.stringify(records[1], null, 2)}\n`,
  );
  assert.equal(await recoverJournalTemp(stateDirectory), secondName);
  assert.equal(JSON.parse(await readFile(join(stateDirectory, secondName), 'utf8')).recordSha256,
    records[1].recordSha256);

  const identicalTemp = join(stateDirectory, `${secondName}.tmp-${'4'.repeat(32)}`);
  await writeFile(identicalTemp, `${JSON.stringify(records[1], null, 2)}\n`);
  assert.equal(await recoverJournalTemp(stateDirectory), secondName);
  await assert.rejects(() => readFile(identicalTemp), { code: 'ENOENT' });

  const thirdName = journalFileName(records[2]);
  for (const suffix of ['2'.repeat(32), '3'.repeat(32)]) {
    await writeFile(join(stateDirectory, `${thirdName}.tmp-${suffix}`), `${JSON.stringify(records[2])}\n`);
  }
  await assert.rejects(() => recoverJournalTemp(stateDirectory), /temporary|ambiguous/i);
});

test('recovery completes the exact hard-link publication crash window and remains idempotent', async (t) => {
  const fixture = await stateFixture(t, 'hkbuddy-linked-publication-recovery-');
  const records = threeRecordJournal();
  const firstName = journalFileName(records[0]);
  const secondName = journalFileName(records[1]);
  const secondBytes = Buffer.from(`${JSON.stringify(records[1], null, 2)}\n`);
  const temporaryPath = join(fixture.stateDirectory, `${secondName}.tmp-${'5'.repeat(32)}`);
  const finalPath = join(fixture.stateDirectory, secondName);
  await writeFile(join(fixture.stateDirectory, firstName), `${JSON.stringify(records[0], null, 2)}\n`);
  await writeFile(temporaryPath, secondBytes);
  await link(temporaryPath, finalPath);
  assert.equal((await stat(temporaryPath)).nlink, 2);
  assert.equal((await stat(finalPath)).nlink, 2);

  assert.equal(await recoverJournalTemp(fixture.stateDirectory), secondName);
  await assert.rejects(() => stat(temporaryPath), { code: 'ENOENT' });
  assert.equal((await stat(finalPath)).nlink, 1);
  assert.deepEqual(await readFile(finalPath), secondBytes);
  assert.equal(await recoverJournalTemp(fixture.stateDirectory), null);
  assert.deepEqual(
    (await readReleaseJournalRecords(fixture.receiptDirectory)).map((record) => record.recordSha256),
    records.slice(0, 2).map((record) => record.recordSha256),
  );
});

test('linked publication recovery rejects every ambiguous or adversarial topology before unlink', async (t) => {
  const records = threeRecordJournal();
  const firstName = journalFileName(records[0]);
  const secondName = journalFileName(records[1]);
  const secondBytes = Buffer.from(`${JSON.stringify(records[1], null, 2)}\n`);

  async function installFirstAndPair(subtest, label) {
    const fixture = await stateFixture(subtest, label);
    await writeFile(
      join(fixture.stateDirectory, firstName),
      `${JSON.stringify(records[0], null, 2)}\n`,
    );
    const temporaryPath = join(fixture.stateDirectory, `${secondName}.tmp-${'6'.repeat(32)}`);
    const finalPath = join(fixture.stateDirectory, secondName);
    await writeFile(temporaryPath, secondBytes);
    await link(temporaryPath, finalPath);
    return { ...fixture, temporaryPath, finalPath };
  }

  await t.test('nlink greater than two proves an external alias', async (subtest) => {
    const fixture = await installFirstAndPair(subtest, 'hkbuddy-linked-publication-external-alias-');
    const aliasPath = join(fixture.root, 'external-alias');
    await link(fixture.finalPath, aliasPath);
    await assert.rejects(() => recoverJournalTemp(fixture.stateDirectory), /link|ordinary|identity|temporary|journal/i);
    assert.equal((await stat(fixture.temporaryPath)).nlink, 3);
    assert.equal((await stat(fixture.finalPath)).nlink, 3);
  });

  await t.test('two separately linked inodes are not an owned publication pair', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-linked-publication-distinct-inodes-');
    await writeFile(join(fixture.stateDirectory, firstName), `${JSON.stringify(records[0], null, 2)}\n`);
    const temporaryPath = join(fixture.stateDirectory, `${secondName}.tmp-${'7'.repeat(32)}`);
    const finalPath = join(fixture.stateDirectory, secondName);
    await writeFile(temporaryPath, secondBytes);
    await writeFile(finalPath, secondBytes);
    await link(temporaryPath, join(fixture.root, 'temporary-alias'));
    await link(finalPath, join(fixture.root, 'final-alias'));
    await assert.rejects(() => recoverJournalTemp(fixture.stateDirectory), /link|ordinary|identity|temporary|journal/i);
    assert.equal((await stat(temporaryPath)).nlink, 2);
    assert.equal((await stat(finalPath)).nlink, 2);
  });

  for (const [label, finalName, bytes] of [
    ['malformed record', secondName, Buffer.from('{"not":"canonical"}')],
    ['record and final name mismatch', secondName, Buffer.from(`${JSON.stringify(records[0], null, 2)}\n`)],
    ['noncontiguous journal chain', journalFileName(records[2]), Buffer.from(`${JSON.stringify(records[2], null, 2)}\n`)],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = await stateFixture(subtest, `hkbuddy-linked-publication-${label.replaceAll(' ', '-')}-`);
      await writeFile(join(fixture.stateDirectory, firstName), `${JSON.stringify(records[0], null, 2)}\n`);
      const temporaryPath = join(fixture.stateDirectory, `${finalName}.tmp-${'8'.repeat(32)}`);
      const finalPath = join(fixture.stateDirectory, finalName);
      await writeFile(temporaryPath, bytes);
      await link(temporaryPath, finalPath);
      await assert.rejects(() => recoverJournalTemp(fixture.stateDirectory), /invalid|journal|temporary|link|ordinary/i);
      assert.equal((await stat(temporaryPath)).nlink, 2);
      assert.equal((await stat(finalPath)).nlink, 2);
    });
  }

  await t.test('a second temporary name is ambiguous', async (subtest) => {
    const fixture = await installFirstAndPair(subtest, 'hkbuddy-linked-publication-multiple-temp-');
    await writeFile(
      join(fixture.stateDirectory, `${secondName}.tmp-${'9'.repeat(32)}`),
      secondBytes,
    );
    await assert.rejects(() => recoverJournalTemp(fixture.stateDirectory), /ordinary|temporary|ambiguous/i);
    assert.equal((await stat(fixture.temporaryPath)).nlink, 2);
  });

  await t.test('a temporary name added after pair inspection is rejected before unlink', async (subtest) => {
    const fixture = await installFirstAndPair(subtest, 'hkbuddy-linked-publication-late-temp-');
    const lateTemporaryPath = join(fixture.stateDirectory, `${secondName}.tmp-${'a'.repeat(32)}`);
    let added = false;
    const reader = async (filePath, options) => {
      const bytes = await readBoundedOrdinaryFile(filePath, options);
      if (!added && filePath.endsWith(firstName)) {
        added = true;
        await writeFile(lateTemporaryPath, secondBytes);
      }
      return bytes;
    };
    await assert.rejects(
      () => recoverJournalTemp(fixture.stateDirectory, { fileReader: reader }),
      /ambiguous|changed|identity|journal|temporary/i,
    );
    assert.equal(added, true);
    assert.equal((await stat(fixture.temporaryPath)).nlink, 2);
    assert.deepEqual(await readFile(lateTemporaryPath), secondBytes);
  });

  await t.test('final path replacement after pair inspection is rejected', async (subtest) => {
    const fixture = await installFirstAndPair(subtest, 'hkbuddy-linked-publication-path-swap-');
    let swapped = false;
    const reader = async (filePath, options) => {
      const bytes = await readBoundedOrdinaryFile(filePath, options);
      if (!swapped && filePath.endsWith(firstName)) {
        swapped = true;
        await rename(fixture.finalPath, join(fixture.root, 'displaced-final'));
        await writeFile(fixture.finalPath, secondBytes);
      }
      return bytes;
    };
    await assert.rejects(
      () => recoverJournalTemp(fixture.stateDirectory, { fileReader: reader }),
      /changed|identity|link|ordinary|journal|temporary/i,
    );
    assert.equal(swapped, true);
    assert.equal((await stat(fixture.temporaryPath)).nlink, 2);
  });

  await t.test('state parent replacement after pair inspection is rejected', async (subtest) => {
    const fixture = await installFirstAndPair(subtest, 'hkbuddy-linked-publication-parent-swap-');
    const displacedState = join(fixture.root, 'state-displaced');
    let swapped = false;
    const reader = async (filePath, options) => {
      const bytes = await readBoundedOrdinaryFile(filePath, options);
      if (!swapped && filePath.endsWith(firstName)) {
        swapped = true;
        await rename(fixture.stateDirectory, displacedState);
        await mkdir(fixture.stateDirectory);
      }
      return bytes;
    };
    await assert.rejects(
      () => recoverJournalTemp(fixture.stateDirectory, { fileReader: reader }),
      /changed|identity|parent|journal|temporary/i,
    );
    assert.equal(swapped, true);
    assert.equal((await stat(join(displacedState, `${secondName}.tmp-${'6'.repeat(32)}`))).nlink, 2);
  });

  await t.test('a final-only hard link remains a generic linked journal rejection', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-linked-publication-final-only-');
    const finalPath = join(fixture.stateDirectory, firstName);
    await writeFile(finalPath, `${JSON.stringify(records[0], null, 2)}\n`);
    await link(finalPath, join(fixture.root, 'external-final-alias'));
    await assert.rejects(() => recoverJournalTemp(fixture.stateDirectory), /link|ordinary|identity|journal/i);
    assert.equal((await stat(finalPath)).nlink, 2);
  });
});

test('reserved journal, temp, lock, and stale-lock names reject non-ordinary directory entries on every platform', async (t) => {
  const cases = [
    ['journal', '00000001-intent.json', ({ receiptDirectory }) => readReleaseJournalRecords(receiptDirectory)],
    ['temp', `00000001-intent.json.tmp-${'1'.repeat(32)}`, ({ stateDirectory }) => recoverJournalTemp(stateDirectory)],
    ['active lock', '.release-state.lock', ({ stateDirectory }) => acquireReleaseStateLock(stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'), isPidAlive: () => false,
    })],
    ['stale lock', `.release-state.lock.stale-${'1'.repeat(32)}`, ({ stateDirectory }) => acquireReleaseStateLock(stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'), isPidAlive: () => false,
    })],
  ];
  for (const [name, entryName, action] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await stateFixture(subtest, `hkbuddy-state-nonordinary-${name.replace(' ', '-')}-`);
      await mkdir(join(fixture.stateDirectory, entryName));
      await assert.rejects(() => action(fixture), /reserved state entry is not an ordinary file/i);
    });
  }
});

test('release-state directory enumeration fails closed above the explicit 1024-entry ceiling', async (t) => {
  const fixture = await stateFixture(t, 'hkbuddy-state-entry-cap-');
  for (let generation = 1; generation <= 1025; generation += 1) {
    await mkdir(join(fixture.stateDirectory, `${String(generation).padStart(8, '0')}-intent.json`));
  }
  await assert.rejects(
    () => readReleaseJournalRecords(fixture.receiptDirectory),
    /entry|count|journal directory/i,
  );
});

test('every journal, temp, recovery-target, and lock read is descriptor-bound against pathname replacement', async (t) => {
  const record = threeRecordJournal()[0];
  const recordName = journalFileName(record);
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);

  await t.test('canonical journal', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-journal-');
    await writeFile(join(fixture.stateDirectory, recordName), recordBytes);
    const observed = pathnameReplacementReader((filePath) => filePath.endsWith(recordName));
    await assert.rejects(
      () => readReleaseJournalRecords(fixture.receiptDirectory, { fileReader: observed.reader }),
      /changed|identity|ordinary/i,
    );
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [1024 * 1024]);
  });

  await t.test('recovery temp', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-temp-');
    const tempName = `${recordName}.tmp-${'1'.repeat(32)}`;
    await writeFile(join(fixture.stateDirectory, tempName), recordBytes);
    const observed = pathnameReplacementReader((filePath) => filePath.endsWith(tempName));
    await assert.rejects(
      () => recoverJournalTemp(fixture.stateDirectory, { fileReader: observed.reader }),
      /changed|identity|ordinary|temporary/i,
    );
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [1024 * 1024]);
  });

  await t.test('published recovery target reread', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-final-');
    const tempName = `${recordName}.tmp-${'2'.repeat(32)}`;
    await writeFile(join(fixture.stateDirectory, recordName), recordBytes);
    await writeFile(join(fixture.stateDirectory, tempName), recordBytes);
    let finalReads = 0;
    const observed = pathnameReplacementReader((filePath) => {
      if (!filePath.endsWith(recordName)) return false;
      finalReads += 1;
      return finalReads === 2;
    });
    await assert.rejects(
      () => recoverJournalTemp(fixture.stateDirectory, { fileReader: observed.reader }),
      /changed|identity|ordinary|target/i,
    );
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [
      1024 * 1024, 1024 * 1024, 1024 * 1024,
    ]);
  });

  await t.test('active lock', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-active-lock-');
    await writeFile(join(fixture.stateDirectory, '.release-state.lock'), canonicalLockBytes());
    const observed = pathnameReplacementReader((filePath) => filePath.endsWith('.release-state.lock'));
    await assert.rejects(() => acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
      isPidAlive: () => false, staleAfterMs: 60_000, fileReader: observed.reader,
    }), /changed|identity|ordinary|lock/i);
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [16 * 1024]);
  });

  await t.test('stale-lock recovery artifact', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-stale-lock-');
    const staleName = `.release-state.lock.stale-${'3'.repeat(32)}`;
    await writeFile(join(fixture.stateDirectory, staleName), canonicalLockBytes());
    const observed = pathnameReplacementReader((filePath) => filePath.endsWith(staleName));
    await assert.rejects(() => acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
      isPidAlive: () => false, staleAfterMs: 60_000, fileReader: observed.reader,
    }), /changed|identity|ordinary|lock/i);
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [16 * 1024]);
  });

  await t.test('moved stale lock after takeover rename', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-moved-lock-');
    await writeFile(join(fixture.stateDirectory, '.release-state.lock'), canonicalLockBytes());
    const observed = pathnameReplacementReader((filePath) => filePath.includes('.release-state.lock.stale-'));
    await assert.rejects(() => acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
      isPidAlive: () => false, staleAfterMs: 60_000, fileReader: observed.reader,
    }), /changed|identity|ordinary|lock|takeover/i);
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [16 * 1024, 16 * 1024]);
  });

  await t.test('release-time ownership read', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-swap-release-lock-');
    const observed = pathnameReplacementReader((filePath) => filePath.endsWith('.release-state.lock'));
    const lock = await acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date(CREATED_AT), fileReader: observed.reader,
    });
    await assert.rejects(() => lock.release(), /changed|identity|ordinary|lock|ownership/i);
    assert.deepEqual(observed.calls.map(({ maximumBytes }) => maximumBytes), [16 * 1024]);
  });
});

test('oversized journal, temp, lock, and stale-lock files route through explicit preallocation bounds', async (t) => {
  const cases = [
    ['journal', '00000001-intent.json', 1024 * 1024,
      ({ receiptDirectory }, reader) => readReleaseJournalRecords(receiptDirectory, { fileReader: reader })],
    ['temp', `00000001-intent.json.tmp-${'4'.repeat(32)}`, 1024 * 1024,
      ({ stateDirectory }, reader) => recoverJournalTemp(stateDirectory, { fileReader: reader })],
    ['active lock', '.release-state.lock', 16 * 1024,
      ({ stateDirectory }, reader) => acquireReleaseStateLock(stateDirectory, {
        attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
        isPidAlive: () => false, fileReader: reader,
      })],
    ['stale lock', `.release-state.lock.stale-${'5'.repeat(32)}`, 16 * 1024,
      ({ stateDirectory }, reader) => acquireReleaseStateLock(stateDirectory, {
        attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
        isPidAlive: () => false, fileReader: reader,
      })],
  ];
  for (const [name, entryName, maximumBytes, action] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await stateFixture(subtest, `hkbuddy-state-oversized-${name.replace(' ', '-')}-`);
      await writeFile(join(fixture.stateDirectory, entryName), Buffer.alloc(maximumBytes + 1, 0x78));
      const calls = [];
      const reader = async (filePath, options) => {
        calls.push({ filePath, maximumBytes: options?.maximumBytes });
        return readBoundedOrdinaryFile(filePath, options);
      };
      await assert.rejects(() => action(fixture, reader), /length|ordinary|invalid|journal|temporary|lock/i);
      assert.deepEqual(calls.map((call) => call.maximumBytes), [maximumBytes]);
    });
  }

  await t.test('final recovery target grows beyond the journal bound before its decisive reread', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-oversized-final-target-');
    const record = threeRecordJournal()[0];
    const recordName = journalFileName(record);
    const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const finalPath = join(fixture.stateDirectory, recordName);
    const tempPath = join(fixture.stateDirectory, `${recordName}.tmp-${'6'.repeat(32)}`);
    await writeFile(finalPath, recordBytes);
    await writeFile(tempPath, recordBytes);
    const reader = async (filePath, options) => {
      const bytes = await readBoundedOrdinaryFile(filePath, options);
      if (filePath === tempPath) await writeFile(finalPath, Buffer.alloc(1024 * 1024 + 1, 0x78));
      return bytes;
    };
    await assert.rejects(
      () => recoverJournalTemp(fixture.stateDirectory, { fileReader: reader }),
      /length|ordinary|changed|target/i,
    );
  });

  await t.test('moved stale lock grows beyond the lock bound before its decisive reread', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-oversized-moved-lock-');
    const activePath = join(fixture.stateDirectory, '.release-state.lock');
    await writeFile(activePath, canonicalLockBytes());
    const reader = async (filePath, options) => {
      const bytes = await readBoundedOrdinaryFile(filePath, options);
      if (filePath === activePath) await writeFile(activePath, Buffer.alloc(16 * 1024 + 1, 0x78));
      return bytes;
    };
    await assert.rejects(() => acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date('2026-08-26T01:22:03.000Z'),
      isPidAlive: () => false, staleAfterMs: 60_000, fileReader: reader,
    }), /length|ordinary|changed|lock|takeover/i);
  });

  await t.test('release-time lock grows beyond the lock bound before ownership read', async (subtest) => {
    const fixture = await stateFixture(subtest, 'hkbuddy-state-oversized-release-lock-');
    const activePath = join(fixture.stateDirectory, '.release-state.lock');
    let growBeforeRead = false;
    const reader = async (filePath, options) => {
      if (growBeforeRead && filePath === activePath) {
        await writeFile(activePath, Buffer.alloc(16 * 1024 + 1, 0x78));
      }
      return readBoundedOrdinaryFile(filePath, options);
    };
    const lock = await acquireReleaseStateLock(fixture.stateDirectory, {
      attemptId: ATTEMPT_ID, now: () => new Date(CREATED_AT), fileReader: reader,
    });
    growBeforeRead = true;
    await assert.rejects(() => lock.release(), /length|ordinary|changed|lock|ownership/i);
  });
});

test('Windows directory-sync degradation accepts EPERM only', async () => {
  const module = await import('../scripts/release-state-store.js');
  assert.equal(module.classifyDirectorySyncError(
    Object.assign(new Error('unsupported'), { code: 'EPERM' }), { platform: 'win32' },
  ), 'windows-process-crash-boundary');
  for (const code of ['EACCES', 'EBADF', 'EINVAL']) {
    assert.throws(() => module.classifyDirectorySyncError(
      Object.assign(new Error(code), { code }), { platform: 'win32' },
    ), { code });
  }
});

test('release-state lock permits only bounded dead same-host takeover', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-state-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  const first = await acquireReleaseStateLock(stateDirectory, {
    attemptId: ATTEMPT_ID, host: hostname(), pid: 1234, now: () => new Date(CREATED_AT),
  });
  await assert.rejects(() => acquireReleaseStateLock(stateDirectory, {
    attemptId: '223e4567-e89b-42d3-a456-426614174000', host: 'foreign-host', pid: 9999,
    now: () => new Date('2026-08-26T01:12:03.000Z'), isPidAlive: () => false,
  }), /lock/i);
  await first.release();

  await writeFile(join(stateDirectory, '.release-state.lock'), `${JSON.stringify({
    schemaVersion: 1, attemptId: '323e4567-e89b-42d3-a456-426614174000',
    host: hostname(), pid: 4321, createdAt: CREATED_AT,
  }, null, 2)}\n`, { mode: 0o600 });
  const reclaimed = await acquireReleaseStateLock(stateDirectory, {
    attemptId: ATTEMPT_ID, host: hostname(), pid: 5678,
    now: () => new Date('2026-08-26T01:12:03.000Z'), isPidAlive: () => false,
    staleAfterMs: 60_000,
  });
  await reclaimed.release();
});

test('state-store open recovers one bounded stale-lock rename artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-stale-lock-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptDirectory = join(root, 'receipts');
  const stateDirectory = join(receiptDirectory, 'state');
  await mkdir(receiptDirectory);
  await mkdir(stateDirectory);
  await writeFile(join(stateDirectory, `.release-state.lock.stale-${'1'.repeat(32)}`), `${JSON.stringify({
    schemaVersion: 1,
    attemptId: '323e4567-e89b-42d3-a456-426614174000',
    host: hostname(),
    pid: 2_147_483_647,
    createdAt: CREATED_AT,
  }, null, 2)}\n`, { mode: 0o600 });

  const store = await openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'candidate',
    phasePlanSha256: PLAN_SHA,
    attemptId: ATTEMPT_ID,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date('2026-08-26T01:22:03.000Z'),
    allowTemporaryState: true,
  });
  await store.close();
});

test('persisted-secret scanner rejects credential-key variants recursively', () => {
  for (const value of [
    { password: 'redacted-looking-but-forbidden' },
    { nested: { apiKey: 'redacted-looking-but-forbidden' } },
    { items: [{ client_secret: 'redacted-looking-but-forbidden' }] },
    { clientSecret: 'redacted-looking-but-forbidden' },
    { passphrase: 'redacted-looking-but-forbidden' },
  ]) assert.equal(containsForbiddenPersistedSecret(value), true);
  assert.equal(containsForbiddenPersistedSecret({ passwordSha256: 'a'.repeat(64) }), false);
});

test('state store appends one exact intent-checkpoint-terminal attempt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-state-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptDirectory = join(root, 'receipts');
  await mkdir(receiptDirectory);
  const store = await openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'candidate',
    phasePlanSha256: PLAN_SHA,
    attemptId: ATTEMPT_ID,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date(CREATED_AT),
    allowTemporaryState: true,
  });
  const intent = await store.appendIntent(common().payload, { operationId: 'candidate-deploy' });
  const checkpoint = await store.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after', outcome: 'applied', observationSha256: '2'.repeat(64),
    safeResult: { kind: 'resource', state: 'present', identitySha256: '3'.repeat(64), valueSha256: '2'.repeat(64) },
  });
  await store.appendTerminal({
    status: 'phase-complete', checkpointRecordSha256: checkpoint.recordSha256,
    receiptSha256: '4'.repeat(64), terminalState: { candidate: 'private-100', mutationCount: 1 },
    mutationCount: 1, responseLossOperationIds: [],
  });
  assert.equal(validateJournalRecords(store.records), true);
  await store.close();
});

test('state store closes one unperformed intent with an abort and permits a new attempt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-state-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptDirectory = join(root, 'receipts');
  await mkdir(receiptDirectory);
  const store = await openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'promote',
    phasePlanSha256: PLAN_SHA,
    attemptId: ATTEMPT_ID,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date(CREATED_AT),
    allowTemporaryState: true,
  });
  const proofIntent = await store.appendIntent(common().payload, {
    operationId: 'promote-privacy-publish',
  });
  const proofCheckpoint = await store.appendCheckpoint({
    intentRecordSha256: proofIntent.recordSha256,
    classification: 'after', outcome: 'applied', observationSha256: '2'.repeat(64),
    safeResult: { kind: 'artifact-bundle', artifactCount: 1, bundleSha256: '2'.repeat(64) },
  });
  const finalIntent = await store.appendIntent({
    ...common().payload,
    mutationOrdinal: 2,
  }, { operationId: 'promote-traffic' });
  await store.appendAbort({
    intentRecordSha256: finalIntent.recordSha256,
    reason: 'expired-before-final-mutation',
  });
  await store.appendTerminal({
    status: 'phase-blocked', checkpointRecordSha256: proofCheckpoint.recordSha256,
    receiptSha256: '4'.repeat(64),
    terminalState: { code: 'PROMOTION_REPROOF_REQUIRED', mutationCount: 1, phase: 'promote' },
    mutationCount: 1, responseLossOperationIds: [],
  });
  assert.equal(validateJournalRecords(store.records), true);
  await store.close();

  const nextAttemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const next = await openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'promote',
    phasePlanSha256: PLAN_SHA,
    attemptId: nextAttemptId,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date(CREATED_AT),
    allowTemporaryState: true,
  });
  assert.equal(next.attemptId, nextAttemptId);
  assert.equal(next.records.at(-1).recordType, 'terminal');
  await next.close();
});

test('state store reopens one matching in-flight attempt and rejects plan drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hkbuddy-state-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptDirectory = join(root, 'receipts');
  await mkdir(receiptDirectory);
  const first = await openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'candidate',
    phasePlanSha256: PLAN_SHA,
    attemptId: ATTEMPT_ID,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date(CREATED_AT),
    allowTemporaryState: true,
  });
  const intent = await first.appendIntent(common().payload, { operationId: 'candidate-deploy' });
  await first.close();

  const restartAttemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await assert.rejects(() => openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'candidate',
    phasePlanSha256: '9'.repeat(64),
    attemptId: restartAttemptId,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date(CREATED_AT),
    allowTemporaryState: true,
  }), /journal|plan/i);

  const restarted = await openReleaseStateStore({
    receiptDirectory,
    releaseSha: RELEASE_SHA,
    releaseIdentitySha256: RELEASE_IDENTITY,
    phase: 'candidate',
    phasePlanSha256: PLAN_SHA,
    attemptId: restartAttemptId,
    receiptHeadSha256: RECEIPT_HEAD,
    now: () => new Date(CREATED_AT),
    allowTemporaryState: true,
  });
  assert.equal(restarted.attemptId, ATTEMPT_ID);
  assert.equal(restarted.records.at(-1).recordSha256, intent.recordSha256);
  await restarted.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: 'adopted-restart',
    observationSha256: '2'.repeat(64),
    safeResult: { kind: 'none' },
  });
  await restarted.close();
});

test('reconciliation adopts only exact after and blocks before, in-flight, and mixed truth', async () => {
  const before = { state: 'before', revision: 'old' };
  const inFlight = { state: 'in-flight', revision: 'new' };
  const after = { state: 'after', revision: 'new' };
  assert.equal(classifyReconciliation({ before, inFlight, after, observed: structuredClone(after) }), 'after');
  assert.equal(classifyReconciliation({ before, inFlight, after, observed: structuredClone(before) }), 'before');
  assert.equal(classifyReconciliation({ before, inFlight, after, observed: structuredClone(inFlight) }), 'in-flight');
  assert.equal(classifyReconciliation({ before, inFlight, after, observed: { state: 'mixed' } }), 'mixed');

  const events = [];
  const adopted = await reconcileMutation({
    before, inFlight, after,
    readBefore: async () => structuredClone(before),
    appendIntent: async (value) => { events.push(['intent', value]); return { recordSha256: '1'.repeat(64) }; },
    mutate: async () => { events.push(['mutate']); throw new Error('response lost'); },
    readAfter: async () => structuredClone(after),
    appendCheckpoint: async (value) => { events.push(['checkpoint', value]); return value; },
    intent: common().payload,
    safeResult: { kind: 'resource', state: 'present', identitySha256: '3'.repeat(64), valueSha256: '2'.repeat(64) },
  });
  assert.equal(adopted.outcome, 'adopted-response-loss');
  assert.deepEqual(events.map(([kind]) => kind), ['intent', 'mutate', 'checkpoint']);

  for (const observed of [before, inFlight, { state: 'mixed' }]) {
    await assert.rejects(() => reconcileMutation({
      before, inFlight, after,
      readBefore: async () => structuredClone(before),
      appendIntent: async () => ({ recordSha256: '1'.repeat(64) }),
      mutate: async () => true,
      readAfter: async () => structuredClone(observed),
      appendCheckpoint: async () => { throw new Error('must not checkpoint'); },
      intent: common().payload,
      safeResult: { kind: 'none' },
    }), /reconciliation/i);
  }
});

test('every mutation family has an explicit restart classification policy', () => {
  const boundedRetryKinds = [
    'cloud-run-job-replace',
    'cloud-run-service-replace',
    'cloud-run-service-iam',
    'cloud-run-traffic',
    'cloud-run-service-delete',
    'gcs-object-write',
    'gcs-object-delete',
  ];
  const noRetryKinds = [
    'cloud-build-submit',
    'cloud-run-job-execute',
    'secret-version-add',
  ];
  for (const reconcileKind of [...boundedRetryKinds, ...noRetryKinds]) {
    assert.equal(classifyRestartDisposition({ reconcileKind, classification: 'after' }),
      'adopt-after', reconcileKind);
    assert.equal(classifyRestartDisposition({ reconcileKind, classification: 'in-flight' }),
      'poll-only', reconcileKind);
    assert.equal(classifyRestartDisposition({ reconcileKind, classification: 'mixed' }),
      'block-mixed', reconcileKind);
  }
  for (const reconcileKind of boundedRetryKinds) {
    assert.equal(classifyRestartDisposition({ reconcileKind, classification: 'before' }),
      'retry-exact-before', reconcileKind);
  }
  for (const reconcileKind of noRetryKinds) {
    assert.equal(classifyRestartDisposition({ reconcileKind, classification: 'before' }),
      'block-ambiguous', reconcileKind);
  }
  assert.throws(() => classifyRestartDisposition({
    reconcileKind: 'unknown', classification: 'after',
  }), /restart/i);
});

test('intent durability failure prevents mutation and restart-after adopts without repeating it', async () => {
  let mutationCalls = 0;
  await assert.rejects(() => reconcileMutation({
    before: { state: 'before' }, after: { state: 'after' },
    readBefore: async () => ({ state: 'before' }),
    appendIntent: async () => { throw new Error('disk full'); },
    mutate: async () => { mutationCalls += 1; },
    readAfter: async () => ({ state: 'after' }),
    appendCheckpoint: async () => true,
    intent: common().payload, safeResult: { kind: 'none' },
  }), /intent|disk/i);
  assert.equal(mutationCalls, 0);

  const events = [];
  const existingIntent = { recordSha256: '1'.repeat(64) };
  const adopted = await reconcileMutation({
    before: { state: 'before' }, after: { state: 'after' }, existingIntent,
    readBefore: async () => { throw new Error('restart must not re-read or retry before'); },
    appendIntent: async () => { throw new Error('restart must not append a second intent'); },
    mutate: async () => { mutationCalls += 1; },
    readAfter: async () => { events.push('read-after'); return { state: 'after' }; },
    appendCheckpoint: async (value) => { events.push('checkpoint'); return value; },
    intent: common().payload, safeResult: { kind: 'none' },
  });
  assert.equal(adopted.outcome, 'adopted-restart');
  assert.deepEqual(events, ['read-after', 'checkpoint']);
  assert.equal(mutationCalls, 0);
});

test('receipt-before-terminal recovery performs one local terminal append and no mutation', async () => {
  const records = threeRecordJournal().slice(0, 2);
  const events = [];
  const receipt = { receiptSha256: '4'.repeat(64), phase: 'candidate' };
  const terminal = await recoverTerminalFromReceipt({
    records,
    receipt,
    terminalState: { candidate: 'private-100', mutationCount: 1 },
    appendTerminal: async (payload) => { events.push(payload); return payload; },
  });
  assert.equal(terminal.receiptSha256, receipt.receiptSha256);
  assert.deepEqual(events[0].responseLossOperationIds, []);
  assert.equal(events[0].checkpointRecordSha256, records[1].recordSha256);
});

test('terminal recovery counts only the current attempt in a multi-phase journal', async () => {
  const records = threeRecordJournal();
  const secondAttemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const intent = finalizeJournalRecord(common({
    recordType: 'intent',
    generation: 4,
    attemptId: secondAttemptId,
    phase: 'candidate-cleanup',
    phasePlanSha256: '8'.repeat(64),
    operationId: 'candidate-cleanup-delete',
    receiptHeadSha256: records.at(-1).payload.receiptSha256,
    previousRecordSha256: records.at(-1).recordSha256,
    payload: {
      mutationOrdinal: 1,
      operationAttemptId: '9'.repeat(32),
      commandSha256: 'a'.repeat(64),
      reconcileKind: 'cloud-run-service-delete',
      beforeSha256: 'b'.repeat(64),
      afterSha256: 'c'.repeat(64),
    },
  }));
  const checkpoint = finalizeJournalRecord(common({
    recordType: 'checkpoint',
    generation: 5,
    attemptId: secondAttemptId,
    phase: 'candidate-cleanup',
    phasePlanSha256: '8'.repeat(64),
    operationId: 'candidate-cleanup-delete',
    receiptHeadSha256: records.at(-1).payload.receiptSha256,
    previousRecordSha256: intent.recordSha256,
    payload: {
      intentRecordSha256: intent.recordSha256,
      classification: 'after',
      outcome: 'adopted-restart',
      observationSha256: 'c'.repeat(64),
      safeResult: { kind: 'none' },
    },
  }));
  records.push(intent, checkpoint);
  let terminalPayload;
  await recoverTerminalFromReceipt({
    records,
    receipt: { receiptSha256: 'd'.repeat(64), phase: 'candidate-cleanup' },
    terminalState: { cleanup: 'absent', mutationCount: 1 },
    appendTerminal: async (payload) => { terminalPayload = payload; return payload; },
  });
  assert.equal(terminalPayload.mutationCount, 1);
  assert.deepEqual(terminalPayload.responseLossOperationIds, ['candidate-cleanup-delete']);
});

test('final mutation guard permits only reads and durable local writes afterwards', () => {
  const guard = createFinalMutationGuard({
    finalOperationId: 'promote-public-service',
    mutationOperationIds: ['promote-stable-deploy', 'promote-public-service'],
  });
  assert.equal(guard.beforeOperation('promote-stable-deploy'), true);
  assert.equal(guard.beforeOperation('promote-public-service'), true);
  assert.equal(guard.afterOperation('promote-public-service'), true);
  assert.equal(guard.beforeOperation('promote-public-iam-readback'), true);
  assert.throws(() => guard.beforeOperation('promote-stable-deploy'), /final mutation/i);
});

test('resume accepts only checkpointed-after prefix, one current intent, and untouched suffix', () => {
  assert.equal(validateReconciliationPrefix({
    operationIds: ['one', 'two', 'three'],
    records: [
      { recordType: 'intent', operationId: 'one', recordSha256: '1'.repeat(64) },
      { recordType: 'checkpoint', operationId: 'one', payload: { classification: 'after' } },
      { recordType: 'intent', operationId: 'two', recordSha256: '2'.repeat(64) },
    ],
  }), true);
  for (const records of [
    [{ recordType: 'intent', operationId: 'two' }],
    [{ recordType: 'checkpoint', operationId: 'one', payload: { classification: 'before' } }],
    [
      { recordType: 'intent', operationId: 'one' },
      { recordType: 'checkpoint', operationId: 'one', payload: { classification: 'after' } },
      { recordType: 'intent', operationId: 'three' },
    ],
  ]) assert.throws(() => validateReconciliationPrefix({
    operationIds: ['one', 'two', 'three'], records,
  }), /prefix/i);
});
