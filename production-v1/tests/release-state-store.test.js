import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireReleaseStateLock,
  canonicalJson,
  finalizeJournalRecord,
  journalFileName,
  openReleaseStateStore,
  recoverJournalTemp,
  validateJournalRecords,
  writeAtomicCreateOnly,
} from '../scripts/release-state-store.js';
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

  const thirdName = journalFileName(records[2]);
  for (const suffix of ['2'.repeat(32), '3'.repeat(32)]) {
    await writeFile(join(stateDirectory, `${thirdName}.tmp-${suffix}`), `${JSON.stringify(records[2])}\n`);
  }
  await assert.rejects(() => recoverJournalTemp(stateDirectory), /temporary|ambiguous/i);
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
  })}\n`, { mode: 0o600 });
  const reclaimed = await acquireReleaseStateLock(stateDirectory, {
    attemptId: ATTEMPT_ID, host: hostname(), pid: 5678,
    now: () => new Date('2026-08-26T01:12:03.000Z'), isPidAlive: () => false,
    staleAfterMs: 60_000,
  });
  await reclaimed.release();
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
