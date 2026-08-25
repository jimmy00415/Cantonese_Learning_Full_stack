import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverMigrations, runMigrations } from '../scripts/run-migrations.js';

test('migration discovery accepts only one contiguous versioned set with self-recording SQL', async () => {
  const migrations = await discoverMigrations({
    migrationsDirectory: 'controlled-migrations',
    readDirectory: async () => ['002_second.sql', '001_initial.sql'],
    readFile: async (filePath) => (
      filePath.endsWith('001_initial.sql')
        ? 'BEGIN; INSERT INTO schema_migrations (version) VALUES (1); COMMIT;'
        : 'BEGIN; INSERT INTO schema_migrations (version) VALUES (2); COMMIT;'
    ),
  });

  assert.deepEqual(migrations.map(({ version, fileName }) => [version, fileName]), [
    [1, '001_initial.sql'],
    [2, '002_second.sql'],
  ]);

  for (const files of [
    ['002_second.sql'],
    ['001_initial.sql', '003_third.sql'],
    ['001_initial.sql', '001_duplicate.sql'],
    ['001_initial.sql', 'notes.txt'],
    ['001_initial.sql', '002_Bad.sql'],
    ['001_initial.sql', '002_second.SQL'],
    ['001_initial.sql', '.hidden.sql'],
  ]) await assert.rejects(discoverMigrations({
    migrationsDirectory: 'controlled-migrations',
    readDirectory: async () => files,
    readFile: async () => 'INSERT INTO schema_migrations (version) VALUES (1);',
  }), /migration set/i);
});

test('one-shot migration runner applies every missing migration and verifies the exact final set', async () => {
  const calls = [];
  let applied = false;
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/pg_advisory_lock/.test(text)) return { rows: [] };
      if (/to_regclass/.test(text)) return { rows: [{ table_name: null }] };
      if (/CREATE TABLE schema_migrations/.test(text)) { applied = true; return { rows: [] }; }
      if (/SELECT version FROM schema_migrations/.test(text)) {
        return { rows: applied ? [{ version: 1 }] : [] };
      }
      if (/pg_advisory_unlock/.test(text)) return { rows: [{ unlocked: true }] };
      throw new Error(`unexpected query: ${text}`);
    },
    release() { calls.push({ release: true }); },
  };
  const pool = {
    async connect() { calls.push({ connect: true }); return client; },
    async end() { calls.push({ end: true }); },
  };

  const result = await runMigrations({
    databaseUrl: 'postgresql://private.example.test/v1?sslmode=require',
    poolFactory(options) {
      assert.deepEqual(options, {
        connectionString: 'postgresql://private.example.test/v1?sslmode=require',
        options: '-c search_path=public',
        connectionTimeoutMillis: 30_000,
        query_timeout: 60_000,
        statement_timeout: 60_000,
      });
      return pool;
    },
    migrationsDirectory: 'controlled-migrations',
    readDirectory: async () => ['001_initial.sql'],
    readFile: async () => 'BEGIN; CREATE TABLE schema_migrations(version integer); INSERT INTO schema_migrations (version) VALUES (1); COMMIT;',
  });

  assert.deepEqual(result, { applied: [1], verified: [1] });
  assert.equal(calls.some((call) => /pg_advisory_unlock/.test(call.text ?? '')), true);
  assert.deepEqual(calls.slice(-2), [{ release: true }, { end: true }]);
});

test('migration runner rejects insecure or overridden URLs before discovery and pool construction', async () => {
  for (const databaseUrl of [
    'postgresql://private-user:private-password@v1-db.example.test/campus',
    'postgresql://private-user:private-password@v1-db.example.test/campus?sslmode=disable',
    'postgresql://private-user:private-password@v1-db.example.test/campus?sslmode=require&options=-c%20search_path%3Dlegacy',
    'postgresql://private-user:private-password@v1-db.example.test/campus?sslmode=require&search_path=legacy',
  ]) {
    let discoveryCalls = 0;
    let poolFactoryCalls = 0;
    await assert.rejects(runMigrations({
      databaseUrl,
      readDirectory: async () => {
        discoveryCalls += 1;
        return ['001_initial.sql'];
      },
      readFile: async () => 'INSERT INTO schema_migrations (version) VALUES (1);',
      poolFactory: () => {
        poolFactoryCalls += 1;
        throw new Error('pool must not be constructed');
      },
    }), (error) => {
      assert.equal(error.message.includes('private-password'), false);
      assert.match(error.message, /V1_DATABASE_URL|PostgreSQL|migration/i);
      return true;
    });
    assert.equal(discoveryCalls, 0, databaseUrl);
    assert.equal(poolFactoryCalls, 0, databaseUrl);
  }
});

test('migration runner fails closed when the database version set is missing or ahead and still closes', async () => {
  for (const versions of [[], [{ version: 1 }, { version: 2 }]]) {
    let ended = 0;
    let released = 0;
    const client = {
      async query(text) {
        if (/pg_advisory_lock|pg_advisory_unlock/.test(text)) return { rows: [] };
        if (/to_regclass/.test(text)) return { rows: [{ table_name: 'schema_migrations' }] };
        if (/SELECT version FROM schema_migrations/.test(text)) return { rows: versions };
        if (/INSERT INTO schema_migrations/.test(text) && versions.length === 0) return { rows: [] };
        throw new Error('unexpected migration SQL');
      },
      release() { released += 1; },
    };
    await assert.rejects(runMigrations({
      databaseUrl: 'postgresql://private.example.test/v1?sslmode=require',
      poolFactory: () => ({ connect: async () => client, end: async () => { ended += 1; } }),
      migrationsDirectory: 'controlled-migrations',
      readDirectory: async () => ['001_initial.sql'],
      readFile: async () => 'INSERT INTO schema_migrations (version) VALUES (1);',
    }), /migration verification/i);
    assert.equal(released, 1);
    assert.equal(ended, 1);
  }
});
