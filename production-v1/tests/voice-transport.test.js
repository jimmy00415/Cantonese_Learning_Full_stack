import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceTransport } from '../public/voice-transport.js';

const ORIGIN = 'https://buddy.example';
const CLIENT_UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_SHA256 = '0123456789abcdef'.repeat(4);

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function readyData(overrides = {}) {
  return {
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    state: 'ready',
    transcript: 'hello',
    ...overrides,
  };
}

function errorBody(code) {
  return {
    data: null,
    error: { code, message: `server message for ${code}` },
    requestId: 'request-1',
  };
}

test('postUpload sends the exact WAV Blob and immutable upload identity with same-origin credentials', async () => {
  const audio = new Blob([Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' });
  let request;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    csrfHeaders: { 'X-CSRF-Token': 'csrf-token' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(201, {
        data: {
          clientUploadId: CLIENT_UPLOAD_ID,
          requestSha256: REQUEST_SHA256,
          state: 'ready',
          transcript: 'hello',
        },
        error: null,
      });
    },
  });

  const result = await transport.postUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    asrLanguage: 'cmn-Hans-CN',
    audio,
  });

  assert.equal(request.url, '/api/v1/voice/transcriptions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.body, audio);
  assert.equal(new Headers(request.options.headers).get('content-type'), 'audio/wav');
  assert.equal(new Headers(request.options.headers).get('x-client-upload-id'), CLIENT_UPLOAD_ID);
  assert.equal(new Headers(request.options.headers).get('x-content-sha256'), REQUEST_SHA256);
  assert.equal(new Headers(request.options.headers).get('x-asr-language'), 'cmn-Hans-CN');
  assert.equal(new Headers(request.options.headers).get('x-csrf-token'), 'csrf-token');
  assert.deepEqual(
    {
      status: result.status,
      data: result.data,
      location: result.location,
      retryAfter: result.retryAfter,
      retryAfterMs: result.retryAfterMs,
    },
    {
      status: 201,
      data: {
        clientUploadId: CLIENT_UPLOAD_ID,
        requestSha256: REQUEST_SHA256,
        state: 'ready',
        transcript: 'hello',
      },
      location: null,
      retryAfter: null,
      retryAfterMs: null,
    },
  );
});

test('postUpload requires one exact immutable ASR language before transport', async () => {
  let calls = 0;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
  });
  const audio = new Blob([Uint8Array.from([82, 73, 70, 70])], { type: 'audio/wav' });
  for (const asrLanguage of [undefined, 'auto', 'zhHant', 'zhHans', 'zh-Hant', 'cantonese']) {
    await assert.rejects(transport.postUpload({
      clientUploadId: CLIENT_UPLOAD_ID,
      requestSha256: REQUEST_SHA256,
      asrLanguage,
      audio,
    }), /ASR language/i);
  }
  assert.equal(calls, 0);
});

test('factory exposes the three coordinator methods and GET carries the exact AbortSignal', async () => {
  const controller = new AbortController();
  let request;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(200, { data: readyData(), error: null });
    },
  });

  assert.equal(typeof transport.getUploadStatus, 'function');
  assert.equal(typeof transport.postUpload, 'function');
  assert.equal(typeof transport.deleteUpload, 'function');
  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    signal: controller.signal,
  });

  assert.equal(request.url, `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.signal, controller.signal);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, readyData());
});

test('DELETE injects current CSRF headers without allowing them to replace the request method', async () => {
  const injections = [];
  let request;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    getCsrfHeaders: ({ method, path }) => {
      injections.push({ method, path });
      return { 'X-CSRF-Token': 'fresh-token' };
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(200, {
        data: readyData({ state: 'failed', failureCode: 'VOICE_UPLOAD_CANCELLED', retryable: false }),
        error: null,
      });
    },
  });

  const result = await transport.deleteUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.deepEqual(injections, [{ method: 'DELETE', path: `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}` }]);
  assert.equal(request.options.method, 'DELETE');
  assert.equal(new Headers(request.options.headers).get('x-csrf-token'), 'fresh-token');
  assert.equal(result.status, 200);
  assert.equal(result.data.failureCode, 'VOICE_UPLOAD_CANCELLED');
});

test('GET-first 404 remains distinguishable from transport failure', async () => {
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(404, errorBody('NOT_FOUND')),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'NOT_FOUND');
  assert.equal(result.location, null);
  assert.equal(result.retryAfter, null);
  assert.equal(result.retryAfterMs, null);
});

test('POST 410 keeps the durable cancelled identity terminal without throwing', async () => {
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(410, errorBody('VOICE_UPLOAD_CANCELLED')),
  });

  const result = await transport.postUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    asrLanguage: 'yue-Hant-HK',
    audio: new Blob([Uint8Array.from([1])], { type: 'audio/wav' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 410);
  assert.equal(result.error.code, 'VOICE_UPLOAD_CANCELLED');
});

test('DELETE 409 preserves the already-attached conflict for coordinator reconciliation', async () => {
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(409, errorBody('VOICE_DRAFT_ALREADY_ATTACHED')),
  });

  const result = await transport.deleteUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.error.code, 'VOICE_DRAFT_ALREADY_ATTACHED');
});

test('202 validates and normalizes a same-origin absolute Location and delta Retry-After', async () => {
  const expectedPath = `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(202, {
      data: readyData({ state: 'transcribing', transcript: undefined }),
      error: null,
    }, {
      Location: `${ORIGIN}${expectedPath}`,
      'Retry-After': '1',
    }),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.location, expectedPath);
  assert.equal(result.retryAfter, '1');
  assert.equal(result.retryAfterMs, 1_000);
});

