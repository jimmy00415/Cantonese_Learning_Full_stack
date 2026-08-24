import { createHash, timingSafeEqual } from 'node:crypto';

export const CANONICAL_WAV = Object.freeze({
  format: 1,
  channels: 1,
  sampleRate: 16_000,
  bitsPerSample: 16,
  byteRate: 32_000,
  blockAlign: 2,
  headerBytes: 44,
  maxPcmBytes: 1_920_000,
  maxDurationMs: 60_000,
  mimeType: 'audio/wav',
  contractVersion: 'canonical-wav-v1',
});

function wavError(code = 'VOICE_INVALID_WAV') {
  const error = new Error(code);
  error.code = code;
  error.status = 422;
  error.retryable = false;
  return error;
}

function exactAscii(buffer, offset, value) {
  return buffer.subarray(offset, offset + value.length).equals(Buffer.from(value, 'ascii'));
}

export function validateCanonicalWav(value, { expectedSha256 } = {}) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  if (buffer.length < CANONICAL_WAV.headerBytes
    || !exactAscii(buffer, 0, 'RIFF')
    || buffer.readUInt32LE(4) !== buffer.length - 8
    || !exactAscii(buffer, 8, 'WAVE')
    || !exactAscii(buffer, 12, 'fmt ')
    || buffer.readUInt32LE(16) !== 16
    || buffer.readUInt16LE(20) !== CANONICAL_WAV.format
    || buffer.readUInt16LE(22) !== CANONICAL_WAV.channels
    || buffer.readUInt32LE(24) !== CANONICAL_WAV.sampleRate
    || buffer.readUInt32LE(28) !== CANONICAL_WAV.byteRate
    || buffer.readUInt16LE(32) !== CANONICAL_WAV.blockAlign
    || buffer.readUInt16LE(34) !== CANONICAL_WAV.bitsPerSample
    || !exactAscii(buffer, 36, 'data')) {
    throw wavError();
  }

  const pcmBytes = buffer.readUInt32LE(40);
  if (pcmBytes === 0 || pcmBytes % CANONICAL_WAV.blockAlign !== 0
    || pcmBytes > CANONICAL_WAV.maxPcmBytes
    || CANONICAL_WAV.headerBytes + pcmBytes !== buffer.length) {
    throw wavError();
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(String(expectedSha256))) throw wavError('VOICE_HASH_MISMATCH');
    const expected = Buffer.from(expectedSha256, 'hex');
    const actual = Buffer.from(sha256, 'hex');
    if (!timingSafeEqual(actual, expected)) throw wavError('VOICE_HASH_MISMATCH');
  }

  return {
    buffer,
    sha256,
    byteLength: buffer.length,
    pcmBytes,
    durationMs: (pcmBytes / CANONICAL_WAV.byteRate) * 1_000,
    mimeType: CANONICAL_WAV.mimeType,
  };
}
