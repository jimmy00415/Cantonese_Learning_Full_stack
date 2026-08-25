import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRODUCTION_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const GAXIOS_PACKAGE_TREE_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'build/src/common.d.ts',
  'build/src/common.js',
  'build/src/common.js.map',
  'build/src/gaxios.d.ts',
  'build/src/gaxios.js',
  'build/src/gaxios.js.map',
  'build/src/index.d.ts',
  'build/src/index.js',
  'build/src/index.js.map',
  'build/src/interceptor.d.ts',
  'build/src/interceptor.js',
  'build/src/interceptor.js.map',
  'build/src/retry.d.ts',
  'build/src/retry.js',
  'build/src/retry.js.map',
  'build/src/util.d.ts',
  'build/src/util.js',
  'build/src/util.js.map',
  'package.json',
];
const UUID_PACKAGE_TREE_FILES = [
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE.md',
  'README.md',
  'dist/bin/uuid',
  'dist/commonjs-browser/index.js',
  'dist/commonjs-browser/md5.js',
  'dist/commonjs-browser/native.js',
  'dist/commonjs-browser/nil.js',
  'dist/commonjs-browser/parse.js',
  'dist/commonjs-browser/regex.js',
  'dist/commonjs-browser/rng.js',
  'dist/commonjs-browser/sha1.js',
  'dist/commonjs-browser/stringify.js',
  'dist/commonjs-browser/v1.js',
  'dist/commonjs-browser/v3.js',
  'dist/commonjs-browser/v35.js',
  'dist/commonjs-browser/v4.js',
  'dist/commonjs-browser/v5.js',
  'dist/commonjs-browser/validate.js',
  'dist/commonjs-browser/version.js',
  'dist/esm-browser/index.js',
  'dist/esm-browser/md5.js',
  'dist/esm-browser/native.js',
  'dist/esm-browser/nil.js',
  'dist/esm-browser/parse.js',
  'dist/esm-browser/regex.js',
  'dist/esm-browser/rng.js',
  'dist/esm-browser/sha1.js',
  'dist/esm-browser/stringify.js',
  'dist/esm-browser/v1.js',
  'dist/esm-browser/v3.js',
  'dist/esm-browser/v35.js',
  'dist/esm-browser/v4.js',
  'dist/esm-browser/v5.js',
  'dist/esm-browser/validate.js',
  'dist/esm-browser/version.js',
  'dist/esm-node/index.js',
  'dist/esm-node/md5.js',
  'dist/esm-node/native.js',
  'dist/esm-node/nil.js',
  'dist/esm-node/parse.js',
  'dist/esm-node/regex.js',
  'dist/esm-node/rng.js',
  'dist/esm-node/sha1.js',
  'dist/esm-node/stringify.js',
  'dist/esm-node/v1.js',
  'dist/esm-node/v3.js',
  'dist/esm-node/v35.js',
  'dist/esm-node/v4.js',
  'dist/esm-node/v5.js',
  'dist/esm-node/validate.js',
  'dist/esm-node/version.js',
  'dist/index.js',
  'dist/md5-browser.js',
  'dist/md5.js',
  'dist/native-browser.js',
  'dist/native.js',
  'dist/nil.js',
  'dist/parse.js',
  'dist/regex.js',
  'dist/rng-browser.js',
  'dist/rng.js',
  'dist/sha1-browser.js',
  'dist/sha1.js',
  'dist/stringify.js',
  'dist/uuid-bin.js',
  'dist/v1.js',
  'dist/v3.js',
  'dist/v35.js',
  'dist/v4.js',
  'dist/v5.js',
  'dist/validate.js',
  'dist/version.js',
  'package.json',
  'wrapper.mjs',
];
const UUID_EXPORTS = {
  '.': {
    node: {
      module: './dist/esm-node/index.js',
      require: './dist/index.js',
      import: './wrapper.mjs',
    },
    browser: {
      import: './dist/esm-browser/index.js',
      require: './dist/commonjs-browser/index.js',
    },
    default: './dist/esm-browser/index.js',
  },
  './package.json': './package.json',
};

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
          resolved: 'https://registry.npmjs.org/gaxios/-/gaxios-6.7.1.tgz',
          integrity: 'sha512-LDODD4TMYx7XXdpwxAVRAIAuB0bzv0s+ywFonY46k126qzQHT9ygyoa9tncmOiQmmDrik65UYsEkv3lbfqQ3yQ==',
          packageTreeSha256: '79b81803bf8037ffa1117a3a626d73e161427e01834e5e00bdf99de36529bb2b',
          sourcePath: 'build/src/gaxios.js',
          sourceSha256: '9a9988f38306d08faaa73aa0316ed0c6eed519ef8cfd3561273a45249eaf94b2',
        },
        {
          path: 'node_modules/gtoken/node_modules/gaxios',
          version: '6.7.1',
          uuidRange: '^9.0.1',
          resolved: 'https://registry.npmjs.org/gaxios/-/gaxios-6.7.1.tgz',
          integrity: 'sha512-LDODD4TMYx7XXdpwxAVRAIAuB0bzv0s+ywFonY46k126qzQHT9ygyoa9tncmOiQmmDrik65UYsEkv3lbfqQ3yQ==',
          packageTreeSha256: '79b81803bf8037ffa1117a3a626d73e161427e01834e5e00bdf99de36529bb2b',
          sourcePath: 'build/src/gaxios.js',
          sourceSha256: '9a9988f38306d08faaa73aa0316ed0c6eed519ef8cfd3561273a45249eaf94b2',
        },
      ],
      gaxiosPackage: {
        packageTreeFiles: [...GAXIOS_PACKAGE_TREE_FILES],
        manifest: {
          main: 'build/src/index.js',
          files: ['build/src'],
          exportsPresent: false,
          typePresent: false,
        },
        runtimeSourcePaths: [
          'build/src/common.js',
          'build/src/gaxios.js',
          'build/src/index.js',
          'build/src/interceptor.js',
          'build/src/retry.js',
          'build/src/util.js',
        ],
        entrypoint: {
          path: 'build/src/index.js',
          implementationPath: 'build/src/gaxios.js',
          implementationRequire: 'const gaxios_1 = require("./gaxios");',
        },
      },
      uuidPackage: {
        path: 'node_modules/uuid',
        version: '9.0.1',
        resolved: 'https://registry.npmjs.org/uuid/-/uuid-9.0.1.tgz',
        integrity: 'sha512-b+1eJOlsR9K8HJpow9Ok3fiWOWSIcIzXodvv0rQjVoOVNpWMpxf1wZNpt4y9h10odCNrqnYp1OBzRktckBe3sA==',
        packageTreeSha256: '588984b1885d6848ca4f9773d4a76705bf4e562f2c0057593f76c2f612e4339a',
        packageTreeFiles: [...UUID_PACKAGE_TREE_FILES],
        manifest: {
          main: './dist/index.js',
          exports: structuredClone(UUID_EXPORTS),
          files: [
            'CHANGELOG.md',
            'CONTRIBUTING.md',
            'LICENSE.md',
            'README.md',
            'dist',
            'wrapper.mjs',
          ],
          typePresent: false,
        },
        entrypoint: {
          path: 'dist/index.js',
          v4Require: 'var _v3 = _interopRequireDefault(require("./v4.js"));',
        },
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

function parseStableVersion(value) {
  if (typeof value !== 'string') throw gateError('DEPENDENCY_CONTRACT_INVALID');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw gateError('DEPENDENCY_CONTRACT_INVALID');
  const version = match.slice(1).map(Number);
  if (version.some((part) => !Number.isSafeInteger(part))) {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  return version;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function affectedLockEntries(packages, packageName, isAffected) {
  const suffix = `node_modules/${packageName}`;
  const entries = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path !== suffix && !path.endsWith(`/${suffix}`)) continue;
    if (!plainRecord(entry)) throw gateError('DEPENDENCY_CONTRACT_INVALID');
    const parsed = parseStableVersion(entry.version);
    if (isAffected(parsed)) entries.push(`${path}@${entry.version}`);
  }
  return entries.sort();
}

function parseJsonObjectText(value) {
  if (typeof value !== 'string') throw gateError('DEPENDENCY_CONTRACT_INVALID');
  try {
    const parsed = JSON.parse(value);
    if (!plainRecord(parsed)) throw new TypeError('JSON value must be an object');
    return parsed;
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
}

function reviewedPackageTree(packageTrees, packagePath, {
  expectedFiles,
  expectedSha256,
  textPaths,
}) {
  const tree = packageTrees?.[packagePath];
  if (!exactKeys(tree, ['files', 'texts', 'treeSha256'])
    || !Array.isArray(tree.files)
    || tree.files.some((path) => typeof path !== 'string'
      || path.length === 0
      || path.includes('\\')
      || path.startsWith('/')
      || path.split('/').includes('..'))
    || !plainRecord(tree.texts)
    || typeof tree.treeSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(tree.treeSha256)) {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  if (!isDeepStrictEqual(tree.files, expectedFiles)
    || tree.treeSha256 !== expectedSha256
    || !isDeepStrictEqual(Object.keys(tree.texts).sort(), [...textPaths].sort())) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }
  for (const path of textPaths) {
    if (typeof tree.texts[path] !== 'string') {
      throw gateError('DEPENDENCY_CONTRACT_INVALID');
    }
  }
  return tree;
}

function validateGaxiosExecutableTree({ tree, copy, installation, source }) {
  const contract = installation.gaxiosPackage;
  const manifest = parseJsonObjectText(tree.texts['package.json']);
  if (manifest.name !== 'gaxios'
    || manifest.version !== copy.version
    || manifest.main !== contract.manifest.main
    || !isDeepStrictEqual(manifest.files, contract.manifest.files)
    || Object.hasOwn(manifest, 'exports') !== contract.manifest.exportsPresent
    || Object.hasOwn(manifest, 'type') !== contract.manifest.typePresent
    || !plainRecord(manifest.dependencies)
    || manifest.dependencies.uuid !== copy.uuidRange) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }

  const executablePaths = tree.files
    .filter((path) => path.startsWith('build/src/') && path.endsWith('.js'));
  if (!isDeepStrictEqual(executablePaths, contract.runtimeSourcePaths)
    || tree.texts[copy.sourcePath] !== source
    || occurrences(
      tree.texts[contract.entrypoint.path],
      contract.entrypoint.implementationRequire,
    ) !== 1) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }

  const runtime = contract.runtimeSourcePaths.map((path) => tree.texts[path]).join('\n');
  const uuidRequires = runtime.match(/\brequire\(\s*["']uuid["']\s*\)/g) ?? [];
  const methods = [...runtime.matchAll(/\buuid_1\.([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  if (uuidRequires.length !== 1
    || occurrences(runtime, installation.sourceContract.requireStatement) !== 1
    || occurrences(runtime, installation.sourceContract.zeroArgumentCall) !== 1
    || !isDeepStrictEqual(methods, [installation.sourceContract.allowedMethod])
    || /\buuid_1\s*(?:\[|\?\.)/.test(runtime)
    || /\b(?:import|require)\s*\(\s*["']uuid["']\s*\)/.test(
      runtime.replace(installation.sourceContract.requireStatement, ''),
    )
    || /\bfrom\s*["']uuid["']/.test(runtime)
    || /\buuid_1\.(?:v3|v5|v6)\b/.test(runtime)) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }
}

function validateUuidExecutableTree({ tree, uuid }) {
  const manifest = parseJsonObjectText(tree.texts['package.json']);
  if (manifest.name !== 'uuid'
    || manifest.version !== uuid.version
    || manifest.main !== uuid.manifest.main
    || !isDeepStrictEqual(manifest.exports, uuid.manifest.exports)
    || !isDeepStrictEqual(manifest.files, uuid.manifest.files)
    || Object.hasOwn(manifest, 'type') !== uuid.manifest.typePresent
    || occurrences(tree.texts[uuid.entrypoint.path], uuid.entrypoint.v4Require) !== 1) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }
}

export function evaluateInstalledContract({
  packageLock,
  files,
  packageTrees,
  policy,
} = {}) {
  validatePolicy(policy);
  const installation = policy.installation;
  if (!plainRecord(packageLock)
    || !plainRecord(packageLock.packages)
    || !plainRecord(files)
    || !plainRecord(packageTrees)
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
      || locked.resolved !== copy.resolved
      || locked.integrity !== copy.integrity
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

    const tree = reviewedPackageTree(packageTrees, copy.path, {
      expectedFiles: installation.gaxiosPackage.packageTreeFiles,
      expectedSha256: copy.packageTreeSha256,
      textPaths: [
        'package.json',
        ...installation.gaxiosPackage.runtimeSourcePaths,
      ],
    });
    validateGaxiosExecutableTree({ tree, copy, installation, source });
  }

  const uuid = installation.uuidPackage;
  const lockedUuid = packageLock.packages[uuid.path];
  if (!plainRecord(lockedUuid)) throw gateError('DEPENDENCY_CONTRACT_INVALID');
  const uuidManifestPath = `${uuid.path}/package.json`;
  const uuidManifest = parseManifest(files, uuidManifestPath);
  expectedFilePaths.push(uuidManifestPath);
  if (lockedUuid.version !== uuid.version
    || lockedUuid.resolved !== uuid.resolved
    || lockedUuid.integrity !== uuid.integrity
    || uuidManifest.name !== 'uuid'
    || uuidManifest.version !== uuid.version) {
    throw gateError('DEPENDENCY_CONTRACT_DRIFT');
  }
  const uuidTree = reviewedPackageTree(packageTrees, uuid.path, {
    expectedFiles: uuid.packageTreeFiles,
    expectedSha256: uuid.packageTreeSha256,
    textPaths: ['package.json', uuid.entrypoint.path],
  });
  validateUuidExecutableTree({ tree: uuidTree, uuid });

  const affectedGaxios = affectedLockEntries(
    packageLock.packages,
    'gaxios',
    (version) => compareVersions(version, [6, 4, 0]) >= 0
      && compareVersions(version, [6, 7, 1]) <= 0,
  );
  const reviewedGaxios = installation.gaxiosCopies
    .map(({ path, version }) => `${path}@${version}`)
    .sort();
  const affectedUuid = affectedLockEntries(
    packageLock.packages,
    'uuid',
    (version) => compareVersions(version, [11, 1, 1]) < 0,
  );
  if (!isDeepStrictEqual(affectedGaxios, reviewedGaxios)
    || !isDeepStrictEqual(affectedUuid, [`${uuid.path}@${uuid.version}`])
    || !isDeepStrictEqual(Object.keys(files).sort(), expectedFilePaths.sort())
    || !isDeepStrictEqual(
      Object.keys(packageTrees).sort(),
      [...reviewedGaxios.map((entry) => entry.slice(0, entry.lastIndexOf('@'))), uuid.path].sort(),
    )) {
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

export function collectInstalledPackageTree({ cwd, packagePath, textPaths } = {}) {
  if (typeof cwd !== 'string'
    || typeof packagePath !== 'string'
    || !Array.isArray(textPaths)
    || textPaths.some((path) => typeof path !== 'string')) {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  const root = resolve(cwd, packagePath);
  const files = [];
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TypeError('package root must be a physical directory');
    }
    const walk = (directory, relativeDirectory = '') => {
      const entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const entry of entries) {
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) walk(absolutePath, relativePath);
        else if (entry.isFile()) files.push(relativePath);
        else throw new TypeError('package tree contains a non-regular entry');
      }
    };
    walk(root);
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }

  files.sort();
  const requestedTexts = new Set(textPaths);
  const texts = {};
  const treeHash = createHash('sha256');
  try {
    for (const relativePath of files) {
      const bytes = readFileSync(resolve(root, ...relativePath.split('/')));
      const pathBytes = Buffer.from(relativePath, 'utf8');
      treeHash.update(Buffer.from(`${pathBytes.length}:`));
      treeHash.update(pathBytes);
      treeHash.update(Buffer.from(`:${bytes.length}:`));
      treeHash.update(bytes);
      treeHash.update(Buffer.from('\n'));
      if (requestedTexts.has(relativePath)) {
        texts[relativePath] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
    }
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  if (!isDeepStrictEqual(Object.keys(texts).sort(), [...requestedTexts].sort())) {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  return {
    files,
    treeSha256: treeHash.digest('hex'),
    texts,
  };
}

function readInstallationPackageTrees({ cwd, collectPackageTree, policy }) {
  if (typeof collectPackageTree !== 'function') {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  const trees = {};
  try {
    for (const copy of policy.installation.gaxiosCopies) {
      trees[copy.path] = collectPackageTree({
        cwd,
        packagePath: copy.path,
        textPaths: [
          'package.json',
          ...policy.installation.gaxiosPackage.runtimeSourcePaths,
        ],
      });
    }
    const uuid = policy.installation.uuidPackage;
    trees[uuid.path] = collectPackageTree({
      cwd,
      packagePath: uuid.path,
      textPaths: ['package.json', uuid.entrypoint.path],
    });
  } catch {
    throw gateError('DEPENDENCY_CONTRACT_INVALID');
  }
  return trees;
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
  collectPackageTree = collectInstalledPackageTree,
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
    packageTrees: readInstallationPackageTrees({
      cwd,
      collectPackageTree,
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
