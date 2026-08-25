import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_MIME_TYPES,
  VoiceCaptureError,
  createVoiceCapture,
  selectRecordingMimeType,
} from '../public/voice-capture.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeEventTarget {
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type, details = {}) {
    const event = { type, target: this, ...details };
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener.call(this, event);
  }

  listenerCount() {
    return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class FakeTrack extends FakeEventTarget {
  stopCalls = 0;

  stop() {
    this.stopCalls += 1;
  }

  end() {
    this.emit('ended');
  }
}

function fakeStream(trackCount = 2) {
  const tracks = Array.from({ length: trackCount }, () => new FakeTrack());
  return { tracks, getTracks: () => tracks };
}

function recorderHarness(supported = ['audio/webm;codecs=opus']) {
  const instances = [];
  class FakeMediaRecorder extends FakeEventTarget {
    static isTypeSupported(type) {
      return supported.includes(type);
    }

    constructor(stream, options) {
      super();
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.startCalls = 0;
      this.stopCalls = 0;
      instances.push(this);
    }

    start() {
      this.startCalls += 1;
      this.state = 'recording';
    }

    stop() {
      this.stopCalls += 1;
      this.state = 'inactive';
    }

    emitStart() {
      this.state = 'recording';
      this.emit('start');
    }

    emitData(bytes) {
      this.emit('dataavailable', {
        data: new Blob([Uint8Array.from(bytes)], { type: this.mimeType }),
      });
    }

    emitStop() {
      this.state = 'inactive';
      this.emit('stop');
    }

    emitError(error = new Error('recorder failed')) {
      this.emit('error', { error });
    }
  }
  return { MediaRecorderClass: FakeMediaRecorder, instances };
}

function queuedMediaDevices(values) {
  const queue = [...values];
  const calls = [];
  return {
    calls,
    async getUserMedia(constraints) {
      calls.push(constraints);
      const next = queue.shift();
      return await next;
    },
  };
}

function fakeTimers(clock) {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutImpl(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay, dueAt: clock.value + delay });
      return id;
    },
    clearTimeoutImpl(id) {
      pending.delete(id);
    },
    fireNext() {
      const entry = [...pending.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      assert.ok(entry, 'expected a pending timer');
      pending.delete(entry[0]);
      entry[1].callback();
      return entry[1];
    },
    pendingCount: () => pending.size,
    pendingDelays: () => [...pending.values()].map((entry) => entry.delay),
  };
}

const canonicalBlob = () => new Blob([new Uint8Array(46)], { type: 'audio/wav' });

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function startRecording(capture, recorders) {
  const handle = capture.begin();
  await flushMicrotasks();
  const recorder = recorders.instances.at(-1);
  assert.ok(recorder, 'runtime permission must construct a recorder');
  recorder.emitStart();
  assert.equal((await handle.started).status, 'recording');
  return { handle, recorder };
}

test('consented permission preflight stops every temporary track and constructs zero recorders', async () => {
  const permissionStream = fakeStream(3);
  const recorders = recorderHarness();
  const mediaDevices = queuedMediaDevices([permissionStream]);
  const capture = createVoiceCapture({
    mediaDevices,
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
  });

  await assert.rejects(() => capture.preflightPermission({ consent: false }), {
    code: 'VOICE_CONSENT_REQUIRED',
  });
  assert.equal(mediaDevices.calls.length, 0);

  const ready = await capture.preflightPermission({ consent: true });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(mediaDevices.calls, [{ audio: true }]);
  assert.deepEqual(permissionStream.tracks.map((track) => track.stopCalls), [1, 1, 1]);
  assert.equal(recorders.instances.length, 0);
});

