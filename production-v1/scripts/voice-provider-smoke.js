import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadVoiceSmokeConfiguration } from '../src/config.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
import { decodeCanonicalMp3 } from '../src/media/canonical-mp3.js';
import { validateCanonicalWav } from '../src/media/canonical-wav.js';
import { createAsrProvider } from '../src/providers/asr.js';
import { createTtsProvider } from '../src/providers/tts.js';
import {
  finalizeEvidenceRecord,
  providerConfigDigest,
  voiceEvidenceContracts,
} from '../src/services/voice-evidence.js';
import { writeImmutableGcsEvidence } from '../src/services/gcs-evidence-writer.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/i;
const FIXED_TTS_PHRASE = '你好，這是 Hong Kong Buddy 的非敏感語音驗證。';
const RUNTIME_IDENTITY = GCP_IDENTITY.serviceAccounts.runtime;
const FIXTURE_DEFINITIONS = Object.freeze([
  Object.freeze({
    responseLanguage: 'yue-Hant-HK', locale: 'yue-Hant-HK', referenceId: 'voice-smoke-yue-v1',
    text: '我想知道點樣申請學生證', voiceName: 'yue-HK-Chirp3-HD-Achernar',
  }),
  Object.freeze({
    responseLanguage: 'en', locale: 'en-US', referenceId: 'voice-smoke-en-v1',
    text: 'How do I apply for my student card', voiceName: 'en-US-Chirp3-HD-Achernar',
  }),
  Object.freeze({
    responseLanguage: 'cmn-Hans-CN', locale: 'cmn-Hans-CN', referenceId: 'voice-smoke-cmn-v1',
    text: '我想知道怎样申请学生证', voiceName: 'cmn-CN-Chirp3-HD-Achernar',
  }),
]);
const productionRoot = fileURLToPath(new URL('../', import.meta.url));

function defaultLoadSmokeConfig(environment, now) {
  return environment.NODE_ENV === 'production' || environment.V1_RELEASE_MANIFEST_FILE
    ? loadVoiceSmokeConfiguration(environment, { now })
    : loadConfig(environment, { now });
}

function exactArguments(argv) {
  if (argv.length === 3
    && argv[0] === '--capability' && argv[1] === 'tts'
    && argv[2] === '--confirm-real-voice-provider') {
    return { capability: 'tts', mode: 'provider-voices', asrFile: null };
  }
  if (argv.length === 5
    && argv[0] === '--capability' && argv[1] === 'asr'
    && argv[2] === '--generate-asr-fixtures-with-pinned-tts'
    && argv[3] === '--confirm-real-voice-provider'
    && argv[4] === '--confirm-asr-audio-nonsensitive') {
    return { capability: 'asr', mode: 'generated-fixtures', asrFile: null };
  }
  if (argv.length === 6
    && argv[0] === '--capability' && argv[1] === 'asr'
    && argv[2] === '--asr-file' && isAbsolute(argv[3])
    && argv[4] === '--confirm-real-voice-provider'
    && argv[5] === '--confirm-asr-audio-nonsensitive') {
    return { capability: 'asr', mode: 'reviewed-file', asrFile: argv[3] };
  }
  return null;
}

function normalizedSpeechText(value) {
  return [...String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US')]
    .filter((character) => /[\p{L}\p{N}]/u.test(character));
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function transcriptMetrics(transcript, reference) {
  const value = String(transcript ?? '');
  if (!value.trim()) throw Object.assign(new Error('empty smoke transcript'), { code: 'VOICE_SMOKE_ACCURACY_FAILED' });
  const normalizedTranscript = normalizedSpeechText(value);
  const normalizedReference = normalizedSpeechText(reference);
  const distance = editDistance(normalizedTranscript, normalizedReference);
  const errorRate = Number((distance / normalizedReference.length).toFixed(6));
  if (errorRate > 0.35) throw Object.assign(new Error('speech accuracy bound exceeded'), { code: 'VOICE_SMOKE_ACCURACY_FAILED' });
  return {
    transcriptUtf8Bytes: Buffer.byteLength(value, 'utf8'),
    transcriptCodePointCount: [...value].length,
    normalizedReferenceCodePointCount: normalizedReference.length,
    normalizedEditDistance: distance,
    normalizedErrorRate: errorRate,
  };
}

async function defaultResolveRuntimeIdentity(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('metadata fetch is unavailable');
  const response = await fetchImpl(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3_000), redirect: 'error' },
  );
  const body = await response.text();
  if (!response.ok || response.headers.get('metadata-flavor') !== 'Google' || body.length > 320) {
    throw new Error('runtime metadata identity is invalid');
  }
  return body.trim();
}

