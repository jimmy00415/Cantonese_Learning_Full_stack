import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssistantAudioController } from '../public/assistant-audio-controller.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';

function envelope(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify({ data, error: null, requestId: 'request-public' }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function failure(code, { status = 500, headers = {}, privateMessage = 'private upstream detail' } = {}) {
  return new Response(JSON.stringify({
    data: null,
    error: { code, message: privateMessage },
    requestId: 'request-public',
  }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function responseLike({
  status = 200,
  data,
  error = null,
  headers = {},
  url = '',
  redirected = false,
  text,
  onCancel = () => {},
} = {}) {
  const bodyText = text ?? JSON.stringify({ data, error, requestId: 'request-public' });
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected,
    url,
    headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    text: async () => bodyText,
    body: { cancel: async () => onCancel() },
  };
}

class ForbiddenAudio {
  constructor() {
    throw new Error('Audio must not be constructed during generation');
  }
}

class FakeAudio {
  static instances = [];
  static nextPlayError = null;

  constructor() {
    this.src = '';
    this.preload = '';
    this.autoplay = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.listeners = new Map();
    this.playResult = Promise.resolve();
    FakeAudio.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }

  play() {
    this.playCalls += 1;
    if (FakeAudio.nextPlayError) {
      const error = FakeAudio.nextPlayError;
      FakeAudio.nextPlayError = null;
      return Promise.reject(error);
    }
    return this.playResult;
  }

  pause() {
    this.pauseCalls += 1;
  }
}

test('factory exposes the bounded audio API and returns immutable snapshots', () => {
  const controller = createAssistantAudioController({
    fetchImpl: async () => { throw new Error('must not fetch'); },
    AudioClass: class {},
    origin: 'https://buddy.example',
  });

  for (const method of [
    'snapshot',
    'generate',
    'refresh',
    'prepare',
    'play',
    'pause',
    'handleHidden',
    'dispose',
  ]) {
    assert.equal(typeof controller[method], 'function', method);
  }

  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot, {
    disposed: false,
    entries: {},
    playback: null,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.entries), true);
  assert.throws(() => { snapshot.entries.fake = {}; }, TypeError);
});

test('one explicit generate gesture only POSTs and exposes ready audio without constructing or playing Audio', async () => {
  const calls = [];
  const changes = [];
  const controller = createAssistantAudioController({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return envelope({
        messageId: MESSAGE_ID,
        state: 'attached',
        mediaId: MEDIA_ID,
        failureCode: null,
        retryable: false,
      }, { status: 201 });
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
    onChange: (snapshot) => changes.push(snapshot),
  });

  const result = await controller.generate(MESSAGE_ID);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/messages/${MESSAGE_ID}/audio`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(result, {
    messageId: MESSAGE_ID,
    state: 'ready',
    mediaId: MEDIA_ID,
    failureCode: null,
    retryable: false,
    retryAfterMs: null,
    retryNotBefore: null,
    statusText: 'Audio ready. Tap Play to listen.',
  });
  assert.deepEqual(controller.snapshot().entries[MESSAGE_ID], result);
  assert.ok(changes.some((snapshot) => snapshot.entries[MESSAGE_ID]?.state === 'generating'));
  assert.equal(Object.isFrozen(changes.at(-1)), true);
  assert.equal(Object.isFrozen(changes.at(-1).entries[MESSAGE_ID]), true);
  assert.equal(controller.snapshot().playback, null);
});

test('voice reply preparation is GET-first, preserves text, and never constructs or plays Audio', async () => {
  FakeAudio.instances.length = 0;
  const calls = [];
  const message = {
    id: MESSAGE_ID,
    role: 'assistant',
    text: 'Grounded text remains visible.',
    replyMode: 'voice',
    mediaId: null,
  };
  const controller = createAssistantAudioController({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return envelope({ messageId: MESSAGE_ID, state: 'attached', mediaId: MEDIA_ID, failureCode: null, retryable: false });
    },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });
  const result = await controller.prepare(message);
  assert.equal(result.state, 'ready');
  assert.equal(message.text, 'Grounded text remains visible.');
  assert.deepEqual(calls, [{ url: `/api/v1/messages/${MESSAGE_ID}/audio/status`, method: 'GET' }]);
  assert.equal(FakeAudio.instances.length, 0);
  assert.equal(controller.snapshot().playback, null);
});

test('text replies never prepare audio and voice preparation failure leaves grounded text unchanged', async () => {
  let calls = 0;
  const controller = createAssistantAudioController({
    fetchImpl: async () => {
      calls += 1;
      return failure('VOICE_SYNTHESIS_REJECTED', { status: 502 });
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
  });
  const textMessage = { id: MESSAGE_ID, role: 'assistant', text: 'Text only.', replyMode: 'text', mediaId: null };
  assert.equal(await controller.prepare(textMessage), null);
  const voiceMessage = { ...textMessage, text: 'Keep this answer.', replyMode: 'voice' };
  const failed = await controller.prepare(voiceMessage);
  assert.equal(failed.state, 'failed');
  assert.equal(voiceMessage.text, 'Keep this answer.');
  assert.equal(calls, 1);
  assert.equal(controller.snapshot().playback, null);
});

test('202 generation polls only the validated status Location after a positive Retry-After and still never plays', async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    envelope({
      messageId: MESSAGE_ID,
      state: 'generating',
      mediaId: null,
      failureCode: null,
      retryable: false,
    }, {
      status: 202,
      headers: {
        Location: `https://buddy.example/api/v1/messages/${MESSAGE_ID}/audio/status`,
        'Retry-After': '2',
      },
    }),
    envelope({
      messageId: MESSAGE_ID,
      state: 'attached',
      mediaId: MEDIA_ID,
      failureCode: null,
      retryable: false,
    }),
  ];
  const controller = createAssistantAudioController({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
    sleep: async (milliseconds, { signal }) => {
      sleeps.push(milliseconds);
      assert.equal(signal.aborted, false);
    },
    now: () => 1_000,
  });

  const result = await controller.generate(MESSAGE_ID);

  assert.equal(result.state, 'ready');
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    [`/api/v1/messages/${MESSAGE_ID}/audio`, 'POST'],
    [`/api/v1/messages/${MESSAGE_ID}/audio/status`, 'GET'],
  ]);
  assert.ok(calls.every(({ options }) => (
    options.credentials === 'same-origin'
      && options.redirect === 'error'
      && options.signal instanceof AbortSignal
  )));
  assert.equal(controller.snapshot().playback, null);
});

