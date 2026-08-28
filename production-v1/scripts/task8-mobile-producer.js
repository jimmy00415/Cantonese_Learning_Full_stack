import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';
import { validateUniqueScreenshots } from './png-evidence.js';
import { validateCanonicalWav } from '../src/media/canonical-wav.js';

export const MOBILE_CHECK_IDS = Object.freeze([
  'first-visit', 'response-language-mode-change', 'text-send', 'editable-voice-transcript',
  'assistant-audio-ready-no-autoplay', 'verified-official-source',
  'unsupported-honest-handoff', 'retry-reload-retention', 'consent',
  'clear-conversation', 'keyboard-focus', 'bottom-safe-area', 'no-horizontal-overflow',
]);
export const MOBILE_SCREENSHOT_IDS = Object.freeze([
  'first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area',
]);
export const MOBILE_BROWSER_CONTRACT = Object.freeze({
  engine: 'chromium',
  playwrightVersion: '1.62.1',
  revision: '1234',
  browserVersion: '151.0.7922.34',
  pinned: true,
  realIosSafari: false,
});
export const MOBILE_WAV_CONTRACT = Object.freeze({
  sha256: 'ef989be190f7e9cef40b80516209d972eb08910263ddee3a44f52fdf84e534a7',
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  durationMs: 1_000,
  mimeType: 'audio/wav',
});
const FIXTURE_PATH = fileURLToPath(new URL('../tests/fixtures/mobile-voice-en.wav', import.meta.url));
const DIGEST = /^[0-9a-f]{64}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const browserOwnedFlows = new WeakSet();

function fail() {
  const error = new Error('Controlled mobile evidence is invalid');
  error.code = 'MOBILE_CONTROLLED_EVIDENCE_INVALID';
  throw error;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  // Binary publication payloads are immutable by ownership, not by
  // Object.freeze(): Node rejects freezing non-empty typed-array views.
  if (ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export async function loadPinnedBrowserContract() {
  const packageJson = JSON.parse(await readFile(new URL('../node_modules/playwright/package.json', import.meta.url)));
  const browsers = JSON.parse(await readFile(new URL('../node_modules/playwright-core/browsers.json', import.meta.url)));
  const pinned = browsers.browsers.find(({ name }) => name === 'chromium');
  const actual = {
    engine: 'chromium',
    playwrightVersion: packageJson.version,
    revision: pinned?.revision,
    browserVersion: pinned?.browserVersion,
    pinned: true,
    realIosSafari: false,
  };
  if (JSON.stringify(actual) !== JSON.stringify(MOBILE_BROWSER_CONTRACT)) fail();
  return deepFreeze(actual);
}

export function finalizeTask8MobileRecord(record) {
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return deepFreeze({ ...payload, artifactSha256: canonicalSha256(payload) });
}

function assertPrivacyReference(value, boundarySha256) {
  const observed = Date.parse(value?.observedAt);
  const expires = Date.parse(value?.expiresAt);
  if (!exactKeys(value, [
    'artifactSha256', 'boundarySha256', 'expiresAt', 'filePath', 'objectSha256',
    'observedAt', 'schemaVersion',
  ]) || value.schemaVersion !== 3 || !DIGEST.test(value.artifactSha256)
    || !DIGEST.test(value.objectSha256) || value.boundarySha256 !== boundarySha256
    || !Number.isFinite(observed) || expires - observed !== MAX_EVIDENCE_AGE_MS) fail();
  return value;
}

export function validateTask8MobileRecord(record, {
  binding,
  sourceArchiveSha256,
  boundarySha256,
  candidateAccess,
  now = new Date(),
} = {}) {
  try {
    const current = new Date(now).getTime();
    const occurredAt = Date.parse(record?.occurredAt);
    const expiresAt = Date.parse(record?.expiresAt);
    if (!RELEASE_SHA.test(binding?.releaseSha) || !IMAGE_DIGEST.test(binding?.imageDigest)
      || !DIGEST.test(sourceArchiveSha256) || !DIGEST.test(boundarySha256)
      || !exactKeys(record, [
        'access', 'artifactSha256', 'browser', 'candidateOrigin', 'candidateRevision',
        'candidateService', 'candidateTag', 'checks', 'commitSha', 'controlPlane',
        'expiresAt', 'finalNavigationUrl', 'fixture', 'gate', 'imageDigest', 'network',
        'occurredAt', 'privacyProofs', 'result', 'schemaVersion', 'screenshots',
        'sourceArchiveSha256', 'stableService', 'stableTrafficState', 'trafficPercent',
        'trafficState', 'viewport',
      ]) || record.schemaVersion !== 3 || record.gate !== 'mobile' || record.result !== 'pass'
      || record.commitSha !== binding.releaseSha || record.sourceArchiveSha256 !== sourceArchiveSha256
      || record.imageDigest !== binding.imageDigest || record.candidateService !== binding.candidateService
      || record.candidateRevision !== binding.candidateRevision || record.candidateTag !== binding.candidateTag
      || record.candidateOrigin !== binding.candidateOrigin
      || !exactKeys(candidateAccess, [
        'authenticated', 'audience', 'issuer', 'subjectSha256', 'taggedUrl',
      ]) || !exactKeys(record.access, Object.keys(candidateAccess))
      || JSON.stringify(record.access) !== JSON.stringify(candidateAccess)
      || record.finalNavigationUrl !== binding.candidateOrigin
      || record.trafficPercent !== 100 || record.trafficState !== 'candidate-service-private-100'
      || !['stable-absent', 'stable-prior-100'].includes(record.stableTrafficState)
      || !Number.isFinite(current) || current < occurredAt - 30_000 || current >= expiresAt
      || JSON.stringify(record.browser) !== JSON.stringify(MOBILE_BROWSER_CONTRACT)
      || JSON.stringify(record.fixture) !== JSON.stringify(MOBILE_WAV_CONTRACT)
      || JSON.stringify(record.viewport) !== JSON.stringify({
        width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      }) || !exactKeys(record.privacyProofs, ['end', 'start'])) fail();
    const start = assertPrivacyReference(record.privacyProofs.start, boundarySha256);
    const end = assertPrivacyReference(record.privacyProofs.end, boundarySha256);
    if (record.occurredAt !== start.observedAt
      || record.expiresAt !== (Date.parse(start.expiresAt) <= Date.parse(end.expiresAt)
        ? start.expiresAt : end.expiresAt)
      || Date.parse(end.observedAt) <= Date.parse(start.observedAt)
      || !Array.isArray(record.checks) || record.checks.length !== MOBILE_CHECK_IDS.length
      || record.checks.some((check, index) => !exactKeys(check, ['derived', 'id'])
        || check.id !== MOBILE_CHECK_IDS[index] || check.derived !== true)
      || !Array.isArray(record.screenshots) || record.screenshots.length !== 4
      || record.screenshots.some((shot, index) => !exactKeys(shot, [
        'byteLength', 'colorCount', 'dominantRatio', 'filePath', 'height', 'id',
        'luminanceSpan', 'luminanceVariance', 'nonDominantRatio', 'pixelSha256',
        'rawSha256', 'width',
      ]) || shot.id !== MOBILE_SCREENSHOT_IDS[index]
        || typeof shot.filePath !== 'string' || shot.filePath.length < 1
        || shot.width !== 390 || shot.height !== 844 || !DIGEST.test(shot.rawSha256)
        || !DIGEST.test(shot.pixelSha256) || !Number.isSafeInteger(shot.byteLength)
        || shot.byteLength < 128 || shot.byteLength > 4 * 1024 * 1024
        || !Number.isSafeInteger(shot.colorCount)
        || shot.colorCount < 64 || !Number.isFinite(shot.luminanceSpan)
        || shot.luminanceSpan < 32 || !Number.isFinite(shot.luminanceVariance)
        || shot.luminanceVariance <= 0 || !Number.isFinite(shot.dominantRatio)
        || !Number.isFinite(shot.nonDominantRatio) || shot.nonDominantRatio < 0.02
        || Math.abs(shot.dominantRatio + shot.nonDominantRatio - 1) > 1e-9)
      || new Set(record.screenshots.map(({ rawSha256 }) => rawSha256)).size !== 4
      || new Set(record.screenshots.map(({ pixelSha256 }) => pixelSha256)).size !== 4
      || !exactKeys(record.controlPlane, ['afterSha256', 'beforeSha256', 'stable'])
      || record.controlPlane.stable !== true
      || record.controlPlane.beforeSha256 !== record.controlPlane.afterSha256
      || !exactKeys(record.network, ['eventCount', 'traceSha256'])
      || !Number.isSafeInteger(record.network.eventCount) || record.network.eventCount < 1
      || !DIGEST.test(record.network.traceSha256)
      || containsForbiddenPersistedSecret(record)
      || JSON.stringify(finalizeTask8MobileRecord(record)) !== JSON.stringify(record)) fail();
    return true;
  } catch {
    fail();
  }
}

function exactCandidateOrigin(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) fail();
    return parsed.origin;
  } catch {
    fail();
  }
}

