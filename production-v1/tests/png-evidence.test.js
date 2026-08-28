import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { inspectPngEvidence, validateUniqueScreenshots } from '../scripts/png-evidence.js';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left : (upDistance <= upperLeftDistance ? up : upperLeft);
}

function png({ width = 390, height = 844, solid = false, filterOverride = null, seed = 0 } = {}) {
  const channels = 3;
  const stride = width * channels;
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const pixels = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      const offset = x * channels;
      pixels[offset] = solid ? 80 : (x * 17 + y * 3 + seed * 19) % 256;
      pixels[offset + 1] = solid ? 80 : (x * 5 + y * 11 + seed * 23) % 256;
      pixels[offset + 2] = solid ? 80 : (x * 13 + y * 7 + seed * 29) % 256;
    }
    const filter = filterOverride ?? y % 5;
    const encoded = Buffer.alloc(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? pixels[index - channels] : 0;
      const up = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : filter === 4 ? paeth(left, up, upperLeft) : 0;
      encoded[index] = (pixels[index] - predictor + 256) % 256;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), encoded]));
    previous = pixels;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG evidence decodes every filter and derives bounded visual hashes and diversity', () => {
  const bytes = png();
  const result = inspectPngEvidence(bytes);
  assert.equal(result.width, 390);
  assert.equal(result.height, 844);
  assert.equal(result.bitDepth, 8);
  assert.equal(result.colorType, 2);
  assert.equal(result.rawSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.match(result.pixelSha256, /^[0-9a-f]{64}$/);
  assert.ok(result.colorCount >= 64);
  assert.ok(result.luminanceSpan >= 32);
  assert.ok(result.luminanceVariance > 0);
  assert.ok(result.nonDominantRatio >= 0.02);
  assert.ok(result.dominantRatio <= 0.98);
});

test('PNG evidence rejects malformed structure, dimensions, low information, filters, and inflate overflow', () => {
  const valid = png();
  const ihdr = valid.subarray(8, 33);
  const idatStart = 33;
  const idatLength = valid.readUInt32BE(idatStart);
  const idat = valid.subarray(idatStart, idatStart + 12 + idatLength);
  const iend = valid.subarray(idatStart + 12 + idatLength);
  const duplicateIhdr = Buffer.concat([SIGNATURE, ihdr, ihdr, idat, iend]);
  const invalidIhdrData = Buffer.from(ihdr.subarray(8, 21));
  invalidIhdrData[8] = 16;
  const invalidIhdr = Buffer.concat([SIGNATURE, chunk('IHDR', invalidIhdrData), idat, iend]);
  const crcDrift = Buffer.from(valid);
  crcDrift[29] ^= 1;
  const invalidFilter = png({ filterOverride: 5 });
  const extraInflated = Buffer.concat([
    Buffer.alloc((390 * 3 + 1) * 845),
  ]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(390, 0);
  header.writeUInt32BE(844, 4);
  header[8] = 8;
  header[9] = 2;
  const overflow = Buffer.concat([
    SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(extraInflated)), chunk('IEND', Buffer.alloc(0)),
  ]);
  for (const [name, bytes] of [
    ['truncated', valid.subarray(0, valid.length - 1)],
    ['signature-only', SIGNATURE],
    ['crc-drift', crcDrift],
    ['invalid-ihdr', invalidIhdr],
    ['duplicate-ihdr', duplicateIhdr],
    ['wrong-dimensions-dpr2', png({ width: 780, height: 1688 })],
    ['solid', png({ solid: true })],
    ['idat-before-ihdr', Buffer.concat([SIGNATURE, idat, ihdr, iend])],
    ['trailing-bytes', Buffer.concat([valid, Buffer.from([0])])],
    ['invalid-filter', invalidFilter],
    ['inflate-overflow', overflow],
  ]) assert.throws(() => inspectPngEvidence(bytes), /PNG evidence is invalid/, name);
});

test('four screenshot evidence items must have unique encoded and decoded pixels', () => {
  const screenshots = [0, 1, 2, 3].map((index) => {
    const bytes = png();
    bytes[bytes.length - 1 - index] ^= index === 0 ? 0 : index;
    return { id: `shot-${index}`, bytes };
  });
  assert.throws(() => validateUniqueScreenshots(screenshots), /PNG evidence is invalid/);
  const unique = [0, 1, 2, 3].map((index) => ({
    id: `shot-${index}`,
    bytes: png({ filterOverride: index, seed: index }),
  }));
  assert.equal(validateUniqueScreenshots(unique).length, 4);
  assert.throws(() => validateUniqueScreenshots([unique[0], unique[1], unique[2], unique[0]]),
    /PNG evidence is invalid/);
});
