import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ADVISORY_ID = 'GHSA-w5hq-g745-h8pq';
const EXPIRY = '2026-09-26T00:00:00.000Z';
const GAXIOS_RESOLVED = 'https://registry.npmjs.org/gaxios/-/gaxios-6.7.1.tgz';
const GAXIOS_INTEGRITY = 'sha512-LDODD4TMYx7XXdpwxAVRAIAuB0bzv0s+ywFonY46k126qzQHT9ygyoa9tncmOiQmmDrik65UYsEkv3lbfqQ3yQ==';
const GAXIOS_TREE_SHA256 = '79b81803bf8037ffa1117a3a626d73e161427e01834e5e00bdf99de36529bb2b';
const UUID_RESOLVED = 'https://registry.npmjs.org/uuid/-/uuid-9.0.1.tgz';
const UUID_INTEGRITY = 'sha512-b+1eJOlsR9K8HJpow9Ok3fiWOWSIcIzXodvv0rQjVoOVNpWMpxf1wZNpt4y9h10odCNrqnYp1OBzRktckBe3sA==';
const UUID_TREE_SHA256 = '588984b1885d6848ca4f9773d4a76705bf4e562f2c0057593f76c2f612e4339a';
const GAXIOS_TREE_FILES = [
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
const UUID_TREE_FILES = [
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
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(ROOT_DIR, 'scripts', 'dependency-security-gate.js');

const modulePromise = import('../scripts/dependency-security-gate.js').catch(() => null);

async function gateModule() {
  const subject = await modulePromise;
  assert.equal(
    typeof subject?.evaluateAuditReport,
    'function',
    'scripts/dependency-security-gate.js must export evaluateAuditReport',
  );
  return subject;
}

async function installedContractEvaluator() {
  const subject = await gateModule();
  assert.equal(
    typeof subject?.evaluateInstalledContract,
    'function',
    'scripts/dependency-security-gate.js must export evaluateInstalledContract',
  );
  return subject.evaluateInstalledContract;
}

async function dependencySecurityRunner() {
  const subject = await gateModule();
  assert.equal(
    typeof subject?.runDependencySecurityGate,
    'function',
    'scripts/dependency-security-gate.js must export runDependencySecurityGate',
  );
  return subject.runDependencySecurityGate;
}

function exactPolicy() {
  return {
    schemaVersion: 1,
    exceptionId: ADVISORY_ID,
    expiresAt: EXPIRY,
    auditReportVersion: 2,
    advisory: {
      source: 1119441,
      name: 'uuid',
      dependency: 'uuid',
      title: 'uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided',
      url: `https://github.com/advisories/${ADVISORY_ID}`,
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
          resolved: GAXIOS_RESOLVED,
          integrity: GAXIOS_INTEGRITY,
          packageTreeSha256: GAXIOS_TREE_SHA256,
          sourcePath: 'build/src/gaxios.js',
          sourceSha256: '9a9988f38306d08faaa73aa0316ed0c6eed519ef8cfd3561273a45249eaf94b2',
        },
        {
          path: 'node_modules/gtoken/node_modules/gaxios',
          version: '6.7.1',
          uuidRange: '^9.0.1',
          resolved: GAXIOS_RESOLVED,
          integrity: GAXIOS_INTEGRITY,
          packageTreeSha256: GAXIOS_TREE_SHA256,
          sourcePath: 'build/src/gaxios.js',
          sourceSha256: '9a9988f38306d08faaa73aa0316ed0c6eed519ef8cfd3561273a45249eaf94b2',
        },
      ],
      gaxiosPackage: {
        packageTreeFiles: structuredClone(GAXIOS_TREE_FILES),
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
        resolved: UUID_RESOLVED,
        integrity: UUID_INTEGRITY,
        packageTreeSha256: UUID_TREE_SHA256,
        packageTreeFiles: structuredClone(UUID_TREE_FILES),
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

function exactAuditReport() {
  const policy = exactPolicy();
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      gaxios: structuredClone(policy.vulnerabilities.gaxios),
      uuid: {
        ...structuredClone(policy.vulnerabilities.uuid),
        via: [structuredClone(policy.advisory)],
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 2,
        high: 0,
        critical: 0,
        total: 2,
      },
      dependencies: {
        prod: 193,
        dev: 1,
        optional: 1,
        peer: 0,
        peerOptional: 0,
        total: 194,
      },
    },
  };
}

function exactInstallationInputs() {
  const policy = exactPolicy();
  const [storageGaxios, gtokenGaxios] = policy.installation.gaxiosCopies;
  const source = [
    policy.installation.sourceContract.requireStatement,
    `const boundary = ${policy.installation.sourceContract.zeroArgumentCall};`,
  ].join('\n');
  const files = {};
  const packageTrees = {};

  for (const parent of policy.installation.parentPackages) {
    files[`${parent.path}/package.json`] = {
      text: JSON.stringify({
        name: parent.name,
        version: parent.version,
        dependencies: { [parent.dependency.name]: parent.dependency.range },
      }),
    };
  }
  for (const copy of policy.installation.gaxiosCopies) {
    const manifest = {
      name: 'gaxios',
      version: copy.version,
      main: policy.installation.gaxiosPackage.manifest.main,
      files: structuredClone(policy.installation.gaxiosPackage.manifest.files),
      dependencies: { uuid: copy.uuidRange },
    };
    files[`${copy.path}/package.json`] = {
      text: JSON.stringify(manifest),
    };
    files[`${copy.path}/${copy.sourcePath}`] = {
      text: source,
      sha256: copy.sourceSha256,
    };
    const texts = Object.fromEntries(
      policy.installation.gaxiosPackage.runtimeSourcePaths.map((path) => [path, '']),
    );
    texts['package.json'] = JSON.stringify(manifest);
    texts[policy.installation.gaxiosPackage.entrypoint.path] =
      policy.installation.gaxiosPackage.entrypoint.implementationRequire;
    texts[policy.installation.gaxiosPackage.entrypoint.implementationPath] = source;
    packageTrees[copy.path] = {
      files: structuredClone(policy.installation.gaxiosPackage.packageTreeFiles),
      treeSha256: copy.packageTreeSha256,
      texts,
    };
  }
  const uuidManifest = {
    name: 'uuid',
    version: policy.installation.uuidPackage.version,
    main: policy.installation.uuidPackage.manifest.main,
    exports: structuredClone(policy.installation.uuidPackage.manifest.exports),
    files: structuredClone(policy.installation.uuidPackage.manifest.files),
  };
  files[`${policy.installation.uuidPackage.path}/package.json`] = {
    text: JSON.stringify(uuidManifest),
  };
  packageTrees[policy.installation.uuidPackage.path] = {
    files: structuredClone(policy.installation.uuidPackage.packageTreeFiles),
    treeSha256: policy.installation.uuidPackage.packageTreeSha256,
    texts: {
      'package.json': JSON.stringify(uuidManifest),
      [policy.installation.uuidPackage.entrypoint.path]:
        policy.installation.uuidPackage.entrypoint.v4Require,
    },
  };

  return {
    policy,
    packageLock: {
      lockfileVersion: policy.installation.lockfileVersion,
      packages: {
        [policy.installation.parentPackages[0].path]: {
          version: policy.installation.parentPackages[0].version,
          dependencies: {
            [policy.installation.parentPackages[0].dependency.name]:
              policy.installation.parentPackages[0].dependency.range,
          },
        },
        [policy.installation.parentPackages[1].path]: {
          version: policy.installation.parentPackages[1].version,
          dependencies: {
            [policy.installation.parentPackages[1].dependency.name]:
              policy.installation.parentPackages[1].dependency.range,
          },
        },
        [storageGaxios.path]: {
          version: storageGaxios.version,
          resolved: storageGaxios.resolved,
          integrity: storageGaxios.integrity,
          dependencies: { uuid: storageGaxios.uuidRange },
        },
        [gtokenGaxios.path]: {
          version: gtokenGaxios.version,
          resolved: gtokenGaxios.resolved,
          integrity: gtokenGaxios.integrity,
          dependencies: { uuid: gtokenGaxios.uuidRange },
        },
        [policy.installation.uuidPackage.path]: {
          version: policy.installation.uuidPackage.version,
          resolved: policy.installation.uuidPackage.resolved,
          integrity: policy.installation.uuidPackage.integrity,
        },
        'node_modules/gaxios': {
          version: '7.3.1',
          dependencies: {},
        },
      },
    },
    files,
    packageTrees,
  };
}

function exactRunnerDependencies(overrides = {}) {
  const installation = exactInstallationInputs();
  const auditResult = {
    status: 1,
    signal: null,
    stdout: JSON.stringify(exactAuditReport()),
    stderr: '',
  };
  return {
    cwd: 'C:/isolated/production-v1',
    now: new Date('2026-08-26T12:00:00.000Z'),
    runAudit: () => auditResult,
    readTextFile: (path) => {
      if (path === 'package-lock.json') return JSON.stringify(installation.packageLock);
      const file = installation.files[path];
      if (!file) throw new Error(`missing fixture: ${path}`);
      return file.text;
    },
    hashText: (_text, path) => installation.files[path]?.sha256,
    collectPackageTree: ({ packagePath }) => structuredClone(installation.packageTrees[packagePath]),
    ...overrides,
  };
}

test('the exact reviewed npm audit exception is accepted before its deadline', async () => {
  const { evaluateAuditReport } = await gateModule();

  assert.deepEqual(evaluateAuditReport({
    report: exactAuditReport(),
    policy: exactPolicy(),
    now: new Date('2026-08-26T12:00:00.000Z'),
  }), {
    advisoryId: ADVISORY_ID,
    expiresAt: EXPIRY,
    vulnerabilityCount: 2,
  });
});

test('the audit exception fails closed when expired or when npm output drifts', async (t) => {
  const { evaluateAuditReport } = await gateModule();
  const cases = [
    ['deadline reached', () => ({
      report: exactAuditReport(), policy: exactPolicy(), now: new Date(EXPIRY),
    }), 'DEPENDENCY_EXCEPTION_EXPIRED'],
    ['invalid clock', () => ({
      report: exactAuditReport(), policy: exactPolicy(), now: new Date('invalid'),
    }), 'DEPENDENCY_POLICY_INVALID'],
    ['malformed report', () => ({
      report: null, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z'),
    }), 'DEPENDENCY_AUDIT_INVALID'],
    ['audit schema drift', () => {
      const report = exactAuditReport();
      report.auditReportVersion = 3;
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_INVALID'],
    ['new moderate', () => {
      const report = exactAuditReport();
      report.vulnerabilities.newPackage = {
        name: 'new-package', severity: 'moderate', isDirect: false,
        via: [], effects: [], range: '<2.0.0', nodes: ['node_modules/new-package'], fixAvailable: true,
      };
      report.metadata.vulnerabilities.moderate = 3;
      report.metadata.vulnerabilities.total = 3;
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_NOT_ALLOWED'],
    ['new high', () => {
      const report = exactAuditReport();
      report.vulnerabilities.newPackage = {
        name: 'new-package', severity: 'high', isDirect: false,
        via: [], effects: [], range: '<2.0.0', nodes: ['node_modules/new-package'], fixAvailable: true,
      };
      report.metadata.vulnerabilities.high = 1;
      report.metadata.vulnerabilities.total = 3;
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_NOT_ALLOWED'],
    ['new critical', () => {
      const report = exactAuditReport();
      report.vulnerabilities.newPackage = {
        name: 'new-package', severity: 'critical', isDirect: false,
        via: [], effects: [], range: '<2.0.0', nodes: ['node_modules/new-package'], fixAvailable: true,
      };
      report.metadata.vulnerabilities.critical = 1;
      report.metadata.vulnerabilities.total = 3;
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_NOT_ALLOWED'],
    ['gaxios path drift', () => {
      const report = exactAuditReport();
      report.vulnerabilities.gaxios.nodes[0] = 'node_modules/unreviewed/gaxios';
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_NOT_ALLOWED'],
    ['advisory drift', () => {
      const report = exactAuditReport();
      report.vulnerabilities.uuid.via[0].source = 9999999;
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_NOT_ALLOWED'],
    ['missing reviewed finding', () => {
      const report = exactAuditReport();
      delete report.vulnerabilities.gaxios;
      report.metadata.vulnerabilities.moderate = 1;
      report.metadata.vulnerabilities.total = 1;
      return { report, policy: exactPolicy(), now: new Date('2026-08-26T12:00:00.000Z') };
    }, 'DEPENDENCY_AUDIT_NOT_ALLOWED'],
  ];

  for (const [name, input, code] of cases) {
    await t.test(name, () => {
      assert.throws(() => evaluateAuditReport(input()), { code });
    });
  }
});

test('the reviewed exception policy cannot be widened or extended by configuration', async (t) => {
  const { evaluateAuditReport } = await gateModule();
  const now = new Date('2026-08-26T12:00:00.000Z');
  const cases = [
    ['advisory identity', (policy) => { policy.exceptionId = 'GHSA-unreviewed'; }],
    ['expiry', (policy) => { policy.expiresAt = '2027-09-26T00:00:00.000Z'; }],
    ['extra policy field', (policy) => { policy.allowFutureModerates = true; }],
    ['allowed audit path', (policy) => {
      policy.vulnerabilities.gaxios.nodes[0] = 'node_modules/unreviewed/gaxios';
    }],
    ['installed source hash', (policy) => {
      policy.installation.gaxiosCopies[0].sourceSha256 = '0'.repeat(64);
    }],
    ['uuid method', (policy) => { policy.installation.sourceContract.allowedMethod = 'v5'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const policy = exactPolicy();
      mutate(policy);
      assert.throws(
        () => evaluateAuditReport({ report: exactAuditReport(), policy, now }),
        { code: 'DEPENDENCY_POLICY_INVALID' },
      );
    });
  }
});

test('the exact installed dependency graph and reviewed uuid.v4 call contract are accepted', async () => {
  const evaluateInstalledContract = await installedContractEvaluator();

  assert.deepEqual(evaluateInstalledContract(exactInstallationInputs()), {
    gaxiosCopies: 2,
    uuidMethod: 'v4',
    uuidVersion: '9.0.1',
  });
});

test('the installed dependency and source contract fails closed on malformed input or drift', async (t) => {
  const evaluateInstalledContract = await installedContractEvaluator();
  const cases = [
    ['malformed lockfile', (input) => { input.packageLock = null; }, 'DEPENDENCY_CONTRACT_INVALID'],
    ['missing installed file', (input) => {
      delete input.files['node_modules/uuid/package.json'];
    }, 'DEPENDENCY_CONTRACT_INVALID'],
    ['malformed package manifest', (input) => {
      input.files['node_modules/uuid/package.json'].text = '{';
    }, 'DEPENDENCY_CONTRACT_INVALID'],
    ['lockfile version drift', (input) => {
      input.packageLock.lockfileVersion = 4;
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['extra vulnerable gaxios copy', (input) => {
      input.packageLock.packages['node_modules/unreviewed/node_modules/gaxios'] = {
        version: '6.7.1', dependencies: { uuid: '^9.0.1' },
      };
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ...['6.4.0', '6.6.0', '6.7.0'].map((version) => [
      `unreviewed affected gaxios ${version}`,
      (input) => {
        input.packageLock.packages[`node_modules/unreviewed-${version}/node_modules/gaxios`] = {
          version, dependencies: { uuid: '^9.0.1' },
        };
      },
      'DEPENDENCY_CONTRACT_DRIFT',
    ]),
    ...['8.0.0', '10.0.0', '11.0.0'].map((version) => [
      `unreviewed affected uuid ${version}`,
      (input) => {
        input.packageLock.packages[`node_modules/unreviewed-${version}/node_modules/uuid`] = {
          version,
        };
      },
      'DEPENDENCY_CONTRACT_DRIFT',
    ]),
    ['malformed gaxios version', (input) => {
      input.packageLock.packages['node_modules/unreviewed/node_modules/gaxios'] = {
        version: '6.7', dependencies: { uuid: '^9.0.1' },
      };
    }, 'DEPENDENCY_CONTRACT_INVALID'],
    ['malformed uuid version', (input) => {
      input.packageLock.packages['node_modules/unreviewed/node_modules/uuid'] = {
        version: 'not-semver',
      };
    }, 'DEPENDENCY_CONTRACT_INVALID'],
    ['parent dependency drift', (input) => {
      input.packageLock.packages['node_modules/gtoken'].dependencies.gaxios = '^7.0.0';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['installed gaxios version drift', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/package.json';
      const manifest = JSON.parse(input.files[path].text);
      manifest.version = '6.7.2';
      input.files[path].text = JSON.stringify(manifest);
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['installed uuid version drift', (input) => {
      input.packageLock.packages['node_modules/uuid'].version = '9.0.2';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['gaxios lock tarball drift', (input) => {
      input.packageLock.packages[
        'node_modules/gtoken/node_modules/gaxios'
      ].resolved = 'https://registry.npmjs.org/gaxios/-/gaxios-6.7.0.tgz';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['gaxios lock integrity drift', (input) => {
      input.packageLock.packages[
        'node_modules/gtoken/node_modules/gaxios'
      ].integrity = 'sha512-unreviewed';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid lock tarball drift', (input) => {
      input.packageLock.packages['node_modules/uuid'].resolved =
        'https://registry.npmjs.org/uuid/-/uuid-10.0.0.tgz';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['gaxios main redirects to evil.js', (input) => {
      const tree = input.packageTrees['node_modules/gtoken/node_modules/gaxios'];
      const manifest = JSON.parse(tree.texts['package.json']);
      manifest.main = 'evil.js';
      tree.texts['package.json'] = JSON.stringify(manifest);
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['gaxios exports redirects the entrypoint', (input) => {
      const tree = input.packageTrees['node_modules/gtoken/node_modules/gaxios'];
      const manifest = JSON.parse(tree.texts['package.json']);
      manifest.exports = { '.': './evil.js' };
      tree.texts['package.json'] = JSON.stringify(manifest);
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['gaxios entrypoint chain redirects to evil.js', (input) => {
      const tree = input.packageTrees['node_modules/gtoken/node_modules/gaxios'];
      tree.texts['build/src/index.js'] = 'const gaxios_1 = require("./evil");';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid exports redirects the CommonJS entrypoint', (input) => {
      const tree = input.packageTrees['node_modules/uuid'];
      const manifest = JSON.parse(tree.texts['package.json']);
      manifest.exports['.'].node.require = './evil.js';
      tree.texts['package.json'] = JSON.stringify(manifest);
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid entrypoint chain redirects v4', (input) => {
      const tree = input.packageTrees['node_modules/uuid'];
      tree.texts['dist/index.js'] =
        'var _v3 = _interopRequireDefault(require("./evil.js"));';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['extra executable package file', (input) => {
      const tree = input.packageTrees['node_modules/gtoken/node_modules/gaxios'];
      tree.files.push('evil.js');
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['complete package tree digest drift', (input) => {
      input.packageTrees['node_modules/gtoken/node_modules/gaxios'].treeSha256 = '0'.repeat(64);
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['alternate uuid import in another runtime source', (input) => {
      const tree = input.packageTrees['node_modules/gtoken/node_modules/gaxios'];
      tree.texts['build/src/common.js'] =
        'const altUuid = require("uuid"); altUuid["v5"]();';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['alternative uuid property access', (input) => {
      const tree = input.packageTrees['node_modules/gtoken/node_modules/gaxios'];
      tree.texts['build/src/gaxios.js'] = tree.texts['build/src/gaxios.js']
        .replace('uuid_1.v4)()', 'uuid_1["v4"])()');
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['source hash drift', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/build/src/gaxios.js';
      input.files[path].sha256 = '0'.repeat(64);
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid.v4 arguments introduced', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/build/src/gaxios.js';
      input.files[path].text = input.files[path].text.replace('uuid_1.v4)()', 'uuid_1.v4)(buffer)');
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid.v3 introduced', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/build/src/gaxios.js';
      input.files[path].text = input.files[path].text.replaceAll('uuid_1.v4', 'uuid_1.v3');
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid.v5 introduced', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/build/src/gaxios.js';
      input.files[path].text = input.files[path].text.replaceAll('uuid_1.v4', 'uuid_1.v5');
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['uuid.v6 introduced', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/build/src/gaxios.js';
      input.files[path].text = input.files[path].text.replaceAll('uuid_1.v4', 'uuid_1.v6');
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
    ['second uuid call introduced', (input) => {
      const path = 'node_modules/gtoken/node_modules/gaxios/build/src/gaxios.js';
      input.files[path].text += '\nconst second = (0, uuid_1.v4)();';
    }, 'DEPENDENCY_CONTRACT_DRIFT'],
  ];

  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const input = exactInstallationInputs();
      mutate(input);
      assert.throws(() => evaluateInstalledContract(input), { code });
    });
  }
});

test('the command runner invokes a fresh production-only npm audit and verifies installed files', async () => {
  const runDependencySecurityGate = await dependencySecurityRunner();
  const invocations = [];
  const dependencies = exactRunnerDependencies({
    runAudit: (request) => {
      invocations.push(request);
      return {
        status: 1,
        signal: null,
        stdout: JSON.stringify(exactAuditReport()),
        stderr: '',
      };
    },
  });

  assert.deepEqual(runDependencySecurityGate(dependencies), {
    status: 'passed',
    code: 'DEPENDENCY_SECURITY_EXCEPTION_REVIEWED',
    advisoryId: ADVISORY_ID,
    expiresAt: EXPIRY,
    vulnerabilityCount: 2,
    gaxiosCopies: 2,
    uuidMethod: 'v4',
    uuidVersion: '9.0.1',
  });
  assert.deepEqual(invocations, [{
    cwd: 'C:/isolated/production-v1',
    args: ['audit', '--omit=dev', '--json'],
  }]);
});

test('the command runner fails closed on audit, output, and filesystem failures', async (t) => {
  const runDependencySecurityGate = await dependencySecurityRunner();
  const cases = [
    ['audit launch failure', {
      runAudit: () => { throw new Error('network unavailable'); },
    }, 'DEPENDENCY_AUDIT_COMMAND_FAILED'],
    ['unexpected clean exit', {
      runAudit: () => ({
        status: 0, signal: null, stdout: JSON.stringify(exactAuditReport()), stderr: '',
      }),
    }, 'DEPENDENCY_AUDIT_COMMAND_FAILED'],
    ['terminated audit', {
      runAudit: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    }, 'DEPENDENCY_AUDIT_COMMAND_FAILED'],
    ['audit stderr', {
      runAudit: () => ({ status: 1, signal: null, stdout: '{}', stderr: 'network warning' }),
    }, 'DEPENDENCY_AUDIT_COMMAND_FAILED'],
    ['empty audit output', {
      runAudit: () => ({ status: 1, signal: null, stdout: '', stderr: '' }),
    }, 'DEPENDENCY_AUDIT_OUTPUT_INVALID'],
    ['malformed audit output', {
      runAudit: () => ({ status: 1, signal: null, stdout: '{', stderr: '' }),
    }, 'DEPENDENCY_AUDIT_OUTPUT_INVALID'],
    ['npm network error JSON', {
      runAudit: () => ({
        status: 1, signal: null, stdout: JSON.stringify({ error: { code: 'ENETUNREACH' } }), stderr: '',
      }),
    }, 'DEPENDENCY_AUDIT_COMMAND_FAILED'],
    ['package lock read failure', {
      readTextFile: () => { throw new Error('not found'); },
    }, 'DEPENDENCY_CONTRACT_INVALID'],
  ];

  for (const [name, overrides, code] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => runDependencySecurityGate(exactRunnerDependencies(overrides)),
        { code },
      );
    });
  }
});

test('the executable gate wires npm audit arguments and emits only reviewed evidence', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dependency-gate-'));
  try {
    const fakeNpm = join(temp, 'fake-npm.mjs');
    writeFileSync(fakeNpm, [
      `const expected = ${JSON.stringify(['audit', '--omit=dev', '--json'])};`,
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);',
      `process.stdout.write(${JSON.stringify(JSON.stringify(exactAuditReport()))});`,
      'process.exitCode = 1;',
    ].join('\n'));

    const result = spawnSync(process.execPath, [GATE_SCRIPT], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: fakeNpm },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'passed',
      code: 'DEPENDENCY_SECURITY_EXCEPTION_REVIEWED',
      advisoryId: ADVISORY_ID,
      expiresAt: EXPIRY,
      vulnerabilityCount: 2,
      gaxiosCopies: 2,
      uuidMethod: 'v4',
      uuidVersion: '9.0.1',
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('the executable gate returns a safe failure without leaking audit stderr', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dependency-gate-'));
  try {
    const fakeNpm = join(temp, 'fake-npm.mjs');
    writeFileSync(fakeNpm, [
      "process.stderr.write('SECRET NETWORK DETAIL');",
      'process.exitCode = 1;',
    ].join('\n'));

    const result = spawnSync(process.execPath, [GATE_SCRIPT], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: fakeNpm },
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      status: 'failed',
      code: 'DEPENDENCY_AUDIT_COMMAND_FAILED',
    });
    assert.equal(result.stderr.includes('SECRET NETWORK DETAIL'), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('package scripts expose the gate and include its syntax in the standard check', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));

  assert.equal(
    manifest.scripts['security:dependencies'],
    'node scripts/dependency-security-gate.js',
  );
  assert.match(
    manifest.scripts.check,
    /(?:^|&& )node --check scripts\/dependency-security-gate\.js(?: &&|$)/,
  );
});
