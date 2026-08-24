import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { validateCanonicalWav } from '../src/media/canonical-wav.js';
import { createAsrProvider } from '../src/providers/asr.js';
import { createTtsProvider } from '../src/providers/tts.js';
import {
  finalizeEvidenceRecord,
  providerConfigDigest,
  voiceEvidenceContracts,
} from '../src/services/voice-evidence.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/i;
const FIXED_TTS_PHRASE = '你好，這是 Hong Kong Buddy 的非敏感語音驗證。';
const productionRoot = fileURLToPath(new URL('../', import.meta.url));

function exactArguments(argv) {
  if (argv.length === 3
    && argv[0] === '--capability' && argv[1] === 'tts'
    && argv[2] === '--confirm-real-voice-provider') {
    return { capability: 'tts', asrFile: null };
  }
  if (argv.length === 7
    && argv[0] === '--capability' && argv[1] === 'asr'
    && argv[2] === '--asr-file' && isAbsolute(argv[3])
    && argv[4] === '--confirm-real-voice-provider'
    && argv[5] === '--confirm-asr-audio-nonsensitive'
    && argv[6] === undefined) {
    return { capability: 'asr', asrFile: argv[3] };
  }
  // The exact ASR invocation has six arguments after the script path.
  if (argv.length === 6
    && argv[0] === '--capability' && argv[1] === 'asr'
    && argv[2] === '--asr-file' && isAbsolute(argv[3])
    && argv[4] === '--confirm-real-voice-provider'
    && argv[5] === '--confirm-asr-audio-nonsensitive') {
    return { capability: 'asr', asrFile: argv[3] };
  }
  return null;
}

async function defaultWriteEvidence(record) {
  const directory = join(productionRoot, 'reports', 'speech');
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${record.commitSha}-${record.capability}-${record.artifactSha256}.json`);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return filePath;
}

function safeOutput(writeOutput, value) {
  writeOutput(`${JSON.stringify(value)}\n`);
}

export async function runVoiceProviderSmoke({
  argv = process.argv.slice(2),
  environment = process.env,
  createTts = (config) => createTtsProvider({ config }),
  createAsr = (config) => createAsrProvider({ config }),
  writeEvidence = defaultWriteEvidence,
  writeOutput = (value) => process.stdout.write(value),
  now = () => new Date(),
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) {
    safeOutput(writeOutput, { result: 'not_run', errorCode: 'VOICE_SMOKE_CONFIRMATION_REQUIRED' });
    return { exitCode: 2, result: 'not_run', errorCode: 'VOICE_SMOKE_CONFIRMATION_REQUIRED' };
  }
  let config;
  try { config = loadConfig(environment, { now }); } catch {
    safeOutput(writeOutput, { capability: selection.capability, result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' });
    return { exitCode: 2, capability: selection.capability, result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' };
  }
  const selected = selection.capability === 'asr' ? config.asr : config.tts;
  if (!RELEASE_SHA.test(String(config.releaseCommitSha ?? ''))
    || !selected?.available || !selected.settings?.credentialVersion) {
    safeOutput(writeOutput, { capability: selection.capability, provider: selected?.provider ?? 'none', result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' });
    return { exitCode: 2, capability: selection.capability, provider: selected?.provider ?? 'none', result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' };
  }

  try {
    let result;
    let fixture = {};
    if (selection.capability === 'tts') {
      result = await createTts(selected).synthesize(FIXED_TTS_PHRASE);
    } else {
      const bytes = await readFile(selection.asrFile);
      const validated = validateCanonicalWav(bytes);
      result = await createAsr(selected).transcribe(bytes);
      fixture = {
        fixtureSha256: validated.sha256,
        fixtureDurationMs: validated.durationMs,
      };
    }
    const contractVersion = selection.capability === 'asr'
      ? voiceEvidenceContracts.asr
      : selected.provider === 'azure' ? voiceEvidenceContracts.azureTts : voiceEvidenceContracts.minimaxTts;
    const record = finalizeEvidenceRecord({
      schemaVersion: 1,
      commitSha: config.releaseCommitSha,
      capability: selection.capability,
      provider: selected.provider,
      contractVersion,
      providerConfigDigest: providerConfigDigest(selected, selection.capability),
      ...fixture,
      occurredAt: new Date(now()).toISOString(),
      result: 'pass',
      latencyMs: Math.max(0, Number(result.latencyMs) || 0),
    });
    await writeEvidence(record);
    const output = {
      capability: selection.capability,
      provider: selected.provider,
      result: 'pass',
      latencyMs: record.latencyMs,
      ...(selection.capability === 'asr' ? {
        fixtureSha256: record.fixtureSha256,
        fixtureDurationMs: record.fixtureDurationMs,
        fixtureByteLength: (await readFile(selection.asrFile)).length,
      } : {}),
      artifactSha256: record.artifactSha256,
    };
    safeOutput(writeOutput, output);
    return { exitCode: 0, ...output };
  } catch (error) {
    const errorCode = typeof error?.code === 'string' && /^VOICE_[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'VOICE_SMOKE_FAILED';
    const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }
}

const directPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (directPath === fileURLToPath(import.meta.url)) {
  const result = await runVoiceProviderSmoke();
  process.exitCode = result.exitCode;
}