test('Retry-After HTTP-date becomes a caller-cappable wait and transport never sleeps', async () => {
  const nowMs = Date.parse('2026-08-25T10:00:00.000Z');
  const retryAt = new Date(nowMs + 7_000).toUTCString();
  let fetchReturned = false;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    now: () => nowMs,
    fetchImpl: async () => {
      fetchReturned = true;
      return jsonResponse(429, errorBody('RATE_LIMITED'), { 'Retry-After': retryAt });
    },
  });

  const result = await transport.postUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    asrLanguage: 'en',
    audio: new Blob([Uint8Array.from([1])], { type: 'audio/wav' }),
  });

  assert.equal(fetchReturned, true);
  assert.equal(result.status, 429);
  assert.equal(result.error.code, 'RATE_LIMITED');
  assert.equal(result.retryAfter, retryAt);
  assert.equal(result.retryAfterMs, 7_000);
});

test('non-JSON 5xx is safely normalized while preserving status and Retry-After metadata', async () => {
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => new Response('private upstream diagnostic', {
      status: 503,
      headers: { 'Retry-After': '2', 'Content-Type': 'text/plain' },
    }),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal(result.retryAfter, '2');
  assert.equal(result.retryAfterMs, 2_000);
  assert.equal(JSON.stringify(result).includes('private upstream diagnostic'), false);
});

test('202 with a missing Location is a protocol failure that retains HTTP timing metadata', async () => {
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(202, {
      data: readyData({ state: 'uploading', transcript: undefined }),
      error: null,
    }, { 'Retry-After': '3' }),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 202);
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal(result.location, null);
  assert.equal(result.retryAfter, '3');
  assert.equal(result.retryAfterMs, 3_000);
});

test('202 with a missing Retry-After is a protocol failure rather than a hot polling loop', async () => {
  const expectedPath = `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(202, {
      data: readyData({ state: 'uploading', transcript: undefined }),
      error: null,
    }, { Location: expectedPath }),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 202);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal(result.location, expectedPath);
  assert.equal(result.retryAfter, null);
  assert.equal(result.retryAfterMs, null);
});

test('202 accepts only processing states and a strictly positive Retry-After', async (t) => {
  const expectedPath = `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`;
  const cases = [
    ['ready state', readyData({ state: 'ready' }), '1'],
    ['failed state', readyData({ state: 'failed', transcript: undefined, failureCode: 'VOICE_INVALID_WAV' }), '1'],
    ['zero delay', readyData({ state: 'uploading', transcript: undefined }), '0'],
    ['past date', readyData({ state: 'transcribing', transcript: undefined }), 'Mon, 24 Aug 2026 10:00:00 GMT'],
  ];

  for (const [name, data, retryAfter] of cases) {
    await t.test(name, async () => {
      const transport = createVoiceTransport({
        origin: ORIGIN,
        now: () => Date.parse('2026-08-25T10:00:00.000Z'),
        fetchImpl: async () => jsonResponse(202, { data, error: null }, {
          Location: expectedPath,
          'Retry-After': retryAfter,
        }),
      });
      const result = await transport.getUploadStatus({
        clientUploadId: CLIENT_UPLOAD_ID,
        requestSha256: REQUEST_SHA256,
      });
      assert.equal(result.ok, false, name);
      assert.equal(result.error.code, 'INVALID_RESPONSE', name);
    });
  }
});

test('cross-origin, queried, and wrong-upload Location headers are never exposed', async (t) => {
  const wrongLocations = [
    `https://evil.example/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`,
    `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}?next=1`,
    '/api/v1/voice/uploads/22222222-2222-4222-8222-222222222222',
  ];

  for (const location of wrongLocations) {
    await t.test(location, async () => {
      const transport = createVoiceTransport({
        origin: ORIGIN,
        fetchImpl: async () => jsonResponse(202, {
          data: readyData({ state: 'uploading', transcript: undefined }),
          error: null,
        }, { Location: location, 'Retry-After': '1' }),
      });
      const result = await transport.getUploadStatus({
        clientUploadId: CLIENT_UPLOAD_ID,
        requestSha256: REQUEST_SHA256,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 202);
      assert.equal(result.location, null);
      assert.equal(result.error.code, 'INVALID_RESPONSE');
    });
  }
});

