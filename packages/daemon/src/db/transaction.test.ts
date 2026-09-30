import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from './connection.js';
import {
  calculateJitterDelay,
  isBusyError,
  withImmediateTransaction,
  withImmediateTransactionAsync,
} from './transaction.js';
import type { SqliteDatabase } from './types.js';

describe('Transaction management and BEGIN IMMEDIATE with jittered retry', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        val INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('isBusyError', () => {
    it('identifies SQLite busy error codes', () => {
      expect(isBusyError({ code: 'SQLITE_BUSY' })).toBe(true);
      expect(isBusyError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
      expect(isBusyError({ code: 'SQLITE_BUSY_RECOVERY' })).toBe(true);
    });

    it('identifies database is locked message', () => {
      expect(isBusyError(new Error('database is locked'))).toBe(true);
      expect(isBusyError(new Error('SqliteError: database table is locked'))).toBe(false);
    });

    it('returns false for non-busy errors and non-objects', () => {
      expect(isBusyError(new Error('CHECK constraint failed'))).toBe(false);
      expect(isBusyError(new Error('syntax error'))).toBe(false);
      expect(isBusyError(new Error('EBUSY: resource busy or locked'))).toBe(false);
      expect(isBusyError({ code: 'EBUSY', message: 'resource busy or locked' })).toBe(false);
      expect(isBusyError({ code: 'SQLITE_LOCKED', message: 'database table is locked' })).toBe(false);
      expect(isBusyError(null)).toBe(false);
      expect(isBusyError(undefined)).toBe(false);
      expect(isBusyError(123)).toBe(false);
    });
  });

  describe('calculateJitterDelay', () => {
    it('returns exact delay when jitter is disabled', () => {
      const delay0 = calculateJitterDelay(0, 20, 1000, 2, false);
      expect(delay0).toBe(20);
      const delay1 = calculateJitterDelay(1, 20, 1000, 2, false);
      expect(delay1).toBe(40);
      const delayMax = calculateJitterDelay(10, 20, 100, 2, false);
      expect(delayMax).toBe(100);
    });

    it('returns randomized delay within bounds when jitter is enabled', () => {
      for (let i = 0; i < 20; i++) {
        const delay = calculateJitterDelay(2, 20, 500, 2, true);
        // rawDelay is 20 * 4 = 80
        expect(delay).toBeGreaterThanOrEqual(20);
        expect(delay).toBeLessThanOrEqual(80);
      }
    });
  });

  describe('withImmediateTransaction (sync)', () => {
    it('commits successful operations', () => {
      const result = withImmediateTransaction(db, () => {
        db.prepare('INSERT INTO items (id, val) VALUES (?, ?)').run('a', 42);
        return 'success';
      });

      expect(result).toBe('success');
      const row = db.prepare('SELECT val FROM items WHERE id = ?').get('a') as { val: number };
      expect(row.val).toBe(42);
    });

    it('rolls back completely on error', () => {
      expect(() => {
        withImmediateTransaction(db, () => {
          db.prepare('INSERT INTO items (id, val) VALUES (?, ?)').run('b', 100);
          throw new Error('boom');
        });
      }).toThrow('boom');

      const row = db.prepare('SELECT val FROM items WHERE id = ?').get('b');
      expect(row).toBeUndefined();
    });

    it('retries on busy errors and succeeds once lock is free', () => {
      let attempts = 0;
      const retryLog: Array<{ attempt: number; delay: number }> = [];

      const result = withImmediateTransaction(
        db,
        () => {
          attempts++;
          if (attempts < 3) {
            const err = new Error('database is locked');
            (err as unknown as { code: string }).code = 'SQLITE_BUSY';
            throw err;
          }
          db.prepare('INSERT INTO items (id, val) VALUES (?, ?)').run('c', 200);
          return 'retry_succeeded';
        },
        {
          maxRetries: 5,
          baseDelayMs: 5,
          maxDelayMs: 50,
          onRetry: (attempt, delay) => {
            retryLog.push({ attempt, delay });
          },
        }
      );

      expect(result).toBe('retry_succeeded');
      expect(attempts).toBe(3);
      expect(retryLog).toHaveLength(2);
      const row = db.prepare('SELECT val FROM items WHERE id = ?').get('c') as { val: number };
      expect(row.val).toBe(200);
    });

    it('rethrows when max retries exceeded', () => {
      let attempts = 0;
      expect(() => {
        withImmediateTransaction(
          db,
          () => {
            attempts++;
            const err = new Error('database is locked');
            (err as unknown as { code: string }).code = 'SQLITE_BUSY';
            throw err;
          },
          {
            maxRetries: 3,
            baseDelayMs: 2,
            maxDelayMs: 10,
          }
        );
      }).toThrow('database is locked');

      // Initial attempt (0) + 3 retries (1, 2, 3) = 4 total invocations
      expect(attempts).toBe(4);
    });
  });

  describe('withImmediateTransactionAsync', () => {
    it('asynchronously executes and commits', async () => {
      const result = await withImmediateTransactionAsync(db, () => {
        db.prepare('INSERT INTO items (id, val) VALUES (?, ?)').run('d', 300);
        return 999;
      });

      expect(result).toBe(999);
      const row = db.prepare('SELECT val FROM items WHERE id = ?').get('d') as { val: number };
      expect(row.val).toBe(300);
    });

    it('asynchronously retries on busy error', async () => {
      let attempts = 0;
      const result = await withImmediateTransactionAsync(
        db,
        () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error('database is locked');
            (err as unknown as { code: string }).code = 'SQLITE_BUSY';
            throw err;
          }
          db.prepare('INSERT INTO items (id, val) VALUES (?, ?)').run('e', 400);
          return 'async_retry_succeeded';
        },
        {
          maxRetries: 5,
          baseDelayMs: 5,
          maxDelayMs: 20,
        }
      );

      expect(result).toBe('async_retry_succeeded');
      expect(attempts).toBe(2);
      const row = db.prepare('SELECT val FROM items WHERE id = ?').get('e') as { val: number };
      expect(row.val).toBe(400);
    });
  });
});
