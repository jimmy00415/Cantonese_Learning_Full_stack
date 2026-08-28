import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

import {
  MOBILE_BROWSER_CONTRACT,
  MOBILE_CHECK_IDS,
  MOBILE_WAV_CONTRACT,
  deriveChallengeWav,
  loadPinnedBrowserContract,
  runPinnedPlaywrightFlow,
  runTask8Mobile,
  validateTask8MobileRecord,
  verifyChallengeBoundUpload,
} from '../scripts/task8-mobile-producer.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDispatcher } from '../src/services/dispatcher.js';
import { EventHub } from '../src/services/events.js';
import { createTurnProcessor } from '../src/services/turn-processor.js';
import { createVoiceService } from '../src/services/voice.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import { LocalMediaStore } from '../src/stores/local-media-store.js';

const RELEASE_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const BOUNDARY = 'd'.repeat(64);
const FIXTURE_FILE = fileURLToPath(new URL('./fixtures/mobile-voice-en.wav', import.meta.url));

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
      upload: {
        clientUploadId: '11111111-1111-4111-8111-111111111111',
        claimedSha256: MOBILE_WAV_CONTRACT.sha256,
        contentSha256: MOBILE_WAV_CONTRACT.sha256,
        language: 'en',
        byteLength: 32_044,
        status: 202,
        location: '/api/v1/voice/uploads/11111111-1111-4111-8111-111111111111',
        retryAfter: '1',
      },
      polls: [{
        clientUploadId: '11111111-1111-4111-8111-111111111111',
        requestSha256: MOBILE_WAV_CONTRACT.sha256,
        status: 200,
      }],
      terminal: {
        clientUploadId: '11111111-1111-4111-8111-111111111111',
        requestSha256: MOBILE_WAV_CONTRACT.sha256,
        transcript: 'Editable transcript',
        voiceDraftId: '22222222-2222-4222-8222-222222222222',
        domTranscript: 'Editable transcript',
      },
      transcriptEditable: true,
      transcriptSent: false,
      fixture: { ...MOBILE_WAV_CONTRACT },
      witness: {
        baseFixtureSha256: MOBILE_WAV_CONTRACT.sha256,
        challengeCommitmentSha256: 'c'.repeat(64),
        uploadSha256: MOBILE_WAV_CONTRACT.sha256,
        durationMs: 1_000,
        durationDeltaMs: 0,
        comparedSamples: 16_000,
        baseCorrelation: 0.99,
        watermarkCorrelation: 0.9,
        commandLineVerified: true,
        playbackObserved: true,
        witnessed: true,
      },
    },
    network: [
      { path: '/', method: 'GET', resourceType: 'document', status: 200, durationMs: 25 },
      { path: '/api/v1/voice/transcriptions', method: 'POST', resourceType: 'fetch', status: 202, durationMs: 50 },
    ],
    screenshots: ['first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area']
      .map((id, index) => ({ id, bytes: Buffer.from(`png-${index}`) })),
  };
}