test('release wins once and a normal lostpointercapture cannot discard its final recording', async () => {
  const permissionStream = fakeStream();
  const runtimeStream = fakeStream();
  const recorders = recorderHarness();
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([permissionStream, runtimeStream]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
  });
  await capture.preflightPermission({ consent: true });
  const { handle, recorder } = await startRecording(capture, recorders);

  const finishing = capture.finish('release');
  const cancelling = capture.cancel('lostpointercapture');
  assert.equal(recorder.stopCalls, 1);
  recorder.emitData([1]);
  recorder.emitStop();
  const result = await finishing;
  assert.equal(result.status, 'ready');
  assert.equal(result.completionReason, 'release');
  assert.deepEqual(await cancelling, result);
  assert.deepEqual(await handle.result, result);
  assert.deepEqual(runtimeStream.tracks.map((track) => track.stopCalls), [1, 1]);
});

test('55-second hard timer starts after start() returns and start event never arms a duplicate', async () => {
  const clock = { value: 10_000 };
  const timers = fakeTimers(clock);
  const recorders = recorderHarness();
  let normalizeCalls = 0;
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), fakeStream()]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => { normalizeCalls += 1; return canonicalBlob(); },
    now: () => clock.value,
    ...timers,
  });
  await capture.preflightPermission({ consent: true });
  const handle = capture.begin();
  await flushMicrotasks();
  const recorder = recorders.instances[0];
  assert.equal(timers.pendingCount(), 1);

  recorder.emitStart();
  await handle.started;
  assert.equal(timers.pendingCount(), 1);
  clock.value = 65_000;
  const timer = timers.fireNext();
  assert.equal(timer.delay, 55_000);
  const release = capture.finish('release');
  assert.equal(recorder.stopCalls, 1);
  recorder.emitData([1, 2]);
  recorder.emitStop();

  const result = await release;
  assert.equal(result.status, 'ready');
  assert.equal(result.completionReason, 'max-duration');
  assert.equal(result.durationMs, 55_000);
  assert.equal(normalizeCalls, 1);
});

test('queued start-event races remain bounded after MediaRecorder.start returns', async (t) => {
  await t.test('release before start event cancels and clears the hard timer', async () => {
    const clock = { value: 0 };
    const timers = fakeTimers(clock);
    const runtime = fakeStream();
    const recorders = recorderHarness();
    let normalizeCalls = 0;
    const capture = createVoiceCapture({
      mediaDevices: queuedMediaDevices([fakeStream(), runtime]),
      MediaRecorderClass: recorders.MediaRecorderClass,
      normalizer: async () => { normalizeCalls += 1; return canonicalBlob(); },
      now: () => clock.value,
      ...timers,
    });
    await capture.preflightPermission({ consent: true });
    const handle = capture.begin();
    await flushMicrotasks();
    const recorder = recorders.instances[0];
    assert.equal(timers.pendingCount(), 1);
    assert.deepEqual(await capture.finish('release'), {
      status: 'cancelled', reason: 'finish-before-start',
    });
    assert.equal(timers.pendingCount(), 0);
    assert.equal(recorder.stopCalls, 1);
    recorder.emitStart();
    recorder.emitData([1]);
    recorder.emitStop();
    assert.equal(normalizeCalls, 0);
    assert.equal((await handle.started).status, 'cancelled');
    assert.ok(runtime.tracks.every((track) => track.stopCalls === 1));
  });

  await t.test('hard deadline stops even while the queued start event is delayed', async () => {
    const clock = { value: 500 };
    const timers = fakeTimers(clock);
    const recorders = recorderHarness();
    const capture = createVoiceCapture({
      mediaDevices: queuedMediaDevices([fakeStream(), fakeStream()]),
      MediaRecorderClass: recorders.MediaRecorderClass,
      normalizer: async () => canonicalBlob(),
      now: () => clock.value,
      ...timers,
    });
    await capture.preflightPermission({ consent: true });
    const handle = capture.begin();
    await flushMicrotasks();
    const recorder = recorders.instances[0];
    clock.value = 55_500;
    timers.fireNext();
    assert.equal(recorder.stopCalls, 1);
    recorder.emitData([1]);
    recorder.emitStop();
    const result = await handle.result;
    assert.equal(result.status, 'ready');
    assert.equal(result.completionReason, 'max-duration');
    assert.equal(result.durationMs, 55_000);
    recorder.emitStart();
    assert.equal(timers.pendingCount(), 0);
  });
});

