export const CANONICAL_AUDIO = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  bytesPerSample: 2,
  byteRate: 32_000,
  blockAlign: 2,
  headerBytes: 44,
  maxDurationSeconds: 55,
  mimeType: 'audio/wav',
});

export class AudioNormalizationError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'AudioNormalizationError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function finiteSample(value) {
  const sample = Number(value);
  return Number.isFinite(sample) ? sample : 0;
}

function requireSamples(samples) {
  if (!samples || !Number.isSafeInteger(samples.length) || samples.length < 1) {
    throw new TypeError('Audio samples must contain at least one sample');
  }
  return samples;
}

function requireRate(rate, name) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} rate must be positive`);
  return value;
}

export function downmixChannels(channelData) {
  const channels = Array.from(channelData ?? []);
  if (channels.length < 1) throw new TypeError('Audio must contain at least one channel');
  const length = requireSamples(channels[0]).length;
  for (const channel of channels) {
    requireSamples(channel);
    if (channel.length !== length) throw new RangeError('Audio channel length mismatch');
  }

  const mono = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += finiteSample(channel[frame]);
    mono[frame] = sum / channels.length;
  }
  return mono;
}

export function resampleLinear(samples, sourceSampleRate, targetSampleRate = CANONICAL_AUDIO.sampleRate) {
  const input = requireSamples(samples);
  const sourceRate = requireRate(sourceSampleRate, 'Source sample');
  const targetRate = requireRate(targetSampleRate, 'Target sample');
  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  if (!Number.isSafeInteger(outputLength)) throw new RangeError('Resampled audio length is invalid');

  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = (index * sourceRate) / targetRate;
    const leftIndex = Math.min(input.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const fraction = Math.min(1, Math.max(0, sourcePosition - leftIndex));
    const left = finiteSample(input[leftIndex]);
    const right = finiteSample(input[rightIndex]);
    output[index] = left + ((right - left) * fraction);
  }
  return output;
}

export function floatToPcm16Le(samples) {
  const input = requireSamples(samples);
  const bytes = new Uint8Array(input.length * CANONICAL_AUDIO.bytesPerSample);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, finiteSample(input[index])));
    const value = Math.round(sample * (sample < 0 ? 32_768 : 32_767));
    view.setInt16(index * CANONICAL_AUDIO.bytesPerSample, value, true);
  }
  return bytes;
}

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

export function encodeCanonicalWav(samples) {
  const input = requireSamples(samples);
  const maximumSamples = CANONICAL_AUDIO.maxDurationSeconds * CANONICAL_AUDIO.sampleRate;
  if (input.length > maximumSamples) throw new RangeError('Audio samples exceed the maximum duration');
  const pcm = floatToPcm16Le(input);
  const bytes = new Uint8Array(CANONICAL_AUDIO.headerBytes + pcm.length);
  const view = new DataView(bytes.buffer);

  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CANONICAL_AUDIO.channels, true);
  view.setUint32(24, CANONICAL_AUDIO.sampleRate, true);
  view.setUint32(28, CANONICAL_AUDIO.byteRate, true);
  view.setUint16(32, CANONICAL_AUDIO.blockAlign, true);
  view.setUint16(34, CANONICAL_AUDIO.bitsPerSample, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, pcm.length, true);
  bytes.set(pcm, CANONICAL_AUDIO.headerBytes);
  return bytes;
}

function decodeWithWebAudio(context, arrayBuffer) {
  if (typeof context?.decodeAudioData !== 'function') {
    return Promise.reject(new TypeError('decodeAudioData is unavailable'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const accept = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const decline = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      const result = context.decodeAudioData(arrayBuffer, accept, decline);
      if (result && typeof result.then === 'function') result.then(accept, decline);
      else if (result !== undefined) accept(result);
    } catch (error) {
      decline(error);
    }
  });
}

function decodedChannels(decoded) {
  if (!decoded
    || !Number.isSafeInteger(decoded.numberOfChannels)
    || decoded.numberOfChannels < 1
    || !Number.isSafeInteger(decoded.length)
    || decoded.length < 1
    || typeof decoded.getChannelData !== 'function') {
    throw new AudioNormalizationError('AUDIO_INVALID_DECODE');
  }
  const sampleRate = requireRate(decoded.sampleRate, 'Decoded sample');
  const durationSeconds = decoded.length / sampleRate;
  if (durationSeconds > CANONICAL_AUDIO.maxDurationSeconds) {
    throw new AudioNormalizationError('AUDIO_TOO_LONG');
  }

  const channels = [];
  for (let index = 0; index < decoded.numberOfChannels; index += 1) {
    const channel = decoded.getChannelData(index);
    if (!channel || channel.length !== decoded.length) {
      throw new AudioNormalizationError('AUDIO_INVALID_DECODE');
    }
    channels.push(channel);
  }
  return { channels, sampleRate };
}

function browserAudioContextClass(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'AudioContextClass')) {
    return options.AudioContextClass;
  }
  return globalThis.AudioContext ?? globalThis.webkitAudioContext;
}

async function closeAudioContext(context) {
  if (typeof context?.close !== 'function') return;
  try {
    await context.close();
  } catch {
    // Closing is best-effort resource cleanup and must not replace the decode result.
  }
}

export async function normalizeAudioBlobToCanonicalWav(blob, options = {}) {
  if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size) || blob.size < 0) {
    throw new AudioNormalizationError('AUDIO_INVALID_INPUT');
  }
  if (blob.size === 0) throw new AudioNormalizationError('AUDIO_EMPTY_INPUT');

  const AudioContextClass = browserAudioContextClass(options);
  if (typeof AudioContextClass !== 'function') {
    throw new AudioNormalizationError('WEB_AUDIO_UNAVAILABLE');
  }

  let encoded;
  try {
    encoded = await blob.arrayBuffer();
  } catch (error) {
    throw new AudioNormalizationError('AUDIO_READ_FAILED', error);
  }
  if (!(encoded instanceof ArrayBuffer) || encoded.byteLength < 1) {
    throw new AudioNormalizationError('AUDIO_READ_FAILED');
  }

  let context;
  try {
    context = new AudioContextClass();
  } catch (error) {
    throw new AudioNormalizationError('WEB_AUDIO_UNAVAILABLE', error);
  }

  try {
    let decoded;
    try {
      decoded = await decodeWithWebAudio(context, encoded);
    } catch (error) {
      throw new AudioNormalizationError('AUDIO_DECODE_FAILED', error);
    }

    try {
      const { channels, sampleRate } = decodedChannels(decoded);
      const mono = downmixChannels(channels);
      const resampled = resampleLinear(mono, sampleRate, CANONICAL_AUDIO.sampleRate);
      const wav = encodeCanonicalWav(resampled);
      return new Blob([wav], { type: CANONICAL_AUDIO.mimeType });
    } catch (error) {
      if (error instanceof AudioNormalizationError) throw error;
      throw new AudioNormalizationError('AUDIO_INVALID_DECODE', error);
    }
  } finally {
    await closeAudioContext(context);
  }
}
