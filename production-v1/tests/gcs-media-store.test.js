import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { GcsMediaStore } from '../src/stores/gcs-media-store.js';

const PROJECT_ID = 'motion-expert-hk-ltd-webpage';
const BUCKET_NAME = 'hkbuddy-v1-582852715831-media';

async function readableBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function providerError(code, message = 'private provider detail') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createFakeBucket({
  metadata = {
    name: BUCKET_NAME,
    location: 'ASIA-EAST2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: 'enforced',
    },
  },
} = {}) {
  const objects = new Map();
  const calls = { writes: [], reads: [], deletes: [], lists: [], metadata: 0 };
  let generation = 0;
  const bucket = {
    name: BUCKET_NAME,
    async getMetadata(options) {
      calls.metadata += 1;
      calls.metadataOptions = options;
      return [metadata];
    },
    file(storageKey) {
      return {
        name: storageKey,
        createWriteStream(options) {
          const chunks = [];
          calls.writes.push({ storageKey, chunks, options });
          return new Writable({
            write(chunk, encoding, callback) {
              void encoding;
              chunks.push(Buffer.from(chunk));
              callback();
            },
            final(callback) {
              if (objects.has(storageKey) && options?.preconditionOpts?.ifGenerationMatch === 0) {
                callback(providerError(412));
                return;
              }
              generation += 1;
              const bytes = Buffer.concat(chunks);
              objects.set(storageKey, {
                bytes,
                metadata: {
                  size: String(bytes.length),
                  updated: '2026-08-24T00:00:00.000Z',
                  generation: String(generation),
                  etag: `etag-${generation}`,
                  ...options.metadata,
                },
              });
              callback();
            },
          });
        },
        async getMetadata(options) {
          calls.readMetadataOptions = options;
          const object = objects.get(storageKey);
          if (!object) throw providerError(404);
          return [object.metadata];
        },
        createReadStream(options) {
          calls.reads.push({ storageKey, options });
          const object = objects.get(storageKey);
          if (!object) return Readable.from((async function* missing() { throw providerError(404); }()));
          return Readable.from([object.ignoreRange
            ? object.bytes
            : object.bytes.subarray(options.start, options.end + 1)]);
        },
        async delete(options) {
          calls.deletes.push({ storageKey, options });
          if (!objects.delete(storageKey)) throw providerError(404);
          return [{}];
        },
      };
    },
    async getFiles(options) {
      calls.lists.push(options);
      const all = [...objects.entries()]
        .filter(([name]) => name.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const offset = options.pageToken ? Number(options.pageToken.slice('page-'.length)) : 0;
      const selected = all.slice(offset, offset + options.maxResults).map(([name, value]) => ({
        name,
        metadata: value.metadata,
      }));
      const nextOffset = offset + selected.length;
      const nextQuery = nextOffset < all.length ? { pageToken: `page-${nextOffset}` } : null;
      return [selected, nextQuery, { nextPageToken: nextQuery?.pageToken }];
    },
  };
  return { bucket, calls, objects };
}

test('private GCS media lifecycle keeps opaque keys, conditional writes, bounded ranges, and no URL', async () => {
  const { bucket, calls } = createFakeBucket();
  const store = new GcsMediaStore({ projectId: PROJECT_ID, bucketName: BUCKET_NAME, bucket });
  await store.init();

  const storageKey = store.createAttemptKey({ kind: 'tts' });
  assert.match(storageKey, /^attempts\/tts\/[0-9a-f-]{36}$/);
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
  const stored = await store.putAttempt({
    storageKey,
    readable: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
    maxBytes: 10,
    contentType: 'audio/mpeg',
  });

  assert.equal(stored.byteLength, 4);
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls.writes[0].options, {
    resumable: false,
    validation: 'crc32c',
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: 'audio/mpeg',
      cacheControl: 'private, no-store',
      metadata: { sha256: stored.sha256, byte_length: '4' },
    },
  });
  assert.equal(Object.hasOwn(stored, 'url'), false);

  const opened = await store.open({ storageKey, start: 1, end: 2 });
  assert.equal(opened.size, 4);
  assert.equal(opened.contentLength, 2);
  assert.equal(Object.hasOwn(opened, 'url'), false);
  assert.deepEqual(await readableBuffer(opened.readable), bytes.subarray(1, 3));
  assert.deepEqual(calls.reads[0].options, { start: 1, end: 2, validation: false });

  await assert.rejects(store.putAttempt({
    storageKey, readable: Readable.from([bytes]), maxBytes: 10, contentType: 'audio/mpeg',
  }), { code: 'MEDIA_UNAVAILABLE' });
  assert.deepEqual(await store.delete({ storageKey }), { deleted: true, notFound: false });
  assert.deepEqual(await store.delete({ storageKey }), { deleted: false, notFound: true });
  assert.equal((await store.healthCheck()).driver, 'gcs');
});