test('refresh starts with GET and recovers an already attached message without POST or playback', async () => {
  const calls = [];
  const controller = createAssistantAudioController({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return envelope({
        messageId: MESSAGE_ID,
        state: 'attached',
        mediaId: MEDIA_ID,
        failureCode: null,
        retryable: false,
      });
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
  });

  assert.equal((await controller.refresh(MESSAGE_ID)).state, 'ready');
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [[
    `/api/v1/messages/${MESSAGE_ID}/audio/status`,
    'GET',
  ]]);
});

test('202 rejects every unsafe polling instruction without sleeping or following it', async (t) => {
  const validData = {
    messageId: MESSAGE_ID,
    state: 'generating',
    mediaId: null,
    failureCode: null,
    retryable: false,
  };
  const cases = [
    ['missing Location', { 'Retry-After': '1' }, validData],
    ['cross-origin Location', { Location: 'https://evil.example/status', 'Retry-After': '1' }, validData],
    ['queried Location', { Location: `/api/v1/messages/${MESSAGE_ID}/audio/status?next=1`, 'Retry-After': '1' }, validData],
    ['wrong message Location', { Location: '/api/v1/messages/33333333-3333-4333-8333-333333333333/audio/status', 'Retry-After': '1' }, validData],
    ['missing Retry-After', { Location: `/api/v1/messages/${MESSAGE_ID}/audio/status` }, validData],
    ['zero Retry-After', { Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`, 'Retry-After': '0' }, validData],
    ['oversized Retry-After', { Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`, 'Retry-After': '31' }, validData],
    ['wrong payload identity', { Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`, 'Retry-After': '1' }, { ...validData, messageId: '33333333-3333-4333-8333-333333333333' }],
    ['non-generating 202 state', { Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`, 'Retry-After': '1' }, { ...validData, state: 'attached', mediaId: MEDIA_ID }],
  ];

  for (const [name, headers, data] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      let sleeps = 0;
      const controller = createAssistantAudioController({
        fetchImpl: async () => {
          calls += 1;
          return envelope(data, { status: 202, headers });
        },
        AudioClass: ForbiddenAudio,
        origin: 'https://buddy.example',
        sleep: async () => { sleeps += 1; },
        maxRetryAfterMs: 30_000,
      });

      const result = await controller.generate(MESSAGE_ID);
      assert.equal(result.state, 'retryable');
      assert.equal(result.failureCode, 'AUDIO_INVALID_RESPONSE');
      assert.match(result.statusText, /text answer/i);
      assert.equal(calls, 1);
      assert.equal(sleeps, 0);
    });
  }
});

