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
    files[`${copy.path}/package.json`] = {
      text: JSON.stringify({
        name: 'gaxios',
        version: copy.version,
        dependencies: { uuid: copy.uuidRange },
      }),
    };
    files[`${copy.path}/${copy.sourcePath}`] = {
      text: source,
      sha256: copy.sourceSha256,
    };
  }
  files[`${policy.installation.uuidPackage.path}/package.json`] = {
    text: JSON.stringify({ name: 'uuid', version: policy.installation.uuidPackage.version }),
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
          dependencies: { uuid: storageGaxios.uuidRange },
        },
        [gtokenGaxios.path]: {
          version: gtokenGaxios.version,
          dependencies: { uuid: gtokenGaxios.uuidRange },
        },
        [policy.installation.uuidPackage.path]: {
          version: policy.installation.uuidPackage.version,
        },
        'node_modules/gaxios': {
          version: '7.3.1',
          dependencies: {},
        },
      },
    },
    files,
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
