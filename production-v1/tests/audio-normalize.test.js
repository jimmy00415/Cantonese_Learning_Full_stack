import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_AUDIO,
  AudioNormalizationError,
  downmixChannels,
  encodeCanonicalWav,
  floatToPcm16Le,
  normalizeAudioBlobToCanonicalWav,
  resampleLinear,
} from '../public/audio-normalize.js';

function decodedBuffer(channels, sampleRate) {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    duration: sampleRate > 0 ? length / sampleRate : Number.NaN,
    getChannelData(index) {
      return channels[index];
    },
  };
}

function audioContextClass({ decoded, decodeError, constructError, tracker = {} } = {}) {
  return class FakeAudioContext {
    constructor() {
      tracker.constructed = (tracker.constructed ?? 0) + 1;
      if (constructError) throw constructError;
    }

    decodeAudioData(arrayBuffer) {
      tracker.decodeCalls = (tracker.decodeCalls ?? 0) + 1;
      tracker.decodedInput = new Uint8Array(arrayBuffer).slice();
      if (decodeError) return Promise.reject(decodeError);
      return Promise.resolve(decoded);
    }

    close() {
      tracker.closed = (tracker.closed ?? 0) + 1;
      return Promise.resolve();
    }
  };
}

function wavView(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

function ascii(bytes, start, end) {
  return new TextDecoder('ascii').decode(bytes.subarray(start, end));
}

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AudioNormalizationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('downmixChannels averages every channel without mutating source samples', () => {
  const first = Float32Array.from([1, -1, 0.5]);
  const second = Float32Array.from([-1, 1, 0.5]);
  const third = Float32Array.from([0.5, 0.5, -1]);
  const mono = downmixChannels([first, second, third]);

  assert.notStrictEqual(mono, first);
  assert.equal(mono.length, 3);
  assert.ok(Math.abs(mono[0] - (1 / 6)) < 1e-6);
  assert.ok(Math.abs(mono[1] - (1 / 6)) < 1e-6);
  assert.equal(mono[2], 0);
  assert.deepEqual(Array.from(first), [1, -1, 0.5]);
});

test('resampleLinear preserves duration-derived length and linearly interpolates samples', () => {
  const output = resampleLinear(Float32Array.from([0, 1, 0, -1]), 4, 8);
  assert.equal(output.length, 8);
  assert.deepEqual(Array.from(output), [0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);

  const speechFrame = new Float32Array(441);
  assert.equal(resampleLinear(speechFrame, 44_100, 16_000).length, 160);
});

test('floatToPcm16Le clips, rounds, signs, and writes little-endian PCM16 exactly', () => {
  const bytes = floatToPcm16Le(Float32Array.from([
    -2, -1, -0.5, -0, 0, 0.5, 1, 2, Number.NaN,
  ]));
  const values = new Int16Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < values.length; index += 1) values[index] = view.getInt16(index * 2, true);

  assert.deepEqual(Array.from(values), [
    -32_768, -32_768, -16_384, 0, 0, 16_384, 32_767, 32_767, 0,
  ]);
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0x00, 0x80, 0x00, 0x80, 0x00, 0xc0, 0x00, 0x00]);
});

test('encodeCanonicalWav writes an exact 44-byte canonical header and matching data sizes', () => {
  const wav = encodeCanonicalWav(Float32Array.from([-1, 0, 1]));
  const { bytes, view } = wavView(wav);

  assert.equal(bytes.length, 44 + 6);
  assert.equal(ascii(bytes, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(ascii(bytes, 8, 12), 'WAVE');
  assert.equal(ascii(bytes, 12, 16), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(bytes, 36, 40), 'data');
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual(Array.from(bytes.subarray(44)), [0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
});

test('encodeCanonicalWav preserves digital silence as zero-valued data bytes', () => {
  const wav = encodeCanonicalWav(new Float32Array(160));
  assert.equal(wav.length, 44 + 320);
  assert.ok(wav.subarray(44).every((value) => value === 0));
});

test('numeric helpers reject empty, mismatched, or invalid audio shapes', () => {
  assert.throws(() => downmixChannels([]), /channel/i);
  assert.throws(
    () => downmixChannels([new Float32Array(2), new Float32Array(1)]),
    /length/i,
  );
  assert.throws(() => resampleLinear(new Float32Array(), 48_000), /sample/i);
  assert.throws(() => resampleLinear(Float32Array.of(0), 0), /rate/i);
  assert.throws(() => encodeCanonicalWav(new Float32Array()), /sample/i);
});

test('normalizeAudioBlobToCanonicalWav decodes the complete opaque blob, downmixes, and returns a new WAV Blob', async () => {
  const opaqueBytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x99]);
  const input = new Blob([opaqueBytes], { type: 'audio/webm' });
  const tracker = {};
  const AudioContextClass = audioContextClass({
    decoded: decodedBuffer([
      Float32Array.from([1, 0.5, -1, 0.25]),
      Float32Array.from([-1, 0.5, 1, 0.75]),
    ], 16_000),
    tracker,
  });

  const output = await normalizeAudioBlobToCanonicalWav(input, { AudioContextClass });
  const bytes = new Uint8Array(await output.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.notStrictEqual(output, input);
  assert.equal(output.type, 'audio/wav');
  assert.equal(output.size, 44 + 8);
  assert.deepEqual(Array.from(tracker.decodedInput), Array.from(opaqueBytes));
  assert.equal(tracker.decodeCalls, 1);
  assert.equal(tracker.closed, 1);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16_384);
  assert.equal(view.getInt16(48, true), 0);
  assert.equal(view.getInt16(50, true), 16_384);
});

test('normalization accepts exactly 55 seconds and emits only canonical header plus PCM data', async () => {
  const AudioContextClass = audioContextClass({
    decoded: decodedBuffer([new Float32Array(55)], 1),
  });
  const output = await normalizeAudioBlobToCanonicalWav(new Blob(['x']), { AudioContextClass });

  assert.equal(CANONICAL_AUDIO.maxDurationSeconds, 55);
  assert.equal(output.type, 'audio/wav');
  assert.equal(output.size, 44 + (55 * 16_000 * 2));
});

test('normalization rejects empty input, invalid decoded audio, and decoded audio over 55 seconds', async () => {
  let constructions = 0;
  class CountingContext {
    constructor() { constructions += 1; }
  }
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob([]), { AudioContextClass: CountingContext }),
    'AUDIO_EMPTY_INPUT',
  );
  assert.equal(constructions, 0);

  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob(['x']), {
      AudioContextClass: audioContextClass({ decoded: decodedBuffer([], 48_000) }),
    }),
    'AUDIO_INVALID_DECODE',
  );
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob(['x']), {
      AudioContextClass: audioContextClass({
        decoded: decodedBuffer([new Float32Array(56)], 1),
      }),
    }),
    'AUDIO_TOO_LONG',
  );
});

