import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateCanonicalWav } from '../src/media/canonical-wav.js';
import {
  finalizeEvidenceRecord,
  iosVoiceEvidenceContract,
  iosVoiceNormalizationBinding,
} from '../src/services/voice-evidence.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^\d+(?:\.\d+){1,2}$/;
const REPORT_KEYS = Object.freeze([
  'schemaVersion', 'reportSource', 'deviceRunId', 'deviceModelIdentifier', 'iosVersion',
  'safariVersion', 'captureMimeType', 'observedAt', 'rawCapture', 'normalizedWav',
  'normalizationSteps',
]);
const RAW_BINDING_KEYS = Object.freeze(['sha256', 'byteLength']);
const STEPS_BINDING_KEYS = Object.freeze(['sha256', 'byteLength']);
const WAV_BINDING_KEYS = Object.freeze([
  'sha256', 'byteLength', 'durationMs', 'normalizerContractVersion',
]);
const NORMALIZATION_KEYS = Object.freeze([
  'schemaVersion', 'source', 'deviceRunId', 'rawCapture', 'normalizedWav',
  'normalizer', 'steps',
]);
const NORMALIZATION_RAW_KEYS = Object.freeze(['sha256', 'byteLength', 'mimeType']);
const NORMALIZER_KEYS = Object.freeze(['tool', 'version', 'exitCode', 'arguments']);
const STEP_KEYS = Object.freeze(['id', 'outcome', 'observedAt']);
const ALLOWED_MP4_BRANDS = new Set(['M4A ', 'isom', 'mp41', 'mp42', 'iso2', 'iso5', 'iso6', 'qt  ']);
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);

function exactOwnKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const expected = new Set(keys);
  return actual.length === keys.length && actual.every((key) => expected.has(key));
}

function exactArguments(argv) {
  if (argv.length !== 9
    || argv[0] !== '--device-report' || !isAbsolute(argv[1])
    || argv[2] !== '--raw-capture' || !isAbsolute(argv[3])
    || argv[4] !== '--canonical-wav' || !isAbsolute(argv[5])
    || argv[6] !== '--normalization-steps' || !isAbsolute(argv[7])
    || argv[8] !== '--confirm-real-iphone-safari') return null;
  return { reportPath: argv[1], rawCapturePath: argv[3], wavPath: argv[5], stepsPath: argv[7] };
}