test('successful HTTP states must match the exact POST and GET generation contract', async (t) => {
  const attached = {
    messageId: MESSAGE_ID,
    state: 'attached',
    mediaId: MEDIA_ID,
    failureCode: null,
    retryable: false,
  };
  const cases = [
    ['POST rejects 206', 'generate', 206, attached],
    ['GET rejects 201', 'refresh', 201, attached],
    ['attached rejects retryable contradiction', 'generate', 201, { ...attached, retryable: true }],
    ['attached rejects failure contradiction', 'generate', 201, { ...attached, failureCode: 'VOICE_SYNTHESIS_FAILED' }],
  ];

  for (const [name, method, status, data] of cases) {
    await t.test(name, async () => {
      const controller = createAssistantAudioController({
        fetchImpl: async () => envelope(data, { status }),
        AudioClass: ForbiddenAudio,
        origin: 'https://buddy.example',
      });
      const result = await controller[method](MESSAGE_ID);
      assert.equal(result.state, 'retryable');
      assert.equal(result.failureCode, 'AUDIO_INVALID_RESPONSE');
    });
  }
});

test('202 generating rejects failure and retry contradictions', async () => {
  for (const data of [
    { messageId: MESSAGE_ID, state: 'generating', mediaId: null, failureCode: 'VOICE_SYNTHESIS_FAILED', retryable: false },
    { messageId: MESSAGE_ID, state: 'generating', mediaId: null, failureCode: null, retryable: true },
  ]) {
    const controller = createAssistantAudioController({
      fetchImpl: async () => envelope(data, {
        status: 202,
        headers: new Headers({ Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`, 'Retry-After': '1' }),
      }),
      AudioClass: ForbiddenAudio,
      origin: 'https://buddy.example',
      sleep: async () => undefined,
    });
    const result = await controller.generate(MESSAGE_ID);
    assert.equal(result.state, 'retryable');
    assert.equal(result.failureCode, 'AUDIO_INVALID_RESPONSE');
  }
});

test('429 stores an absolute retry boundary and blocks hot regeneration before it', async () => {
  let calls = 0;
  let clock = 1_000;
  const controller = createAssistantAudioController({
    fetchImpl: async () => {
      calls += 1;
      return failure('RATE_LIMITED', {
        status: 429,
        headers: { 'Retry-After': '2' },
      });
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
    now: () => clock,
  });

  const limited = await controller.generate(MESSAGE_ID);
  assert.equal(limited.retryNotBefore, 3_000);
  assert.equal(calls, 1);
  assert.equal((await controller.generate(MESSAGE_ID)).state, 'retryable');
  assert.equal(calls, 1);
  clock = 3_000;
  await controller.generate(MESSAGE_ID);
  assert.equal(calls, 2);
});

test('429 with zero, past, or missing Retry-After still enforces a positive retry floor', async (t) => {
  for (const [name, retryAfter] of [
    ['zero', '0'],
    ['past date', 'Thu, 01 Jan 1970 00:00:00 GMT'],
    ['missing', null],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      let clock = 1_000;
      const headers = retryAfter === null ? {} : { 'Retry-After': retryAfter };
      const controller = createAssistantAudioController({
        fetchImpl: async () => {
          calls += 1;
          return failure('RATE_LIMITED', { status: 429, headers });
        },
        AudioClass: ForbiddenAudio,
        origin: 'https://buddy.example',
        now: () => clock,
      });

      const limited = await controller.generate(MESSAGE_ID);
      assert.equal(limited.retryAfterMs, 250);
      assert.equal(limited.retryNotBefore, 1_250);
      await controller.generate(MESSAGE_ID);
      assert.equal(calls, 1);
      clock = 1_250;
      await controller.generate(MESSAGE_ID);
      assert.equal(calls, 2);
    });
  }
});

test('GET-first recovery exposes definitive missing without mutating or playing', async () => {
  const controller = createAssistantAudioController({
    fetchImpl: async () => failure('NOT_FOUND', {
      status: 404,
    }),
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
  });
  const result = await controller.refresh(MESSAGE_ID);
  assert.equal(result.state, 'missing');
  assert.equal(result.mediaId, null);
});

test('redirected and cross-origin final response URLs fail closed and cancel unread bodies', async (t) => {
  for (const [name, responseOptions] of [
    ['redirected response', {
      redirected: true,
      url: `https://buddy.example/api/v1/messages/${MESSAGE_ID}/audio`,
    }],
    ['cross-origin response URL', {
      url: `https://evil.example/api/v1/messages/${MESSAGE_ID}/audio`,
    }],
  ]) {
    await t.test(name, async () => {
      let cancelled = 0;
      const controller = createAssistantAudioController({
        fetchImpl: async () => responseLike({
          ...responseOptions,
          status: 201,
          data: { messageId: MESSAGE_ID, state: 'attached', mediaId: MEDIA_ID, failureCode: null, retryable: false },
          onCancel: () => { cancelled += 1; },
        }),
        AudioClass: ForbiddenAudio,
        origin: 'https://buddy.example',
      });

      const result = await controller.generate(MESSAGE_ID);
      assert.equal(result.failureCode, 'AUDIO_INVALID_RESPONSE');
      assert.equal(result.state, 'retryable');
      assert.equal(cancelled, 1);
    });
  }
});

test('network, session, rate-limit, TTS, malformed, and durable failure outcomes expose only safe bounded state', async (t) => {
  const cases = [
    ['network', async () => { throw new Error('secret socket detail'); }, 'retryable', 'NETWORK_UNAVAILABLE', null],
    ['session', async () => failure('SESSION_NOT_FOUND', { status: 401 }), 'failed', 'SESSION_NOT_FOUND', null],
    ['rate limit', async () => failure('RATE_LIMITED', { status: 429, headers: { 'Retry-After': '10' } }), 'retryable', 'RATE_LIMITED', 10_000],
    ['provider missing', async () => failure('VOICE_PROVIDER_MISCONFIGURED', { status: 503 }), 'failed', 'VOICE_PROVIDER_MISCONFIGURED', null],
    ['transient TTS', async () => failure('VOICE_SYNTHESIS_FAILED', { status: 502 }), 'retryable', 'VOICE_SYNTHESIS_FAILED', null],
    ['permanent TTS', async () => failure('VOICE_SYNTHESIS_REJECTED', { status: 502 }), 'failed', 'VOICE_SYNTHESIS_REJECTED', null],
    ['non JSON', async () => new Response('upstream private html', { status: 502 }), 'retryable', 'AUDIO_INVALID_RESPONSE', null],
    ['durable retryable failure', async () => envelope({ messageId: MESSAGE_ID, state: 'failed', mediaId: null, failureCode: 'VOICE_ATTEMPT_EXPIRED', retryable: true }), 'retryable', 'VOICE_ATTEMPT_EXPIRED', null],
    ['durable permanent failure', async () => envelope({ messageId: MESSAGE_ID, state: 'failed', mediaId: null, failureCode: 'VOICE_PROVIDER_INVALID_RESPONSE', retryable: false }), 'failed', 'VOICE_PROVIDER_INVALID_RESPONSE', null],
  ];

  for (const [name, fetchImpl, state, code, retryAfterMs] of cases) {
    await t.test(name, async () => {
      const controller = createAssistantAudioController({
        fetchImpl,
        AudioClass: ForbiddenAudio,
        origin: 'https://buddy.example',
      });
      const result = await controller.generate(MESSAGE_ID);
      assert.equal(result.state, state);
      assert.equal(result.failureCode, code);
      assert.equal(result.retryAfterMs, retryAfterMs);
      assert.match(result.statusText, /text answer/i);
      assert.doesNotMatch(JSON.stringify(result), /private|secret|socket|html/i);
    });
  }
});

test('an existing message mediaId plays only through the explicit play API and never changes message text', async () => {
  FakeAudio.instances.length = 0;
  const message = {
    id: MESSAGE_ID,
    mediaId: MEDIA_ID,
    text: 'The complete assistant answer must remain visible.',
  };
  const controller = createAssistantAudioController({
    fetchImpl: async () => { throw new Error('existing media must not generate'); },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });

  const result = await controller.play({ messageId: message.id, mediaId: message.mediaId });

  assert.equal(FakeAudio.instances.length, 1);
  const audio = FakeAudio.instances[0];
  assert.equal(audio.src, `/api/v1/media/${MEDIA_ID}`);
  assert.equal(audio.preload, 'none');
  assert.equal(audio.autoplay, false);
  assert.equal(audio.playCalls, 1);
  assert.equal(result.state, 'playing');
  assert.deepEqual(controller.snapshot().playback, {
    messageId: MESSAGE_ID,
    mediaId: MEDIA_ID,
    state: 'playing',
    failureCode: null,
    statusText: 'Playing audio.',
  });
  assert.equal(controller.snapshot().entries[MESSAGE_ID].state, 'ready');
  assert.equal(message.text, 'The complete assistant answer must remain visible.');
});

test('play enforces the generated message/media identity and never creates Audio for a mismatch', async () => {
  FakeAudio.instances.length = 0;
  const controller = createAssistantAudioController({
    fetchImpl: async () => envelope({
      messageId: MESSAGE_ID,
      state: 'attached',
      mediaId: MEDIA_ID,
      failureCode: null,
      retryable: false,
    }, { status: 201 }),
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });
  await controller.generate(MESSAGE_ID);

  await assert.rejects(
    controller.play({
      messageId: MESSAGE_ID,
      mediaId: '33333333-3333-4333-8333-333333333333',
    }),
    /does not match/i,
  );
  assert.equal(FakeAudio.instances.length, 0);
});

test('only one Audio is active: switching pauses the old item, pause and hidden never auto-resume', async () => {
  FakeAudio.instances.length = 0;
  const secondMessageId = '33333333-3333-4333-8333-333333333333';
  const secondMediaId = '44444444-4444-4444-8444-444444444444';
  const controller = createAssistantAudioController({
    fetchImpl: async () => { throw new Error('must not fetch'); },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });

  await controller.play({ messageId: MESSAGE_ID, mediaId: MEDIA_ID });
  const first = FakeAudio.instances[0];
  await controller.play({ messageId: secondMessageId, mediaId: secondMediaId });
  const second = FakeAudio.instances[1];
  assert.equal(first.pauseCalls, 1);
  assert.equal(first.playCalls, 1);
  assert.equal(second.playCalls, 1);
  assert.equal(controller.snapshot().playback.messageId, secondMessageId);

  controller.pause();
  assert.equal(second.pauseCalls, 1);
  assert.equal(controller.snapshot().playback.state, 'paused');
  await controller.play({ messageId: secondMessageId, mediaId: secondMediaId });
  assert.equal(FakeAudio.instances.length, 2, 'resume reuses the one current Audio instance');
  assert.equal(second.playCalls, 2);
  controller.handleHidden();
  assert.equal(second.pauseCalls, 2);
  assert.equal(controller.snapshot().playback.state, 'paused');
  await Promise.resolve();
  assert.equal(second.playCalls, 2, 'visibility does not resume playback');
});

test('stale Audio events cannot replace the active item and playback errors never expose adapter details', async () => {
  FakeAudio.instances.length = 0;
  const secondMessageId = '33333333-3333-4333-8333-333333333333';
  const secondMediaId = '44444444-4444-4444-8444-444444444444';
  const controller = createAssistantAudioController({
    fetchImpl: async () => { throw new Error('must not fetch'); },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });

  await controller.play({ messageId: MESSAGE_ID, mediaId: MEDIA_ID });
  const first = FakeAudio.instances[0];
  await controller.play({ messageId: secondMessageId, mediaId: secondMediaId });
  const second = FakeAudio.instances[1];
  first.dispatch('error');
  assert.equal(controller.snapshot().playback.messageId, secondMessageId);

  second.dispatch('error');
  assert.equal(controller.snapshot().playback.state, 'error');
  assert.equal(controller.snapshot().playback.failureCode, 'AUDIO_PLAYBACK_FAILED');
  assert.match(controller.snapshot().playback.statusText, /text answer/i);
  assert.doesNotMatch(JSON.stringify(controller.snapshot().playback), /adapter|private|secret/i);
});

test('a rejected play promise becomes safe paused error state and never hides ready text state', async () => {
  FakeAudio.instances.length = 0;
  FakeAudio.nextPlayError = new Error('private autoplay policy diagnostics');
  const controller = createAssistantAudioController({
    fetchImpl: async () => { throw new Error('must not fetch'); },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });
  const result = await controller.play({ messageId: MESSAGE_ID, mediaId: MEDIA_ID });
  assert.equal(result.state, 'error');
  assert.equal(result.failureCode, 'AUDIO_PLAYBACK_FAILED');
  assert.equal(controller.snapshot().entries[MESSAGE_ID].state, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /private|autoplay|policy/i);
});

test('concurrent generate calls for one message share one POST and one terminal result', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = createAssistantAudioController({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return envelope({
        messageId: MESSAGE_ID,
        state: 'attached',
        mediaId: MEDIA_ID,
        failureCode: null,
        retryable: false,
      }, { status: 201 });
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
  });

  const first = controller.generate(MESSAGE_ID);
  const second = controller.generate(MESSAGE_ID);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('the total poll window stops repeated valid 202 responses without hot or unbounded polling', async () => {
  let clock = 0;
  let calls = 0;
  const sleeps = [];
  const controller = createAssistantAudioController({
    fetchImpl: async () => {
      calls += 1;
      return envelope({
        messageId: MESSAGE_ID,
        state: 'generating',
        mediaId: null,
        failureCode: null,
        retryable: false,
      }, {
        status: 202,
        headers: {
          Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`,
          'Retry-After': '2',
        },
      });
    },
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
    now: () => clock,
    maxPollMs: 5_000,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  const result = await controller.generate(MESSAGE_ID);
  assert.equal(result.state, 'retryable');
  assert.equal(result.failureCode, 'AUDIO_INVALID_RESPONSE');
  assert.deepEqual(sleeps, [2_000, 2_000]);
  assert.equal(calls, 3);
});

test('dispose aborts even an adapter that ignores AbortSignal and fences its late ready response', async () => {
  let requestSignal;
  let resolveFetch;
  const changes = [];
  const responsePending = new Promise((resolve) => { resolveFetch = resolve; });
  const controller = createAssistantAudioController({
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return responsePending;
    },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
    onChange: (snapshot) => changes.push(snapshot),
  });

  const pending = controller.generate(MESSAGE_ID);
  await Promise.resolve();
  controller.dispose();
  assert.equal(requestSignal.aborted, true);
  assert.equal(controller.snapshot().disposed, true);
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dispose did not bound fetch')), 100)),
  ]);
  assert.equal(result.state, 'disposed');
  const notificationsAfterDispose = changes.length;

  resolveFetch(envelope({
    messageId: MESSAGE_ID,
    state: 'attached',
    mediaId: MEDIA_ID,
    failureCode: null,
    retryable: false,
  }, { status: 201 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().entries[MESSAGE_ID].state, 'generating');
  assert.equal(changes.length, notificationsAfterDispose, 'late response cannot notify disposed UI');
});

test('dispose cancels a stalled response body and pauses the one active Audio', async () => {
  FakeAudio.instances.length = 0;
  let textStarted;
  let startText;
  let cancelled = 0;
  const bodyStarted = new Promise((resolve) => { startText = resolve; });
  const controller = createAssistantAudioController({
    fetchImpl: async () => responseLike({
      status: 201,
      data: { messageId: MESSAGE_ID, state: 'attached', mediaId: MEDIA_ID, failureCode: null, retryable: false },
      text: undefined,
      onCancel: () => { cancelled += 1; },
    }),
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });

  await controller.play({ messageId: MESSAGE_ID, mediaId: MEDIA_ID });
  const audio = FakeAudio.instances[0];
  controller.pause();
  await controller.play({ messageId: MESSAGE_ID, mediaId: MEDIA_ID });

  const stalledResponse = responseLike({
    status: 201,
    data: { messageId: MESSAGE_ID, state: 'attached', mediaId: MEDIA_ID, failureCode: null, retryable: false },
    onCancel: () => { cancelled += 1; },
  });
  stalledResponse.text = () => {
    textStarted = true;
    startText();
    return new Promise(() => {});
  };
  // Swap only the external adapter for the request under test through a second controller.
  const stalled = createAssistantAudioController({
    fetchImpl: async () => stalledResponse,
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });
  const pending = stalled.refresh(MESSAGE_ID);
  await bodyStarted;
  assert.equal(textStarted, true);
  stalled.dispose();
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dispose did not bound body read')), 100)),
  ]);
  assert.equal(result.state, 'disposed');
  assert.equal(cancelled, 1);

  controller.dispose();
  assert.ok(audio.pauseCalls >= 2);
  assert.equal(controller.snapshot().disposed, true);
  assert.equal(controller.snapshot().playback.state, 'paused');
});

test('dispose also bounds an injected polling sleep that ignores AbortSignal', async () => {
  let sleepStarted;
  let startSleep;
  const sleeping = new Promise((resolve) => { startSleep = resolve; });
  const controller = createAssistantAudioController({
    fetchImpl: async () => envelope({
      messageId: MESSAGE_ID,
      state: 'generating',
      mediaId: null,
      failureCode: null,
      retryable: false,
    }, {
      status: 202,
      headers: {
        Location: `/api/v1/messages/${MESSAGE_ID}/audio/status`,
        'Retry-After': '1',
      },
    }),
    AudioClass: ForbiddenAudio,
    origin: 'https://buddy.example',
    sleep: async () => {
      sleepStarted = true;
      startSleep();
      return new Promise(() => {});
    },
  });

  const pending = controller.generate(MESSAGE_ID);
  await sleeping;
  assert.equal(sleepStarted, true);
  controller.dispose();
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dispose did not bound polling sleep')), 100)),
  ]);
  assert.equal(result.state, 'disposed');
});

test('invalid public identities fail before fetch or Audio construction', async () => {
  FakeAudio.instances.length = 0;
  let calls = 0;
  const controller = createAssistantAudioController({
    fetchImpl: async () => { calls += 1; return envelope(null); },
    AudioClass: FakeAudio,
    origin: 'https://buddy.example',
  });

  await assert.rejects(controller.generate('not-a-message'), /UUID/);
  await assert.rejects(controller.refresh('not-a-message'), /UUID/);
  await assert.rejects(controller.play({ messageId: MESSAGE_ID, mediaId: 'not-media' }), /UUID/);
  assert.equal(calls, 0);
  assert.equal(FakeAudio.instances.length, 0);
});