test('finish waits for final dataavailable and stop before normalizing the complete raw blob', async () => {
  const recorders = recorderHarness();
  const normalized = deferred();
  const observed = [];
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), fakeStream()]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async (blob) => {
      observed.push({ type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
      return await normalized.promise;
    },
  });
  await capture.preflightPermission({ consent: true });
  const { recorder } = await startRecording(capture, recorders);
  recorder.emitData([1]);
  const resultPromise = capture.finish('release');
  recorder.emitData([2, 3]);
  await flushMicrotasks();
  assert.equal(observed.length, 0);

  recorder.emitStop();
  await flushMicrotasks();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].type, 'audio/webm;codecs=opus');
  assert.deepEqual(Array.from(observed[0].bytes), [1, 2, 3]);
  normalized.resolve(canonicalBlob());
  const result = await resultPromise;
  assert.deepEqual(Object.keys(result).sort(), [
    'audio', 'completionReason', 'durationMs', 'mimeType', 'status',
  ]);
  assert.equal(result.audio.type, 'audio/wav');
  assert.equal('rawBlob' in result, false);
});

test('late runtime permission after finish is fenced, stops tracks, and cannot construct a recorder', async () => {
  const pendingPermission = deferred();
  const lateStream = fakeStream(2);
  const recorders = recorderHarness();
  let normalizeCalls = 0;
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), pendingPermission.promise]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => { normalizeCalls += 1; return canonicalBlob(); },
  });
  await capture.preflightPermission({ consent: true });
  const handle = capture.begin();
  const finished = capture.finish('release');
  assert.deepEqual(await finished, { status: 'cancelled', reason: 'finish-before-start' });

  pendingPermission.resolve(lateStream);
  await flushMicrotasks();
  assert.deepEqual(await handle.result, { status: 'cancelled', reason: 'finish-before-start' });
  assert.deepEqual(lateStream.tracks.map((track) => track.stopCalls), [1, 1]);
  assert.equal(recorders.instances.length, 0);
  assert.equal(normalizeCalls, 0);
});

test('MIME selection prefers WebM then MP4 then Ogg then WAV and fails closed before permission', async () => {
  const supportedClass = (supported) => recorderHarness(supported).MediaRecorderClass;
  assert.deepEqual(CAPTURE_MIME_TYPES, [
    'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/wav',
  ]);
  assert.equal(selectRecordingMimeType(supportedClass(CAPTURE_MIME_TYPES)), 'audio/webm;codecs=opus');
  assert.equal(selectRecordingMimeType(supportedClass(['audio/mp4'])), 'audio/mp4');
  assert.equal(selectRecordingMimeType(supportedClass(['audio/ogg;codecs=opus'])), 'audio/ogg;codecs=opus');
  assert.equal(selectRecordingMimeType(supportedClass(['audio/wav'])), 'audio/wav');
  assert.equal(selectRecordingMimeType(supportedClass([])), null);
  assert.equal(selectRecordingMimeType(class MissingProbe {}), null);

  const mediaDevices = queuedMediaDevices([fakeStream()]);
  const capture = createVoiceCapture({
    mediaDevices,
    MediaRecorderClass: supportedClass([]),
    normalizer: async () => canonicalBlob(),
  });
  await assert.rejects(
    () => capture.preflightPermission({ consent: true }),
    { code: 'VOICE_CAPTURE_UNSUPPORTED' },
  );
  assert.equal(mediaDevices.calls.length, 0);
});

