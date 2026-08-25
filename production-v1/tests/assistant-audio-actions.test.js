import assert from 'node:assert/strict';
import test from 'node:test';

import { performAssistantAudioAction } from '../public/assistant-audio-actions.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';

function harness({ entry = null, playback = null, message = {}, now = 1_000 } = {}) {
  const calls = [];
  const controller = {
    generate: async (messageId) => { calls.push(['generate', messageId]); return { state: 'ready', mediaId: MEDIA_ID }; },
    refresh: async (messageId) => { calls.push(['refresh', messageId]); return { state: 'ready', mediaId: MEDIA_ID }; },
    play: async (identity) => { calls.push(['play', identity]); return { state: 'playing' }; },
    pause: () => { calls.push(['pause']); return { state: 'paused' }; },
  };
  return {
    calls,
    controller,
    input: {
      controller,
      message: { id: MESSAGE_ID, role: 'assistant', status: 'delivered', mediaId: null, ...message },
      snapshot: { entries: entry ? { [MESSAGE_ID]: entry } : {}, playback },
      now: () => now,
    },
  };
}

test('first assistant voice gesture only generates and a canonical media gesture only plays', async () => {
  const first = harness();
  assert.equal((await performAssistantAudioAction(first.input)).action, 'generate');
  assert.deepEqual(first.calls, [['generate', MESSAGE_ID]]);

  const existing = harness({ message: { mediaId: MEDIA_ID } });
  assert.equal((await performAssistantAudioAction(existing.input)).action, 'play');
  assert.deepEqual(existing.calls, [['play', { messageId: MESSAGE_ID, mediaId: MEDIA_ID }]]);
});

test('playing audio pauses, generating is inert, and malformed or contradictory media fails closed', async () => {
  const playing = harness({ playback: { messageId: MESSAGE_ID, mediaId: MEDIA_ID, state: 'playing' } });
  assert.equal((await performAssistantAudioAction(playing.input)).action, 'pause');
  assert.deepEqual(playing.calls, [['pause']]);

  const generating = harness({ entry: { state: 'generating', mediaId: null } });
  assert.equal((await performAssistantAudioAction(generating.input)).action, 'none');
  assert.deepEqual(generating.calls, []);

  for (const invalid of [
    harness({ message: { mediaId: 'not-a-uuid' } }),
    harness({ message: { mediaId: MEDIA_ID }, entry: { state: 'ready', mediaId: '33333333-3333-4333-8333-333333333333' } }),
  ]) {
    const result = await performAssistantAudioAction(invalid.input);
    assert.equal(result.state, 'invalid');
    assert.match(result.statusText, /text answer/i);
    assert.deepEqual(invalid.calls, []);
  }
});

test('429 retry delay prevents hot POST and enables exact retry only after its not-before time', async () => {
  const waiting = harness({
    now: 1_999,
    entry: { state: 'retryable', mediaId: null, failureCode: 'RATE_LIMITED', retryNotBefore: 2_000 },
  });
  assert.equal((await performAssistantAudioAction(waiting.input)).action, 'wait');
  assert.deepEqual(waiting.calls, []);

  const ready = harness({
    now: 2_000,
    entry: { state: 'retryable', mediaId: null, failureCode: 'RATE_LIMITED', retryNotBefore: 2_000 },
  });
  assert.equal((await performAssistantAudioAction(ready.input)).action, 'generate');
  assert.deepEqual(ready.calls, [['generate', MESSAGE_ID]]);
});

test('ambiguous generation retries recover with GET first and POST only after definitive missing', async () => {
  const recovered = harness({ entry: { state: 'retryable', mediaId: null, failureCode: 'NETWORK_UNAVAILABLE', retryNotBefore: null } });
  assert.equal((await performAssistantAudioAction(recovered.input)).action, 'refresh');
  assert.deepEqual(recovered.calls, [['refresh', MESSAGE_ID]]);

  const missing = harness({ entry: { state: 'retryable', mediaId: null, failureCode: 'AUDIO_INVALID_RESPONSE', retryNotBefore: null } });
  missing.controller.refresh = async (messageId) => { missing.calls.push(['refresh', messageId]); return { state: 'missing' }; };
  assert.equal((await performAssistantAudioAction(missing.input)).action, 'generate-after-missing');
  assert.deepEqual(missing.calls, [['refresh', MESSAGE_ID], ['generate', MESSAGE_ID]]);
});

test('controller rejection is normalized to safe text-primary state without escaping the gesture', async () => {
  const broken = harness();
  broken.controller.generate = async () => { throw new Error('secret adapter detail'); };
  const result = await performAssistantAudioAction(broken.input);
  assert.equal(result.state, 'error');
  assert.match(result.statusText, /text answer/i);
  assert.doesNotMatch(result.statusText, /secret/i);
});