async function startLocalProduct(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-mobile-browser-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  const mediaStore = new LocalMediaStore({ rootDirectory: join(directory, 'media') });
  await store.init();
  await mediaStore.init();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({
    NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 'm'.repeat(32),
    V1_ASR_PROVIDER: 'azure', V1_TTS_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'local-test-only', AZURE_SPEECH_REGION: 'eastasia',
  });
  const eventHub = new EventHub();
  const fixture = await readFile(new URL('./fixtures/mobile-voice-en.wav', import.meta.url));
  const voiceService = createVoiceService({
    config,
    store,
    mediaStore,
    eventHub,
    asrProvider: {
      provider: 'local-test',
      async transcribe() {
        return { transcript: 'Editable local voice transcript', provider: 'local-test', latencyMs: 1, confidence: 0.99 };
      },
    },
    ttsProvider: {
      provider: 'local-test',
      async synthesize() {
        return { buffer: fixture, mimeType: 'audio/mpeg', provider: 'local-test', latencyMs: 1 };
      },
    },
    spoolParentDirectory: join(directory, 'spool'),
  });
  const answerService = {
    async answer({ text }) {
      if (/private staff-only/i.test(text)) {
        return {
          text: 'I cannot verify a private staff-only fact. Use the official student guide or contact HKBU.',
          citations: [{
            title: 'HKBU student guide', publisher: 'Hong Kong Baptist University',
            url: 'https://sa.hkbu.edu.hk/student-guide', verifiedAt: null, status: 'unverified',
          }],
          cards: [{
            title: 'HKBU student guide', label: 'Open official guide',
            url: 'https://sa.hkbu.edu.hk/student-guide',
          }],
          suggestedReplies: [], needsClarification: false, groundingStatus: 'unverified',
        };
      }
      return {
        text: `Local grounded answer for: ${text}`,
        citations: [{
          title: 'HKBU SSOid guide', publisher: 'Hong Kong Baptist University',
          url: 'https://ito.hkbu.edu.hk/services/ssoid',
          verifiedAt: '2026-08-27T08:00:00.000Z', status: 'verified',
        }],
        cards: [], suggestedReplies: [], needsClarification: false, groundingStatus: 'verified',
      };
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub, voiceService });
  const dispatcher = createDispatcher({
    store, processTurn: processor.processTurn, pollIntervalMs: 5,
    leaseDurationMs: 2_000, renewalIntervalMs: 200,
  });
  const app = createApp({ config, store, mediaStore, eventHub, dispatcher, voiceService });
  server.on('request', app);
  dispatcher.start();
  t.after(async () => {
    await dispatcher.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mediaStore.close?.();
    await store.close();
  });
  return origin;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function controlledRun(flow) {
  const contract = {
    schemaVersion: 3,
    filePath: 'C:\\release\\mobile.json',
    candidateService: binding().candidateService,
    stableService: 'hkbuddy-v1',
    trafficState: 'candidate-service-private-100',
    stableTrafficState: 'stable-prior-100',
    privacyProofs: { start: { filePath: 'C:\\release\\start.json' }, end: { filePath: 'C:\\release\\end.json' } },
  };
  return runTask8Mobile({
    binding: binding(), sourceArchiveSha256: SOURCE_SHA, evidenceContract: contract,
    stableService: 'hkbuddy-v1', stableTrafficState: 'stable-prior-100',
    candidateAccess: candidateAccess(),
    producePrivacyArtifact: async (boundary) => privacyArtifact(
      boundary === 'start' ? contract.privacyProofs.start.filePath : contract.privacyProofs.end.filePath,
      boundary === 'start' ? '1' : '2',
      boundary === 'start' ? '2026-08-27T08:00:00.000Z' : '2026-08-27T08:01:00.000Z',
    ),
    executeBrowserFlow: async () => flow,
    controlledBrowserAdapter: true,
    captureControlPlane: async () => ({ stable: true, sha256: '3'.repeat(64) }),
    inspectScreenshots: (items) => items.map(({ id }, index) => ({
      id, width: 390, height: 844,
      rawSha256: ['4', '5', '6', '7'][index].repeat(64),
      pixelSha256: ['8', '9', 'a', 'b'][index].repeat(64),
      colorCount: 128, luminanceSpan: 96, luminanceVariance: 512,
      dominantRatio: 0.2, nonDominantRatio: 0.8, byteLength: 128,
    })),
    now: () => new Date('2026-08-27T08:02:00.000Z'),
  });
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

test('one-time WAV watermark is bounded and rejects base, prior, unrelated, silence, and forged replays', async () => {
  const base = await readFile(FIXTURE_FILE);
  const current = deriveChallengeWav(base, { seed: Buffer.alloc(32, 0x31) });
  const prior = deriveChallengeWav(base, { seed: Buffer.alloc(32, 0x32) });
  const witness = verifyChallengeBoundUpload(current.bytes, { baseValue: base, challenge: current });
  assert.equal(witness.witnessed, true);
  assert.equal(witness.uploadSha256, createHash('sha256').update(current.bytes).digest('hex'));
  let baseEnergy = 0;
  let watermarkEnergy = 0;
  for (let offset = 44; offset < base.length; offset += 2) {
    const baseSample = base.readInt16LE(offset);
    const delta = current.bytes.readInt16LE(offset) - baseSample;
    baseEnergy += baseSample * baseSample;
    watermarkEnergy += delta * delta;
  }
  assert.ok(10 * Math.log10(baseEnergy / watermarkEnergy) > 20, 'watermark must remain over 20 dB below the base signal');

  const silence = Buffer.from(base);
  silence.fill(0, 44);
  const unrelated = Buffer.from(base);
  for (let offset = 44; offset < unrelated.length; offset += 2) {
    unrelated.writeInt16LE(-unrelated.readInt16LE(offset), offset);
  }
  for (const attack of [base, prior.bytes, unrelated, silence]) {
    assert.throws(
      () => verifyChallengeBoundUpload(attack, { baseValue: base, challenge: current }),
      /Controlled mobile evidence is invalid/,
    );
  }
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

test('pinned browser runs the actual product shell, native EventSource, voice, audio, retry, and handoff APIs', async (t) => {
  const origin = await startLocalProduct(t);
  let privateChallengePath = null;
  const flow = await runPinnedPlaywrightFlow({
    candidateOrigin: origin,
    authorization: 'Bearer local-browser-contract',
    fixturePath: FIXTURE_FILE,
    context: {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
    },
    challengeSeed: Buffer.alloc(32, 0x5a),
    testHooks: { onChallengeCreated: ({ filePath }) => { privateChallengePath = filePath; } },
  });
  assert.equal(flow.finalNavigationUrl, origin);
  assert.equal(flow.network.some(({ path, resourceType, status }) => (
    path === '/api/v1/events' && resourceType === 'eventsource' && status === 200
  )), true);
  assert.equal(flow.network.some(({ path, method }) => path === '/api/v1/voice/transcriptions' && method === 'POST'), true);
  assert.equal(flow.voice.upload.claimedSha256, flow.voice.upload.contentSha256);
  assert.match(flow.voice.upload.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(flow.voice.fixture.sha256, MOBILE_WAV_CONTRACT.sha256);
  assert.equal(flow.voice.witness.witnessed, true);
  assert.equal(flow.voice.witness.commandLineVerified, true);
  assert.equal(flow.voice.witness.playbackObserved, true);
  assert.match(flow.voice.witness.challengeCommitmentSha256, /^[0-9a-f]{64}$/);
  assert.equal(flow.voice.terminal.requestSha256, flow.voice.upload.contentSha256);
  assert.equal(flow.voice.terminal.transcript, flow.voice.terminal.domTranscript);
  assert.equal(flow.dom.assistantAudioReady, true);
  assert.equal(flow.dom.assistantAudioAutoplayed, false);
  assert.equal(flow.dom.retryReloadRetained, true);
  assert.equal(flow.dom.unsupportedHandoffVisible, true);
  await assert.rejects(() => readFile(privateChallengePath), { code: 'ENOENT' });
  assert.equal(JSON.stringify(flow).includes(privateChallengePath), false);
});

test('context fence blocks popup-first, WebSocket, and arbitrary EventSource traffic before a sentinel sees it', async (t) => {
  let sentinelRequests = 0;
  let sentinelUpgrades = 0;
  const sentinel = createServer((request, response) => {
    sentinelRequests += 1;
    response.statusCode = 204;
    response.end();
  });
  sentinel.on('upgrade', (request, socket) => {
    sentinelUpgrades += 1;
    socket.destroy();
  });
  await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
  const sentinelOrigin = `http://127.0.0.1:${sentinel.address().port}`;
  const candidate = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><div class="chat-shell" data-app-state="ready" style="display:block;width:10px;height:10px"></div><script>
      window.open(${JSON.stringify(`${sentinelOrigin}/popup-first`)});
      new WebSocket(${JSON.stringify(sentinelOrigin.replace(/^http/, 'ws'))});
      new EventSource('/arbitrary-events');
      globalThis.__hkbuddyMobileObservation = { getUserMediaObserved: true, mediaRecorderObserved: true };
    </script>`);
  });
  await new Promise((resolve) => candidate.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await closeServer(candidate); await closeServer(sentinel); });
  await assert.rejects(() => runPinnedPlaywrightFlow({
    candidateOrigin: `http://127.0.0.1:${candidate.address().port}`,
    authorization: 'Bearer local-fence-contract', fixturePath: FIXTURE_FILE,
    testProbeOnly: true,
    context: {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
    },
  }), /Controlled mobile evidence is invalid/);
  assert.equal(sentinelRequests, 0);
  assert.equal(sentinelUpgrades, 0);
  const source = await readFile(new URL('../scripts/task8-mobile-producer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /__hkbuddyMobileObservation/);
  assert.doesNotMatch(source, /exposeBinding|__hkbuddyRecordMediaLifecycle|instrumentationToken/);
});

test('candidate main world cannot enumerate, replace, or invoke the isolated playback witness', async (t) => {
  const candidate = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><div class="chat-shell" data-app-state="ready" style="display:block;width:10px;height:10px">ready</div>
      <script>
        globalThis.__hkbuddyRecordMediaLifecycle = () => true;
        globalThis.__hkbuddyMobileObservation = { getUserMediaObserved: true, mediaRecorderObserved: true };
      </script>`);
  });
  await new Promise((resolve) => candidate.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(candidate));
  let visibleWitnessNames = null;
  await runPinnedPlaywrightFlow({
    candidateOrigin: `http://127.0.0.1:${candidate.address().port}`,
    authorization: 'Bearer local-binding-contract', fixturePath: FIXTURE_FILE,
    challengeSeed: Buffer.alloc(32, 0x65), testProbeOnly: true,
    testHooks: {
      async afterReady({ page }) {
        visibleWitnessNames = await page.evaluate(() => Object.getOwnPropertyNames(globalThis)
          .filter((name) => /^__hbw_/.test(name)));
      },
    },
    context: {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
    },
  });
  assert.deepEqual(visibleWitnessNames, []);
});

test('challenge-bound pinned browser rejects replay of the public base fixture with a coherent hash', async (t) => {
  const origin = await startLocalProduct(t);
  const base = await readFile(FIXTURE_FILE);
  await assert.rejects(() => runPinnedPlaywrightFlow({
    candidateOrigin: origin,
    authorization: 'Bearer local-browser-replay-contract',
    fixturePath: FIXTURE_FILE,
    challengeSeed: Buffer.alloc(32, 0x61),
    testHooks: {
      transformUpload() {
        return { bytes: base, claimedSha256: createHash('sha256').update(base).digest('hex') };
      },
    },
    context: {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
    },
  }), /Controlled mobile evidence is invalid/);
});

test('pinned browser rejects prior challenge, unrelated WAV, silence, and self-consistent forged uploads', async (t) => {
  const origin = await startLocalProduct(t);
  const base = await readFile(FIXTURE_FILE);
  const prior = deriveChallengeWav(base, { seed: Buffer.alloc(32, 0x70) }).bytes;
  const unrelated = Buffer.from(base);
  for (let offset = 44; offset < unrelated.length; offset += 2) {
    unrelated.writeInt16LE(-unrelated.readInt16LE(offset), offset);
  }
  const silence = Buffer.from(base);
  silence.fill(0, 44);
  const forged = Buffer.from(base);
  for (let offset = 44; offset < forged.length; offset += 2) {
    forged.writeInt16LE(Math.round(500 * Math.sin(offset / 11)), offset);
  }
  const attacks = { 'prior-challenge': prior, unrelated, silence, 'self-consistent-forged': forged };
  for (const [name, bytes] of Object.entries(attacks)) {
    await assert.rejects(() => runPinnedPlaywrightFlow({
      candidateOrigin: origin,
      authorization: 'Bearer local-browser-attack-contract',
      fixturePath: FIXTURE_FILE,
      challengeSeed: Buffer.alloc(32, 0x71 + Object.keys(attacks).indexOf(name)),
      testHooks: {
        transformUpload() {
          return { bytes, claimedSha256: createHash('sha256').update(bytes).digest('hex') };
        },
      },
      context: {
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
        isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
      },
    }), /Controlled mobile evidence is invalid/, name);
  }
});

test('download attempts fail closed on both the primary page and a popup before persistence', async (t) => {
  for (const target of ['primary', 'popup']) {
    let downloadObserved = false;
    const candidate = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.url === '/popup') {
        response.end('<button id="attack">download</button><script>attack.onclick=()=>{const a=document.createElement("a");a.href="data:text/plain,private";a.download="popup.txt";a.click()}</script>');
        return;
      }
      response.end(`<!doctype html><div class="chat-shell" data-app-state="ready" style="display:block;width:10px;height:10px">ready</div>
        <button id="attack">download</button><script>
        attack.onclick=()=>{${target === 'primary'
    ? 'const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["private"]));a.download="primary.txt";a.click()'
    : 'window.open("/popup")'}}
        </script>`);
    });
    await new Promise((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(() => runPinnedPlaywrightFlow({
        candidateOrigin: `http://127.0.0.1:${candidate.address().port}`,
        authorization: 'Bearer local-download-contract', fixturePath: FIXTURE_FILE,
        challengeSeed: Buffer.alloc(32, target === 'primary' ? 0x62 : 0x63),
        testProbeOnly: true,
        testHooks: {
          onDownloadAttempt() { downloadObserved = true; },
          retainUnexpectedPages: target === 'popup',
          async afterReady({ page, context }) {
            if (target === 'primary') await page.locator('#attack').click();
            else {
              const popup = context.waitForEvent('page');
              await page.locator('#attack').click();
              const child = await popup;
              await child.locator('#attack').click().catch(() => undefined);
            }
          },
        },
        context: {
          viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
          isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
        },
      }), /Controlled mobile evidence is invalid/, target);
      assert.equal(downloadObserved, true, target);
    } finally {
      await closeServer(candidate);
    }
  }
});

