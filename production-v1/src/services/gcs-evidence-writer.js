import { createHash } from 'node:crypto';

import { GCP_IDENTITY } from '../gcp-identity.js';
import { createGoogleAccessTokenProvider } from '../providers/google-auth.js';

const BUCKET = GCP_IDENTITY.bucket;
const OBJECT_NAME = /^release-evidence\/[0-9a-f]{40}\/(?:llm-smoke|voice-smoke)\/[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

async function boundedText(response, maximumBytes = 16 * 1024) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('GCS evidence response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

export async function writeImmutableGcsEvidence({
  bucket,
  objectName,
  record,
  googleAuthProvider: suppliedGoogleAuthProvider,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (bucket !== BUCKET || !OBJECT_NAME.test(String(objectName ?? ''))
    || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('GCS evidence target is invalid');
  }
  const body = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(body, 'utf8') > 128 * 1024) throw new Error('GCS evidence artifact is too large');
  const googleAuthProvider = suppliedGoogleAuthProvider
    ?? createGoogleAccessTokenProvider({ fetchImpl });
  if (typeof googleAuthProvider?.fetch !== 'function') throw new Error('GCS evidence ADC is unavailable');
  const query = new URLSearchParams({
    uploadType: 'media', name: objectName, ifGenerationMatch: '0',
  });
  let response;
  try {
    response = await googleAuthProvider.fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      },
    );
  } catch { throw new Error('GCS evidence upload failed'); }
  const text = await boundedText(response);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('GCS evidence receipt is invalid'); }
  if (!response.ok || payload?.bucket !== bucket || payload?.name !== objectName
    || !/^\d+$/.test(String(payload?.generation ?? ''))) {
    throw new Error('GCS evidence receipt is invalid');
  }
  return Object.freeze({
    evidenceBucket: bucket,
    evidenceObject: objectName,
    evidenceGeneration: String(payload.generation),
    evidenceObjectSha256: createHash('sha256').update(body).digest('hex'),
  });
}