test('permission denial is text-safe and dispose fences an in-flight preflight stream', async () => {
  const denied = createVoiceCapture({
    mediaDevices: queuedMediaDevices([Promise.reject(new DOMException('denied', 'NotAllowedError'))]),
    MediaRecorderClass: recorderHarness().MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
  });
  await assert.rejects(
    () => denied.preflightPermission({ consent: true }),
    (error) => {
      assert.ok(error instanceof VoiceCaptureError);
      assert.equal(error.code, 'VOICE_PERMISSION_DENIED');
      assert.equal(error.textSafe, true);
      assert.equal(error.message.includes('denied'), false);
      return true;
    },
  );

  const pending = deferred();
  const lateStream = fakeStream();
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([pending.promise]),
    MediaRecorderClass: recorderHarness().MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
  });
  const preflight = capture.preflightPermission({ consent: true });
  await capture.dispose();
  pending.resolve(lateStream);
  await assert.rejects(() => preflight, { code: 'VOICE_CAPTURE_CANCELLED' });
  assert.deepEqual(lateStream.tracks.map((track) => track.stopCalls), [1, 1]);
  assert.deepEqual(capture.getState(), { disposed: true, permission: 'unknown', phase: 'idle' });
});

test('every cancellation seam fences pending preflight permission and late grants never become ready', async (t) => {
  const actions = [
    'cancel', 'hidden', 'pagehide', 'pointercancel', 'lostpointercapture',
    'visible-cancel', 'escape', 'finish', 'dispose',
  ];
  for (const action of actions) {
    await t.test(action, async () => {
      const pending = deferred();
      const lateStream = fakeStream();
      const recorders = recorderHarness();
      const mediaDevices = queuedMediaDevices([pending.promise]);
      const capture = createVoiceCapture({
        mediaDevices,
        MediaRecorderClass: recorders.MediaRecorderClass,
        normalizer: async () => canonicalBlob(),
      });
      const preflight = capture.preflightPermission({ consent: true });
      const rejected = assert.rejects(preflight, { code: 'VOICE_CAPTURE_CANCELLED' });
      await flushMicrotasks();
      assert.equal(mediaDevices.calls.length, 1);
      let outcome;
      if (action === 'finish') outcome = await capture.finish('release');
      else if (action === 'dispose') outcome = await capture.dispose();
      else outcome = await capture.cancel(action);
      assert.deepEqual(outcome, {
        status: 'cancelled',
        reason: action === 'finish' ? 'finish-before-start' : action,
      });
      pending.resolve(lateStream);
      await rejected;
      assert.deepEqual(lateStream.tracks.map((track) => track.stopCalls), [1, 1]);
      assert.equal(recorders.instances.length, 0);
      assert.equal(capture.getState().permission, 'unknown');
      assert.equal(capture.getState().phase, 'idle');
    });
  }
});

test('a second preflight and begin fail busy before another getUserMedia call', async () => {
  const pending = deferred();
  const stream = fakeStream();
  const mediaDevices = queuedMediaDevices([pending.promise, fakeStream()]);
  const capture = createVoiceCapture({
    mediaDevices,
    MediaRecorderClass: recorderHarness().MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
  });
  const first = capture.preflightPermission({ consent: true });
  await flushMicrotasks();
  await assert.rejects(
    () => capture.preflightPermission({ consent: true }),
    { code: 'VOICE_CAPTURE_BUSY' },
  );
  assert.throws(() => capture.begin(), { code: 'VOICE_CAPTURE_BUSY' });
  assert.equal(mediaDevices.calls.length, 1);
  const cancelled = assert.rejects(first, { code: 'VOICE_CAPTURE_CANCELLED' });
  await capture.cancel('cancel');
  pending.resolve(stream);
  await cancelled;
  assert.ok(stream.tracks.every((track) => track.stopCalls === 1));
});