test('isolated browser witness rejects data, blob, preloaded, and WebAudio playback before explicit Play', async () => {
  const audioData = (await readFile(FIXTURE_FILE)).toString('base64');
  const attacks = {
    data: `<audio id="hidden" hidden src="data:audio/wav;base64,${audioData}"></audio><script>attack.onclick=()=>hidden.play()</script>`,
    blob: `<script>attack.onclick=async()=>{const blob=await fetch('data:audio/wav;base64,${audioData}').then(r=>r.blob());const audio=new Audio(URL.createObjectURL(blob));audio.hidden=true;document.body.append(audio);await audio.play()}</script>`,
    preloaded: '<audio id="hidden" hidden preload="auto" src="/audio.wav"></audio><script>attack.onclick=()=>hidden.play()</script>',
    webaudio: '<script>attack.onclick=async()=>{const context=new AudioContext();const buffer=context.createBuffer(1,16000,16000);buffer.getChannelData(0).fill(.1);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.start()}</script>',
  };
  for (const [name, attack] of Object.entries(attacks)) {
    const candidate = createServer((request, response) => {
      if (request.url === '/audio.wav') {
        response.setHeader('Content-Type', 'audio/wav');
        response.end(Buffer.from(audioData, 'base64'));
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><div class="chat-shell" data-app-state="ready" style="display:block;width:10px;height:10px">ready</div><button id="attack">play</button>${attack}`);
    });
    await new Promise((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(() => runPinnedPlaywrightFlow({
        candidateOrigin: `http://127.0.0.1:${candidate.address().port}`,
        authorization: 'Bearer local-playback-contract', fixturePath: FIXTURE_FILE,
        challengeSeed: Buffer.alloc(32, 0x66 + Object.keys(attacks).indexOf(name)),
        testProbeOnly: true,
        testHooks: { async afterReady({ page }) { await page.locator('#attack').click(); } },
        context: {
          viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
          isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false,
        },
      }), /Controlled mobile evidence is invalid/, name);
    } finally {
      await closeServer(candidate);
    }
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
    controlledBrowserAdapter: true,
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
  assert.throws(() => validateTask8MobileRecord(result.record, {
    binding: binding(), sourceArchiveSha256: SOURCE_SHA,
    boundarySha256: BOUNDARY, candidateAccess: candidateAccess(),
    now: new Date(result.record.expiresAt),
  }), /Controlled mobile evidence is invalid/);
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
    controlledBrowserAdapter: true,
    captureControlPlane: async () => ({ stable: true, sha256: '3'.repeat(64) }),
    inspectScreenshots: () => [],
    now: () => new Date('2026-08-27T08:02:00.000Z'),
  }), /Controlled mobile evidence is invalid/);
});

