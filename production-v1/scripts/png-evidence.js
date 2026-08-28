import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WIDTH = 390;
const HEIGHT = 844;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

function invalid() {
  const error = new Error('PNG evidence is invalid');
  error.code = 'PNG_EVIDENCE_INVALID';
  return error;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left : (upDistance <= upperLeftDistance ? up : upperLeft);
}

function parseChunks(buffer) {
  if (buffer.length < SIGNATURE.length + 12 || buffer.length > MAX_PNG_BYTES
    || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw invalid();
  const chunks = [];
  let offset = SIGNATURE.length;
  let ended = false;
  while (offset < buffer.length) {
    if (ended || offset + 12 > buffer.length) throw invalid();
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_CHUNK_BYTES || offset + 12 + length > buffer.length) throw invalid();
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalid();
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (buffer.readUInt32BE(offset + 8 + length) !== crc32(Buffer.concat([typeBytes, data]))) {
      throw invalid();
    }
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') ended = true;
  }
  if (!ended || offset !== buffer.length) throw invalid();
  return chunks;
}

function decodePixels(chunks) {
  if (chunks[0]?.type !== 'IHDR' || chunks.filter(({ type }) => type === 'IHDR').length !== 1
    || chunks.at(-1)?.type !== 'IEND' || chunks.filter(({ type }) => type === 'IEND').length !== 1
    || chunks.at(-1).data.length !== 0) throw invalid();
  const header = chunks[0].data;
  if (header.length !== 13) throw invalid();
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  if (width !== WIDTH || height !== HEIGHT || bitDepth !== 8 || ![2, 6].includes(colorType)
    || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) throw invalid();
  const idatIndexes = chunks.map(({ type }, index) => (type === 'IDAT' ? index : -1))
    .filter((index) => index >= 0);
  if (idatIndexes.length < 1 || idatIndexes.some((index, ordinal) => (
    ordinal > 0 && index !== idatIndexes[ordinal - 1] + 1
  ))) throw invalid();
  for (const { type } of chunks.slice(1, -1)) {
    const critical = (type.charCodeAt(0) & 0x20) === 0;
    if (critical && type !== 'IDAT') throw invalid();
  }
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const expectedLength = (stride + 1) * height;
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idatIndexes.map((index) => chunks[index].data)), {
      maxOutputLength: expectedLength,
    });
  } catch {
    throw invalid();
  }
  if (inflated.length !== expectedLength) throw invalid();
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    if (filter > 4) throw invalid();
    const rowOffset = y * stride;
    const priorOffset = rowOffset - stride;
    for (let index = 0; index < stride; index += 1) {
      const encoded = inflated[inputOffset + index];
      const left = index >= channels ? pixels[rowOffset + index - channels] : 0;
      const up = y > 0 ? pixels[priorOffset + index] : 0;
      const upperLeft = y > 0 && index >= channels
        ? pixels[priorOffset + index - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upperLeft);
      pixels[rowOffset + index] = (encoded + predictor) & 0xff;
    }
    inputOffset += stride;
  }
  return { bitDepth, channels, colorType, height, pixels, width };
}

export function inspectPngEvidence(value) {
  try {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const decoded = decodePixels(parseChunks(buffer));
    const counts = new Map();
    let minimum = Infinity;
    let maximum = -Infinity;
    let mean = 0;
    let sumSquaredDelta = 0;
    let samples = 0;
    for (let offset = 0; offset < decoded.pixels.length; offset += decoded.channels) {
      const red = decoded.pixels[offset];
      const green = decoded.pixels[offset + 1];
      const blue = decoded.pixels[offset + 2];
      const alpha = decoded.channels === 4 ? decoded.pixels[offset + 3] : 255;
      const key = `${red},${green},${blue},${alpha}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      minimum = Math.min(minimum, luminance);
      maximum = Math.max(maximum, luminance);
      samples += 1;
      const delta = luminance - mean;
      mean += delta / samples;
      sumSquaredDelta += delta * (luminance - mean);
    }
    const dominantCount = Math.max(...counts.values());
    const dominantRatio = dominantCount / samples;
    const result = Object.freeze({
      width: decoded.width,
      height: decoded.height,
      bitDepth: decoded.bitDepth,
      colorType: decoded.colorType,
      rawSha256: createHash('sha256').update(buffer).digest('hex'),
      pixelSha256: createHash('sha256').update(decoded.pixels).digest('hex'),
      colorCount: counts.size,
      luminanceSpan: maximum - minimum,
      luminanceVariance: sumSquaredDelta / samples,
      dominantRatio,
      nonDominantRatio: 1 - dominantRatio,
      byteLength: buffer.length,
    });
    if (result.colorCount < 64 || result.luminanceSpan < 32
      || result.nonDominantRatio < 0.02) throw invalid();
    return result;
  } catch (error) {
    if (error?.code === 'PNG_EVIDENCE_INVALID') throw error;
    throw invalid();
  }
}

export function validateUniqueScreenshots(value) {
  try {
    if (!Array.isArray(value) || value.length !== 4
      || new Set(value.map(({ id }) => id)).size !== 4) throw invalid();
    const results = value.map(({ id, bytes }) => Object.freeze({
      id,
      ...inspectPngEvidence(bytes),
    }));
    if (new Set(results.map(({ rawSha256 }) => rawSha256)).size !== 4
      || new Set(results.map(({ pixelSha256 }) => pixelSha256)).size !== 4) throw invalid();
    return Object.freeze(results);
  } catch (error) {
    if (error?.code === 'PNG_EVIDENCE_INVALID') throw error;
    throw invalid();
  }
}