test('a cancelled older preflight completion cannot overwrite a newer ready permission state', async () => {
  const oldPermission = deferred();
  const newPermission = deferred();
  const oldStream = fakeStream();
  const newStream = fakeStream();
  const mediaDevices = queuedMediaDevices([oldPermission.promise, newPermission.promise]);
  const capture = createVoiceCapture({
    mediaDevices,
    MediaRecorderClass: recorderHarness().MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
  });

  const oldPreflight = capture.preflightPermission({ consent: true });
  const oldRejected = assert.rejects(oldPreflight, { code: 'VOICE_CAPTURE_CANCELLED' });
  await capture.cancel('hidden');
  const newPreflight = capture.preflightPermission({ consent: true });
  newPermission.resolve(newStream);
  assert.equal((await newPreflight).status, 'ready');
  assert.equal(capture.getState().permission, 'ready');

  oldPermission.resolve(oldStream);
  await oldRejected;
  await flushMicrotasks();
  assert.ok(oldStream.tracks.every((track) => track.stopCalls === 1));
  assert.ok(newStream.tracks.every((track) => track.stopCalls === 1));
  assert.equal(capture.getState().permission, 'ready');
});

test('one active permission interaction rejects overlap and cancel or dispose fences late grants', async (t) => {
  for (const action of ['cancel', 'dispose']) {
    await t.test(action, async () => {
      const pending = deferred();
      const lateStream = fakeStream();
      const recorders = recorderHarness();
      const capture = createVoiceCapture({
        mediaDevices: queuedMediaDevices([fakeStream(), pending.promise]),
        MediaRecorderClass: recorders.MediaRecorderClass,
        normalizer: async () => canonicalBlob(),
      });
      await capture.preflightPermission({ consent: true });
      const handle = capture.begin();
      assert.throws(() => capture.begin(), { code: 'VOICE_CAPTURE_BUSY' });
      const outcome = action === 'dispose'
        ? await capture.dispose()
        : await capture.cancel('visible-cancel');
      assert.equal(outcome.status, 'cancelled');
      pending.resolve(lateStream);
      await flushMicrotasks();
      assert.equal((await handle.result).status, 'cancelled');
      assert.deepEqual(lateStream.tracks.map((track) => track.stopCalls), [1, 1]);
      assert.equal(recorders.instances.length, 0);
      if (action === 'dispose') assert.throws(() => capture.begin(), { code: 'VOICE_CAPTURE_DISPOSED' });
    });
  }
});

test('Safari-style MP4 support is selected and preserved only inside the raw normalizer input', async () => {
  const recorders = recorderHarness(['audio/mp4']);
  let rawType;
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), fakeStream()]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async (raw) => { rawType = raw.type; return canonicalBlob(); },
  });
  const permission = await capture.preflightPermission({ consent: true });
  assert.equal(permission.mimeType, 'audio/mp4');
  const { recorder } = await startRecording(capture, recorders);
  assert.equal(recorder.mimeType, 'audio/mp4');
  const resultPromise = capture.finish('release');
  recorder.emitData([1]);
  recorder.emitStop();
  const result = await resultPromise;
  assert.equal(rawType, 'audio/mp4');
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal('sourceMimeType' in result, false);
});

test('all UI cancellation causes use one cleanup seam with zero normalization and no late listeners', async (t) => {
  const reasons = [
    'hidden', 'pagehide', 'pointercancel', 'lostpointercapture', 'visible-cancel', 'escape',
  ];
  const streams = reasons.map(() => fakeStream());
  const clock = { value: 0 };
  const timers = fakeTimers(clock);
  const recorders = recorderHarness();
  let normalizeCalls = 0;
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), ...streams]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => { normalizeCalls += 1; return canonicalBlob(); },
    now: () => clock.value,
    ...timers,
  });
  await capture.preflightPermission({ consent: true });

  for (let index = 0; index < reasons.length; index += 1) {
    await t.test(reasons[index], async () => {
      const { handle, recorder } = await startRecording(capture, recorders);
      recorder.emitData([index + 1]);
      const outcome = await capture.cancel(reasons[index]);
      assert.deepEqual(outcome, { status: 'cancelled', reason: reasons[index] });
      assert.deepEqual(await handle.result, outcome);
      assert.equal(recorder.stopCalls, 1);
      assert.equal(recorder.listenerCount(), 0);
      assert.ok(streams[index].tracks.every((track) => track.stopCalls === 1 && track.listenerCount() === 0));
      assert.equal(timers.pendingCount(), 0);
      recorder.emitData([99]);
      recorder.emitStop();
    });
  }
  assert.equal(normalizeCalls, 0);
});

