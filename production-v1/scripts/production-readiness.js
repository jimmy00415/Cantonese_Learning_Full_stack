import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { evaluateProductionReadiness } from '../src/services/readiness.js';

function configurationFailure() {
  return {
    exitCode: 1,
    publicReport: {
      status: 'not-ready',
      productionReady: false,
      boundary: 'production-v1',
      checks: [{ name: 'configuration', status: 'not-ready', version: 'production-config-v1' }],
    },
  };
}

export async function runProductionReadiness({
  environment = process.env,
  checks = {},
  createRuntime,
  now = () => new Date(),
  writeOutput = (line) => process.stdout.write(line),
  loadConfigImpl = loadConfig,
  evaluateReadinessImpl = evaluateProductionReadiness,
} = {}) {
  let result;
  let runtime = null;
  try {
    const config = loadConfigImpl(environment, { now });
    if (config.nodeEnv === 'production' && typeof createRuntime === 'function') {
      runtime = await createRuntime({ config, environment, now });
      if (typeof runtime?.readiness !== 'function' || typeof runtime?.close !== 'function') {
        throw new Error('Production readiness runtime is invalid');
      }
      result = await runtime.readiness();
    } else {
      result = await evaluateReadinessImpl({ config, checks, now });
    }
  } catch {
    result = configurationFailure();
  }
  if (runtime) {
    try { await runtime.close(); } catch { result = configurationFailure(); }
  }
  writeOutput(`${JSON.stringify(result.publicReport)}\n`);
  return result;
}

async function createLiveReadinessRuntime({ config, environment, now }) {
  const server = await startServer({
    config,
    environment,
    host: '127.0.0.1',
    port: 0,
    now,
  });
  return {
    readiness: server.runtime.readiness,
    close: server.shutdown,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runProductionReadiness({ createRuntime: createLiveReadinessRuntime });
  process.exitCode = result.exitCode;
}
