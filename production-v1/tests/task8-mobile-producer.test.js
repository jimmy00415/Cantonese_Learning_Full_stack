import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

import {
  MOBILE_BROWSER_CONTRACT,
  MOBILE_CHECK_IDS,
  MOBILE_WAV_CONTRACT,
  loadPinnedBrowserContract,
  runTask8Mobile,
  validateTask8MobileRecord,
} from '../scripts/task8-mobile-producer.js';

const RELEASE_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const BOUNDARY = 'd'.repeat(64);

function privacyArtifact(filePath, digit, observedAt) {
  const proof = { schemaVersion: 3, artifactSha256: digit.repeat(64) };
  const contents = `${JSON.stringify(proof, null, 2)}\n`;
  return {
    filePath,
    contents,
    reference: {
      schemaVersion: 3,
      filePath,
      artifactSha256: proof.artifactSha256,
      objectSha256: createHash('sha256').update(contents).digest('hex'),
      boundarySha256: BOUNDARY,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 5 * 60_000).toISOString(),
    },
  };
}

function binding() {
  return {
    releaseSha: RELEASE_SHA,
    imageDigest: IMAGE_DIGEST,
    candidateService: 'hkbuddy-v1-candidate',
    candidateRevision: 'hkbuddy-v1-candidate-aaaaaaaaaaaa',
    candidateTag: 'qa-aaaaaaaaaaaa',
    candidateOrigin: 'https://qa-aaaaaaaaaaaa---hkbuddy-v1-candidate.asia-east2.run.app',
  };
}

function candidateAccess() {
  return {
    authenticated: true,
    audience: 'https://hkbuddy-v1-candidate-123456789012.asia-east2.run.app',
    issuer: 'https://accounts.google.com',
    subjectSha256: 'e'.repeat(64),
    taggedUrl: binding().candidateOrigin,
  };
}

function rawFlow() {
  return {
    browser: { ...MOBILE_BROWSER_CONTRACT },
    finalNavigationUrl: binding().candidateOrigin,
    dom: {
      firstVisitVisible: true,
      aiDisclosureVisible: true,
      responseLanguageModeChanged: true,
      textMessageSent: true,
      voiceTranscriptEditable: true,
      voiceTranscriptUnsent: true,
      assistantAudioReady: true,
      assistantAudioAutoplayed: false,
      verifiedOfficialSourceVisible: true,
      unsupportedHandoffVisible: true,
      retryReloadRetained: true,
      consentDialogObserved: true,
      clearConversationObserved: true,
      keyboardFocusVisible: true,
      bottomSafeAreaPx: 16,
      scrollWidth: 390,
      clientWidth: 390,
    },
    voice: {
      getUserMediaObserved: true,
      mediaRecorderObserved: true,
      uploadPath: '/api/v1/voice/transcriptions',
      pollingPathPrefix: '/api/v1/voice/uploads/',
      transcriptEditable: true,
      transcriptSent: false,
      fixture: { ...MOBILE_WAV_CONTRACT },
    },
    network: [
      { path: '/', method: 'GET', resourceType: 'document', status: 200, durationMs: 25 },
      { path: '/api/v1/voice/transcriptions', method: 'POST', resourceType: 'fetch', status: 202, durationMs: 50 },
    ],
    screenshots: ['first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area']
      .map((id, index) => ({ id, bytes: Buffer.from(`png-${index}`) })),
  };
}

test('mobile producer locks exact Playwright, Chromium, viewport, and canonical WAV contracts', async () => {
  assert.deepEqual(await loadPinnedBrowserContract(), MOBILE_BROWSER_CONTRACT);
  assert.deepEqual(MOBILE_BROWSER_CONTRACT, {
    engine: 'chromium', playwrightVersion: '1.62.1', revision: '1234',
    browserVersion: '151.0.7922.34', pinned: true, realIosSafari: false,
  });
  assert.deepEqual(MOBILE_WAV_CONTRACT, {
    sha256: 'ef989be190f7e9cef40b80516209d972eb08910263ddee3a44f52fdf84e534a7',
    sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1_000,
    mimeType: 'audio/wav',
  });
});

test('matching pinned Chromium launches only from the task-owned D browser cache', async () => {
  const expectedRoot = 'D:\\VS_PROJECT\\Testing\\HongKong_Buddy\\.codex-task-5g-temp\\playwright';
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, expectedRoot);
  assert.equal(chromium.executablePath().toLowerCase().startsWith(expectedRoot.toLowerCase()), true);
  assert.match(chromium.executablePath(), /chromium-1234/i);
  const browser = await chromium.launch({ headless: true });
  try {
    assert.equal(browser.version(), MOBILE_BROWSER_CONTRACT.browserVersion);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const page = await context.newPage();
    await page.setContent('<main id="local-browser-proof">Pinned local Chromium</main>');
    assert.deepEqual(page.viewportSize(), { width: 390, height: 844 });
    assert.equal(await page.locator('#local-browser-proof').textContent(), 'Pinned local Chromium');
    await context.close();
  } finally {
    await browser.close();
  }
});

