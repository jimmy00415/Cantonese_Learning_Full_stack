import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { runLegacyResourceInventory } from '../scripts/legacy-resource-inventory.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const COMMIT = '1'.repeat(40);
const MANIFEST_PATH = resolve('owner-reviewed-legacy-resources.json');
const CWD = resolve('..');
const POSTGRES_RESOURCE_ID = '/subscriptions/legacy-sub/resourceGroups/legacy-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/legacy-db';
const BLOB_RESOURCE_ID = '/subscriptions/legacy-sub/resourceGroups/legacy-rg/providers/Microsoft.Storage/storageAccounts/legacyblob';

function ownerManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    legacyApplicationIds: ['hkbuddy-pilot-0630'],
    legacyOrigins: ['https://hkbuddy-pilot-0630.azurewebsites.net'],
    postgresResources: [{
      resourceId: POSTGRES_RESOURCE_ID,
      identitySha256: 'a'.repeat(64),
    }],
    blobResources: [{
      resourceId: BLOB_RESOURCE_ID,
      identitySha256: 'b'.repeat(64),
    }],
    declaresNoLegacyPostgres: false,
    declaresNoLegacyBlob: false,
    ...overrides,
  };
}

function exactArgv(manifestPath = MANIFEST_PATH) {
  return ['--manifest', manifestPath, '--confirm-owner-reviewed-legacy-resources'];
}

function instrumentedRun(overrides = {}) {
  const calls = [];
  const output = [];
  const records = [];
  return {
    calls,
    output,
    records,
    run: () => runLegacyResourceInventory({
      argv: exactArgv(),
      environment: { V1_RELEASE_COMMIT_SHA: COMMIT },
      cwd: CWD,
      now: () => NOW,
      readTextFile: async (filePath) => {
        calls.push(['read', filePath]);
        return JSON.stringify(ownerManifest());
      },
      inspectGit: async (gitCwd) => {
        calls.push(['git', gitCwd]);
        return { head: COMMIT, clean: true };
      },
      writeArtifact: async (input) => {
        calls.push(['write', input.filePath]);
        records.push(input);
      },
      writeOutput: (line) => output.push(line),
      ...overrides,
    }),
  };
}

test('command is inert unless the exact absolute-json manifest confirmation invocation is supplied', async (t) => {
  const cases = [
    ['missing arguments', []],
    ['missing confirmation', ['--manifest', MANIFEST_PATH]],
    ['wrong order', ['--confirm-owner-reviewed-legacy-resources', '--manifest', MANIFEST_PATH]],
    ['relative manifest', ['--manifest', 'owner-reviewed.json', '--confirm-owner-reviewed-legacy-resources']],
    ['non-json manifest', ['--manifest', resolve('owner-reviewed.txt'), '--confirm-owner-reviewed-legacy-resources']],
    ['extra argument', [...exactArgv(), '--also-discover-resources']],
  ];

  for (const [name, argv] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ argv });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.publicReport, {
        status: 'not-run',
        code: 'OWNER_REVIEW_CONFIRMATION_REQUIRED',
      });
      assert.deepEqual(fixture.calls, []);
      assert.deepEqual(fixture.output, [`${JSON.stringify(result.publicReport)}\n`]);
    });
  }
});