test('an invalid Location cancels the unread response body before failing closed', async () => {
  let textCalls = 0;
  let cancelCalls = 0;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => ({
      status: 202,
      ok: true,
      redirected: false,
      url: `${ORIGIN}/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`,
      headers: new Headers({
        Location: 'https://evil.example/upload',
        'Retry-After': '1',
      }),
      body: { cancel: async () => { cancelCalls += 1; } },
      text: async () => { textCalls += 1; return '{}'; },
    }),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal(textCalls, 0);
  assert.equal(cancelCalls, 1);
});

test('AbortSignal cancels a stalled response body after headers and resolves safely', async () => {
  const controller = new AbortController();
  let textStarted;
  const started = new Promise((resolve) => { textStarted = resolve; });
  let cancelCalls = 0;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      redirected: false,
      url: `${ORIGIN}/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`,
      headers: new Headers(),
      body: { cancel: async () => { cancelCalls += 1; } },
      text: () => {
        textStarted();
        return new Promise(() => undefined);
      },
    }),
  });

  const pending = transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('stalled body was not aborted')), 100)),
  ]);

  assert.equal(result.error.code, 'REQUEST_ABORTED');
  assert.equal(cancelCalls, 1);
});

test('AbortSignal settles immediately even when both response text and body cancellation ignore abort', async (t) => {
  for (const [name, abortBeforeRead] of [
    ['abort while reading', false],
    ['response returned after a pre-aborted fetch', true],
  ]) {
    await t.test(name, async () => {
      const controller = new AbortController();
      let textStarted;
      const started = new Promise((resolve) => { textStarted = resolve; });
      let cancelCalls = 0;
      const transport = createVoiceTransport({
        origin: ORIGIN,
        fetchImpl: async () => {
          if (abortBeforeRead) controller.abort();
          return {
            status: 200,
            ok: true,
            redirected: false,
            url: `${ORIGIN}/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`,
            headers: new Headers(),
            body: {
              cancel: () => {
                cancelCalls += 1;
                return new Promise(() => undefined);
              },
            },
            text: () => {
              textStarted();
              return new Promise(() => undefined);
            },
          };
        },
      });

      const pending = transport.getUploadStatus({
        clientUploadId: CLIENT_UPLOAD_ID,
        requestSha256: REQUEST_SHA256,
        signal: controller.signal,
      });
      if (!abortBeforeRead) {
        await started;
        controller.abort();
      }
      const result = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('abort waited for body cancellation')), 100)),
      ]);

      assert.equal(result.error.code, 'REQUEST_ABORTED');
      assert.equal(cancelCalls, 1);
    });
  }
});

test('CSRF callback failures are normalized without exposing private setup diagnostics', async () => {
  let fetchCalls = 0;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    getCsrfHeaders: async () => { throw new Error('private csrf diagnostic'); },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  });

  const result = await transport.deleteUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.error.code, 'REQUEST_SETUP_FAILED');
  assert.equal(JSON.stringify(result).includes('private csrf diagnostic'), false);
  assert.equal(fetchCalls, 0);
});

test('redirected or cross-origin adapter responses are rejected and their bodies are cancelled', async (t) => {
  for (const [name, redirected, url] of [
    ['redirected', true, `${ORIGIN}/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`],
    ['cross-origin final URL', false, `https://evil.example/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`],
  ]) {
    await t.test(name, async () => {
      let cancelCalls = 0;
      const transport = createVoiceTransport({
        origin: ORIGIN,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          redirected,
          url,
          headers: new Headers(),
          body: { cancel: async () => { cancelCalls += 1; } },
          text: async () => JSON.stringify({ data: readyData(), error: null }),
        }),
      });
      const result = await transport.getUploadStatus({
        clientUploadId: CLIENT_UPLOAD_ID,
        requestSha256: REQUEST_SHA256,
      });
      assert.equal(result.error.code, 'INVALID_RESPONSE', name);
      assert.equal(cancelCalls, 1, name);
    });
  }
});

