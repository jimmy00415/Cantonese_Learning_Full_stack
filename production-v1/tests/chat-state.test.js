import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOptimisticMessage,
  eventHint,
  formatFreshness,
  markOptimisticFailed,
  reconcileTimeline,
  retryPayload,
  safeOfficialUrl,
  shouldSubmitOnEnter,
  shouldSyncDraft,
  turnStatusMessage,
} from '../public/chat-state.js';

test('chat state replaces an optimistic bubble with its canonical accepted message', () => {
  const pending = createOptimisticMessage({
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    text: 'How do I activate my account?',
    createdAt: '2026-08-25T10:00:00.000Z',
  });
  const canonical = [{
    id: 'message-1', clientMessageId: pending.clientMessageId, sequence: 7,
    role: 'user', kind: 'text', status: 'accepted', text: pending.text,
    createdAt: '2026-08-25T10:00:00.100Z',
  }];

  assert.deepEqual(reconcileTimeline(canonical, [pending]), canonical);
});

test('chat state preserves unmatched optimistic messages after ordered canonical history', () => {
  const pending = createOptimisticMessage({
    clientMessageId: '22222222-2222-4222-8222-222222222222',
    text: 'Where is the library?',
    createdAt: '2026-08-25T10:00:02.000Z',
  });
  const canonical = [
    { id: 'm2', sequence: 2, role: 'assistant', text: 'Second' },
    { id: 'm1', sequence: 1, role: 'user', text: 'First' },
  ];

  const result = reconcileTimeline(canonical, [pending]);

  assert.deepEqual(result.map((message) => message.id), ['m1', 'm2', pending.id]);
  assert.equal(result[2].status, 'sending');
});

test('chat state retries a failed optimistic send with the original idempotency identity', () => {
  const pending = createOptimisticMessage({
    clientMessageId: '33333333-3333-4333-8333-333333333333',
    text: 'How do I use Duo?',
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'voice',
    createdAt: '2026-08-25T10:00:00.000Z',
  });
  const failed = markOptimisticFailed(pending, 'NETWORK_UNAVAILABLE');

  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'NETWORK_UNAVAILABLE');
  assert.deepEqual(retryPayload(failed), {
    clientMessageId: '33333333-3333-4333-8333-333333333333',
    text: 'How do I use Duo?',
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'voice',
  });
});

test('chat state rejects unsupported preferences and snapshots the accepted wire values for retries', () => {
  assert.throws(() => createOptimisticMessage({
    clientMessageId: '33333333-3333-4333-8333-333333333333',
    text: 'Reply to me',
    replyLanguage: 'fr',
    replyMode: 'text',
  }), /replyLanguage/);
  const pending = createOptimisticMessage({
    clientMessageId: '33333333-3333-4333-8333-333333333333',
    text: 'Reply to me',
    replyLanguage: 'cmn-Hans-CN',
    replyMode: 'voice',
  });
  assert.deepEqual(retryPayload(pending), {
    clientMessageId: pending.clientMessageId,
    text: 'Reply to me',
    replyLanguage: 'cmn-Hans-CN',
    replyMode: 'voice',
  });
});

test('chat state preserves the exact voice draft identity through an ambiguous message retry', () => {
  const pending = createOptimisticMessage({
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Where can I collect my student card?',
    voiceDraftId: '55555555-5555-4555-8555-555555555555',
    replyLanguage: 'en',
    replyMode: 'text',
    createdAt: '2026-08-25T10:00:00.000Z',
  });

  assert.equal(pending.kind, 'voice');
  assert.equal(pending.voiceDraftId, '55555555-5555-4555-8555-555555555555');
  assert.deepEqual(retryPayload(markOptimisticFailed(pending, 'NETWORK_UNAVAILABLE')), {
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Where can I collect my student card?',
    voiceDraftId: '55555555-5555-4555-8555-555555555555',
    replyLanguage: 'en',
    replyMode: 'text',
  });
});

test('chat state treats SSE as a forward-only backfill hint', () => {
  assert.deepEqual(eventHint({ type: 'turn.state', lastEventId: '12' }, 10), {
    cursor: 12, shouldBackfill: true, shouldReconnect: false,
  });
  assert.deepEqual(eventHint({ type: 'message.delivered', lastEventId: '9' }, 12), {
    cursor: 12, shouldBackfill: true, shouldReconnect: false,
  });
  assert.deepEqual(eventHint({ type: 'resync_required', lastEventId: '' }, 12), {
    cursor: 0, shouldBackfill: true, shouldReconnect: true,
  });
});

test('chat state announces only persisted nonterminal turn states', () => {
  assert.equal(turnStatusMessage({ state: 'accepted' }), 'Message received.');
  assert.equal(turnStatusMessage({ state: 'retrieving' }), 'Checking official HKBU information…');
  assert.equal(turnStatusMessage({ state: 'generating' }), 'Preparing a grounded reply…');
  assert.equal(turnStatusMessage({ state: 'delivered' }), '');
  assert.equal(turnStatusMessage({ state: 'failed' }), '');
  assert.equal(turnStatusMessage(null), '');
});

test('chat state accepts only secure official HKBU source links', () => {
  assert.equal(safeOfficialUrl('https://ito.hkbu.edu.hk/services/mfa'), 'https://ito.hkbu.edu.hk/services/mfa');
  assert.equal(safeOfficialUrl('https://www.hkbu.edu.hk/'), 'https://www.hkbu.edu.hk/');
  assert.equal(safeOfficialUrl('http://www.hkbu.edu.hk/'), null);
  assert.equal(safeOfficialUrl('https://hkbu.edu.hk.evil.example/'), null);
  assert.equal(safeOfficialUrl('https://user:pass@www.hkbu.edu.hk/'), null);
  assert.equal(safeOfficialUrl('https://www.hkbu.edu.hk:8443/'), null);
  assert.equal(safeOfficialUrl('https://www.hkbu.edu.hk:443/'), 'https://www.hkbu.edu.hk/');
  assert.equal(safeOfficialUrl('javascript:alert(1)'), null);
});

test('chat state formats a valid evidence date without inventing freshness', () => {
  assert.equal(formatFreshness('2026-08-25T04:00:00+08:00'), 'Verified 25 Aug 2026');
  assert.equal(formatFreshness('not-a-date'), 'Date unavailable');
  assert.equal(formatFreshness(null), 'Date unavailable');
});

test('chat state sends Enter only for a fine pointer and preserves Shift Enter', () => {
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false }, true), true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true, isComposing: false }, true), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true }, true), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false }, false), false);
  assert.equal(shouldSubmitOnEnter({ key: 'a', shiftKey: false, isComposing: false }, true), false);
});

test('chat state syncs an accepted or cleared draft even while the textarea keeps focus', () => {
  assert.equal(shouldSyncDraft('already sent', ''), true);
  assert.equal(shouldSyncDraft('old session text', 'new session text'), true);
  assert.equal(shouldSyncDraft('current draft', 'current draft'), false);
});
