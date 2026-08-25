import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const STORAGE_KEY = /^(attempts)\/(voice|tts)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function mediaError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateKey(storageKey) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) {
    throw mediaError('INVALID_STORAGE_KEY');
  }
  return storageKey;
}

function abortError(signal) {
  if (!signal?.aborted) return null;
  return mediaError('MEDIA_OPERATION_ABORTED', signal.reason);
}

export class LocalMediaStore {
  constructor({ rootDirectory }) {
    if (!rootDirectory) throw new Error('LocalMediaStore requires rootDirectory');
    this.rootDirectory = resolve(rootDirectory);
  }

  async init() { await mkdir(this.rootDirectory, { recursive: true }); }
  async close() {}

  createAttemptKey({ kind }) {
    if (!['voice', 'tts'].includes(kind)) throw mediaError('INVALID_STORAGE_KEY');
    return `attempts/${kind}/${randomUUID()}`;
  }

  #path(storageKey) {
    validateKey(storageKey);
    const filePath = resolve(this.rootDirectory, ...storageKey.split('/'));
    if (!filePath.startsWith(`${this.rootDirectory}${sep}`)) throw mediaError('INVALID_STORAGE_KEY');
    return filePath;
  }

  async putAttempt({ storageKey, readable, maxBytes, signal }) {
    const filePath = this.#path(storageKey);
    const cap = Number(maxBytes);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('maxBytes must be a positive integer');
    const aborted = abortError(signal);
    if (aborted) throw aborted;
    await mkdir(resolve(filePath, '..'), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx');
    const hash = createHash('sha256');
    let byteLength = 0;
    try {
      const source = Buffer.isBuffer(readable) || readable instanceof Uint8Array ? [readable] : readable;
      if (!source?.[Symbol.asyncIterator] && !source?.[Symbol.iterator]) throw new Error('readable must be iterable');
      for await (const value of source) {
        const signalError = abortError(signal);
        if (signalError) throw signalError;
        const chunk = Buffer.from(value);
        if (byteLength + chunk.length > cap) throw mediaError('VOICE_UPLOAD_TOO_LARGE');
        await handle.write(chunk);
        hash.update(chunk);
        byteLength += chunk.length;
      }
      const signalError = abortError(signal);
      if (signalError) throw signalError;
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, filePath);
      return { storageKey, byteLength, sha256: hash.digest('hex') };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async open({ storageKey, start, end, signal } = {}) {
    const signalError = abortError(signal);
    if (signalError) throw signalError;
    const filePath = this.#path(storageKey);
    let details;
    try { details = await stat(filePath); } catch (error) {
      if (error?.code === 'ENOENT') throw mediaError('MEDIA_NOT_FOUND');
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
    const first = start === undefined ? 0 : Number(start);
    const last = end === undefined ? details.size - 1 : Number(end);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last >= details.size) {
      throw mediaError('INVALID_MEDIA_RANGE');
    }
    return {
      readable: createReadStream(filePath, { start: first, end: last, signal }),
      size: details.size,
      contentLength: last - first + 1,
    };
  }

  async delete({ storageKey, signal } = {}) {
    const signalError = abortError(signal);
    if (signalError) throw signalError;
    const filePath = this.#path(storageKey);
    try {
      await unlink(filePath);
      return { deleted: true, notFound: false };
    } catch (error) {
      if (error?.code === 'ENOENT') return { deleted: false, notFound: true };
      throw mediaError('MEDIA_DELETE_FAILED', error);
    }
  }

  async listAttemptKeys({ prefix, before, limit = 100, cursor, signal } = {}) {
    if (!/^attempts\/(voice|tts)\/$/.test(prefix ?? '')) throw mediaError('INVALID_STORAGE_KEY');
    const maximum = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    const beforeMs = new Date(before).getTime();
    if (!Number.isFinite(beforeMs)) throw new Error('before must be a valid instant');
    const directory = resolve(this.rootDirectory, ...prefix.split('/').filter(Boolean));
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === 'ENOENT') return { keys: [], cursor: null };
      throw mediaError('MEDIA_UNAVAILABLE', error);
    }
    const keys = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const signalError = abortError(signal);
      if (signalError) throw signalError;
      const storageKey = `${prefix}${entry.name}`;
      if (!entry.isFile() || (cursor && storageKey <= cursor) || !STORAGE_KEY.test(storageKey)) continue;
      const details = await stat(this.#path(storageKey), { bigint: true });
      const modifiedMs = Number(details.mtimeNs) / 1_000_000;
      if (modifiedMs < beforeMs) {
        keys.push({
          storageKey,
          lastModified: new Date(modifiedMs).toISOString(),
          byteLength: Number(details.size),
          version: `local:${details.dev}:${details.ino}:${details.birthtimeNs}:${details.ctimeNs}:${details.mtimeNs}`,
        });
      }
      if (keys.length >= maximum) break;
    }
    return { keys, cursor: keys.length === maximum ? keys.at(-1).storageKey : null };
  }

  async healthCheck() {
    await this.init();
    return { ok: true, driver: 'local' };
  }
}
