import { createHash } from 'node:crypto';

import { MPEGDecoder } from 'mpg123-decoder';

const MAX_FRAME_COUNT = 100_000;
const MAX_DECODE_DURATION_DELTA_MS = 250;
const MIN_DECODED_PEAK = 1e-7;
const MIN_DECODED_MEAN_SQUARE = 1e-16;

const MPEG1_BITRATES = Object.freeze({
  1: Object.freeze([0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]),
  2: Object.freeze([0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]),
  3: Object.freeze([0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]),
});
const MPEG2_BITRATES = Object.freeze({
  1: Object.freeze([0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]),
  2: Object.freeze([0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]),
  3: Object.freeze([0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]),
});
const BASE_SAMPLE_RATES = Object.freeze([44_100, 48_000, 32_000]);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CANONICAL_MP3' });
}

function id3AudioStart(buffer) {
  if (buffer.subarray(0, 3).toString('ascii') !== 'ID3') return 0;
  if (buffer.length < 10) throw invalid('Invalid MP3 ID3 header');
  const version = buffer[3];
  const flags = buffer[5];
  if (version < 2 || version > 4 || buffer[4] === 0xff) throw invalid('Invalid MP3 ID3 version');
  const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : 0xf0;
  if ((flags & ~allowedFlags) !== 0 || (version !== 4 && (flags & 0x10) !== 0)) {
    throw invalid('Invalid MP3 ID3 flags');
  }
  const sizeBytes = buffer.subarray(6, 10);
  if ([...sizeBytes].some((byte) => byte > 0x7f)) throw invalid('Invalid MP3 ID3 size');
  const tagSize = [...sizeBytes].reduce((size, byte) => (size << 7) | byte, 0);
  const footerSize = flags & 0x10 ? 10 : 0;
  const start = 10 + tagSize + footerSize;
  if (start > buffer.length) throw invalid('Truncated MP3 ID3 tag');
  return start;
}

function id3AudioEnd(buffer, start) {
  if (buffer.length - start >= 128
    && buffer.subarray(buffer.length - 128, buffer.length - 125).toString('ascii') === 'TAG') {
    return buffer.length - 128;
  }
  return buffer.length;
}

function parseFrameHeader(buffer, offset) {
  if (offset + 4 > buffer.length) throw invalid('Truncated MP3 frame header');
  const first = buffer[offset];
  const second = buffer[offset + 1];
  const third = buffer[offset + 2];
  const fourth = buffer[offset + 3];
  if (first !== 0xff || (second & 0xe0) !== 0xe0) throw invalid('Invalid MP3 frame sync');

  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 2.5 : null;
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : layerBits === 1 ? 3 : null;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  const padding = (third >> 1) & 0x01;
  if (!version || !layer || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3
    || (fourth & 0x03) === 2) throw invalid('Invalid MP3 frame header');

  const bitrate = (version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES)[layer][bitrateIndex];
  const divisor = version === 1 ? 1 : version === 2 ? 2 : 4;
  const sampleRate = BASE_SAMPLE_RATES[sampleRateIndex] / divisor;
  let frameLength;
  if (layer === 1) frameLength = Math.floor(((12 * bitrate * 1_000) / sampleRate) + padding) * 4;
  else if (layer === 3 && version !== 1) frameLength = Math.floor((72 * bitrate * 1_000) / sampleRate) + padding;
  else frameLength = Math.floor((144 * bitrate * 1_000) / sampleRate) + padding;
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1_152;
  const channelCount = ((fourth >> 6) & 0x03) === 3 ? 1 : 2;
  if (!Number.isSafeInteger(frameLength) || frameLength <= 4) throw invalid('Invalid MP3 frame length');
  return { version, layer, sampleRate, frameLength, samplesPerFrame, channelCount };
}

