import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from './connection.js';
import type { SqliteDatabase } from './types.js';

describe('SQLite connection management and pragmas (spec v1.1 §5)', () => {
  let tempDir: string | null = null;
  let db: SqliteDatabase | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentmesh-conn-test-'));
  });

  afterEach(() => {
    if (db && db.open) {
      closeDatabase(db);
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('opens in-memory database with correct default pragmas', () => {
    db = openDatabase(':memory:');
    expect(db.open).toBe(true);
    expect(db.memory).toBe(true);

    const busyTimeout = db.pragma('busy_timeout', { simple: true });
    expect(busyTimeout).toBe(5000);

    const synchronous = db.pragma('synchronous', { simple: true });
    // In SQLite, synchronous = NORMAL corresponds to 1
    expect(synchronous).toBe(1);

    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    expect(foreignKeys).toBe(1);
  });

  it('opens file-based database in WAL mode', () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const dbPath = join(tempDir, 'nested', 'test.db');
    db = openDatabase(dbPath);

    expect(db.open).toBe(true);
    expect(db.memory).toBe(false);

    // On disk, journal_mode = WAL must return 'wal'
    const journalMode = db.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');

    const busyTimeout = db.pragma('busy_timeout', { simple: true });
    expect(busyTimeout).toBe(5000);

    const synchronous = db.pragma('synchronous', { simple: true });
    expect(synchronous).toBe(1);

    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    expect(foreignKeys).toBe(1);

    // Parent directory creation is automatic
    expect(existsSync(join(tempDir, 'nested'))).toBe(true);
  });

  it('respects custom pragma options', () => {
    db = openDatabase(':memory:', {
      busyTimeout: 10000,
      foreignKeys: false,
    });

    const busyTimeout = db.pragma('busy_timeout', { simple: true });
    expect(busyTimeout).toBe(10000);

    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    expect(foreignKeys).toBe(0);
  });

  it('closeDatabase cleanly closes open connections', () => {
    db = openDatabase(':memory:');
    expect(db.open).toBe(true);
    closeDatabase(db);
    expect(db.open).toBe(false);

    // Idempotent close
    expect(() => closeDatabase(db as SqliteDatabase)).not.toThrow();
  });
});
