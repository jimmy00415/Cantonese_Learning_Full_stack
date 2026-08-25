import assert from 'node:assert/strict';
import test from 'node:test';

import { clearErrorCopy, sendErrorCopy, startErrorCopy } from '../public/chat-copy.js';

test('chat copy keeps bootstrap failure separate from send ambiguity', () => {
  const copy = startErrorCopy({ code: 'NETWORK_UNAVAILABLE' });
  assert.match(copy, /chat could not start/i);
  assert.doesNotMatch(copy, /message|send not confirmed/i);
});

test('chat copy distinguishes ambiguous send, explicit rejection, and recovered session', () => {
  assert.match(sendErrorCopy({ code: 'NETWORK_UNAVAILABLE' }), /send not confirmed/i);
  assert.match(sendErrorCopy({ code: 'RATE_LIMITED', status: 429, retryAfter: '10' }), /not accepted.*wait/i);
  assert.match(sendErrorCopy({ code: 'UNAUTHORIZED', status: 401 }), /not accepted/i);
  assert.doesNotMatch(sendErrorCopy({ code: 'UNAUTHORIZED', status: 401 }), /retry send/i);
  assert.match(sendErrorCopy({ code: 'SESSION_RECOVERED' }), /new guest chat.*draft.*kept/i);
});

test('chat copy tells the truth when clear succeeded but guest restart failed', () => {
  const partial = clearErrorCopy({ code: 'CLEARED_RESTART_FAILED', deleted: true });
  assert.match(partial, /^Conversation cleared\./i);
  assert.doesNotMatch(partial, /was not cleared/i);
  assert.match(clearErrorCopy({ code: 'NETWORK_UNAVAILABLE' }), /was not cleared/i);
});

test('chat copy explains the non-ready state when clear and same-session recovery both fail', () => {
  const copy = clearErrorCopy({ code: 'CLEAR_FAILED_RECOVERY_PENDING', deleted: false });
  assert.match(copy, /was not cleared/i);
  assert.match(copy, /could not be reloaded/i);
  assert.match(copy, /refresh/i);
});

test('chat copy does not invent a clear outcome when DELETE and scope recovery are both ambiguous', () => {
  const copy = clearErrorCopy({ code: 'CLEAR_OUTCOME_UNKNOWN', deleted: null });
  assert.match(copy, /could not be confirmed/i);
  assert.match(copy, /refresh/i);
  assert.doesNotMatch(copy, /was not cleared|^Conversation cleared/i);
});