test('track ended, recorder error, unexpected stop, and start throw all fail closed', async (t) => {
  for (const scenario of ['track-ended', 'recorder-error', 'unexpected-stop']) {
    await t.test(scenario, async () => {
      const runtime = fakeStream();
      const recorders = recorderHarness();
      let normalizeCalls = 0;
      const capture = createVoiceCapture({
        mediaDevices: queuedMediaDevices([fakeStream(), runtime]),
        MediaRecorderClass: recorders.MediaRecorderClass,
        normalizer: async () => { normalizeCalls += 1; return canonicalBlob(); },
      });
      await capture.preflightPermission({ consent: true });
      const { handle, recorder } = await startRecording(capture, recorders);
      if (scenario === 'track-ended') runtime.tracks[0].end();
      if (scenario === 'recorder-error') recorder.emitError();
      if (scenario === 'unexpected-stop') recorder.emitStop();
      const outcome = await handle.result;
      const expected = scenario === 'track-ended' ? 'VOICE_TRACK_ENDED'
        : scenario === 'recorder-error' ? 'VOICE_RECORDER_FAILED' : 'VOICE_RECORDER_STOPPED';
      assert.deepEqual(outcome, { status: 'error', error: { code: expected, textSafe: true } });
      assert.equal(normalizeCalls, 0);
      assert.equal(recorder.listenerCount(), 0);
      assert.ok(runtime.tracks.every((track) => track.stopCalls === 1));
    });
  }

  await t.test('start-throw', async () => {
    const base = recorderHarness();
    class ThrowingStartRecorder extends base.MediaRecorderClass {
      start() { throw new Error('start failed'); }
    }
    const runtime = fakeStream();
    const capture = createVoiceCapture({
      mediaDevices: queuedMediaDevices([fakeStream(), runtime]),
      MediaRecorderClass: ThrowingStartRecorder,
      normalizer: async () => canonicalBlob(),
    });
    await capture.preflightPermission({ consent: true });
    const handle = capture.begin();
    assert.deepEqual(await handle.result, {
      status: 'error', error: { code: 'VOICE_RECORDER_FAILED', textSafe: true },
    });
    assert.ok(runtime.tracks.every((track) => track.stopCalls === 1));
  });
});

test('an early duration timer reschedules and exact 55 seconds still stops only once', async () => {
  const clock = { value: 100 };
  const timers = fakeTimers(clock);
  const recorders = recorderHarness();
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), fakeStream()]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => canonicalBlob(),
    now: () => clock.value,
    ...timers,
  });
  await capture.preflightPermission({ consent: true });
  const { recorder } = await startRecording(capture, recorders);
  clock.value = 55_099;
  timers.fireNext();
  assert.equal(recorder.stopCalls, 0);
  assert.deepEqual(timers.pendingDelays(), [1]);
  clock.value = 55_100;
  timers.fireNext();
  assert.equal(recorder.stopCalls, 1);
  await capture.cancel('visible-cancel');
  assert.equal(recorder.stopCalls, 1);
});