async function defaultWriteEvidence(record, environment = process.env) {
  if (environment.V1_VOICE_SMOKE_OUTPUT_OBJECT) {
    return writeImmutableGcsEvidence({
      bucket: environment.V1_VOICE_SMOKE_OUTPUT_BUCKET,
      objectName: environment.V1_VOICE_SMOKE_OUTPUT_OBJECT,
      record,
    });
  }
  const directory = join(productionRoot, 'reports', 'speech');
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${record.commitSha}-${record.capability}-${record.artifactSha256}.json`);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { filePath };
}

function safeOutput(writeOutput, value) {
  writeOutput(`${JSON.stringify(value)}\n`);
}

async function defaultInspectGit(environment = process.env) {
  if (environment.V1_RELEASE_MANIFEST_FILE !== '/app/release-manifest.json') return null;
  const raw = await readFile(environment.V1_RELEASE_MANIFEST_FILE, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 1_024) return null;
  const manifest = JSON.parse(raw);
  const keys = Object.keys(manifest ?? {}).sort();
  if (keys.join('\0') !== ['releaseSha', 'schemaVersion', 'sourceArchiveSha256', 'sourcePath'].sort().join('\0')
    || manifest.schemaVersion !== 1
    || manifest.releaseSha !== environment.V1_RELEASE_COMMIT_SHA
    || !/^[0-9a-f]{64}$/.test(String(manifest.sourceArchiveSha256 ?? ''))
    || manifest.sourcePath !== 'git-archive:production-v1') return null;
  return { commitSha: manifest.releaseSha, clean: true };
}

function validFrozenGit(state, commitSha) {
  return state?.clean === true && state.commitSha === commitSha;
}

export async function runVoiceProviderSmoke({
  argv = process.argv.slice(2),
  environment = process.env,
  loadSmokeConfig = defaultLoadSmokeConfig,
  createTts = (config) => createTtsProvider({ config }),
  createAsr = (config) => createAsrProvider({ config }),
  inspectGit = defaultInspectGit,
  resolveRuntimeIdentity = defaultResolveRuntimeIdentity,
  writeEvidence,
  writeOutput = (value) => process.stdout.write(value),
  now = () => new Date(),
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) {
    safeOutput(writeOutput, { result: 'not_run', errorCode: 'VOICE_SMOKE_CONFIRMATION_REQUIRED' });
    return { exitCode: 2, result: 'not_run', errorCode: 'VOICE_SMOKE_CONFIRMATION_REQUIRED' };
  }
  let config;
  try { config = loadSmokeConfig(environment, now); } catch {
    safeOutput(writeOutput, { capability: selection.capability, result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' });
    return { exitCode: 2, capability: selection.capability, result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' };
  }
  const selected = selection.capability === 'asr' ? config.asr : config.tts;
  if (!RELEASE_SHA.test(String(config.releaseCommitSha ?? ''))
    || !selected?.available || !selected.settings?.credentialVersion) {
    safeOutput(writeOutput, { capability: selection.capability, provider: selected?.provider ?? 'none', result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' });
    return { exitCode: 2, capability: selection.capability, provider: selected?.provider ?? 'none', result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' };
  }
  const productionJob = environment.V1_RELEASE_MANIFEST_FILE === '/app/release-manifest.json';
  const expectedOutput = new RegExp(`^release-evidence/${config.releaseCommitSha}/voice-smoke/${selection.capability}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$`);
  if (productionJob && !writeEvidence && (environment.V1_VOICE_SMOKE_OUTPUT_BUCKET !== GCP_IDENTITY.bucket
    || !expectedOutput.test(String(environment.V1_VOICE_SMOKE_OUTPUT_OBJECT ?? '')))) {
    const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode: 'VOICE_EVIDENCE_OUTPUT_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 2, ...output };
  }
  const persistEvidence = writeEvidence ?? ((record) => defaultWriteEvidence(record, environment));
  const googleV2 = (selection.capability === 'asr' && selected.provider === 'google-stt-v2')
    || (selection.capability === 'tts' && selected.provider === 'google-tts');
  if ((selection.capability === 'asr' && selected.provider === 'google-stt-v2'
      && (selection.mode !== 'generated-fixtures' || config.tts.provider !== 'google-tts' || !config.tts.available))
    || (selection.capability === 'asr' && selected.provider !== 'google-stt-v2' && selection.mode !== 'reviewed-file')) {
    const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode: 'VOICE_PROVIDER_MISCONFIGURED' };
    safeOutput(writeOutput, output);
    return { exitCode: 2, ...output };
  }

  let runtimeIdentity = null;
  if (googleV2) {
    try { runtimeIdentity = await resolveRuntimeIdentity(); } catch { runtimeIdentity = null; }
    if (runtimeIdentity !== RUNTIME_IDENTITY) {
      const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode: 'VOICE_RUNTIME_IDENTITY_MISMATCH' };
      safeOutput(writeOutput, output);
      return { exitCode: 2, ...output };
    }
  }

  let initialGit;
  try { initialGit = await inspectGit(environment); } catch { initialGit = null; }
  if (!validFrozenGit(initialGit, config.releaseCommitSha)) {
    const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode: 'VOICE_RELEASE_GIT_STATE_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 2, ...output };
  }

  let result;
  let fixture = {};
  let samples = null;
  let providerFailure;
  try {
    if (selection.capability === 'tts' && selected.provider === 'google-tts') {
      const provider = createTts(selected);
      samples = [];
      for (const definition of FIXTURE_DEFINITIONS) {
        const synthesized = await provider.synthesize(definition.text, { responseLanguage: definition.responseLanguage });
        const validated = await decodeCanonicalMp3(synthesized.buffer);
        samples.push({
          responseLanguage: definition.responseLanguage,
          locale: definition.locale,
          voiceName: definition.voiceName,
          latencyMs: Math.max(0, Number(synthesized.latencyMs) || 0),
          audioSha256: validated.sha256,
          audioByteLength: validated.byteLength,
          decoder: validated.decoder,
          decodedSampleCount: validated.decodedSampleCount,
          decodedSampleRate: validated.decodedSampleRate,
          decodedChannelCount: validated.decodedChannelCount,
          decodedDurationMs: validated.decodedDurationMs,
          decodable: true,
        });
      }
    } else if (selection.capability === 'tts') {
      result = await createTts(selected).synthesize(FIXED_TTS_PHRASE);
    } else if (selected.provider === 'google-stt-v2') {
      const fixtureProvider = createTts(config.tts);
      const asr = createAsr(selected);
      const fixtureGeneratorConfigDigest = providerConfigDigest(config.tts, 'tts');
      samples = [];
      for (const definition of FIXTURE_DEFINITIONS) {
        const generated = await fixtureProvider.synthesizeLinear16(definition.text, {
          responseLanguage: definition.responseLanguage,
        });
        const validated = validateCanonicalWav(generated.buffer);
        const transcript = await asr.transcribe(validated.buffer, {
          responseLanguage: definition.responseLanguage,
        });
        samples.push({
          responseLanguage: definition.responseLanguage,
          locale: definition.locale,
          referenceId: definition.referenceId,
          fixtureOrigin: 'google-tts-linear16-v1',
          fixtureVoiceName: definition.voiceName,
          fixtureGeneratorContractVersion: voiceEvidenceContracts.googleFixtureGenerator,
          fixtureGeneratorConfigDigest,
          fixtureTtsLatencyMs: Math.max(0, Number(generated.latencyMs) || 0),
          fixtureSha256: validated.sha256,
          fixtureDurationMs: validated.durationMs,
          fixtureByteLength: validated.byteLength,
          ...transcriptMetrics(transcript.transcript, definition.text),
          asrLatencyMs: Math.max(0, Number(transcript.latencyMs) || 0),
        });
      }
    } else {
      const bytes = await readFile(selection.asrFile);
      const validated = validateCanonicalWav(bytes);
      result = await createAsr(selected).transcribe(bytes);
      fixture = {
        fixtureSha256: validated.sha256,
        fixtureDurationMs: validated.durationMs,
      };
    }
  } catch (error) {
    providerFailure = error;
  }

  let finalGit;
  try { finalGit = await inspectGit(environment); } catch { finalGit = null; }
  if (!validFrozenGit(finalGit, config.releaseCommitSha)) {
    const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode: 'VOICE_RELEASE_GIT_STATE_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }
  if (providerFailure) {
    const errorCode = typeof providerFailure?.code === 'string' && /^VOICE_[A-Z0-9_]+$/.test(providerFailure.code)
      ? providerFailure.code
      : 'VOICE_SMOKE_FAILED';
    const output = { capability: selection.capability, provider: selected.provider, result: 'fail', errorCode };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }

  try {
    const contractVersion = selection.capability === 'asr'
      ? selected.provider === 'google-stt-v2'
        ? voiceEvidenceContracts.googleAsr
        : voiceEvidenceContracts.asr
      : selected.provider === 'azure'
        ? voiceEvidenceContracts.azureTts
        : selected.provider === 'google-tts'
          ? voiceEvidenceContracts.googleTts
          : voiceEvidenceContracts.minimaxTts;
    const record = finalizeEvidenceRecord({
      schemaVersion: googleV2 ? 2 : 1,
      commitSha: config.releaseCommitSha,
      capability: selection.capability,
      provider: selected.provider,
      contractVersion,
      providerConfigDigest: providerConfigDigest(selected, selection.capability),
      ...(googleV2 ? { runtimeIdentity, samples } : fixture),
      occurredAt: new Date(now()).toISOString(),
      result: 'pass',
      ...(googleV2 ? {} : { latencyMs: Math.max(0, Number(result.latencyMs) || 0) }),
    });
    await persistEvidence(record);
    const output = {
      capability: selection.capability,
      provider: selected.provider,
      result: 'pass',
      ...(googleV2 ? { runtimeIdentity: record.runtimeIdentity, sampleCount: record.samples.length }
        : { latencyMs: record.latencyMs }),
      ...(!googleV2 && selection.capability === 'asr' ? {
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