async function defaultInspectGit() {
  const options = { cwd: productionRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true };
  const before = (await executeFile('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
  const status = (await executeFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], options)).stdout;
  const after = (await executeFile('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
  return { commitSha: after, clean: before === after && status.length === 0 };
}

async function defaultWriteEvidence(record) {
  const directory = join(productionRoot, 'reports', 'ios');
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${record.commitSha}-ios-voice-${record.artifactSha256}.json`);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return filePath;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recentTimestamp(value, now, maximumAgeMs = 24 * 60 * 60_000) {
  const observedAt = Date.parse(value);
  const nowMs = new Date(now).getTime();
  return Number.isFinite(observedAt) && Number.isFinite(nowMs)
    && observedAt <= nowMs + 5 * 60_000 && nowMs - observedAt <= maximumAgeMs;
}

function exactBinding(actual, expected) {
  return actual?.sha256 === expected.sha256 && actual?.byteLength === expected.byteLength;
}

function validateIsoBmffAudio(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  if (buffer.length <= 32 || buffer.length > 64 * 1_024 * 1_024) throw new Error('invalid raw capture size');
  const boxes = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('truncated mp4 box');
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (!/^[A-Za-z0-9 ]{4}$/.test(type)) throw new Error('invalid mp4 box type');
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > buffer.length) throw new Error('truncated extended mp4 box');
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('oversized mp4 box');
      boxSize = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = buffer.length - offset;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > buffer.length) {
      throw new Error('invalid mp4 box size');
    }
    boxes.push({ type, payload: buffer.subarray(offset + headerSize, offset + boxSize) });
    offset += boxSize;
    if (size32 === 0 && offset !== buffer.length) throw new Error('non-final open mp4 box');
  }
  if (offset !== buffer.length || boxes[0]?.type !== 'ftyp') throw new Error('invalid mp4 traversal');
  const ftyp = boxes[0].payload;
  if (ftyp.length < 8 || ftyp.length % 4 !== 0) throw new Error('invalid mp4 brands');
  const brands = [];
  brands.push(ftyp.subarray(0, 4).toString('ascii'));
  for (let index = 8; index < ftyp.length; index += 4) brands.push(ftyp.subarray(index, index + 4).toString('ascii'));
  if (!brands.some((brand) => ALLOWED_MP4_BRANDS.has(brand))) throw new Error('unsupported mp4 audio brand');
  const moov = boxes.find((box) => box.type === 'moov')?.payload;
  const mdat = boxes.find((box) => box.type === 'mdat')?.payload;
  if (!moov || !mdat || mdat.length === 0 || !mdat.some((byte) => byte !== 0)
    || !moov.includes(Buffer.from('soun', 'ascii'))
    || !['mp4a', 'Opus'].some((codec) => moov.includes(Buffer.from(codec, 'ascii')))) {
    throw new Error('invalid mp4 audio track');
  }
  return { buffer, byteLength: buffer.length, sha256: sha256(buffer) };
}

function reportValid(report, facts, now) {
  const observedAt = Date.parse(report?.observedAt);
  return exactOwnKeys(report, REPORT_KEYS)
    && exactOwnKeys(report.rawCapture, RAW_BINDING_KEYS)
    && exactOwnKeys(report.normalizedWav, WAV_BINDING_KEYS)
    && exactOwnKeys(report.normalizationSteps, STEPS_BINDING_KEYS)
    && report.schemaVersion === iosVoiceEvidenceContract.reportSchemaVersion
    && report.reportSource === iosVoiceEvidenceContract.reportSource
    && UUID.test(String(report.deviceRunId ?? ''))
    && /^iPhone\d{1,2},\d{1,2}$/.test(String(report.deviceModelIdentifier ?? ''))
    && VERSION.test(String(report.iosVersion ?? ''))
    && VERSION.test(String(report.safariVersion ?? ''))
    && report.captureMimeType === 'audio/mp4'
    && exactBinding(report.rawCapture, facts.rawCapture)
    && exactBinding(report.normalizedWav, facts.wav)
    && report.normalizedWav.durationMs === facts.wav.durationMs
    && report.normalizedWav.normalizerContractVersion === 'canonical-wav-v1'
    && exactBinding(report.normalizationSteps, facts.steps)
    && Number.isFinite(observedAt) && recentTimestamp(report.observedAt, now);
}

function stepsValid(steps, facts, report) {
  if (!exactOwnKeys(steps, NORMALIZATION_KEYS)
    || !exactOwnKeys(steps.rawCapture, NORMALIZATION_RAW_KEYS)
    || !exactOwnKeys(steps.normalizedWav, WAV_BINDING_KEYS)
    || !exactOwnKeys(steps.normalizer, NORMALIZER_KEYS)
    || steps.schemaVersion !== iosVoiceEvidenceContract.normalizationStepsSchemaVersion
    || steps.source !== iosVoiceEvidenceContract.normalizationStepsSource
    || steps.deviceRunId !== report.deviceRunId
    || steps.rawCapture.mimeType !== 'audio/mp4'
    || !exactBinding(steps.rawCapture, facts.rawCapture)
    || !exactBinding(steps.normalizedWav, facts.wav)
    || steps.normalizedWav.durationMs !== facts.wav.durationMs
    || steps.normalizedWav.normalizerContractVersion !== 'canonical-wav-v1'
    || steps.normalizer.tool !== iosVoiceEvidenceContract.normalizer.tool
    || !VERSION.test(String(steps.normalizer.version ?? ''))
    || steps.normalizer.exitCode !== 0
    || JSON.stringify(steps.normalizer.arguments) !== JSON.stringify(iosVoiceEvidenceContract.normalizer.arguments)
    || !Array.isArray(steps.steps)
    || steps.steps.length !== iosVoiceEvidenceContract.stepIds.length) return false;
  return steps.steps.every((step, index) => (
    exactOwnKeys(step, STEP_KEYS)
    && step.id === iosVoiceEvidenceContract.stepIds[index]
    && step.outcome === 'pass'
    && step.observedAt === report.observedAt
  ));
}

function safeOutput(writeOutput, value) {
  writeOutput(`${JSON.stringify(value)}\n`);
}

export async function runIosVoiceEvidence({
  argv = process.argv.slice(2),
  environment = process.env,
  inspectGit = defaultInspectGit,
  writeEvidence = defaultWriteEvidence,
  writeOutput = (value) => process.stdout.write(value),
  now = () => new Date(),
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) {
    const output = { result: 'not_run', errorCode: 'IOS_VOICE_CONFIRMATION_REQUIRED' };
    safeOutput(writeOutput, output);
    return { exitCode: 2, ...output };
  }
  const commitSha = String(environment.V1_RELEASE_COMMIT_SHA ?? '');
  if (!RELEASE_SHA.test(commitSha)) {
    const output = { result: 'fail', errorCode: 'IOS_VOICE_RELEASE_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 2, ...output };
  }
  let initialGit;
  try { initialGit = await inspectGit(); } catch { initialGit = null; }
  if (initialGit?.clean !== true || initialGit.commitSha !== commitSha) {
    const output = { result: 'fail', errorCode: 'IOS_VOICE_RELEASE_GIT_STATE_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 2, ...output };
  }

  let reportBytes;
  let report;
  let rawCapture;
  let wav;
  let stepsBytes;
  let steps;
  try {
    rawCapture = validateIsoBmffAudio(await readFile(selection.rawCapturePath));
    wav = validateCanonicalWav(await readFile(selection.wavPath));
    stepsBytes = await readFile(selection.stepsPath);
    if (stepsBytes.length === 0 || stepsBytes.length > 64 * 1_024) throw new Error('invalid steps size');
    steps = JSON.parse(stepsBytes.toString('utf8'));
    reportBytes = await readFile(selection.reportPath);
    if (reportBytes.length === 0 || reportBytes.length > 64 * 1024) throw new Error('invalid report size');
    report = JSON.parse(reportBytes.toString('utf8'));
    const facts = {
      rawCapture,
      wav,
      steps: { sha256: sha256(stepsBytes), byteLength: stepsBytes.length },
    };
    if (!reportValid(report, facts, now()) || !stepsValid(steps, facts, report)) {
      throw new Error('invalid bound device evidence');
    }
  } catch {
    const output = { result: 'fail', errorCode: 'IOS_VOICE_EVIDENCE_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }

  let finalGit;
  try { finalGit = await inspectGit(); } catch { finalGit = null; }
  if (finalGit?.clean !== true || finalGit.commitSha !== commitSha) {
    const output = { result: 'fail', errorCode: 'IOS_VOICE_RELEASE_GIT_STATE_INVALID' };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }

  const boundEvidence = {
    schemaVersion: iosVoiceEvidenceContract.schemaVersion,
    commitSha,
    capability: 'ios-voice',
    normalizerContractVersion: 'canonical-wav-v1',
    reportSource: report.reportSource,
    deviceReportSha256: sha256(reportBytes),
    deviceReportByteLength: reportBytes.length,
    deviceRunId: report.deviceRunId.toLowerCase(),
    deviceModelIdentifier: report.deviceModelIdentifier,
    iosVersion: report.iosVersion,
    safariVersion: report.safariVersion,
    captureMimeType: report.captureMimeType,
    deviceObservedAt: report.observedAt,
    rawCaptureFormat: iosVoiceEvidenceContract.rawCaptureFormat,
    rawCaptureSha256: rawCapture.sha256,
    rawCaptureByteLength: rawCapture.byteLength,
    fixtureSha256: wav.sha256,
    fixtureDurationMs: wav.durationMs,
    fixtureByteLength: wav.byteLength,
    normalizationStepsSha256: sha256(stepsBytes),
    normalizationStepsByteLength: stepsBytes.length,
    verifiedStepIds: [...iosVoiceEvidenceContract.stepIds],
    occurredAt: new Date(now()).toISOString(),
    result: 'pass',
  };
  boundEvidence.normalizationBindingSha256 = iosVoiceNormalizationBinding(boundEvidence);
  const record = finalizeEvidenceRecord(boundEvidence);
  try { await writeEvidence(record); } catch {
    const output = { result: 'fail', errorCode: 'IOS_VOICE_EVIDENCE_WRITE_FAILED' };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }
  const output = {
    result: 'pass', deviceRunId: record.deviceRunId,
    deviceReportSha256: record.deviceReportSha256,
    rawCaptureSha256: record.rawCaptureSha256,
    fixtureSha256: record.fixtureSha256,
    normalizationBindingSha256: record.normalizationBindingSha256,
    artifactSha256: record.artifactSha256,
  };
  safeOutput(writeOutput, output);
  return { exitCode: 0, ...output };
}

const directPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (directPath === fileURLToPath(import.meta.url)) {
  const result = await runIosVoiceEvidence();
  process.exitCode = result.exitCode;
}