test('late permission, recorder events, and normalization from old generations cannot pollute a new capture', async () => {
  const latePermission = deferred();
  const latePermissionStream = fakeStream();
  const oldRuntime = fakeStream();
  const newRuntime = fakeStream();
  const recorders = recorderHarness();
  let normalizeCalls = 0;
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([
      fakeStream(), latePermission.promise, oldRuntime, newRuntime,
    ]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => { normalizeCalls += 1; return canonicalBlob(); },
  });
  await capture.preflightPermission({ consent: true });

  const permissionHandle = capture.begin();
  await capture.cancel('pointercancel');
  const oldHandle = capture.begin();
  await flushMicrotasks();
  const oldRecorder = recorders.instances[0];
  await capture.cancel('escape');
  const newHandle = capture.begin();
  await flushMicrotasks();
  const newRecorder = recorders.instances[1];

  latePermission.resolve(latePermissionStream);
  oldRecorder.emitStart();
  oldRecorder.emitData([7]);
  oldRecorder.emitStop();
  await flushMicrotasks();
  assert.deepEqual(latePermissionStream.tracks.map((track) => track.stopCalls), [1, 1]);
  assert.equal(normalizeCalls, 0);

  newRecorder.emitStart();
  await newHandle.started;
  const newResultPromise = capture.finish('release');
  newRecorder.emitData([8]);
  newRecorder.emitStop();
  const newResult = await newResultPromise;
  assert.equal(newResult.status, 'ready');
  assert.equal(normalizeCalls, 1);
  assert.equal((await permissionHandle.result).status, 'cancelled');
  assert.equal((await oldHandle.result).status, 'cancelled');
  assert.equal((await newHandle.result).status, 'ready');
});

test('cancel during normalization fences late completion and allows a clean next interaction', async () => {
  const pendingNormalization = deferred();
  const recorders = recorderHarness();
  let normalizeCalls = 0;
  const capture = createVoiceCapture({
    mediaDevices: queuedMediaDevices([fakeStream(), fakeStream(), fakeStream()]),
    MediaRecorderClass: recorders.MediaRecorderClass,
    normalizer: async () => {
      normalizeCalls += 1;
      return normalizeCalls === 1 ? pendingNormalization.promise : canonicalBlob();
    },
  });
  await capture.preflightPermission({ consent: true });
  const first = await startRecording(capture, recorders);
  const firstFinish = capture.finish('release');
  first.recorder.emitData([1]);
  first.recorder.emitStop();
  await flushMicrotasks();
  assert.equal(capture.getState().phase, 'normalizing');
  const cancelled = await capture.cancel('escape');
  assert.deepEqual(await firstFinish, cancelled);

  const second = await startRecording(capture, recorders);
  const secondFinish = capture.finish('release');
  second.recorder.emitData([2]);
  second.recorder.emitStop();
  assert.equal((await secondFinish).status, 'ready');
  pendingNormalization.resolve(canonicalBlob());
  await flushMicrotasks();
  assert.equal((await first.handle.result).status, 'cancelled');
  assert.equal((await second.handle.result).status, 'ready');
});

test('normalization failure, empty audio, or raw passthrough returns only a text-safe error', async (t) => {
  for (const scenario of ['reject', 'empty', 'raw-passthrough']) {
    await t.test(scenario, async () => {
      const recorders = recorderHarness(scenario === 'raw-passthrough' ? ['audio/wav'] : undefined);
      const capture = createVoiceCapture({
        mediaDevices: queuedMediaDevices([fakeStream(), fakeStream()]),
        MediaRecorderClass: recorders.MediaRecorderClass,
        normalizer: async (raw) => {
          if (scenario === 'reject') throw new Error('private decoder details');
          if (scenario === 'raw-passthrough') return raw;
          return canonicalBlob();
        },
      });
      await capture.preflightPermission({ consent: true });
      const { handle, recorder } = await startRecording(capture, recorders);
      const resultPromise = capture.finish('release');
      if (scenario !== 'empty') recorder.emitData(new Array(50).fill(1));
      recorder.emitStop();
      const outcome = await resultPromise;
      const expected = scenario === 'empty' ? 'VOICE_EMPTY_RECORDING' : 'VOICE_NORMALIZATION_FAILED';
      assert.deepEqual(outcome, { status: 'error', error: { code: expected, textSafe: true } });
      assert.equal(JSON.stringify(outcome).includes('private decoder'), false);
      assert.equal('audio' in outcome, false);
      assert.deepEqual(await handle.result, outcome);
    });
  }
});