test('mobile producer derives all thirteen checks from raw browser state and binds safe evidence', async () => {
  const contract = {
    schemaVersion: 3,
    filePath: join('C:\\release', 'mobile.json'),
    artifactSha256: '0'.repeat(64),
    objectSha256: '0'.repeat(64),
    candidateService: binding().candidateService,
    stableService: 'hkbuddy-v1',
    trafficState: 'candidate-service-private-100',
    stableTrafficState: 'stable-prior-100',
    privacyProofs: {
      start: { filePath: join('C:\\release', 'mobile-start.json') },
      end: { filePath: join('C:\\release', 'mobile-end.json') },
    },
  };
  const privacy = [
    privacyArtifact(contract.privacyProofs.start.filePath, '1', '2026-08-27T08:00:00.000Z'),
    privacyArtifact(contract.privacyProofs.end.filePath, '2', '2026-08-27T08:01:00.000Z'),
  ];
  let browserOptions = null;
  const lifecycle = [];
  const result = await runTask8Mobile({
    binding: binding(),
    sourceArchiveSha256: SOURCE_SHA,
    evidenceContract: contract,
    stableService: 'hkbuddy-v1',
    stableTrafficState: 'stable-prior-100',
    candidateAccess: candidateAccess(),
    producePrivacyArtifact: async (boundary) => {
      lifecycle.push(`privacy-${boundary}`);
      return privacy[boundary === 'start' ? 0 : 1];
    },
    executeBrowserFlow: async (options) => {
      lifecycle.push('browser');
      browserOptions = options;
      return rawFlow();
    },
    captureControlPlane: async () => ({ stable: true, sha256: '3'.repeat(64) }),
    inspectScreenshots: (items) => items.map(({ id }, index) => ({
      id,
      width: 390,
      height: 844,
      rawSha256: ['4', '5', '6', '7'][index].repeat(64),
      pixelSha256: ['8', '9', 'a', 'b'][index].repeat(64),
      colorCount: 128,
      luminanceSpan: 96,
      luminanceVariance: 512,
      dominantRatio: 0.2,
      nonDominantRatio: 0.8,
      byteLength: 128,
    })),
    now: () => new Date('2026-08-27T08:02:00.000Z'),
  });
  assert.deepEqual(browserOptions.context, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  assert.deepEqual(lifecycle, ['privacy-start', 'browser', 'privacy-end']);
  assert.deepEqual(result.record.checks.map(({ id }) => id), MOBILE_CHECK_IDS);
  assert.equal(result.record.checks.every(({ derived }) => derived === true), true);
  assert.equal(result.record.browser.realIosSafari, false);
  assert.equal(result.record.browser.pinned, true);
  assert.equal(result.record.fixture.sha256, MOBILE_WAV_CONTRACT.sha256);
  assert.deepEqual(result.record.access, candidateAccess());
  assert.equal(JSON.stringify(result).includes('Authorization'), false);
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
  assert.equal(validateTask8MobileRecord(result.record, {
    binding: binding(), sourceArchiveSha256: SOURCE_SHA,
    boundarySha256: BOUNDARY, candidateAccess: candidateAccess(),
    now: new Date('2026-08-27T08:02:00.000Z'),
  }), true);
});

test('mobile producer rejects caller-authored pass strings and every unsafe browser observation', async () => {
  const invalid = rawFlow();
  invalid.dom = { status: 'passed' };
  await assert.rejects(() => runTask8Mobile({
    binding: binding(),
    sourceArchiveSha256: SOURCE_SHA,
    evidenceContract: {
      schemaVersion: 3,
      filePath: 'C:\\release\\mobile.json',
      candidateService: binding().candidateService,
      stableService: 'hkbuddy-v1',
      trafficState: 'candidate-service-private-100',
      stableTrafficState: 'stable-prior-100',
      privacyProofs: { start: { filePath: 'C:\\release\\start.json' }, end: { filePath: 'C:\\release\\end.json' } },
    },
    stableService: 'hkbuddy-v1',
    stableTrafficState: 'stable-prior-100',
    candidateAccess: candidateAccess(),
    producePrivacyArtifact: async (boundary) => privacyArtifact(
      boundary === 'start' ? 'C:\\release\\start.json' : 'C:\\release\\end.json',
      boundary === 'start' ? '1' : '2',
      boundary === 'start' ? '2026-08-27T08:00:00.000Z' : '2026-08-27T08:01:00.000Z',
    ),
    executeBrowserFlow: async () => invalid,
    captureControlPlane: async () => ({ stable: true, sha256: '3'.repeat(64) }),
    inspectScreenshots: () => [],
    now: () => new Date('2026-08-27T08:02:00.000Z'),
  }), /Controlled mobile evidence is invalid/);
});
