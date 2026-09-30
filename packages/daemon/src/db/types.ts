import type Database from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof Database>;

export interface DatabaseConnectionOptions {
  readonly?: boolean | undefined;
  fileMustExist?: boolean | undefined;
  timeout?: number | undefined;
  verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | undefined;
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF' | undefined;
  busyTimeout?: number | undefined;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA' | undefined;
  foreignKeys?: boolean | undefined;
}

export interface TransactionRetryOptions {
  maxRetries?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  factor?: number | undefined;
  jitter?: boolean | undefined;
  onRetry?: ((attempt: number, delayMs: number, error: unknown) => void) | undefined;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string | ((db: SqliteDatabase) => void);
  readonly down?: (string | ((db: SqliteDatabase) => void)) | undefined;
}

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export interface MigrationResult {
  applied: Array<{ version: number; name: string }>;
  currentVersion: number;
}