export function validateCanonicalMp3(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  const audioStart = id3AudioStart(buffer);
  const audioEnd = id3AudioEnd(buffer, audioStart);
  if (audioEnd - audioStart < 8) throw invalid('Invalid MP3 structure');

  let offset = audioStart;
  let frameCount = 0;
  let totalSamples = 0;
  let streamShape = null;
  while (offset < audioEnd) {
    if (frameCount >= MAX_FRAME_COUNT) throw invalid('MP3 frame count exceeds validation bound');
    const frame = parseFrameHeader(buffer, offset);
    const frameEnd = offset + frame.frameLength;
    if (frameEnd > audioEnd) throw invalid('Truncated MP3 frame');
    if (!buffer.subarray(offset + 4, frameEnd).some((byte) => byte !== 0)) {
      throw invalid('Invalid MP3 zero-payload pseudo frame');
    }
    const shape = `${frame.version}:${frame.layer}:${frame.sampleRate}:${frame.channelCount}`;
    if (streamShape !== null && streamShape !== shape) throw invalid('Inconsistent MP3 stream shape');
    streamShape = shape;
    frameCount += 1;
    totalSamples += frame.samplesPerFrame;
    offset = frameEnd;
  }
  if (offset !== audioEnd || frameCount < 2) throw invalid('Incomplete MP3 frame traversal');
  const firstFrame = parseFrameHeader(buffer, audioStart);
  const durationMs = (totalSamples / firstFrame.sampleRate) * 1_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw invalid('Invalid MP3 duration');
  return {
    buffer,
    byteLength: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    frameCount,
    sampleRate: firstFrame.sampleRate,
    channelCount: firstFrame.channelCount,
    durationMs,
  };
}

export async function decodeCanonicalMp3(value, { Decoder = MPEGDecoder } = {}) {
  const structural = validateCanonicalMp3(value);
  let decoder;
  try {
    decoder = new Decoder();
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(
      structural.buffer.buffer,
      structural.buffer.byteOffset,
      structural.buffer.byteLength,
    ));
    if (!decoded || !Array.isArray(decoded.errors) || decoded.errors.length !== 0
      || !Number.isSafeInteger(decoded.samplesDecoded) || decoded.samplesDecoded <= 0
      || !Number.isSafeInteger(decoded.sampleRate) || decoded.sampleRate <= 0
      || decoded.sampleRate !== structural.sampleRate
      || !Array.isArray(decoded.channelData)
      || (decoded.channelData.length !== structural.channelCount
        && !(structural.channelCount === 1 && decoded.channelData.length === 2))
      || decoded.channelData.length < 1 || decoded.channelData.length > 2) {
      throw invalid('Independent MP3 decoder rejected the stream');
    }
    let decodedPeak = 0;
    let decodedEnergy = 0;
    for (const channel of decoded.channelData) {
      if (!ArrayBuffer.isView(channel) || channel.length !== decoded.samplesDecoded
        || channel.some((sample) => !Number.isFinite(sample))) {
        throw invalid('Independent MP3 decoder returned invalid samples');
      }
      for (const sample of channel) {
        const amplitude = Math.abs(sample);
        if (amplitude > decodedPeak) decodedPeak = amplitude;
        decodedEnergy += sample * sample;
      }
    }
    const decodedMeanSquare = decodedEnergy
      / (decoded.samplesDecoded * decoded.channelData.length);
    if (!Number.isFinite(decodedMeanSquare)
      || decodedPeak < MIN_DECODED_PEAK
      || decodedMeanSquare < MIN_DECODED_MEAN_SQUARE) {
      throw invalid('Independent MP3 decoder returned silent PCM');
    }
    const decodedDurationMs = (decoded.samplesDecoded / decoded.sampleRate) * 1_000;
    const durationDeltaMs = Math.abs(structural.durationMs - decodedDurationMs);
    const durationToleranceMs = Math.min(
      MAX_DECODE_DURATION_DELTA_MS,
      Math.max(100, structural.durationMs * 0.02),
    );
    if (!Number.isFinite(decodedDurationMs) || decodedDurationMs <= 0
      || durationDeltaMs > durationToleranceMs) {
      throw invalid('Independent MP3 decoder duration is inconsistent');
    }
    return {
      ...structural,
      decoder: 'mpg123-decoder@1.0.3',
      decodedSampleCount: decoded.samplesDecoded,
      decodedSampleRate: decoded.sampleRate,
      decodedChannelCount: decoded.channelData.length,
      decodedDurationMs,
      durationDeltaMs,
    };
  } catch (error) {
    if (error?.code === 'INVALID_CANONICAL_MP3') throw error;
    throw invalid('Independent MP3 decoder failed');
  } finally {
    if (decoder && typeof decoder.free === 'function') decoder.free();
  }
}
