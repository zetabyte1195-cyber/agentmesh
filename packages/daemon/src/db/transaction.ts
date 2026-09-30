import type { SqliteDatabase, TransactionRetryOptions } from './types.js';

export const DEFAULT_MAX_RETRIES = 10;
export const DEFAULT_BASE_DELAY_MS = 25;
export const DEFAULT_MAX_DELAY_MS = 1000;
export const DEFAULT_FACTOR = 2;

/**
 * Detects whether an error thrown by SQLite / better-sqlite3 represents
 * a busy / lock conflict error eligible for retry.
 */
export function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string') {
    if (
      e.code === 'SQLITE_BUSY' ||
      e.code === 'SQLITE_BUSY_RECOVERY' ||
      e.code === 'SQLITE_BUSY_SNAPSHOT'
    ) {
      return true;
    }
  }
  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase();
    if (msg.includes('database is locked') || msg.includes('sqlite_busy')) {
      return true;
    }
  }
  return false;
}

/**
 * Calculates exponential backoff with randomized jitter.
 */
export function calculateJitterDelay(
  attempt: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
  factor: number = DEFAULT_FACTOR,
  jitter: boolean = true
): number {
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt));
  if (!jitter) {
    return Math.round(rawDelay);
  }
  const min = Math.min(baseDelayMs, rawDelay);
  const max = Math.max(baseDelayMs, rawDelay);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Synchronous sleep using Atomics.wait with busy-spin fallback.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy wait fallback
    }
  }
}

/**
 * Asynchronous sleep using setTimeout.
 */
export function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Executes a write transaction using SQLite `BEGIN IMMEDIATE` with jittered exponential backoff retry.
 * Per Spec v1.1 §5: "All writes use BEGIN IMMEDIATE with jittered retry (P1.2)."
 *
 * Synchronous variant: blocks thread briefly between retries using sleepSync.
 */
export function withImmediateTransaction<T>(
  db: SqliteDatabase,
  fn: () => T,
  options?: TransactionRetryOptions
): T {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = options?.factor ?? DEFAULT_FACTOR;
  const jitter = options?.jitter ?? true;

  const immediateTx = db.transaction(fn).immediate;

  let attempt = 0;
  while (true) {
    try {
      return immediateTx();
    } catch (err: unknown) {
      if (isBusyError(err) && attempt < maxRetries) {
        const delayMs = calculateJitterDelay(attempt, baseDelayMs, maxDelayMs, factor, jitter);
        options?.onRetry?.(attempt, delayMs, err);
        sleepSync(delayMs);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Executes a write transaction using SQLite `BEGIN IMMEDIATE` with asynchronous jittered retry.
 * Allows the Node.js event loop to process other I/O between lock retry attempts.
 */
export async function withImmediateTransactionAsync<T>(
  db: SqliteDatabase,
  fn: () => T,
  options?: TransactionRetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = options?.factor ?? DEFAULT_FACTOR;
  const jitter = options?.jitter ?? true;

  const immediateTx = db.transaction(fn).immediate;

  let attempt = 0;
  while (true) {
    try {
      return immediateTx();
    } catch (err: unknown) {
      if (isBusyError(err) && attempt < maxRetries) {
        const delayMs = calculateJitterDelay(attempt, baseDelayMs, maxDelayMs, factor, jitter);
        options?.onRetry?.(attempt, delayMs, err);
        await sleepAsync(delayMs);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