test('controlled contract rejects mismatched IDs, fabricated transcript, stale row, missing audio readiness, and non-exercised retry', async () => {
  const mutations = [
    (flow) => { flow.voice.polls[0].clientUploadId = '33333333-3333-4333-8333-333333333333'; },
    (flow) => { flow.voice.terminal.requestSha256 = 'f'.repeat(64); },
    (flow) => { flow.voice.terminal.domTranscript = 'fabricated page draft'; },
    (flow) => { flow.dom.unsupportedHandoffVisible = false; },
    (flow) => { flow.dom.assistantAudioReady = false; },
    (flow) => { flow.dom.retryReloadRetained = false; },
    (flow) => { flow.voice.witness.witnessed = false; },
  ];
  for (const mutate of mutations) {
    const flow = structuredClone(rawFlow());
    mutate(flow);
    await assert.rejects(() => controlledRun(flow), /Controlled mobile evidence is invalid/);
  }
});

test('production mobile path rejects a caller-supplied all-true browser adapter', async () => {
  let privacyCalls = 0;
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
    producePrivacyArtifact: async () => { privacyCalls += 1; return null; },
    executeBrowserFlow: async () => rawFlow(),
    captureControlPlane: async () => ({ stable: true, sha256: '3'.repeat(64) }),
  }), /Controlled mobile evidence is invalid/);
  assert.equal(privacyCalls, 0);
});