function parseJsonBody(value) {
  if (typeof value !== 'string' || value.length > 128 * 1024) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function canonicalEventSourceUrl(url, candidateOrigin) {
  if (url.origin !== candidateOrigin || url.pathname !== '/api/v1/events' || url.hash) return false;
  if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has('afterCursor')) return false;
  const cursor = url.searchParams.get('afterCursor');
  return /^(?:0|[1-9][0-9]*)$/.test(cursor) && Number.isSafeInteger(Number(cursor));
}

export async function runPinnedPlaywrightFlow({
  candidateOrigin, authorization, context, fixturePath, testProbeOnly = false,
}) {
  if (typeof authorization !== 'string' || authorization.length < 1 || authorization.length > 16_384) fail();
  const trustedOrigin = exactCandidateOrigin(candidateOrigin);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fixturePath}`,
    ],
  });
  const failures = [];
  const network = [];
  const started = new Map();
  const responseTasks = [];
  const mediaLifecycle = [];
  const messageRequests = [];
  const uploadRequests = [];
  const uploadResponses = [];
  const audioRequests = [];
  const audioResponses = [];
  const expectedFailedRequests = new WeakSet();
  let primaryPage = null;
  let abortNextMessage = false;
  try {
    if (browser.version() !== MOBILE_BROWSER_CONTRACT.browserVersion) fail();
    const browserContext = await browser.newContext(context);
    const instrumentationToken = createHash('sha256')
      .update(`${Date.now()}:${Math.random()}:${authorization.length}`)
      .digest('hex');
    await browserContext.exposeBinding('__hkbuddyRecordMediaLifecycle', ({ page }, token, event, details = {}) => {
      if (page !== primaryPage || token !== instrumentationToken
        || !['getUserMedia.request', 'getUserMedia.resolved', 'MediaRecorder.construct',
          'MediaRecorder.start', 'MediaRecorder.dataavailable', 'MediaRecorder.stop'].includes(event)) return;
      mediaLifecycle.push({
        event,
        size: Number.isSafeInteger(details?.size) && details.size >= 0 ? details.size : null,
        type: typeof details?.type === 'string' ? details.type.slice(0, 64) : null,
      });
    });
    await browserContext.addInitScript(({ token }) => {
      const report = (event, details = {}) => {
        try { void globalThis.__hkbuddyRecordMediaLifecycle(token, event, details); } catch { /* browser teardown */ }
      };
      const mediaDevices = navigator.mediaDevices;
      const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
      if (originalGetUserMedia) {
        Object.defineProperty(mediaDevices, 'getUserMedia', {
          configurable: false,
          value: async (...args) => {
            report('getUserMedia.request');
            const stream = await originalGetUserMedia(...args);
            report('getUserMedia.resolved');
            return stream;
          },
        });
      }
      const OriginalMediaRecorder = globalThis.MediaRecorder;
      if (OriginalMediaRecorder) {
        Object.defineProperty(globalThis, 'MediaRecorder', {
          configurable: false,
          value: new Proxy(OriginalMediaRecorder, {
            construct(target, args, newTarget) {
              const recorder = Reflect.construct(target, args, newTarget);
              report('MediaRecorder.construct', { type: recorder.mimeType });
              recorder.addEventListener('start', () => report('MediaRecorder.start', { type: recorder.mimeType }));
              recorder.addEventListener('dataavailable', (event) => report('MediaRecorder.dataavailable', {
                size: event.data?.size ?? null, type: event.data?.type ?? null,
              }));
              recorder.addEventListener('stop', () => report('MediaRecorder.stop', { type: recorder.mimeType }));
              return recorder;
            },
          }),
        });
      }
    }, { token: instrumentationToken });
    browserContext.on('serviceworker', (worker) => {
      failures.push('serviceworker');
      void worker.evaluate?.(() => self.close?.()).catch?.(() => undefined);
    });
    browserContext.on('page', (page) => {
      if (primaryPage === null) {
        primaryPage = page;
        return;
      }
      if (page !== primaryPage) {
        failures.push('child-page');
        void page.close().catch(() => undefined);
      }
    });
    await browserContext.routeWebSocket('**/*', (socket) => {
      failures.push('websocket');
      socket.close({ code: 1008, reason: 'Blocked by mobile evidence privacy fence' });
    });
    await browserContext.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isEventSource = request.resourceType() === 'eventsource';
      if (url.origin !== trustedOrigin || request.redirectedFrom()
        || (isEventSource && !canonicalEventSourceUrl(url, trustedOrigin))) {
        failures.push(isEventSource ? 'eventsource-request' : 'external-request');
        await route.abort('blockedbyclient');
        return;
      }
      if (abortNextMessage && request.method() === 'POST' && url.pathname === '/api/v1/messages') {
        abortNextMessage = false;
        expectedFailedRequests.add(request);
        await route.abort('failed');
        return;
      }
      await route.continue({ headers: { ...request.headers(), authorization } });
    });
    const page = await browserContext.newPage();
    page.on('pageerror', () => failures.push('pageerror'));
    page.on('worker', (worker) => {
      failures.push('worker');
      void worker.evaluate?.(() => self.close?.()).catch?.(() => undefined);
    });
    page.on('download', () => failures.push('download'));
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      const expectedStreamClose = request.resourceType() === 'eventsource'
        && canonicalEventSourceUrl(url, trustedOrigin);
      if (!expectedFailedRequests.has(request) && !expectedStreamClose) failures.push(`requestfailed:${url.pathname}`);
    });
    page.on('request', (request) => {
      started.set(request, Date.now());
      const url = new URL(request.url());
      if (url.origin !== trustedOrigin) return;
      if (url.pathname === '/api/v1/messages' && request.method() === 'POST') {
        const body = parseJsonBody(request.postData());
        messageRequests.push({ body, request });
      }
      if (url.pathname === '/api/v1/voice/transcriptions' && request.method() === 'POST') {
        const bytes = request.postDataBuffer();
        const headers = request.headers();
        uploadRequests.push({
          clientUploadId: headers['x-client-upload-id'] ?? null,
          claimedSha256: headers['x-content-sha256'] ?? null,
          contentSha256: bytes ? sha256(bytes) : null,
          language: headers['x-asr-language'] ?? null,
          byteLength: bytes?.length ?? null,
          request,
        });
      }
      if ((/^\/api\/v1\/messages\/[^/]+\/audio(?:\/status)?$/.test(url.pathname)
        || /^\/api\/v1\/media\/[^/]+$/.test(url.pathname))) {
        audioRequests.push({ path: url.pathname, method: request.method(), request });
      }
    });
    page.on('response', (response) => {
      const request = response.request();
      const url = new URL(response.url());
      const status = response.status();
      const method = request.method();
      const resourceType = request.resourceType();
      const isEventSource = resourceType === 'eventsource';
      const expectedMissingVoiceProbe = method === 'GET' && status === 404
        && /^\/api\/v1\/voice\/uploads\/[0-9a-f-]{36}$/i.test(url.pathname);
      const allowedStatus = (status >= 200 && status < 300) || expectedMissingVoiceProbe;
      if (url.origin !== trustedOrigin || request.redirectedFrom() || !allowedStatus
        || !['GET', 'POST', 'DELETE'].includes(method)
        || !['document', 'stylesheet', 'script', 'image', 'font', 'fetch', 'xhr', 'eventsource', 'media'].includes(resourceType)
        || (isEventSource && (!canonicalEventSourceUrl(url, trustedOrigin)
          || status !== 200 || !/^text\/event-stream(?:;|$)/i.test(response.headers()['content-type'] ?? '')))) {
        failures.push(`network-response:${method}:${url.pathname}:${status}:${resourceType}`);
      }
      network.push({
        path: url.pathname,
        method,
        resourceType,
        status,
        durationMs: Math.max(0, Date.now() - (started.get(request) ?? Date.now())),
      });
      if (!isEventSource && (
        url.pathname === '/api/v1/voice/transcriptions'
        || /^\/api\/v1\/voice\/uploads\/[^/]+$/.test(url.pathname)
        || /^\/api\/v1\/messages\/[^/]+\/audio(?:\/status)?$/.test(url.pathname)
      )) {
        responseTasks.push((async () => {
          const body = parseJsonBody(await response.text().catch(() => ''));
          if (url.pathname === '/api/v1/voice/transcriptions'
            || /^\/api\/v1\/voice\/uploads\/[^/]+$/.test(url.pathname)) {
            uploadResponses.push({
              path: url.pathname,
              method,
              status,
              location: response.headers().location ?? null,
              retryAfter: response.headers()['retry-after'] ?? null,
              data: body?.data ?? null,
            });
          } else {
            audioResponses.push({ path: url.pathname, method, status, data: body?.data ?? null });
          }
        })().catch(() => failures.push('response-observation')));
      }
    });
    await page.goto(trustedOrigin, { waitUntil: 'domcontentloaded' });
    await page.locator('.chat-shell[data-app-state="ready"]').waitFor({ state: 'visible' });
    if (testProbeOnly === true) {
      await page.waitForTimeout(250);
      if (failures.length > 0) fail();
      const finalNavigationUrl = new URL(page.url()).origin;
      await browserContext.close();
      return { browser: await loadPinnedBrowserContract(), finalNavigationUrl };
    }
    const screenshots = [];
    screenshots.push({ id: 'first-visit', bytes: await page.screenshot({ type: 'png' }) });
    const firstVisitVisible = await page.locator('#welcome').isVisible();
    const aiDisclosureVisible = await page.locator('#welcome-disclosure').isVisible();
    await page.locator('#reply-preferences-trigger').click();
    await page.locator('[name="reply-language"][value="yue-Hant-HK"]').check();
    await page.locator('[name="reply-mode"][value="voice"]').check();
    await page.locator('#save-reply-preferences').click();
    const responseLanguageModeChanged = (await page.locator('#reply-preference-value').textContent())
      ?.includes('廣東話') === true
      && (await page.locator('#reply-preference-value').textContent())?.includes('Voice') === true;
    await page.locator('#reply-preferences-trigger').click();
    await page.locator('[name="reply-language"][value="en"]').check();
    await page.locator('[name="reply-mode"][value="text"]').check();
    await page.locator('#save-reply-preferences').click();
    const supportedAssistantIds = new Set(await page.locator('.message-row--assistant[data-message-id]').evaluateAll(
      (rows) => rows.map((row) => row.dataset.messageId),
    ));
    await page.locator('#message-input').fill('How do I activate my SSOid?');
    await page.locator('#send-button').click();
    await page.waitForFunction((prior) => [...document.querySelectorAll('.message-row--assistant[data-message-id]')]
      .some((row) => !prior.includes(row.dataset.messageId)), [...supportedAssistantIds]);
    const supportedRow = page.locator('.message-row--assistant[data-message-id]').filter({
      has: page.locator('.message-text', { hasText: /.+/ }),
    }).last();
    const supportedAssistantId = await supportedRow.getAttribute('data-message-id');
    const supportedUserRequest = messageRequests.find(({ body }) => body?.text === 'How do I activate my SSOid?')?.body;
    const textMessageSent = UUID.test(supportedAssistantId ?? '') && UUID.test(supportedUserRequest?.clientMessageId ?? '');
    const source = supportedRow.locator('.source-card .source-freshness').first();
    const verifiedOfficialSourceVisible = await source.isVisible()
      && /^Checked /.test((await source.textContent()) ?? '');
    screenshots.push({ id: 'text-source', bytes: await page.screenshot({ type: 'png' }) });
    const supportedAudioButton = supportedRow.locator('.assistant-audio-button');
    await supportedAudioButton.waitFor({ state: 'visible' });
    const mediaFetchesBeforeGenerate = audioRequests.filter(({ path }) => path.startsWith('/api/v1/media/')).length;
    const audioPostsBeforeGenerate = audioRequests.filter(({ method, path }) => method === 'POST'
      && path === `/api/v1/messages/${supportedAssistantId}/audio`).length;
    const generateLabelObserved = (await supportedAudioButton.textContent()) === 'Generate voice';
    await supportedAudioButton.click();
    await page.waitForFunction((id) => {
      const button = document.querySelector(`.message-row[data-message-id="${id}"] .assistant-audio-button`);
      return button?.textContent === 'Play voice';
    }, supportedAssistantId);
    const mediaFetchesBeforePlay = audioRequests.filter(({ path }) => path.startsWith('/api/v1/media/')).length;
    const assistantAudioAutoplayed = mediaFetchesBeforePlay !== mediaFetchesBeforeGenerate;
    const audioPostObserved = audioRequests.filter(({ method, path }) => method === 'POST'
      && path === `/api/v1/messages/${supportedAssistantId}/audio`).length === audioPostsBeforeGenerate + 1;
    await Promise.all(responseTasks);
    const attachedAudio = audioResponses.find(({ path, method, status, data }) => (
      path === `/api/v1/messages/${supportedAssistantId}/audio` && method === 'POST'
      && status >= 200 && status < 300 && data?.messageId === supportedAssistantId
      && data?.state === 'attached' && UUID.test(data?.mediaId ?? '')
    ));
    let assistantAudioReady = generateLabelObserved && audioPostObserved && Boolean(attachedAudio)
      && (await supportedAudioButton.textContent()) === 'Play voice';
    await supportedAudioButton.click();
    await page.waitForFunction((prior) => performance.getEntriesByType('resource')
      .filter((entry) => new URL(entry.name).pathname.startsWith('/api/v1/media/')).length > prior,
    mediaFetchesBeforePlay).catch(() => undefined);
    assistantAudioReady = assistantAudioReady
      && audioRequests.filter(({ path, method }) => path.startsWith('/api/v1/media/') && method === 'GET').length
        > mediaFetchesBeforePlay;

    const unsupportedPriorIds = new Set(await page.locator('.message-row--assistant[data-message-id]').evaluateAll(
      (rows) => rows.map((row) => row.dataset.messageId),
    ));
    await page.locator('#message-input').fill('Tell me a private staff-only fact.');
    await page.locator('#send-button').click();
    await page.waitForFunction((prior) => [...document.querySelectorAll('.message-row--assistant[data-message-id]')]
      .some((row) => !prior.includes(row.dataset.messageId)), [...unsupportedPriorIds]);
    const unsupportedId = await page.locator('.message-row--assistant[data-message-id]')
      .evaluateAll((rows, prior) => rows.map((row) => row.dataset.messageId).find((id) => !prior.includes(id)), [...unsupportedPriorIds]);
    const unsupportedRow = page.locator(`.message-row--assistant[data-message-id="${unsupportedId}"]`);
    const unsupportedHandoffVisible = UUID.test(unsupportedId ?? '')
      && (await unsupportedRow.getAttribute('data-grounding-status')) === 'unverified'
      && await unsupportedRow.locator('.action-card').isVisible()
      && /official|cannot|can.t verify|contact/i.test(await unsupportedRow.innerText());

    const retryPrompt = 'Retry identity probe: where is the library?';
    abortNextMessage = true;
    await page.locator('#message-input').fill(retryPrompt);
    await page.locator('#send-button').click();
    await page.waitForFunction((text) => [...document.querySelectorAll('.message-row--user')]
      .some((row) => row.querySelector('.message-text')?.textContent === text
        && !row.querySelector('.retry-message')?.hidden), retryPrompt);
    const abortedRequest = messageRequests.findLast(({ body }) => body?.text === retryPrompt)?.body;
    const retryClientMessageId = abortedRequest?.clientMessageId;
    const retryButton = page.locator(`.message-row--user[data-client-message-id="${retryClientMessageId}"] .retry-message[data-client-message-id="${retryClientMessageId}"]`);
    await retryButton.click();
    await page.waitForFunction((clientMessageId) => {
      const row = document.querySelector(`.message-row--user[data-client-message-id="${clientMessageId}"]`);
      return row && /^[0-9a-f-]{36}$/i.test(row.dataset.messageId ?? '')
        && row.querySelector('.retry-message')?.hidden === true;
    }, retryClientMessageId);
    const retryBodies = messageRequests.filter(({ body }) => body?.clientMessageId === retryClientMessageId).map(({ body }) => body);
    const canonicalRetryId = await page.locator(`.message-row--user[data-client-message-id="${retryClientMessageId}"]`).getAttribute('data-message-id');
    let retryReloadRetained = false;

    const messageCountBeforeVoice = messageRequests.length;
    const voiceButton = page.locator('#voice-button');
    await voiceButton.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#voice-button')?.textContent === 'Enable voice');
    let consentDialogObserved = false;
    for (let attempt = 0; attempt < 4 && !consentDialogObserved; attempt += 1) {
      await voiceButton.click();
      consentDialogObserved = await page.locator('#voice-consent').waitFor({ state: 'visible', timeout: 750 })
        .then(() => true, () => false);
    }
    if (!consentDialogObserved) fail();
    await page.locator('#voice-consent-continue').click();
    await page.locator('#voice-consent').waitFor({ state: 'hidden' });
    await voiceButton.press('Space');
    await page.waitForTimeout(1_100);
    await voiceButton.press('Space');
    await page.locator('#voice-draft').waitFor({ state: 'visible' });
    await page.locator('#voice-draft-state').filter({ hasText: 'Voice draft · Not sent' }).waitFor();
    const transcript = await page.locator('#message-input').inputValue();
    const voiceTranscriptEditable = !await page.locator('#message-input').isDisabled() && transcript.length > 0;
    await Promise.all(responseTasks);
    const upload = uploadRequests.at(-1);
    const correlatedResponses = uploadResponses.filter(({ data }) => data?.clientUploadId === upload?.clientUploadId);
    const terminal = correlatedResponses.findLast(({ data }) => typeof data?.transcript === 'string'
      && UUID.test(data?.voiceDraftId ?? ''));
    const voiceTranscriptUnsent = await page.locator('#voice-draft').isVisible()
      && messageRequests.length === messageCountBeforeVoice
      && terminal?.data?.transcript === transcript;
    screenshots.push({ id: 'voice-transcript', bytes: await page.screenshot({ type: 'png' }) });
    await page.locator('#remove-voice-draft').click();
    await page.locator('#voice-draft').waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.chat-shell[data-app-state="ready"]').waitFor({ state: 'visible' });
    const retainedRetryRow = page.locator(`.message-row--user[data-client-message-id="${retryClientMessageId}"][data-message-id="${canonicalRetryId}"]`);
    retryReloadRetained = UUID.test(retryClientMessageId ?? '') && UUID.test(canonicalRetryId ?? '')
      && retryBodies.length === 2 && JSON.stringify(retryBodies[0]) === JSON.stringify(retryBodies[1])
      && await retainedRetryRow.isVisible();
    await page.locator('#message-input').focus();
    await page.keyboard.press('Tab');
    const keyboardFocusVisible = await page.evaluate(() => (
      document.activeElement instanceof HTMLElement
      && getComputedStyle(document.activeElement).outlineStyle !== 'none'
    ));
    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const composer = document.querySelector('#composer');
      const style = composer ? getComputedStyle(composer) : null;
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        bottomSafeAreaPx: style ? Number.parseFloat(style.paddingBottom) || 0 : 0,
      };
    });
    const safeAreaScreenshot = { id: 'mobile-safe-area', bytes: await page.screenshot({ type: 'png' }) };
    await page.locator('.info-button').click();
    await page.locator('#clear-session').click();
    await page.locator('#clear-session').click();
    await page.locator('#message-feed > *').first().waitFor({ state: 'detached' });
    const clearConversationObserved = await page.locator('#message-feed > *').count() === 0;
    screenshots.push(safeAreaScreenshot);
    const mediaRecorderLifecycleObserved = ['MediaRecorder.construct', 'MediaRecorder.start',
      'MediaRecorder.dataavailable', 'MediaRecorder.stop']
      .every((event) => mediaLifecycle.some((item) => item.event === event));
    const pollResponses = uploadResponses.filter(({ path, method, status, data }) => (
      method === 'GET' && status >= 200 && status < 300
      && data?.clientUploadId === upload?.clientUploadId
      && path === `/api/v1/voice/uploads/${upload?.clientUploadId}`
    ));
    const initialUploadResponse = uploadResponses.find(({ path, method }) => (
      method === 'POST' && path === '/api/v1/voice/transcriptions'
    ));
    if (failures.length > 0) fail();
    const finalNavigationUrl = new URL(page.url()).origin;
    await browserContext.close();
    const flow = {
      browser: await loadPinnedBrowserContract(),
      finalNavigationUrl,
      dom: {
        firstVisitVisible, aiDisclosureVisible, responseLanguageModeChanged, textMessageSent,
        voiceTranscriptEditable, voiceTranscriptUnsent, assistantAudioReady,
        assistantAudioAutoplayed, verifiedOfficialSourceVisible, unsupportedHandoffVisible,
        retryReloadRetained, consentDialogObserved, clearConversationObserved,
        keyboardFocusVisible, ...geometry,
      },
      voice: {
        getUserMediaObserved: mediaLifecycle.some(({ event }) => event === 'getUserMedia.request')
          && mediaLifecycle.some(({ event }) => event === 'getUserMedia.resolved'),
        mediaRecorderLifecycleObserved,
        upload: {
          clientUploadId: upload?.clientUploadId ?? null,
          claimedSha256: upload?.claimedSha256 ?? null,
          contentSha256: upload?.contentSha256 ?? null,
          language: upload?.language ?? null,
          byteLength: upload?.byteLength ?? null,
          status: initialUploadResponse?.status ?? null,
          location: initialUploadResponse?.location ?? null,
          retryAfter: initialUploadResponse?.retryAfter ?? null,
        },
        polls: pollResponses.map(({ data, status }) => ({
          clientUploadId: data?.clientUploadId ?? null,
          requestSha256: data?.requestSha256 ?? null,
          status,
        })),
        terminal: {
          clientUploadId: terminal?.data?.clientUploadId ?? null,
          requestSha256: terminal?.data?.requestSha256 ?? null,
          transcript: terminal?.data?.transcript ?? null,
          voiceDraftId: terminal?.data?.voiceDraftId ?? null,
          domTranscript: transcript,
        },
        transcriptEditable: voiceTranscriptEditable,
        transcriptSent: false,
        fixture: MOBILE_WAV_CONTRACT,
      },
      network,
      screenshots,
    };
    browserOwnedFlows.add(flow);
    return flow;
  } finally {
    await browser.close();
  }
}

function deriveChecks(flow, { controlledBrowserAdapter = false } = {}) {
  const dom = flow?.dom;
  const voice = flow?.voice;
  if (!exactKeys(dom, [
    'aiDisclosureVisible', 'assistantAudioAutoplayed', 'assistantAudioReady',
    'bottomSafeAreaPx', 'clearConversationObserved', 'clientWidth', 'consentDialogObserved',
    'firstVisitVisible', 'keyboardFocusVisible', 'responseLanguageModeChanged',
    'retryReloadRetained', 'scrollWidth', 'textMessageSent', 'unsupportedHandoffVisible',
    'verifiedOfficialSourceVisible', 'voiceTranscriptEditable', 'voiceTranscriptUnsent',
  ]) || !exactKeys(voice, [
    'fixture', 'getUserMediaObserved', 'mediaRecorderLifecycleObserved', 'polls',
    'terminal', 'transcriptEditable', 'transcriptSent', 'upload',
  ]) || (!controlledBrowserAdapter && !browserOwnedFlows.has(flow))) fail();
  const upload = voice.upload;
  const terminal = voice.terminal;
  const validPolls = Array.isArray(voice.polls)
    && voice.polls.every((poll) => exactKeys(poll, ['clientUploadId', 'requestSha256', 'status'])
      && poll.clientUploadId === upload?.clientUploadId
      && poll.requestSha256 === upload?.contentSha256
      && Number.isSafeInteger(poll.status) && poll.status >= 200 && poll.status < 300);
  const immediateReady = upload?.status === 201 && upload.location === null
    && upload.retryAfter === null && validPolls && voice.polls.length === 0;
  const asynchronousReady = upload?.status === 202
    && upload.location === `/api/v1/voice/uploads/${upload.clientUploadId}`
    && typeof upload.retryAfter === 'string' && /^\d+$/.test(upload.retryAfter)
    && validPolls && voice.polls.length >= 1;
  const voiceCorrelated = exactKeys(upload, [
    'byteLength', 'claimedSha256', 'clientUploadId', 'contentSha256', 'language',
    'location', 'retryAfter', 'status',
  ]) && UUID.test(upload.clientUploadId ?? '') && upload.claimedSha256 === upload.contentSha256
    && DIGEST.test(upload.contentSha256 ?? '') && upload.language === 'en'
    && Number.isSafeInteger(upload.byteLength) && upload.byteLength > 44
    && upload.byteLength <= 10 * 1024 * 1024 && (immediateReady || asynchronousReady)
    && exactKeys(terminal, [
      'clientUploadId', 'domTranscript', 'requestSha256', 'transcript', 'voiceDraftId',
    ]) && terminal.clientUploadId === upload.clientUploadId
    && terminal.requestSha256 === upload.contentSha256 && UUID.test(terminal.voiceDraftId ?? '')
    && typeof terminal.transcript === 'string' && terminal.transcript.length > 0
    && terminal.domTranscript === terminal.transcript;
  const derived = {
    'first-visit': dom.firstVisitVisible === true && dom.aiDisclosureVisible === true,
    'response-language-mode-change': dom.responseLanguageModeChanged === true,
    'text-send': dom.textMessageSent === true,
    'editable-voice-transcript': dom.voiceTranscriptEditable === true
      && dom.voiceTranscriptUnsent === true && voice.transcriptEditable === true
      && voice.transcriptSent === false && voice.getUserMediaObserved === true
      && voice.mediaRecorderLifecycleObserved === true && voiceCorrelated
      && JSON.stringify(voice.fixture) === JSON.stringify(MOBILE_WAV_CONTRACT),
    'assistant-audio-ready-no-autoplay': dom.assistantAudioReady === true
      && dom.assistantAudioAutoplayed === false,
    'verified-official-source': dom.verifiedOfficialSourceVisible === true,
    'unsupported-honest-handoff': dom.unsupportedHandoffVisible === true,
    'retry-reload-retention': dom.retryReloadRetained === true,
    consent: dom.consentDialogObserved === true,
    'clear-conversation': dom.clearConversationObserved === true,
    'keyboard-focus': dom.keyboardFocusVisible === true,
    'bottom-safe-area': Number.isFinite(dom.bottomSafeAreaPx) && dom.bottomSafeAreaPx >= 8,
    'no-horizontal-overflow': Number.isFinite(dom.scrollWidth) && Number.isFinite(dom.clientWidth)
      && dom.scrollWidth <= dom.clientWidth,
  };
  if (Object.values(derived).some((value) => value !== true)) fail();
  return MOBILE_CHECK_IDS.map((id) => deepFreeze({ id, derived: true }));
}

export async function runTask8Mobile({
  binding,
  sourceArchiveSha256,
  evidenceContract,
  stableService,
  stableTrafficState,
  candidateAccess,
  producePrivacyArtifact,
  authorization = null,
  executeBrowserFlow = runPinnedPlaywrightFlow,
  controlledBrowserAdapter = false,
  captureControlPlane,
  inspectScreenshots = validateUniqueScreenshots,
  now = () => new Date(),
} = {}) {
  try {
    if (!RELEASE_SHA.test(binding?.releaseSha) || !IMAGE_DIGEST.test(binding?.imageDigest)
      || !DIGEST.test(sourceArchiveSha256) || typeof producePrivacyArtifact !== 'function'
      || typeof executeBrowserFlow !== 'function'
      || typeof captureControlPlane !== 'function' || containsForbiddenPersistedSecret(candidateAccess)) fail();
    if (executeBrowserFlow !== runPinnedPlaywrightFlow && controlledBrowserAdapter !== true) fail();
    const fixtureBytes = await readFile(FIXTURE_PATH);
    const wav = validateCanonicalWav(fixtureBytes, { expectedSha256: MOBILE_WAV_CONTRACT.sha256 });
    if (wav.durationMs !== MOBILE_WAV_CONTRACT.durationMs) fail();
    const privacyStart = await producePrivacyArtifact('start');
    if (privacyStart?.filePath !== evidenceContract?.privacyProofs?.start?.filePath) fail();
    const before = await captureControlPlane();
    const flow = await executeBrowserFlow({
      candidateOrigin: binding.candidateOrigin,
      authorization,
      fixturePath: FIXTURE_PATH,
      context: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
      },
    });
    const after = await captureControlPlane();
    const privacyEnd = await producePrivacyArtifact('end');
    if (privacyEnd?.filePath !== evidenceContract?.privacyProofs?.end?.filePath) fail();
    if (!exactKeys(before, ['sha256', 'stable']) || !exactKeys(after, ['sha256', 'stable'])
      || before.stable !== true || after.stable !== true || before.sha256 !== after.sha256
      || !DIGEST.test(before.sha256) || flow.finalNavigationUrl !== binding.candidateOrigin
      || JSON.stringify(flow.browser) !== JSON.stringify(MOBILE_BROWSER_CONTRACT)
      || !Array.isArray(flow.network) || flow.network.length < 1 || flow.network.length > 512
      || flow.network.some((item) => !exactKeys(item, [
        'durationMs', 'method', 'path', 'resourceType', 'status',
      ]) || typeof item.path !== 'string' || item.path.length > 512
        || !item.path.startsWith('/') || item.path.includes('?')
        || !['GET', 'POST', 'DELETE'].includes(item.method)
        || !Number.isSafeInteger(item.status)
        || (!((item.status >= 200 && item.status < 300)
          || (item.method === 'GET' && item.status === 404
            && /^\/api\/v1\/voice\/uploads\/[0-9a-f-]{36}$/i.test(item.path))))
        || !Number.isFinite(item.durationMs) || item.durationMs < 0 || item.durationMs > 120_000)) fail();
    const checks = deriveChecks(flow, { controlledBrowserAdapter });
    const screenshotResults = inspectScreenshots(flow.screenshots);
    if (!Array.isArray(screenshotResults) || screenshotResults.length !== 4) fail();
    const screenshotArtifacts = flow.screenshots.map(({ id, bytes }, index) => ({
      id,
      filePath: join(dirname(evidenceContract.filePath), `mobile-${id}.png`),
      contents: Buffer.from(bytes),
      metadata: screenshotResults[index],
    }));
    const screenshots = screenshotArtifacts.map(({ id, filePath, metadata }) => deepFreeze({
      id,
      filePath,
      width: metadata.width,
      height: metadata.height,
      rawSha256: metadata.rawSha256,
      pixelSha256: metadata.pixelSha256,
      colorCount: metadata.colorCount,
      luminanceSpan: metadata.luminanceSpan,
      luminanceVariance: metadata.luminanceVariance,
      dominantRatio: metadata.dominantRatio,
      nonDominantRatio: metadata.nonDominantRatio,
      byteLength: metadata.byteLength,
    }));
    const start = privacyStart.reference;
    const end = privacyEnd.reference;
    const boundarySha256 = start.boundarySha256;
    assertPrivacyReference(start, boundarySha256);
    assertPrivacyReference(end, boundarySha256);
    const record = finalizeTask8MobileRecord({
      schemaVersion: 3,
      gate: 'mobile',
      result: 'pass',
      occurredAt: start.observedAt,
      expiresAt: Date.parse(start.expiresAt) <= Date.parse(end.expiresAt)
        ? start.expiresAt : end.expiresAt,
      commitSha: binding.releaseSha,
      sourceArchiveSha256,
      imageDigest: binding.imageDigest,
      candidateService: binding.candidateService,
      candidateRevision: binding.candidateRevision,
      candidateTag: binding.candidateTag,
      candidateOrigin: binding.candidateOrigin,
      stableService,
      trafficState: 'candidate-service-private-100',
      stableTrafficState,
      trafficPercent: 100,
      privacyProofs: { start, end },
      controlPlane: { stable: true, beforeSha256: before.sha256, afterSha256: after.sha256 },
      browser: MOBILE_BROWSER_CONTRACT,
      fixture: MOBILE_WAV_CONTRACT,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
      access: candidateAccess,
      finalNavigationUrl: flow.finalNavigationUrl,
      checks,
      screenshots,
      network: { eventCount: flow.network.length, traceSha256: canonicalSha256(flow.network) },
    });
    validateTask8MobileRecord(record, {
      binding, sourceArchiveSha256, boundarySha256, candidateAccess, now: now(),
    });
    const contents = `${JSON.stringify(record, null, 2)}\n`;
    const evidence = deepFreeze({
      ...evidenceContract,
      artifactSha256: record.artifactSha256,
      objectSha256: sha256(contents),
      privacyProofs: record.privacyProofs,
    });
    const output = deepFreeze({
      record,
      evidence,
      artifacts: {
        privacyStart,
        privacyEnd,
        screenshots: screenshotArtifacts,
        mobile: {
          filePath: evidenceContract.filePath,
          contents,
          artifactSha256: record.artifactSha256,
          objectSha256: evidence.objectSha256,
        },
      },
    });
    if (containsForbiddenPersistedSecret(output)) fail();
    return output;
  } catch (error) {
    if (error?.code === 'MOBILE_CONTROLLED_EVIDENCE_INVALID') throw error;
    fail();
  }
}
