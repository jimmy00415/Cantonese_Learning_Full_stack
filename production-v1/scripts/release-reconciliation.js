import { createHash } from 'node:crypto';

import { canonicalJson, validateJournalRecords } from './release-state-store.js';

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function classifyReconciliation({ before, inFlight, after, observed } = {}) {
  const observedHash = digest(observed);
  if (observedHash === digest(after)) return 'after';
  if (observedHash === digest(before)) return 'before';
  if (inFlight !== null && inFlight !== undefined && observedHash === digest(inFlight)) return 'in-flight';
  return 'mixed';
}

export async function reconcileMutation({
  before,
  inFlight = null,
  after,
  readBefore,
  appendIntent,
  mutate,
  readAfter,
  appendCheckpoint,
  intent,
  safeResult,
  existingIntent = null,
} = {}) {
  if (![readBefore, appendIntent, mutate, readAfter, appendCheckpoint].every((value) => (
    typeof value === 'function'
  ))) throw new Error('Release reconciliation contract is invalid');
  let intentRecord = existingIntent;
  if (intentRecord === null) {
    const initial = await readBefore();
    if (classifyReconciliation({ before, inFlight, after, observed: initial }) !== 'before') {
      throw new Error('Release reconciliation before-state is invalid');
    }
    intentRecord = await appendIntent(intent);
  }
  if (!/^[0-9a-f]{64}$/.test(String(intentRecord?.recordSha256 ?? ''))) {
    throw new Error('Release reconciliation intent was not durable');
  }
  let commandError = null;
  if (existingIntent === null) {
    try { await mutate(); } catch (error) { commandError = error; }
  }
  const observed = await readAfter();
  const classification = classifyReconciliation({ before, inFlight, after, observed });
  if (classification !== 'after') {
    throw new Error(`Release reconciliation blocked at ${classification}`);
  }
  const outcome = existingIntent !== null
    ? 'adopted-restart' : (commandError ? 'adopted-response-loss' : 'applied');
  const checkpoint = await appendCheckpoint({
    intentRecordSha256: intentRecord.recordSha256,
    classification,
    outcome,
    observationSha256: digest(observed),
    safeResult,
  });
  return Object.freeze({ classification, outcome, checkpoint, commandError });
}

export async function recoverTerminalFromReceipt({
  records,
  receipt,
  terminalState,
  appendTerminal,
} = {}) {
  if (!Array.isArray(records) || records.length < 2
    || typeof appendTerminal !== 'function'
    || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !/^[0-9a-f]{64}$/.test(String(receipt.receiptSha256 ?? ''))
    || records.at(-1)?.recordType !== 'checkpoint') {
    throw new Error('Release terminal recovery is invalid');
  }
  validateJournalRecords(records);
  const responseLossOperationIds = records
    .filter((record) => record.recordType === 'checkpoint'
      && ['adopted-response-loss', 'adopted-restart'].includes(record.payload.outcome))
    .map((record) => record.operationId);
  return appendTerminal({
    status: 'phase-complete',
    checkpointRecordSha256: records.at(-1).recordSha256,
    receiptSha256: receipt.receiptSha256,
    terminalState,
    mutationCount: records.filter((record) => record.recordType === 'checkpoint').length,
    responseLossOperationIds,
  });
}

export function createFinalMutationGuard({ finalOperationId, mutationOperationIds } = {}) {
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(String(finalOperationId ?? ''))
    || !Array.isArray(mutationOperationIds) || !mutationOperationIds.includes(finalOperationId)
    || new Set(mutationOperationIds).size !== mutationOperationIds.length) {
    throw new Error('Final mutation contract is invalid');
  }
  const mutations = new Set(mutationOperationIds);
  let finalMutationCompleted = false;
  return Object.freeze({
    beforeOperation(operationId) {
      if (finalMutationCompleted && mutations.has(operationId)) {
        throw new Error('Cloud mutation is forbidden after the final mutation');
      }
      return true;
    },
    afterOperation(operationId) {
      if (operationId === finalOperationId) finalMutationCompleted = true;
      return true;
    },
    get finalMutationCompleted() { return finalMutationCompleted; },
  });
}

export function validateReconciliationPrefix({ operationIds, records } = {}) {
  if (!Array.isArray(operationIds) || operationIds.length < 1
    || new Set(operationIds).size !== operationIds.length
    || operationIds.some((value) => !/^[a-z][a-z0-9-]{0,95}$/.test(String(value ?? '')))
    || !Array.isArray(records)) throw new Error('Release reconciliation prefix is invalid');
  let operationIndex = 0;
  let currentIntent = null;
  for (const record of records) {
    const expectedOperation = operationIds[operationIndex];
    if (record?.recordType === 'intent') {
      if (currentIntent !== null || record.operationId !== expectedOperation) {
        throw new Error('Release reconciliation prefix is invalid');
      }
      currentIntent = record;
      continue;
    }
    if (record?.recordType === 'checkpoint') {
      if (currentIntent === null || record.operationId !== expectedOperation
        || record.payload?.classification !== 'after') {
        throw new Error('Release reconciliation prefix is invalid');
      }
      currentIntent = null;
      operationIndex += 1;
      continue;
    }
    throw new Error('Release reconciliation prefix is invalid');
  }
  if (operationIndex > operationIds.length
    || (currentIntent !== null && operationIndex >= operationIds.length)) {
    throw new Error('Release reconciliation prefix is invalid');
  }
  return true;
}
