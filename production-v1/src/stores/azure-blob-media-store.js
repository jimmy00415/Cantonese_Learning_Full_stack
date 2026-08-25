import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';

const STORAGE_KEY = /^attempts\/(voice|tts)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

function mediaError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateStorageKey(storageKey) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) throw mediaError('INVALID_STORAGE_KEY');
  return storageKey;
}

function isNotFound(error) {
  return error?.statusCode === 404 || error?.code === 'BlobNotFound' || error?.details?.errorCode === 'BlobNotFound';
}

export class AzureBlobMediaStore {
  constructor({
    containerClient,
    containerName,
    connectionString,
    accountUrl,
    credential,
  } = {}) {
    if (!containerName || !CONTAINER.test(containerName)) throw new Error('AzureBlobMediaStore requires a valid private container name');
    this.containerName = containerName;
    if (containerClient) {
      this.containerClient = containerClient;
      return;
    }
    const connectionMode = Boolean(connectionString);
    const identityMode = Boolean(accountUrl && credential);
    if (connectionMode === identityMode) {
      throw new Error('Azure Blob requires exactly one explicit auth mode');
    }
    let serviceClient;
    if (connectionMode) {
      serviceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      let url;
      try { url = new URL(accountUrl); } catch { throw new Error('Azure Blob account URL must be valid HTTPS'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Azure Blob account URL must be valid HTTPS');
      }
      serviceClient = new BlobServiceClient(url.href, credential);
    }
    this.containerClient = serviceClient.getContainerClient(containerName);
  }

  async init() {
    try {
      await this.containerClient.getProperties();
      const access = await this.containerClient.getAccessPolicy();
      if (access?.blobPublicAccess || access?.publicAccess) throw mediaError('MEDIA_CONTAINER_NOT_PRIVATE');
    } catch (error) {
      if (error?.code === 'MEDIA_CONTAINER_NOT_PRIVATE') throw error;
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async close() {}

  createAttemptKey({ kind }) {
    if (!['voice', 'tts'].includes(kind)) throw mediaError('INVALID_STORAGE_KEY');
    return `attempts/${kind}/${randomUUID()}`;
  }

  async putAttempt({ storageKey, readable, maxBytes, signal, contentType }) {
    validateStorageKey(storageKey);
    if (typeof contentType !== 'string' || !contentType) throw new Error('contentType is required');
    const cap = Number(maxBytes);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('maxBytes must be a positive integer');
    if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
    const source = Buffer.isBuffer(readable) || readable instanceof Uint8Array ? [readable] : readable;
    if (!source?.[Symbol.asyncIterator] && !source?.[Symbol.iterator]) throw new Error('readable must be iterable');
    const hash = createHash('sha256');
    let byteLength = 0;
    const counted = async function* countedChunks() {
      for await (const value of source) {
        if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
        const chunk = Buffer.from(value);
        if (byteLength + chunk.length > cap) throw mediaError('VOICE_UPLOAD_TOO_LARGE');
        byteLength += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    };
    const client = this.containerClient.getBlockBlobClient(storageKey);
    try {
      await client.uploadStream(Readable.from(counted()), 256 * 1024, 2, {
        abortSignal: signal,
        blobHTTPHeaders: { blobContentType: contentType },
      });
      const sha256 = hash.digest('hex');
      await client.setMetadata({ sha256, byte_length: String(byteLength) }, { abortSignal: signal });
      return { storageKey, byteLength, sha256 };
    } catch (error) {
      await client.deleteIfExists({ abortSignal: signal }).catch(() => undefined);
      if (error?.code === 'VOICE_UPLOAD_TOO_LARGE' || error?.code === 'MEDIA_OPERATION_ABORTED') throw error;
      if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async open({ storageKey, start, end, signal } = {}) {
    validateStorageKey(storageKey);
    const client = this.containerClient.getBlockBlobClient(storageKey);
    try {
      const properties = await client.getProperties({ abortSignal: signal });
      const size = Number(properties.contentLength);
      const first = start === undefined ? 0 : Number(start);
      const last = end === undefined ? size - 1 : Number(end);
      if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)
        || first < 0 || last < first || last >= size) throw mediaError('INVALID_MEDIA_RANGE');
      const count = last - first + 1;
      const response = await client.download(first, count, { abortSignal: signal });
      if (!response.readableStreamBody) throw mediaError('MEDIA_UNAVAILABLE');
      return { readable: response.readableStreamBody, size, contentLength: count };
    } catch (error) {
      if (error?.code === 'INVALID_MEDIA_RANGE') throw error;
      if (isNotFound(error)) throw mediaError('MEDIA_NOT_FOUND');
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async delete({ storageKey, signal } = {}) {
    validateStorageKey(storageKey);
    try {
      const result = await this.containerClient.getBlockBlobClient(storageKey).deleteIfExists({ abortSignal: signal });
      return { deleted: Boolean(result.succeeded), notFound: !result.succeeded };
    } catch (error) {
      if (isNotFound(error)) return { deleted: false, notFound: true };
      throw mediaError('MEDIA_DELETE_FAILED', error);
    }
  }

  async listAttemptKeys({ prefix, before, limit = 100, cursor, signal } = {}) {
    if (!/^attempts\/(voice|tts)\/$/.test(prefix ?? '')) throw mediaError('INVALID_STORAGE_KEY');
    const beforeMs = new Date(before).getTime();
    if (!Number.isFinite(beforeMs)) throw new Error('before must be a valid instant');
    const maximum = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    const keys = [];
    try {
      for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
        if (signal?.aborted) throw mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
        if (!STORAGE_KEY.test(blob.name) || (cursor && blob.name <= cursor)) continue;
        const lastModified = blob.properties?.lastModified;
        if (lastModified && new Date(lastModified).getTime() < beforeMs) {
          keys.push({
            storageKey: blob.name,
            lastModified: new Date(lastModified).toISOString(),
            byteLength: Number(blob.properties?.contentLength) || 0,
            version: blob.properties?.etag ?? blob.versionId ?? null,
          });
        }
        if (keys.length >= maximum) break;
      }
      return { keys, cursor: keys.length === maximum ? keys.at(-1).storageKey : null };
    } catch (error) {
      if (error?.code === 'MEDIA_OPERATION_ABORTED') throw error;
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
  }

  async healthCheck() {
    await this.init();
    return { ok: true, driver: 'azure-blob', private: true };
  }
}
