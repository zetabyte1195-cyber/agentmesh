/**
 * SQLite migration engine with version tracking and idempotency.
 */
import { loadInitialSchemaSql } from './schema-v1.js';
import { withImmediateTransaction, withImmediateTransactionAsync } from './transaction.js';
import type { Migration, MigrationRecord, MigrationResult, SqliteDatabase, TransactionRetryOptions } from './types.js';

export const SCHEMA_MIGRATIONS_TABLE = '_schema_migrations';

/**
 * Built-in AgentMesh migrations array.
 * Migration 1: Initial schema v1.1 conforming to Spec v1.1 and S0.3.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '0001_initial_schema',
    up: loadInitialSchemaSql(),
  },
];

/**
 * Ensures the _schema_migrations table exists to track applied migrations.
 */
export function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Retrieves the list of applied migration records in ascending version order.
 */
export function getAppliedMigrations(db: SqliteDatabase): MigrationRecord[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare(`SELECT version, name, applied_at FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version ASC`)
    .all() as MigrationRecord[];
  return rows;
}

/**
 * Returns the SQLite user_version pragma value.
 */
export function getUserVersion(db: SqliteDatabase): number {
  const result = db.pragma('user_version', { simple: true });
  return typeof result === 'number' ? result : 0;
}

/**
 * Sets the SQLite user_version pragma value.
 */
export function setUserVersion(db: SqliteDatabase, version: number): void {
  db.pragma(`user_version = ${version}`);
}

/**
 * Executes pending migrations inside a BEGIN IMMEDIATE transaction with jittered retry.
 * Migrations are completely idempotent: if already applied, they are skipped.
 * Updates both the _schema_migrations table and the PRAGMA user_version.
 */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  retryOptions?: TransactionRetryOptions
): MigrationResult {
  return withImmediateTransaction(
    db,
    () => {
      ensureMigrationsTable(db);
      const appliedRecords = getAppliedMigrations(db);
      const appliedSet = new Set(appliedRecords.map((r) => r.version));

      const pending = migrations
        .filter((m) => !appliedSet.has(m.version))
        .sort((a, b) => a.version - b.version);

      const applied: Array<{ version: number; name: string }> = [];

      for (const migration of pending) {
        if (typeof migration.up === 'string') {
          db.exec(migration.up);
        } else {
          migration.up(db);
        }

        db.prepare(
          `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
        ).run(migration.version, migration.name);

        setUserVersion(db, migration.version);
        applied.push({ version: migration.version, name: migration.name });
      }

      return {
        applied,
        currentVersion: getUserVersion(db),
      };
    },
    retryOptions
  );
}

/**
 * Asynchronous variant of migrate using withImmediateTransactionAsync.
 */
export async function migrateAsync(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  retryOptions?: TransactionRetryOptions
): Promise<MigrationResult> {
  return withImmediateTransactionAsync(
    db,
    () => {
      ensureMigrationsTable(db);
      const appliedRecords = getAppliedMigrations(db);
      const appliedSet = new Set(appliedRecords.map((r) => r.version));

      const pending = migrations
        .filter((m) => !appliedSet.has(m.version))
        .sort((a, b) => a.version - b.version);

      const applied: Array<{ version: number; name: string }> = [];

      for (const migration of pending) {
        if (typeof migration.up === 'string') {
          db.exec(migration.up);
        } else {
          migration.up(db);
        }

        db.prepare(
          `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
        ).run(migration.version, migration.name);

        setUserVersion(db, migration.version);
        applied.push({ version: migration.version, name: migration.name });
      }

      return {
        applied,
        currentVersion: getUserVersion(db),
      };
    },
    retryOptions
  );
}
