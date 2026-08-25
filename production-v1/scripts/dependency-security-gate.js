import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRODUCTION_ROOT = resolve(dirname(SCRIPT_PATH), '..');

function canonicalPolicy() {
  return {
    schemaVersion: 1,
    exceptionId: 'GHSA-w5hq-g745-h8pq',
    expiresAt: '2026-09-26T00:00:00.000Z',
    auditReportVersion: 2,
    advisory: {
      source: 1119441,
      name: 'uuid',
      dependency: 'uuid',
      title: 'uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided',
      url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
      severity: 'moderate',
      cwe: ['CWE-787', 'CWE-1285'],
      cvss: {
        score: 7.5,
        vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N',
      },
      range: '<11.1.1',
    },
    vulnerabilities: {
      gaxios: {
        name: 'gaxios',
        severity: 'moderate',
        isDirect: false,
        via: ['uuid'],
        effects: [],
        range: '6.4.0 - 6.7.1',
        nodes: [
          'node_modules/@google-cloud/storage/node_modules/gaxios',
          'node_modules/gtoken/node_modules/gaxios',
        ],
        fixAvailable: true,
      },
      uuid: {
        name: 'uuid',
        severity: 'moderate',
        isDirect: false,
        effects: ['gaxios'],
        range: '<11.1.1',
        nodes: ['node_modules/uuid'],
        fixAvailable: true,
      },
    },
    installation: {
      lockfileVersion: 3,
      parentPackages: [
        {
          path: 'node_modules/@google-cloud/storage',
          name: '@google-cloud/storage',
          version: '8.0.1',
          dependency: { name: 'gaxios', range: '^6.0.2' },
        },
        {
          path: 'node_modules/gtoken',
          name: 'gtoken',
          version: '7.1.0',
          dependency: { name: 'gaxios', range: '^6.0.0' },
        },
      ],
      gaxiosCopies: [
        {
          path: 'node_modules/@google-cloud/storage/node_modules/gaxios',
          version: '6.7.1',
          uuidRange: '^9.0.1',
          sourcePath: 'build/src/gaxios.js',
          sourceSha256: '9a9988f38306d08faaa73aa0316ed0c6eed519ef8cfd3561273a45249eaf94b2',
        },
        {
          path: 'node_modules/gtoken/node_modules/gaxios',
          version: '6.7.1',
          uuidRange: '^9.0.1',
          sourcePath: 'build/src/gaxios.js',
          sourceSha256: '9a9988f38306d08faaa73aa0316ed0c6eed519ef8cfd3561273a45249eaf94b2',
        },
      ],
      uuidPackage: {
        path: 'node_modules/uuid',
        version: '9.0.1',
      },
      sourceContract: {
        requireStatement: 'const uuid_1 = require("uuid");',
        allowedMethod: 'v4',
        zeroArgumentCall: '(0, uuid_1.v4)()',
      },
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const DEPENDENCY_SECURITY_POLICY = deepFreeze(canonicalPolicy());

function gateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, expected) {
  return plainRecord(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function validVulnerabilityCounts(value) {
  const keys = ['critical', 'high', 'info', 'low', 'moderate', 'total'];
  if (!exactKeys(value, keys)
    || keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  return value.total === value.info + value.low + value.moderate + value.high + value.critical;
}

function validDependencyCounts(value) {
  const keys = ['dev', 'optional', 'peer', 'peerOptional', 'prod', 'total'];
  return exactKeys(value, keys)
    && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function expectedVulnerabilities(policy) {
  return {
    gaxios: structuredClone(policy.vulnerabilities.gaxios),
    uuid: {
      ...structuredClone(policy.vulnerabilities.uuid),
      via: [structuredClone(policy.advisory)],
    },
  };
}

function validatePolicy(policy) {
  if (!isDeepStrictEqual(policy, canonicalPolicy())) {
    throw gateError('DEPENDENCY_POLICY_INVALID');
  }
}

function parseManifest(files, path) {
  const file = files?.[path];
  if (!plainRecord(file) || typeof file.text !== 'string') {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  try {
    const manifest = JSON.parse(file.text);
    if (!plainRecord(manifest)) throw new TypeError('package manifest must be an object');
    return manifest;
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

export function evaluateInstalledContract({ packageLock, files, policy } = {}) {
  validatePolicy(policy);
  const installation = policy.installation;
  if (!plainRecord(packageLock)
    || !plainRecord(packageLock.packages)
    || !plainRecord(files)
    || !Number.isSafeInteger(packageLock.lockfileVersion)) {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  if (packageLock.lockfileVersion !== installation.lockfileVersion) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }

  const expectedFilePaths = [];
  for (const parent of installation.parentPackages) {
    const locked = packageLock.packages[parent.path];
    if (!plainRecord(locked) || !plainRecord(locked.dependencies)) {
      throw gateError('DEPENDENCY_CONTRACT_INVALID');
    }
    const manifestPath = `${parent.path}/package.json`;
    const manifest = parseManifest(files, manifestPath);
    expectedFilePaths.push(manifestPath);
    if (locked.version !== parent.version
      || locked.dependencies[parent.dependency.name] !== parent.dependency.range
      || manifest.name !== parent.name
      || manifest.version !== parent.version
      || !plainRecord(manifest.dependencies)
      || manifest.dependencies[parent.dependency.name] !== parent.dependency.range) {
      throw gateError('DEPENDENCY_CONTRACT_DRIFT');
    }
  }

  for (const copy of installation.gaxiosCopies) {
    const locked = packageLock.packages[copy.path];
    if (!plainRecord(locked) || !plainRecord(locked.dependencies)) {
      throw gateError('DEPENDENCY_CONTRACT_INVALID');
    }
    const manifestPath = `${copy.path}/package.json`;
    const manifest = parseManifest(files, manifestPath);
    expectedFilePaths.push(manifestPath);
    if (locked.version !== copy.version
      || locked.dependencies.uuid !== copy.uuidRange
      || manifest.name !== 'gaxios'
      || manifest.version !== copy.version
      || !plainRecord(manifest.dependencies)
      || manifest.dependencies.uuid !== copy.uuidRange) {
      throw gateError('DEPENDENCY_CONTRACT_DRIFT');
    }

    const sourcePath = `${copy.path}/${copy.sourcePath}`;
    const sourceFile = files[sourcePath];
    expectedFilePaths.push(sourcePath);
    if (!plainRecord(sourceFile)
      || typeof sourceFile.text !== 'string'
      || typeof sourceFile.sha256 !== 'string') {
      throw gateError('DEPENDENCY_CONTRACT_INVALID');
    }
    const source = sourceFile.text;
    const methods = [...source.matchAll(/\buuid_1\.([A-Za-z_$][\w$]*)/g)]
      .map((match) => match[1]);
    if (sourceFile.sha256 !== copy.sourceSha256
      || occurrences(source, installation.sourceContract.requireStatement) !== 1
      || occurrences(source, installation.sourceContract.zeroArgumentCall) !== 1
      || !isDeepStrictEqual(methods, [installation.sourceContract.allowedMethod])
      || /\buuid_1\.(?:v3|v5|v6)\b/.test(source)) {
      throw gateError('DEPENDENCY_CONTRACT_DRIFT');
    }
  }

  const uuid = installation.uuidPackage;
  const lockedUuid = packageLock.packages[uuid.path];
  if (!plainRecord(lockedUuid)) throw gateError('DEPENDENCY_CONTRACT_INVALID');
  const uuidManifestPath = `${uuid.path}/package.json`;
  const uuidManifest = parseManifest(files, uuidManifestPath);
  expectedFilePaths.push(uuidManifestPath);
  if (lockedUuid.version !== uuid.version
    || uuidManifest.name !== 'uuid'
    || uuidManifest.version !== uuid.version) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }

  const vulnerableGaxiosPaths = Object.entries(packageLock.packages)
    .filter(([path, entry]) => path.endsWith('node_modules/gaxios')
      && plainRecord(entry)
      && entry.version === '6.7.1')
    .map(([path]) => path);
  const reviewedGaxiosPaths = installation.gaxiosCopies.map(({ path }) => path);
  const vulnerableUuidPaths = Object.entries(packageLock.packages)
    .filter(([path, entry]) => path.endsWith('node_modules/uuid')
      && plainRecord(entry)
      && entry.version === uuid.version)
    .map(([path]) => path);
  if (!isDeepStrictEqual(vulnerableGaxiosPaths.sort(), reviewedGaxiosPaths.sort())
    || !isDeepStrictEqual(vulnerableUuidPaths.sort(), [uuid.path])
    || !isDeepStrictEqual(Object.keys(files).sort(), expectedFilePaths.sort())) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }

  return {
    gaxiosCopies: installation.gaxiosCopies.length,
    uuidMethod: installation.sourceContract.allowedMethod,
    uuidVersion: uuid.version,
  };
}

export function evaluateAuditReport({ report, policy, now } = {}) {
  validatePolicy(policy);
  const current = new Date(now);
  const expiry = new Date(policy?.expiresAt);
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(expiry.getTime())) {
    throw gateError('DEPENDENCY_POLICY_INVALID');
  }
  if (current.getTime() >= expiry.getTime()) throw gateError('DEPENDENCY_EXCEPTION_EXPIRED');

  if (!exactKeys(report, ['auditReportVersion', 'metadata', 'vulnerabilities'])
    || report.auditReportVersion !== policy?.auditReportVersion
    || !plainRecord(report.vulnerabilities)
    || !exactKeys(report.metadata, ['dependencies', 'vulnerabilities'])
    || !validVulnerabilityCounts(report.metadata.vulnerabilities)
    || !validDependencyCounts(report.metadata.dependencies)) {
    throw gateError('DEPENDENCY_AUDIT_INVALID');
  }

  if (!isDeepStrictEqual(report.vulnerabilities, expectedVulnerabilities(policy))
    || !isDeepStrictEqual(report.metadata.vulnerabilities, {
      info: 0,
      low: 0,
      moderate: 2,
      high: 0,
      critical: 0,
      total: 2,
    })) {
    throw gateError('DEPENDENCY_AUDIT_NOT_ALLOWED');
  }

  return {
    advisoryId: policy.exceptionId,
    expiresAt: policy.expiresAt,
    vulnerabilityCount: 2,
  };
}

function defaultHashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readInstallationFiles({ readTextFile, hashText, policy }) {
  if (typeof readTextFile !== 'function' || typeof hashText !== 'function') {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  const paths = [
    ...policy.installation.parentPackages.map(({ path }) => `${path}/package.json`),
    ...policy.installation.gaxiosCopies.flatMap(({ path, sourcePath }) => [
      `${path}/package.json`,
      `${path}/${sourcePath}`,
    ]),
    `${policy.installation.uuidPackage.path}/package.json`,
  ];
  const sourcePaths = new Set(policy.installation.gaxiosCopies
    .map(({ path, sourcePath }) => `${path}/${sourcePath}`));
  const files = {};
  try {
    for (const path of paths) {
      const text = readTextFile(path);
      if (typeof text !== 'string') throw new TypeError('installed file must be text');
      files[path] = sourcePaths.has(path)
        ? { text, sha256: hashText(text, path) }
        : { text };
    }
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  return files;
}

export function runDependencySecurityGate({
  cwd,
  now,
  runAudit,
  readTextFile,
  hashText = defaultHashText,
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0 || typeof runAudit !== 'function') {
    throw gateError('DEPENDENCY_AUDIT_COMMAND_FAILED');
  }

  let auditResult;
  try {
    auditResult = runAudit({ cwd, args: ['audit', '--omit=dev', '--json'] });
  } catch {
    throw gateError('DEPENDENCY_AUDIT_COMMAND_FAILED');
  }
  if (!plainRecord(auditResult)
    || auditResult.error
    || auditResult.status !== 1
    || auditResult.signal !== null
    || typeof auditResult.stdout !== 'string'
    || typeof auditResult.stderr !== 'string'
    || auditResult.stderr.trim().length > 0) {
    throw gateError('DEPENDENCY_AUDIT_COMMAND_FAILED');
  }

  const output = auditResult.stdout.trim();
  if (output.length === 0) throw gateError('DEPENDENCY_AUDIT_OUTPUT_INVALID');
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw gateError('DEPENDENCY_AUDIT_OUTPUT_INVALID');
  }
  if (plainRecord(report) && Object.hasOwn(report, 'error')) {
    throw gateError('DEPENDENCY_AUDIT_COMMAND_FAILED');
  }

  const auditEvidence = evaluateAuditReport({
    report,
    policy: DEPENDENCY_SECURITY_POLICY,
    now,
  });

  let packageLock;
  try {
    const lockText = readTextFile('package-lock.json');
    if (typeof lockText !== 'string') throw new TypeError('package lock must be text');
    packageLock = JSON.parse(lockText);
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  const installedEvidence = evaluateInstalledContract({
    packageLock,
    files: readInstallationFiles({
      readTextFile,
      hashText,
      policy: DEPENDENCY_SECURITY_POLICY,
    }),
    policy: DEPENDENCY_SECURITY_POLICY,
  });

  return {
    status: 'passed',
    code: 'DEPENDENCY_SECURITY_EXCEPTION_REVIEWED',
    ...auditEvidence,
    ...installedEvidence,
  };
}

function runNpmAudit({ cwd, args }) {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      shell: false,
    });
  }
  if (process.platform === 'win32') throw gateError('DEPENDENCY_AUDIT_COMMAND_FAILED');
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
    shell: false,
  });
}

function safeFailureCode(error) {
  return typeof error?.code === 'string' && /^DEPENDENCY_[A-Z_]+$/.test(error.code)
    ? error.code
    : 'DEPENDENCY_GATE_INTERNAL_ERROR';
}

export function runDependencySecurityGateCli() {
  try {
    const result = runDependencySecurityGate({
      cwd: PRODUCTION_ROOT,
      now: new Date(),
      runAudit: runNpmAudit,
      readTextFile: (path) => readFileSync(resolve(PRODUCTION_ROOT, path), 'utf8'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: safeFailureCode(error),
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = runDependencySecurityGateCli();
}
