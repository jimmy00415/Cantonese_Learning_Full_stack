import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Storage } from '@google-cloud/storage';

const STORAGE_KEY = /^attempts\/(voice|tts)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = /^attempts\/(voice|tts)\/$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

function mediaError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateStorageKey(storageKey) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) {
    throw mediaError('INVALID_STORAGE_KEY');
  }
  return storageKey;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
}

function isNotFound(error) {
  return Number(error?.code) === 404 || Number(error?.statusCode) === 404
    || error?.errors?.some?.((entry) => entry?.reason === 'notFound');
}

async function boundedInput(readable, maximumBytes, signal) {
  const cap = Number(maximumBytes);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('maxBytes must be a positive integer');
  throwIfAborted(signal);
  const source = Buffer.isBuffer(readable) || readable instanceof Uint8Array ? [readable] : readable;
  if (!source?.[Symbol.asyncIterator] && !source?.[Symbol.iterator]) {
    throw new Error('readable must be iterable');
  }
  const chunks = [];
  let byteLength = 0;
  const hash = createHash('sha256');
  for await (const value of source) {
    throwIfAborted(signal);
    const chunk = Buffer.from(value);
    if (byteLength + chunk.length > cap) throw mediaError('VOICE_UPLOAD_TOO_LARGE');
    byteLength += chunk.length;
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (byteLength < 1) throw mediaError('MEDIA_UNAVAILABLE');
  return { bytes: Buffer.concat(chunks, byteLength), byteLength, sha256: hash.digest('hex') };
}

function boundedOutput(source, maximumBytes, signal) {
  let byteLength = 0;
  const bounded = new Transform({
    transform(value, encoding, callback) {
      void encoding;
      const chunk = Buffer.from(value);
      if (byteLength + chunk.length > maximumBytes) {
        source.destroy();
        callback(mediaError('MEDIA_UNAVAILABLE'));
        return;
      }
      byteLength += chunk.length;
      callback(null, chunk);
    },
  });
  const abort = () => {
    const error = mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
    source.destroy(error);
    bounded.destroy(error);
  };
  if (signal) signal.addEventListener('abort', abort, { once: true });
  source.once('error', (error) => {
    if (bounded.destroyed) return;
    bounded.destroy(signal?.aborted
      ? mediaError('MEDIA_OPERATION_ABORTED', signal.reason ?? error)
      : mediaError(isNotFound(error) ? 'MEDIA_NOT_FOUND' : 'MEDIA_UNAVAILABLE', error));
  });
  const cleanup = () => signal?.removeEventListener('abort', abort);
  bounded.once('close', cleanup);
  bounded.once('end', cleanup);
  source.pipe(bounded);
  return bounded;
}

export class GcsMediaStore {
  constructor({ projectId, bucketName, storage, bucket } = {}) {
    if (!PROJECT_ID.test(String(projectId ?? ''))) {
      throw new Error('GcsMediaStore requires a valid project ID');
    }
    if (!BUCKET_NAME.test(String(bucketName ?? ''))) {
      throw new Error('GcsMediaStore requires a valid private bucket name');
    }
    if (bucket && bucket.name && bucket.name !== bucketName) {
      throw new Error('GcsMediaStore bucket identity does not match');
    }
    this.projectId = projectId;
    this.bucketName = bucketName;
    this.storage = storage ?? (bucket ? null : new Storage({ projectId }));
    this.bucket = bucket ?? this.storage.bucket(bucketName);
  }

  async init({ signal } = {}) {
    try {
      throwIfAborted(signal);
      const [metadata] = await this.bucket.getMetadata();
      throwIfAborted(signal);
      const iam = metadata?.iamConfiguration;
      if (metadata?.name !== this.bucketName
        || iam?.uniformBucketLevelAccess?.enabled !== true
        || iam?.publicAccessPrevention !== 'enforced') {
        throw mediaError('MEDIA_CONTAINER_NOT_PRIVATE');
      }
    } catch (error) {
      if (['MEDIA_CONTAINER_NOT_PRIVATE', 'MEDIA_OPERATION_ABORTED'].includes(error?.code)) throw error;
      if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason ?? error);
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async close() {}

  createAttemptKey({ kind }) {
    if (!['voice', 'tts'].includes(kind)) throw mediaError('INVALID_STORAGE_KEY');
    return `attempts/${kind}/${randomUUID()}`;
  }

  async putAttempt({ storageKey, readable, maxBytes, signal, contentType } = {}) {
    validateStorageKey(storageKey);
    if (typeof contentType !== 'string' || !contentType) throw new Error('contentType is required');
    const input = await boundedInput(readable, maxBytes, signal);
    const destination = this.bucket.file(storageKey).createWriteStream({
      resumable: false,
      validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType,
        cacheControl: 'private, no-store',
        metadata: { sha256: input.sha256, byte_length: String(input.byteLength) },
      },
    });
    try {
      if (signal) await pipeline(Readable.from([input.bytes]), destination, { signal });
      else await pipeline(Readable.from([input.bytes]), destination);
      throwIfAborted(signal);
      return { storageKey, byteLength: input.byteLength, sha256: input.sha256 };
    } catch (error) {
      if (error?.code === 'VOICE_UPLOAD_TOO_LARGE' || error?.code === 'MEDIA_OPERATION_ABORTED') throw error;
      if (signal?.aborted || error?.name === 'AbortError') {
        throw mediaError('MEDIA_OPERATION_ABORTED', signal?.reason ?? error);
      }
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async open({ storageKey, start, end, signal } = {}) {
    validateStorageKey(storageKey);
    throwIfAborted(signal);
    const file = this.bucket.file(storageKey);
    try {
      const [metadata] = await file.getMetadata();
      throwIfAborted(signal);
      const size = Number(metadata?.size);
      const first = start === undefined ? 0 : Number(start);
      const last = end === undefined ? size - 1 : Number(end);
      if (!Number.isSafeInteger(size) || size < 1
        || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)
        || first < 0 || last < first || last >= size) {
        throw mediaError('INVALID_MEDIA_RANGE');
      }
      const contentLength = last - first + 1;
      const source = file.createReadStream({ start: first, end: last, validation: false });
      return {
        readable: boundedOutput(source, contentLength, signal),
        size,
        contentLength,
      };
    } catch (error) {
      if (['INVALID_MEDIA_RANGE', 'MEDIA_OPERATION_ABORTED'].includes(error?.code)) throw error;
      if (isNotFound(error)) throw mediaError('MEDIA_NOT_FOUND');
      if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason ?? error);
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async delete({ storageKey, signal } = {}) {
    validateStorageKey(storageKey);
    throwIfAborted(signal);
    try {
      await this.bucket.file(storageKey).delete();
      throwIfAborted(signal);
      return { deleted: true, notFound: false };
    } catch (error) {
      if (isNotFound(error)) return { deleted: false, notFound: true };
      if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason ?? error);
      throw mediaError('MEDIA_DELETE_FAILED', error);
    }
  }

  async listAttemptKeys({ prefix, before, limit = 100, cursor, signal } = {}) {
    if (!PREFIX.test(prefix ?? '')) throw mediaError('INVALID_STORAGE_KEY');
    throwIfAborted(signal);
    const beforeMs = new Date(before).getTime();
    if (!Number.isFinite(beforeMs)) throw new Error('before must be a valid instant');
    const maximum = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    if (cursor !== undefined && cursor !== null
      && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 4_096
        || /[\u0000-\u001f\u007f]/.test(cursor))) {
      throw new Error('cursor must be an opaque GCS page token');
    }
    const options = { prefix, maxResults: maximum, autoPaginate: false };
    if (cursor) options.pageToken = cursor;
    try {
      const [files, nextQuery, apiResponse] = await this.bucket.getFiles(options);
      throwIfAborted(signal);
      const keys = [];
      for (const file of files) {
        throwIfAborted(signal);
        const metadata = file?.metadata ?? {};
        const lastModifiedMs = new Date(metadata.updated).getTime();
        if (!STORAGE_KEY.test(file?.name ?? '') || !Number.isFinite(lastModifiedMs)
          || lastModifiedMs >= beforeMs) continue;
        keys.push({
          storageKey: file.name,
          lastModified: new Date(lastModifiedMs).toISOString(),
          byteLength: Number(metadata.size) || 0,
          version: metadata.generation ?? metadata.etag ?? null,
        });
      }
      return { keys, cursor: nextQuery?.pageToken ?? apiResponse?.nextPageToken ?? null };
    } catch (error) {
      if (error?.code === 'MEDIA_OPERATION_ABORTED') throw error;
      if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason ?? error);
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async healthCheck({ signal } = {}) {
    await this.init({ signal });
    return { ok: true, driver: 'gcs', private: true };
  }
}
