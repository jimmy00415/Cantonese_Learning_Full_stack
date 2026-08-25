import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateCanonicalWav } from '../src/media/canonical-wav.js';
import { finalizeEvidenceRecord } from '../src/services/voice-evidence.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^\d+(?:\.\d+){1,2}$/;
const REPORT_KEYS = Object.freeze([
  'schemaVersion', 'reportSource', 'deviceRunId', 'deviceModelClass', 'iosVersion',
  'safariVersion', 'captureMimeType', 'observedAt', 'assertions',
]);
const ASSERTION_KEYS = Object.freeze([
  'normalizedCanonicalWav', 'autoStop55Seconds', 'permissionCleanup', 'cancelCleanup',
  'oneIdempotentUpload', 'editableTranscript', 'textFallback', 'noRawContainerUpload',
]);
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);

function exactOwnKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const expected = new Set(keys);
  return actual.length === keys.length && actual.every((key) => expected.has(key));
}

function exactArguments(argv) {
  if (argv.length !== 5
    || argv[0] !== '--device-report' || !isAbsolute(argv[1])
    || argv[2] !== '--canonical-wav' || !isAbsolute(argv[3])
    || argv[4] !== '--confirm-real-iphone-safari') return null;
  return { reportPath: argv[1], wavPath: argv[3] };
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

function reportValid(report, now) {
  const observedAt = Date.parse(report?.observedAt);
  const nowMs = new Date(now).getTime();
  return exactOwnKeys(report, REPORT_KEYS)
    && exactOwnKeys(report.assertions, ASSERTION_KEYS)
    && report.schemaVersion === 1
    && report.reportSource === 'real-iphone-safari-manual-v1'
    && UUID.test(String(report.deviceRunId ?? ''))
    && /^iPhone(?:\s+[A-Za-z0-9.+-]+){1,4}$/.test(String(report.deviceModelClass ?? ''))
    && VERSION.test(String(report.iosVersion ?? ''))
    && VERSION.test(String(report.safariVersion ?? ''))
    && report.captureMimeType === 'audio/mp4'
    && ASSERTION_KEYS.every((key) => report.assertions[key] === true)
    && Number.isFinite(observedAt) && Number.isFinite(nowMs)
    && observedAt <= nowMs + 5 * 60_000 && nowMs - observedAt <= 24 * 60 * 60_000;
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
  let wav;
  try {
    reportBytes = await readFile(selection.reportPath);
    if (reportBytes.length === 0 || reportBytes.length > 64 * 1024) throw new Error('invalid report size');
    report = JSON.parse(reportBytes.toString('utf8'));
    if (!reportValid(report, now())) throw new Error('invalid device report');
    wav = validateCanonicalWav(await readFile(selection.wavPath));
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

  const record = finalizeEvidenceRecord({
    schemaVersion: 2,
    commitSha,
    capability: 'ios-voice',
    normalizerContractVersion: 'canonical-wav-v1',
    reportSource: report.reportSource,
    deviceReportSha256: createHash('sha256').update(reportBytes).digest('hex'),
    deviceRunId: report.deviceRunId.toLowerCase(),
    deviceModelClass: report.deviceModelClass,
    iosVersion: report.iosVersion,
    safariVersion: report.safariVersion,
    captureMimeType: report.captureMimeType,
    fixtureSha256: wav.sha256,
    fixtureDurationMs: wav.durationMs,
    fixtureByteLength: wav.byteLength,
    assertions: report.assertions,
    occurredAt: new Date(now()).toISOString(),
    result: 'pass',
  });
  try { await writeEvidence(record); } catch {
    const output = { result: 'fail', errorCode: 'IOS_VOICE_EVIDENCE_WRITE_FAILED' };
    safeOutput(writeOutput, output);
    return { exitCode: 1, ...output };
  }
  const output = {
    result: 'pass', deviceRunId: record.deviceRunId,
    deviceReportSha256: record.deviceReportSha256,
    fixtureSha256: record.fixtureSha256,
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
