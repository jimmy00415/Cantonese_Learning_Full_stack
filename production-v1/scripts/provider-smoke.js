import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createLlmProvider } from '../src/providers/llm.js';

function render(write, value) {
  write(JSON.stringify(value));
}

export async function runProviderSmoke({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (!argv.includes('--confirm-real-provider')) {
    render(stderr, { provider: null, httpClass: null, normalizedSuccess: false, latencyMs: 0, code: 'CONFIRMATION_REQUIRED' });
    return 2;
  }
  let config;
  try {
    config = loadConfig(env);
  } catch {
    render(stderr, { provider: null, httpClass: null, normalizedSuccess: false, latencyMs: 0, code: 'CONFIG_INVALID' });
    return 2;
  }
  if (!config.llm.available || config.llm.provider === 'deterministic') {
    render(stderr, { provider: config.llm.provider, httpClass: null, normalizedSuccess: false, latencyMs: 0, code: 'REAL_PROVIDER_REQUIRED' });
    return 2;
  }
  const provider = createLlmProvider({ config: config.llm, fetchImpl, totalDeadlineMs: config.llm.timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  try {
    await provider.generate({
      turnId: 'provider-check',
      systemPrompt: 'Return one JSON object.',
      messages: [{ role: 'user', content: 'Reply with an empty JSON object.' }],
      evidenceSnapshot: [],
      maxOutputTokens: 16,
    }, { retryLimit: 0 });
    render(stdout, { provider: config.llm.provider, httpClass: '2xx', normalizedSuccess: true, latencyMs: Date.now() - startedAt, code: 'OK' });
    return 0;
  } catch (error) {
    render(stderr, {
      provider: config.llm.provider,
      httpClass: error?.statusClass ?? null,
      normalizedSuccess: false,
      latencyMs: Date.now() - startedAt,
      code: typeof error?.code === 'string' ? error.code : 'PROVIDER_FAILED',
    });
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runProviderSmoke();
