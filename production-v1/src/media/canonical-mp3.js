import { createHash } from 'node:crypto';

export function validateCanonicalMp3(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  let offset = 0;
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    const sizeBytes = buffer.subarray(6, 10);
    if ([...sizeBytes].some((byte) => byte > 0x7f)) throw new Error('Invalid MP3 ID3 size');
    const tagSize = [...sizeBytes].reduce((size, byte) => (size << 7) | byte, 0);
    offset = 10 + tagSize;
  }
  if (buffer.length - offset < 4) throw new Error('Invalid MP3 structure');
  const b1 = buffer[offset];
  const b2 = buffer[offset + 1];
  const b3 = buffer[offset + 2];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0 || (b2 & 0x18) === 0x08
    || (b2 & 0x06) === 0 || (b3 & 0xf0) === 0xf0 || (b3 & 0x0c) === 0x0c) {
    throw new Error('Invalid MP3 frame header');
  }
  const bitrateIndex = (b3 >> 4) & 0x0f;
  const sampleRateIndex = (b3 >> 2) & 0x03;
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const sampleRates = [44_100, 48_000, 32_000];
  const bitrate = bitrates[bitrateIndex];
  const sampleRate = sampleRates[sampleRateIndex];
  if (!bitrate || !sampleRate) throw new Error('Invalid MP3 frame rate');
  const frameLength = Math.floor((144_000 * bitrate) / sampleRate) + ((b3 >> 1) & 1);
  if (frameLength < 4 || offset + frameLength > buffer.length) throw new Error('Truncated MP3 frame');
  return {
    buffer,
    byteLength: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}
