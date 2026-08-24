import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadDefaultCorpus } from './knowledge/corpus.js';
import { createRetriever } from './knowledge/retriever.js';
import { createLlmProvider } from './providers/llm.js';
import { createAnswerService } from './services/answer.js';
import { createDispatcher } from './services/dispatcher.js';
import { EventHub } from './services/events.js';
import { createTurnProcessor } from './services/turn-processor.js';
import { AtomicFileStore } from './stores/atomic-file-store.js';

export async function startServer({
  environment = process.env,
  port = Number(environment.PORT ?? 3000),
  host,
  store: suppliedStore,
  corpus: suppliedCorpus,
  llmProvider: suppliedLlmProvider,
  eventHub: suppliedEventHub,
  dispatcherOptions = {},
  now = () => new Date(),
} = {}) {
  const config = loadConfig(environment);
  if (config.storeDriver !== 'atomic-file') throw new Error(`Store driver ${config.storeDriver} is not available in this build`);
  const store = suppliedStore ?? new AtomicFileStore({ filePath: config.atomicFilePath });
  await store.init();
  const corpus = suppliedCorpus ?? await loadDefaultCorpus();
  const retriever = createRetriever({ corpus, now });
  const llmProvider = suppliedLlmProvider ?? createLlmProvider({ config: config.llm, totalDeadlineMs: config.llm.timeoutMs });
  const answerService = createAnswerService({ corpus, retriever, llmProvider, now });
  const eventHub = suppliedEventHub ?? new EventHub();
  const turnProcessor = createTurnProcessor({ store, answerService, eventHub, now });
  const dispatcher = createDispatcher({ store, processTurn: turnProcessor.processTurn, now, ...dispatcherOptions });
  const runtimeConfig = { ...config, knowledgeSnapshotDate: corpus.snapshotAt?.slice(0, 10) ?? null };
  const app = createApp({ config: runtimeConfig, store, answerService, eventHub, dispatcher });
  const server = host ? app.listen(port, host) : app.listen(port);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  dispatcher.start();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const httpClosed = server.listening
        ? new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        : Promise.resolve();
      eventHub.close();
      server.closeIdleConnections?.();
      await dispatcher.stop();
      await httpClosed;
      await store.close();
    })();
    return shutdownPromise;
  };
  server.shutdown = shutdown;
  server.runtime = { store, dispatcher, eventHub, shutdown };
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
