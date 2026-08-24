import assert from 'node:assert/strict';

export async function exerciseDeletionGenerationContract({ store, storageKey, now }) {
  const first = await store.enqueueMediaDeletion({ storageKey, reason: 'test-delete', notBefore: now, now });
  assert.equal(first.generation, 1);
  const claimed = await store.claimNextMediaDeletion({
    workerId: 'cleanup-one', leaseToken: 'cleanup-token-one',
    leaseExpiresAt: new Date(new Date(now).getTime() + 30_000), now,
  });
  assert.equal(claimed.storageKey, storageKey);
  assert.equal(claimed.generation, 1);

  const rearmed = await store.rearmMediaDeletionAfterWrite({ storageKey, reason: 'late-write', notBefore: now, now });
  assert.equal(rearmed.generation, 2);
  assert.equal(rearmed.state, 'pending');
  await assert.rejects(
    store.completeMediaDeletion({ jobId: claimed.id, generation: 1, leaseToken: 'cleanup-token-one', now }),
    { code: 'LEASE_LOST' },
  );

  const second = await store.claimNextMediaDeletion({
    workerId: 'cleanup-two', leaseToken: 'cleanup-token-two',
    leaseExpiresAt: new Date(new Date(now).getTime() + 30_000), now,
  });
  const completed = await store.completeMediaDeletion({
    jobId: second.id, generation: second.generation, leaseToken: 'cleanup-token-two', now,
  });
  assert.equal(completed.state, 'completed');
  const afterCompletedWrite = await store.rearmMediaDeletionAfterWrite({ storageKey, reason: 'write-after-complete', notBefore: now, now });
  assert.equal(afterCompletedWrite.generation, 3);
  assert.equal(afterCompletedWrite.state, 'pending');
}