test('success payload with the wrong clientUploadId is rejected without exposing its data', async () => {
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => jsonResponse(200, {
      data: readyData({ clientUploadId: '22222222-2222-4222-8222-222222222222' }),
      error: null,
    }),
  });

  const result = await transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
});

test('success payload requestSha256 must be exact and lowercase', async (t) => {
  for (const requestSha256 of ['f'.repeat(64), REQUEST_SHA256.toUpperCase()]) {
    await t.test(requestSha256.slice(0, 8), async () => {
      const transport = createVoiceTransport({
        origin: ORIGIN,
        fetchImpl: async () => jsonResponse(200, {
          data: readyData({ requestSha256 }),
          error: null,
        }),
      });
      const result = await transport.getUploadStatus({
        clientUploadId: CLIENT_UPLOAD_ID,
        requestSha256: REQUEST_SHA256,
      });
      assert.equal(result.ok, false);
      assert.equal(result.data, null);
      assert.equal(result.error.code, 'INVALID_RESPONSE');
    });
  }
});

test('same upload identity can replay the exact Blob and accept a later 200 result', async () => {
  const audio = new Blob([Uint8Array.from([9, 8, 7, 6])], { type: 'audio/wav' });
  const calls = [];
  const responses = [
    () => jsonResponse(202, {
      data: readyData({ state: 'uploading', transcript: undefined }),
      error: null,
    }, { Location: `/api/v1/voice/uploads/${CLIENT_UPLOAD_ID}`, 'Retry-After': '1' }),
    () => jsonResponse(200, { data: readyData(), error: null }),
  ];
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift()();
    },
  });

  const input = {
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    asrLanguage: 'yue-Hant-HK',
    audio,
  };
  const accepted = await transport.postUpload(input);
  const replayed = await transport.postUpload(input);

  assert.equal(accepted.status, 202);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.body, audio);
    const headers = new Headers(call.options.headers);
    assert.equal(headers.get('x-client-upload-id'), CLIENT_UPLOAD_ID);
    assert.equal(headers.get('x-content-sha256'), REQUEST_SHA256);
    assert.equal(headers.get('x-asr-language'), 'yue-Hant-HK');
  }
});

test('network and AbortSignal failures normalize without leaking exception text', async (t) => {
  await t.test('network', async () => {
    const transport = createVoiceTransport({
      origin: ORIGIN,
      fetchImpl: async () => { throw new Error('private proxy diagnostic'); },
    });
    const result = await transport.getUploadStatus({
      clientUploadId: CLIENT_UPLOAD_ID,
      requestSha256: REQUEST_SHA256,
    });
    assert.equal(result.status, null);
    assert.equal(result.error.code, 'NETWORK_UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('private proxy diagnostic'), false);
  });

  await t.test('aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createVoiceTransport({
      origin: ORIGIN,
      fetchImpl: async (_url, options) => {
        assert.equal(options.signal, controller.signal);
        throw new DOMException('secret abort reason', 'AbortError');
      },
    });
    const result = await transport.getUploadStatus({
      clientUploadId: CLIENT_UPLOAD_ID,
      requestSha256: REQUEST_SHA256,
      signal: controller.signal,
    });
    assert.equal(result.status, null);
    assert.equal(result.error.code, 'REQUEST_ABORTED');
    assert.equal(JSON.stringify(result).includes('secret abort reason'), false);
  });
});

test('invalid identity or non-WAV input is rejected before fetch', async (t) => {
  let calls = 0;
  const transport = createVoiceTransport({
    origin: ORIGIN,
    fetchImpl: async () => { calls += 1; return jsonResponse(500, errorBody('SHOULD_NOT_RUN')); },
  });

  await assert.rejects(transport.getUploadStatus({
    clientUploadId: 'not-a-uuid',
    requestSha256: REQUEST_SHA256,
  }), TypeError);
  await assert.rejects(transport.getUploadStatus({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256.toUpperCase(),
  }), TypeError);
  await assert.rejects(transport.postUpload({
    clientUploadId: CLIENT_UPLOAD_ID,
    requestSha256: REQUEST_SHA256,
    audio: new Blob([Uint8Array.from([1])], { type: 'audio/webm' }),
  }), TypeError);
  assert.equal(calls, 0);
});
