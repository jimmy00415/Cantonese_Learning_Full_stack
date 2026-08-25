import { DefaultAzureCredential } from '@azure/identity';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadDefaultCorpus } from './knowledge/corpus.js';
import { createRetriever } from './knowledge/retriever.js';
import { createAsrProvider } from './providers/asr.js';
import { createLlmProvider } from './providers/llm.js';
import { createTtsProvider } from './providers/tts.js';
import { createAnswerService } from './services/answer.js';
import { createDispatcher } from './services/dispatcher.js';
import { EventHub } from './services/events.js';
import { createMediaCleanupService } from './services/media-cleanup.js';
import { createTurnProcessor } from './services/turn-processor.js';
import {
  defaultVoiceIngressSpoolRoot,
  recoverStaleVoiceIngressSpools,
} from './services/voice.js';
import { AtomicFileStore } from './stores/atomic-file-store.js';
import { AzureBlobMediaStore } from './stores/azure-blob-media-store.js';
import { LocalMediaStore } from './stores/local-media-store.js';

function createMediaStore({ config, azureCredential }) {
  if (config.mediaDriver === 'local') {
    return new LocalMediaStore({ rootDirectory: config.localMediaPath });
  }
  if (config.mediaDriver === 'azure-blob') {
    return new AzureBlobMediaStore({
      containerName: config.mediaContainer,
      connectionString: config.mediaConnectionString,
      accountUrl: config.mediaAccountUrl,
      credential: config.mediaAccountUrl ? (azureCredential ?? new DefaultAzureCredential()) : undefined,
    });
  }
  throw new Error(`Media driver ${config.mediaDriver} is not available in this build`);
}

export async function startServer({
  environment = process.env,
  port = Number(environment.PORT ?? 3000),
  host,
  store: suppliedStore,
  corpus: suppliedCorpus,
  llmProvider: suppliedLlmProvider,
  eventHub: suppliedEventHub,
  mediaStore: suppliedMediaStore,
  asrProvider: suppliedAsrProvider,
  ttsProvider: suppliedTtsProvider,
  cleanupService: suppliedCleanupService,
  azureCredential,
  dispatcherOptions = {},
  now = () => new Date(),
  spoolParentDirectory = defaultVoiceIngressSpoolRoot,
  spoolRecoveryLimit,
  spoolStaleAfterMs,
} = {}) {
  const config = loadConfig(environment, { now });
  if (config.storeDriver !== 'atomic-file') throw new Error(`Store driver ${config.storeDriver} is not available in this build`);
  const store = suppliedStore ?? new AtomicFileStore({ filePath: config.atomicFilePath });
  await store.init();
  const mediaStore = suppliedMediaStore ?? createMediaStore({ config, azureCredential });
  await mediaStore.init();
  const spoolRecovery = await recoverStaleVoiceIngressSpools({
    parentDirectory: spoolParentDirectory,
    now,
    limit: spoolRecoveryLimit,
    staleAfterMs: spoolStaleAfterMs,
  });
  const corpus = suppliedCorpus ?? await loadDefaultCorpus();
  const retriever = createRetriever({ corpus, now });
  const llmProvider = suppliedLlmProvider ?? createLlmProvider({ config: config.llm, totalDeadlineMs: config.llm.timeoutMs });
  const asrProvider = suppliedAsrProvider
    ?? (config.asr.available ? createAsrProvider({ config: config.asr }) : null);
  const ttsProvider = suppliedTtsProvider
    ?? (config.tts.available ? createTtsProvider({ config: config.tts }) : null);
  const answerService = createAnswerService({ corpus, retriever, llmProvider, now });
  const eventHub = suppliedEventHub ?? new EventHub();
  const turnProcessor = createTurnProcessor({ store, answerService, eventHub, now });
  const dispatcher = createDispatcher({ store, processTurn: turnProcessor.processTurn, now, ...dispatcherOptions });
  const cleanupService = suppliedCleanupService ?? createMediaCleanupService({ store, mediaStore, now });
  const runtimeConfig = { ...config, knowledgeSnapshotDate: corpus.snapshotAt?.slice(0, 10) ?? null };
  const app = createApp({
    config: runtimeConfig,
    store,
    mediaStore,
    answerService,
    eventHub,
    dispatcher,
    asrProvider,
    ttsProvider,
    cleanupService,
    spoolParentDirectory,
    now,
  });
  const server = host ? app.listen(port, host) : app.listen(port);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  dispatcher.start();
  cleanupService.start();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const httpClosed = server.listening
        ? new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        : Promise.resolve();
      eventHub.close();
      server.closeIdleConnections?.();
      await cleanupService.stop();
      await dispatcher.stop();
      await httpClosed;
      await mediaStore.close();
      await store.close();
    })();
    return shutdownPromise;
  };
  server.shutdown = shutdown;
  server.runtime = {
    store,
    mediaStore,
    dispatcher,
    eventHub,
    asrProvider,
    ttsProvider,
    cleanupService,
    spoolRecovery,
    shutdown,
  };
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file:${process.argv[1]}`).href) {
  try {
    await startServer();
  } catch {
    process.stderr.write('Production V1 failed to start. Check safe configuration and dependency health.\n');
    process.exitCode = 1;
  }
}