test('invalid frozen release commit fails before manifest, git, or artifact access', async (t) => {
  for (const releaseCommit of [undefined, '', 'A'.repeat(40), '1'.repeat(39), 'private-release-name']) {
    await t.test(String(releaseCommit), async () => {
      const fixture = instrumentedRun({ environment: { V1_RELEASE_COMMIT_SHA: releaseCommit } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'RELEASE_COMMIT_INVALID');
      assert.deepEqual(fixture.calls, []);
    });
  }
});

test('invalid clock fails before manifest, git, or artifact access', async () => {
  let clockCalls = 0;
  const fixture = instrumentedRun({
    now: () => {
      clockCalls += 1;
      return new Date('invalid');
    },
  });

  const result = await fixture.run();

  assert.equal(result.exitCode, 2);
  assert.equal(result.publicReport.code, 'REVIEW_TIME_INVALID');
  assert.equal(clockCalls, 1);
  assert.deepEqual(fixture.calls, []);
});

test('owner manifest rejects unknown, duplicate, malformed, or incomplete inventory before git and write', async (t) => {
  const cases = [
    ['malformed json', null, '{'],
    ['array root', null, '[]'],
    ['unknown top-level field', (value) => { value.databaseUrl = 'postgres://private-user:private-password@example.test/db'; }],
    ['owner-supplied generated field', (value) => { value.artifactSha256 = 'c'.repeat(64); }],
    ['wrong schema version', (value) => { value.schemaVersion = 2; }],
    ['missing known application', (value) => { value.legacyApplicationIds = ['another-app']; }],
    ['duplicate application', (value) => { value.legacyApplicationIds.push('hkbuddy-pilot-0630'); }],
    ['malformed application', (value) => { value.legacyApplicationIds.push('https://private.example.test'); }],
    ['missing known origin', (value) => { value.legacyOrigins = ['https://other.example.test']; }],
    ['duplicate origin', (value) => { value.legacyOrigins.push(value.legacyOrigins[0]); }],
    ['origin with path', (value) => { value.legacyOrigins.push('https://other.example.test/private'); }],
    ['unknown resource field', (value) => { value.postgresResources[0].connectionString = 'private'; }],
    ['duplicate resource id', (value) => { value.postgresResources.push({ resourceId: POSTGRES_RESOURCE_ID, identitySha256: 'c'.repeat(64) }); }],
    ['duplicate identity digest', (value) => { value.blobResources.push({ resourceId: `${BLOB_RESOURCE_ID}2`, identitySha256: 'b'.repeat(64) }); }],
    ['uppercase identity digest', (value) => { value.postgresResources[0].identitySha256 = 'A'.repeat(64); }],
    ['short identity digest', (value) => { value.postgresResources[0].identitySha256 = 'a'.repeat(63); }],
    ['postgres URL instead of resource id', (value) => { value.postgresResources[0].resourceId = 'postgres://private-user:private-password@example.test/db'; }],
    ['blob URL instead of resource id', (value) => { value.blobResources[0].resourceId = 'https://legacyblob.blob.core.windows.net/private'; }],
    ['wrong postgres resource type', (value) => { value.postgresResources[0].resourceId = BLOB_RESOURCE_ID; }],
    ['wrong blob resource type', (value) => { value.blobResources[0].resourceId = POSTGRES_RESOURCE_ID; }],
    ['empty postgres without reviewed-none', (value) => { value.postgresResources = []; }],
    ['postgres list plus reviewed-none', (value) => { value.declaresNoLegacyPostgres = true; }],
    ['empty blob without reviewed-none', (value) => { value.blobResources = []; }],
    ['blob list plus reviewed-none', (value) => { value.declaresNoLegacyBlob = true; }],
  ];

  for (const [name, mutate, raw] of cases) {
    await t.test(name, async () => {
      const manifest = ownerManifest();
      mutate?.(manifest);
      const fixture = instrumentedRun({
        readTextFile: async (filePath) => {
          fixture.calls.push(['read', filePath]);
          return raw ?? JSON.stringify(manifest);
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'OWNER_MANIFEST_INVALID');
      assert.deepEqual(fixture.calls, [['read', MANIFEST_PATH]]);
      assert.equal(fixture.output.join('').includes('private'), false);
      assert.equal(fixture.output.join('').includes(MANIFEST_PATH), false);
    });
  }
});

test('each resource class accepts only its explicit owner-reviewed list-or-none branch', async (t) => {
  const cases = [
    ['reviewed no postgres', { postgresResources: [], declaresNoLegacyPostgres: true }],
    ['reviewed no blob', { blobResources: [], declaresNoLegacyBlob: true }],
    ['reviewed no storage resources', {
      postgresResources: [],
      declaresNoLegacyPostgres: true,
      blobResources: [],
      declaresNoLegacyBlob: true,
    }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({
        readTextFile: async (filePath) => {
          fixture.calls.push(['read', filePath]);
          return JSON.stringify(ownerManifest(overrides));
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 0);
      assert.equal(fixture.records.length, 1);
      assert.deepEqual(fixture.records[0].record.postgresResources, ownerManifest(overrides).postgresResources);
      assert.deepEqual(fixture.records[0].record.blobResources, ownerManifest(overrides).blobResources);
    });
  }
});

test('clean HEAD must exactly match the frozen release commit before an artifact write', async (t) => {
  const cases = [
    ['dirty worktree', { head: COMMIT, clean: false }],
    ['different head', { head: '2'.repeat(40), clean: true }],
    ['malformed head', { head: `${COMMIT}\n`, clean: true }],
    ['malformed clean state', { head: COMMIT, clean: 'true' }],
  ];

  for (const [name, gitState] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({
        inspectGit: async (gitCwd) => {
          fixture.calls.push(['git', gitCwd]);
          return gitState;
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'RELEASE_GIT_STATE_INVALID');
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read', 'git']);
      assert.equal(fixture.records.length, 0);
    });
  }

  await t.test('git inspection failure is safely normalized', async () => {
    const fixture = instrumentedRun({
      inspectGit: async (gitCwd) => {
        fixture.calls.push(['git', gitCwd]);
        throw new Error(`private git failure at ${gitCwd}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'RELEASE_GIT_STATE_INVALID');
    assert.equal(fixture.output.join('').includes('private'), false);
    assert.equal(fixture.records.length, 0);
  });
});

test('valid owner attestation writes only a final commit-time-digest-bound safe record', async () => {
  const fixture = instrumentedRun();
  const result = await fixture.run();

  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.status, 'recorded');
  assert.equal(result.publicReport.code, 'LEGACY_INVENTORY_RECORDED');
  assert.match(result.publicReport.artifactSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read', 'git', 'write']);
  assert.equal(fixture.records.length, 1);

  const { filePath, record, contents } = fixture.records[0];
  assert.equal(basename(filePath), `${COMMIT}-${record.artifactSha256}.json`);
  assert.deepEqual(Object.keys(record).sort(), [
    'artifactSha256',
    'blobResources',
    'commitSha',
    'declaresNoLegacyBlob',
    'declaresNoLegacyPostgres',
    'legacyApplicationIds',
    'legacyOrigins',
    'postgresResources',
    'result',
    'reviewedAt',
    'schemaVersion',
  ]);
  assert.equal(record.commitSha, COMMIT);
  assert.equal(record.reviewedAt, NOW.toISOString());
  assert.equal(record.result, true);
  assert.equal(record.artifactSha256, result.publicReport.artifactSha256);
  assert.deepEqual(JSON.parse(contents), record);
  assert.equal(contents.endsWith('\n'), true);

  const publicText = fixture.output.join('');
  for (const forbidden of [MANIFEST_PATH, CWD, POSTGRES_RESOURCE_ID, BLOB_RESOURCE_ID, 'a'.repeat(64), 'b'.repeat(64), 'azurewebsites.net']) {
    assert.equal(publicText.includes(forbidden), false);
  }
});

test('default artifact writer is immutable and never overwrites an existing report', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hk-buddy-legacy-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, 'owner-reviewed.json');
  const artifactDirectory = join(directory, 'reports', 'legacy-inventory');
  await writeFile(manifestPath, JSON.stringify(ownerManifest()));
  const output = [];
  const input = {
    argv: exactArgv(manifestPath),
    environment: { V1_RELEASE_COMMIT_SHA: COMMIT },
    cwd: directory,
    artifactDirectory,
    now: () => NOW,
    inspectGit: async () => ({ head: COMMIT, clean: true }),
    writeOutput: (line) => output.push(line),
  };

  const first = await runLegacyResourceInventory(input);
  assert.equal(first.exitCode, 0);
  const files = await readdir(artifactDirectory);
  assert.deepEqual(files, [`${COMMIT}-${first.publicReport.artifactSha256}.json`]);
  const filePath = join(artifactDirectory, files[0]);
  const original = await readFile(filePath, 'utf8');

  const second = await runLegacyResourceInventory(input);
  assert.equal(second.exitCode, 1);
  assert.equal(second.publicReport.code, 'LEGACY_INVENTORY_ARTIFACT_EXISTS');
  assert.equal(await readFile(filePath, 'utf8'), original);
  assert.equal(output.join('').includes(directory), false);
  assert.equal(output.join('').includes(POSTGRES_RESOURCE_ID), false);
});

test('manifest read and artifact write failures are redacted and cannot expose paths or credentials', async (t) => {
  await t.test('read failure', async () => {
    const fixture = instrumentedRun({
      readTextFile: async (filePath) => {
        fixture.calls.push(['read', filePath]);
        throw new Error(`private-password ${filePath}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'OWNER_MANIFEST_UNREADABLE');
    assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read']);
    assert.equal(fixture.output.join('').includes('private-password'), false);
    assert.equal(fixture.output.join('').includes(MANIFEST_PATH), false);
  });

  await t.test('write failure', async () => {
    const fixture = instrumentedRun({
      writeArtifact: async (input) => {
        fixture.calls.push(['write', input.filePath]);
        throw new Error(`private-password ${input.filePath}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'LEGACY_INVENTORY_WRITE_FAILED');
    assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read', 'git', 'write']);
    assert.equal(fixture.output.join('').includes('private-password'), false);
    assert.equal(fixture.output.join('').includes(MANIFEST_PATH), false);
  });
});
