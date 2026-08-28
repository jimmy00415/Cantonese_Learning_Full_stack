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
      || !Number.isFinite(current) || current < occurredAt - 30_000 || current > expiresAt
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

async function runPinnedPlaywrightFlow({ candidateOrigin, authorization, context, fixturePath }) {
  if (typeof authorization !== 'string' || authorization.length < 1 || authorization.length > 16_384) fail();
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
  try {
    if (browser.version() !== MOBILE_BROWSER_CONTRACT.browserVersion) fail();
    const browserContext = await browser.newContext(context);
    browserContext.on('serviceworker', () => failures.push('serviceworker'));
    await browserContext.addInitScript(() => {
      const observation = { getUserMediaObserved: false, mediaRecorderObserved: false };
      Object.defineProperty(globalThis, '__hkbuddyMobileObservation', {
        value: observation, configurable: false, enumerable: false, writable: false,
      });
      const mediaDevices = navigator.mediaDevices;
      const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
      if (originalGetUserMedia) {
        Object.defineProperty(mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async (...args) => {
            observation.getUserMediaObserved = true;
            return originalGetUserMedia(...args);
          },
        });
      }
      const OriginalMediaRecorder = globalThis.MediaRecorder;
      if (OriginalMediaRecorder) {
        Object.defineProperty(globalThis, 'MediaRecorder', {
          configurable: true,
          value: new Proxy(OriginalMediaRecorder, {
            construct(target, args, newTarget) {
              observation.mediaRecorderObserved = true;
              return Reflect.construct(target, args, newTarget);
            },
          }),
        });
      }
    });
    const page = await browserContext.newPage();
    page.on('console', (message) => {
      if (['warning', 'error'].includes(message.type())) failures.push(`console:${message.type()}`);
    });
    page.on('pageerror', () => failures.push('pageerror'));
    page.on('download', () => failures.push('download'));
    page.on('requestfailed', () => failures.push('requestfailed'));
    page.on('request', (request) => started.set(request, Date.now()));
    page.on('response', (response) => {
      const request = response.request();
      const url = new URL(response.url());
      const status = response.status();
      const method = request.method();
      const resourceType = request.resourceType();
      const allowedStatus = status >= 200 && status < 300;
      if (url.origin !== candidateOrigin || request.redirectedFrom() || !allowedStatus
        || !['GET', 'POST', 'DELETE'].includes(method)
        || !['document', 'stylesheet', 'script', 'image', 'font', 'fetch', 'xhr'].includes(resourceType)) {
        failures.push('network-response');
      }
      network.push({
        path: url.pathname,
        method,
        resourceType,
        status,
        durationMs: Math.max(0, Date.now() - (started.get(request) ?? Date.now())),
      });
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== candidateOrigin || request.redirectedFrom()) {
        failures.push('external-request');
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue({
        headers: { ...request.headers(), authorization },
      });
    });
    await page.goto(candidateOrigin, { waitUntil: 'networkidle' });
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
    await page.locator('#message-input').fill('How do I activate my SSOid?');
    await page.locator('#send-button').click();
    await page.locator('#message-feed .message-row--assistant').last().waitFor();
    const textMessageSent = await page.locator('#message-feed .message-row--user').count() > 0;
    const verifiedOfficialSourceVisible = await page.locator('#message-feed .source-card').count() > 0;
    screenshots.push({ id: 'text-source', bytes: await page.screenshot({ type: 'png' }) });
    await page.locator('#voice-button').click();
    const consentDialogObserved = await page.locator('#voice-consent').isVisible();
    await page.locator('#voice-consent-continue').click();
    await page.locator('#voice-button').press('Space');
    await page.waitForTimeout(1_100);
    await page.locator('#voice-button').press('Space');
    await page.locator('#voice-draft').waitFor({ state: 'visible' });
    const transcript = await page.locator('#message-input').inputValue();
    const voiceTranscriptEditable = !await page.locator('#message-input').isDisabled() && transcript.length > 0;
    const voiceTranscriptUnsent = await page.locator('#voice-draft').isVisible();
    screenshots.push({ id: 'voice-transcript', bytes: await page.screenshot({ type: 'png' }) });
    await page.reload({ waitUntil: 'networkidle' });
    const retryReloadRetained = await page.locator('#message-feed .message-row--user').count() > 0;
    const assistantAudioButton = page.locator('.assistant-audio-button').last();
    const assistantAudioReady = await assistantAudioButton.isVisible()
      && !await assistantAudioButton.isDisabled();
    const assistantAudioAutoplayed = await page.locator('audio').evaluateAll((items) => (
      items.some((item) => !item.paused || item.currentTime > 0)
    ));
    await page.locator('#message-input').fill('Tell me a private staff-only fact.');
    await page.locator('#send-button').click();
    await page.locator('#message-feed .message-row--assistant').last().waitFor();
    const unsupportedHandoffVisible = /official|cannot|can.t verify|contact/i.test(
      await page.locator('#message-feed .message-row--assistant').last().innerText(),
    );
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
    screenshots.push({ id: 'mobile-safe-area', bytes: await page.screenshot({ type: 'png' }) });
    await page.locator('.info-button').click();
    await page.locator('#clear-session').click();
    await page.locator('#clear-session').click();
    await page.locator('#message-feed > *').first().waitFor({ state: 'detached' });
    const clearConversationObserved = await page.locator('#message-feed > *').count() === 0;
    const mediaObservation = await page.evaluate(() => globalThis.__hkbuddyMobileObservation);
    const uploadObserved = network.some(({ path, method }) => (
      path === '/api/v1/voice/transcriptions' && method === 'POST'
    ));
    const pollingObserved = network.some(({ path, method }) => (
      path.startsWith('/api/v1/voice/uploads/') && method === 'GET'
    ));
    if (failures.length > 0) fail();
    const finalNavigationUrl = new URL(page.url()).origin;
    await browserContext.close();
    return {
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
        getUserMediaObserved: mediaObservation?.getUserMediaObserved === true,
        mediaRecorderObserved: mediaObservation?.mediaRecorderObserved === true,
        uploadPath: uploadObserved ? '/api/v1/voice/transcriptions' : null,
        pollingPathPrefix: pollingObserved ? '/api/v1/voice/uploads/' : null,
        transcriptEditable: voiceTranscriptEditable,
        transcriptSent: false,
        fixture: MOBILE_WAV_CONTRACT,
      },
      network,
      screenshots,
    };
  } finally {
    await browser.close();
  }
}

