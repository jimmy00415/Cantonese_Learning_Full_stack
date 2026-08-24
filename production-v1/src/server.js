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

export async function startServer() {
  const config = loadConfig();
  const port = Number(process.env.PORT ?? 3000);
  if (config.storeDriver !== 'atomic-file') throw new Error(`Store driver ${config.storeDriver} is not available in this build`);
  const store = new AtomicFileStore({ filePath: config.atomicFilePath });
  await store.init();
  const corpus = await loadDefaultCorpus();
  const retriever = createRetriever({ corpus });
  const llmProvider = createLlmProvider({ config: config.llm, totalDeadlineMs: config.llm.timeoutMs });
  const answerService = createAnswerService({ corpus, retriever, llmProvider });
  const eventHub = new EventHub();
  const turnProcessor = createTurnProcessor({ store, answerService, eventHub });
  const dispatcher = createDispatcher({ store, processTurn: turnProcessor.processTurn });
  const runtimeConfig = { ...config, knowledgeSnapshotDate: corpus.snapshotAt?.slice(0, 10) ?? null };
  const app = createApp({ config: runtimeConfig, store, answerService, eventHub, dispatcher });
  const server = app.listen(port);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  dispatcher.start();
  server.once('close', () => {
    void dispatcher.stop().then(() => store.close()).finally(() => eventHub.close());
  });
  server.runtime = { store, dispatcher, eventHub };
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