test('normalization fails closed on blob-read or Web Audio decode failure and never returns the original container', async () => {
  const opaque = new Blob(['original-container-must-never-upload'], { type: 'audio/ogg' });
  const tracker = {};
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(opaque, {
      AudioContextClass: audioContextClass({
        decodeError: new DOMException('unsupported bytes', 'EncodingError'),
        tracker,
      }),
    }),
    'AUDIO_DECODE_FAILED',
  );
  assert.equal(tracker.decodeCalls, 1);
  assert.equal(tracker.closed, 1);

  const unreadable = {
    size: 4,
    type: 'audio/webm',
    arrayBuffer: async () => { throw new Error('read failed'); },
  };
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(unreadable, {
      AudioContextClass: audioContextClass({ decoded: decodedBuffer([Float32Array.of(0)], 16_000) }),
    }),
    'AUDIO_READ_FAILED',
  );
});

test('normalization supports callback-only decodeAudioData without bypassing Web Audio', async () => {
  const tracker = { decodeCalls: 0, closed: 0 };
  class CallbackOnlyContext {
    decodeAudioData(arrayBuffer, onSuccess) {
      tracker.decodeCalls += 1;
      tracker.decodedInput = new Uint8Array(arrayBuffer).slice();
      queueMicrotask(() => onSuccess(decodedBuffer([Float32Array.of(0.25)], 16_000)));
      return undefined;
    }

    close() {
      tracker.closed += 1;
      return Promise.resolve();
    }
  }

  const input = Uint8Array.from([9, 8, 7]);
  const output = await normalizeAudioBlobToCanonicalWav(new Blob([input]), {
    AudioContextClass: CallbackOnlyContext,
  });
  const bytes = new Uint8Array(await output.arrayBuffer());
  assert.equal(tracker.decodeCalls, 1);
  assert.deepEqual(Array.from(tracker.decodedInput), Array.from(input));
  assert.equal(tracker.closed, 1);
  assert.equal(new DataView(bytes.buffer).getInt16(44, true), 8_192);
});

test('normalization maps a synchronous decodeAudioData throw and still closes the context', async () => {
  const tracker = { closed: 0 };
  class ThrowingDecodeContext {
    decodeAudioData() {
      throw new DOMException('bad container', 'EncodingError');
    }

    close() {
      tracker.closed += 1;
      return Promise.resolve();
    }
  }

  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob(['bad']), {
      AudioContextClass: ThrowingDecodeContext,
    }),
    'AUDIO_DECODE_FAILED',
  );
  assert.equal(tracker.closed, 1);
});

test('a rejected AudioContext close cannot replace either normalization success or decode failure', async () => {
  class SuccessfulDecodeRejectingClose {
    decodeAudioData() {
      return Promise.resolve(decodedBuffer([Float32Array.of(0)], 16_000));
    }

    close() {
      return Promise.reject(new Error('close failed'));
    }
  }
  const output = await normalizeAudioBlobToCanonicalWav(new Blob(['ok']), {
    AudioContextClass: SuccessfulDecodeRejectingClose,
  });
  assert.equal(output.type, 'audio/wav');

  class FailedDecodeRejectingClose extends SuccessfulDecodeRejectingClose {
    decodeAudioData() {
      return Promise.reject(new Error('decode failed'));
    }
  }
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob(['bad']), {
      AudioContextClass: FailedDecodeRejectingClose,
    }),
    'AUDIO_DECODE_FAILED',
  );
});

test('normalization fails closed when Web Audio is absent or cannot initialize', async () => {
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob(['x']), { AudioContextClass: null }),
    'WEB_AUDIO_UNAVAILABLE',
  );
  await rejectsWithCode(
    () => normalizeAudioBlobToCanonicalWav(new Blob(['x']), {
      AudioContextClass: audioContextClass({ constructError: new Error('blocked by platform') }),
    }),
    'WEB_AUDIO_UNAVAILABLE',
  );
});