function deriveChecks(flow) {
  const dom = flow?.dom;
  const voice = flow?.voice;
  if (!exactKeys(dom, [
    'aiDisclosureVisible', 'assistantAudioAutoplayed', 'assistantAudioReady',
    'bottomSafeAreaPx', 'clearConversationObserved', 'clientWidth', 'consentDialogObserved',
    'firstVisitVisible', 'keyboardFocusVisible', 'responseLanguageModeChanged',
    'retryReloadRetained', 'scrollWidth', 'textMessageSent', 'unsupportedHandoffVisible',
    'verifiedOfficialSourceVisible', 'voiceTranscriptEditable', 'voiceTranscriptUnsent',
  ]) || !exactKeys(voice, [
    'fixture', 'getUserMediaObserved', 'mediaRecorderObserved', 'pollingPathPrefix',
    'transcriptEditable', 'transcriptSent', 'uploadPath',
  ])) fail();
  const derived = {
    'first-visit': dom.firstVisitVisible === true && dom.aiDisclosureVisible === true,
    'response-language-mode-change': dom.responseLanguageModeChanged === true,
    'text-send': dom.textMessageSent === true,
    'editable-voice-transcript': dom.voiceTranscriptEditable === true
      && dom.voiceTranscriptUnsent === true && voice.transcriptEditable === true
      && voice.transcriptSent === false && voice.getUserMediaObserved === true
      && voice.mediaRecorderObserved === true && voice.uploadPath === '/api/v1/voice/transcriptions'
      && voice.pollingPathPrefix === '/api/v1/voice/uploads/'
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
  captureControlPlane,
  inspectScreenshots = validateUniqueScreenshots,
  now = () => new Date(),
} = {}) {
  try {
    if (!RELEASE_SHA.test(binding?.releaseSha) || !IMAGE_DIGEST.test(binding?.imageDigest)
      || !DIGEST.test(sourceArchiveSha256) || typeof producePrivacyArtifact !== 'function'
      || typeof executeBrowserFlow !== 'function'
      || typeof captureControlPlane !== 'function' || containsForbiddenPersistedSecret(candidateAccess)) fail();
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
        || !Number.isSafeInteger(item.status) || item.status < 200 || item.status >= 300
        || !Number.isFinite(item.durationMs) || item.durationMs < 0 || item.durationMs > 120_000)) fail();
    const checks = deriveChecks(flow);
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
