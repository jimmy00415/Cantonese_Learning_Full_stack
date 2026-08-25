import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { assertSecurePostgresRuntimeUrl } from '../src/services/release-evidence.js';

const MIGRATION_FILE = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;
const ADVISORY_LOCK = 'hong-kong-buddy-production-v1-migrations';

function migrationSetError() {
  return new Error('Migration set is invalid');
}

function exactVersions(rows) {
  if (!Array.isArray(rows)) throw migrationSetError();
  return rows.map((row) => Number(row?.version));
}

export async function discoverMigrations({
  migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'),
  readDirectory = readdir,
  readFile: readMigration = readFile,
} = {}) {
  const discovered = await readDirectory(migrationsDirectory);
  if (!Array.isArray(discovered)
    || discovered.some((fileName) => typeof fileName !== 'string' || !MIGRATION_FILE.test(fileName))) {
    throw migrationSetError();
  }
  const fileNames = [...discovered].sort();
  if (fileNames.length < 1) throw migrationSetError();
  const migrations = [];
  const versions = new Set();
  for (const fileName of fileNames) {
    const match = MIGRATION_FILE.exec(fileName);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version !== migrations.length + 1 || versions.has(version)) {
      throw migrationSetError();
    }
    const sql = await readMigration(join(migrationsDirectory, fileName), 'utf8');
    const recordsVersion = new RegExp(
      `INSERT\\s+INTO\\s+schema_migrations\\s*\\(\\s*version\\s*\\)\\s*VALUES\\s*\\(\\s*${version}\\s*\\)`,
      'i',
    );
    if (typeof sql !== 'string' || !recordsVersion.test(sql)) throw migrationSetError();
    versions.add(version);
    migrations.push(Object.freeze({ version, fileName, sql }));
  }
  return migrations;
}

function defaultPoolFactory(options) {
  return new Pool(options);
}

function verifyExactVersions(actual, expected) {
  if (actual.length !== expected.length
    || actual.some((version, index) => version !== expected[index])) {
    throw new Error('Migration verification failed');
  }
}

export async function runMigrations({
  databaseUrl = process.env.V1_DATABASE_URL,
  poolFactory = defaultPoolFactory,
  migrationsDirectory,
  readDirectory,
  readFile: readMigration,
} = {}) {
  try { assertSecurePostgresRuntimeUrl(databaseUrl); } catch {
    throw new Error('V1_DATABASE_URL is invalid for secure migrations');
  }
  if (typeof poolFactory !== 'function') throw new Error('Migration pool factory is invalid');
  const migrations = await discoverMigrations({
    migrationsDirectory,
    readDirectory,
    readFile: readMigration,
  });
  const expected = migrations.map(({ version }) => version);
  const pool = poolFactory({
    connectionString: databaseUrl,
    options: '-c search_path=public',
    connectionTimeoutMillis: 30_000,
    query_timeout: 60_000,
    statement_timeout: 60_000,
  });
  let client;
  let locked = false;
  const applied = [];
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK]);
    locked = true;
    const relation = await client.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    let existing = [];
    if (relation.rows?.[0]?.table_name) {
      existing = exactVersions((await client.query(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows);
      if (existing.some((version) => !expected.includes(version))) {
        throw new Error('Migration verification failed');
      }
    }
    for (const migration of migrations) {
      if (existing.includes(migration.version)) continue;
      await client.query(migration.sql);
      applied.push(migration.version);
    }
    const verified = exactVersions((await client.query(
      'SELECT version FROM schema_migrations ORDER BY version',
    )).rows);
    verifyExactVersions(verified, expected);
    return { applied, verified };
  } finally {
    if (client && locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [ADVISORY_LOCK]); } catch { /* close below */ }
    }
    try { client?.release(); } finally { await pool?.end?.(); }
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = await runMigrations();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: 'MIGRATION_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
