import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  finalizeEvidenceRecord,
  iosVoiceWaiverContract,
} from '../src/services/voice-evidence.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/;

function exactArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) return null;
  const values = {};
  for (const argument of argv) {
    if (typeof argument !== 'string') return null;
    const separator = argument.indexOf('=');
    if (separator < 1) return null;
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!['--release-sha', '--destination', '--confirm-owner'].includes(name)
      || Object.hasOwn(values, name)) return null;
    values[name] = value;
  }
  if (!RELEASE_SHA.test(values['--release-sha'] ?? '')
    || !isAbsolute(values['--destination'] ?? '')
    || extname(values['--destination']).toLowerCase() !== '.json'
    || values['--confirm-owner'] !== iosVoiceWaiverContract.approvedBy) return null;
  return {
    releaseSha: values['--release-sha'],
    destination: values['--destination'],
  };
}

async function defaultWriteArtifact({ filePath, contents }) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

export async function runIosVoiceWaiver({
  argv = process.argv.slice(2),
  now = () => new Date(),
  writeArtifact = defaultWriteArtifact,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) {
    return publish(writeOutput, 2, {
      status: 'not-run',
      code: 'IOS_VOICE_WAIVER_CONFIRMATION_REQUIRED',
    });
  }

  let approvedAt;
  try {
    const currentTime = new Date(now());
    if (!Number.isFinite(currentTime.getTime())) throw new Error('invalid clock');
    approvedAt = currentTime.toISOString();
  } catch {
    return publish(writeOutput, 2, {
      status: 'not-run',
      code: 'IOS_VOICE_WAIVER_TIME_INVALID',
    });
  }
  const expiresAt = new Date(Date.parse(approvedAt) + iosVoiceWaiverContract.durationMs).toISOString();
  const record = finalizeEvidenceRecord({
    schemaVersion: iosVoiceWaiverContract.schemaVersion,
    commitSha: selection.releaseSha,
    capability: iosVoiceWaiverContract.capability,
    decision: iosVoiceWaiverContract.decision,
    scope: iosVoiceWaiverContract.scope,
    approvedBy: iosVoiceWaiverContract.approvedBy,
    approvedAt,
    expiresAt,
    reasonCode: iosVoiceWaiverContract.reasonCode,
    limitations: [...iosVoiceWaiverContract.limitations],
    result: iosVoiceWaiverContract.result,
  });
  const contents = `${canonicalJson(record)}\n`;
  try {
    await writeArtifact({ filePath: selection.destination, contents, record });
  } catch (error) {
    return publish(writeOutput, 1, {
      status: 'failed',
      code: error?.code === 'EEXIST'
        ? 'IOS_VOICE_WAIVER_DESTINATION_EXISTS'
        : 'IOS_VOICE_WAIVER_WRITE_FAILED',
    });
  }

  return publish(writeOutput, 0, {
    destination: selection.destination,
    artifactSha256: record.artifactSha256,
    approvedAt,
    expiresAt,
    decision: record.decision,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runIosVoiceWaiver();
  process.exitCode = result.exitCode;
}
