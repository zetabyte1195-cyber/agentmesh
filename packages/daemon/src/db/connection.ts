/**
 * SQLite connection factory configured with AgentMesh standard connection pragmas.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseConnectionOptions, SqliteDatabase } from './types.js';

export const DEFAULT_BUSY_TIMEOUT = 5000;
export const DEFAULT_JOURNAL_MODE = 'WAL';
export const DEFAULT_SYNCHRONOUS = 'NORMAL';
export const DEFAULT_FOREIGN_KEYS = true;

/**
 * Opens a SQLite database connection with AgentMesh standard connection pragmas
 * per Spec v1.1 §5:
 *   - journal_mode = WAL
 *   - busy_timeout = 5000
 *   - synchronous = NORMAL
 *   - foreign_keys = ON
 */
export function openDatabase(
  filename: string = ':memory:',
  options?: DatabaseConnectionOptions
): SqliteDatabase {
  // Ensure the parent directory exists if using a real file path
  if (filename !== ':memory:' && !filename.startsWith('file:')) {
    const dir = dirname(resolve(filename));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const dbOptions: Database.Options = {};
  if (options?.readonly !== undefined) dbOptions.readonly = options.readonly;
  if (options?.fileMustExist !== undefined) dbOptions.fileMustExist = options.fileMustExist;
  if (options?.timeout !== undefined) dbOptions.timeout = options.timeout;
  if (options?.verbose !== undefined) dbOptions.verbose = options.verbose;

  const db = new Database(filename, dbOptions);

  const busyTimeout = options?.busyTimeout ?? DEFAULT_BUSY_TIMEOUT;
  const journalMode = options?.journalMode ?? DEFAULT_JOURNAL_MODE;
  const synchronous = options?.synchronous ?? DEFAULT_SYNCHRONOUS;
  const foreignKeys = options?.foreignKeys ?? DEFAULT_FOREIGN_KEYS;

  // Apply normative pragmas per Spec v1.1 §5
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma(`journal_mode = ${journalMode}`);
  db.pragma(`synchronous = ${synchronous}`);
  if (foreignKeys) {
    db.pragma('foreign_keys = ON');
  } else {
    db.pragma('foreign_keys = OFF');
  }

  return db;
}

/**
 * Cleanly closes the database connection.
 */
export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) {
    db.close();
  }
}