test('GCS upload and download caps fail before unbounded bytes escape', async () => {
  const { bucket, calls, objects } = createFakeBucket();
  const store = new GcsMediaStore({ projectId: PROJECT_ID, bucketName: BUCKET_NAME, bucket });
  const storageKey = 'attempts/voice/11111111-1111-4111-8111-111111111111';

  await assert.rejects(store.putAttempt({
    storageKey,
    readable: Readable.from([Buffer.alloc(5), Buffer.alloc(6)]),
    maxBytes: 10,
    contentType: 'audio/wav',
  }), { code: 'VOICE_UPLOAD_TOO_LARGE' });
  assert.equal(calls.writes.length, 0, 'oversized input never reaches GCS');

  objects.set(storageKey, {
    bytes: Buffer.from('0123456789'),
    metadata: { size: '4', updated: '2026-08-24T00:00:00.000Z', generation: '7' },
    ignoreRange: true,
  });
  const opened = await store.open({ storageKey });
  await assert.rejects(readableBuffer(opened.readable), { code: 'MEDIA_UNAVAILABLE' });
  await assert.rejects(store.open({ storageKey, start: 0, end: 4 }), { code: 'INVALID_MEDIA_RANGE' });
});

test('GCS private controls and provider failures normalize without credential or body detail', async () => {
  for (const metadata of [
    { name: BUCKET_NAME, iamConfiguration: { publicAccessPrevention: 'enforced' } },
    { name: BUCKET_NAME, iamConfiguration: { uniformBucketLevelAccess: { enabled: true } } },
    { name: BUCKET_NAME, iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'inherited' } },
  ]) {
    const { bucket } = createFakeBucket({ metadata });
    const store = new GcsMediaStore({ projectId: PROJECT_ID, bucketName: BUCKET_NAME, bucket });
    await assert.rejects(store.init(), { code: 'MEDIA_CONTAINER_NOT_PRIVATE' });
  }

  const { bucket } = createFakeBucket();
  bucket.getMetadata = async () => { throw providerError(403, 'Authorization Bearer private-token raw-body'); };
  const store = new GcsMediaStore({ projectId: PROJECT_ID, bucketName: BUCKET_NAME, bucket });
  await assert.rejects(store.init(), (error) => (
    error.code === 'MEDIA_UNAVAILABLE'
      && error.message === 'MEDIA_UNAVAILABLE'
      && !JSON.stringify(error).includes('private-token')
      && !error.stack.includes('raw-body')
  ));
});

test('GCS attempt listing uses provider page tokens and returns only old valid opaque keys', async () => {
  const { bucket, calls, objects } = createFakeBucket();
  const store = new GcsMediaStore({ projectId: PROJECT_ID, bucketName: BUCKET_NAME, bucket });
  for (const [name, updated] of [
    ['attempts/voice/11111111-1111-4111-8111-111111111111', '2026-08-24T00:00:00.000Z'],
    ['attempts/voice/22222222-2222-4222-8222-222222222222', '2026-08-24T01:00:00.000Z'],
    ['attempts/voice/not-opaque', '2026-08-24T00:00:00.000Z'],
    ['attempts/tts/33333333-3333-4333-8333-333333333333', '2026-08-24T00:00:00.000Z'],
  ]) objects.set(name, { bytes: Buffer.from(name), metadata: { size: '7', updated, generation: name.at(-1) } });

  const first = await store.listAttemptKeys({
    prefix: 'attempts/voice/', before: '2026-08-25T00:00:00.000Z', limit: 1,
  });
  assert.deepEqual(first.keys.map((entry) => entry.storageKey), [
    'attempts/voice/11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(first.cursor, 'page-1');
  assert.deepEqual(calls.lists[0], {
    prefix: 'attempts/voice/', maxResults: 1, autoPaginate: false,
  });
  const second = await store.listAttemptKeys({
    prefix: 'attempts/voice/', before: '2026-08-25T00:00:00.000Z', limit: 2, cursor: first.cursor,
  });
  assert.deepEqual(second.keys.map((entry) => entry.storageKey), [
    'attempts/voice/22222222-2222-4222-8222-222222222222',
  ]);
  assert.equal(second.cursor, null);
  assert.equal(calls.lists[1].pageToken, 'page-1');
});
