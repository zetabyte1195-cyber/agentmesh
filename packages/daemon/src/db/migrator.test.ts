import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from './connection.js';
import {
  MIGRATIONS,
  getAppliedMigrations,
  getUserVersion,
  migrate,
  migrateAsync,
} from './migrator.js';
import { INITIAL_SCHEMA_SQL } from './schema-v1.js';
import type { SqliteDatabase } from './types.js';

describe('SQLite Migrations Engine (S0.3 schema v1.1 & Idempotency)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('INITIAL_SCHEMA_SQL matches docs/design/schema.sql exactly (no schema drift)', () => {
    const canonicalPath = fileURLToPath(new URL('../../../../docs/design/schema.sql', import.meta.url));
    const canonicalSql = readFileSync(canonicalPath, 'utf8');
    expect(INITIAL_SCHEMA_SQL.replace(/\r\n/g, '\n').trim()).toBe(canonicalSql.replace(/\r\n/g, '\n').trim());
  });

  it('applies migration 1 to fresh database and updates user_version', () => {
    expect(getUserVersion(db)).toBe(0);
    expect(getAppliedMigrations(db)).toHaveLength(0);

    const result = migrate(db);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.version).toBe(1);
    expect(result.applied[0]?.name).toBe('0001_initial_schema');
    expect(result.currentVersion).toBe(1);
    expect(getUserVersion(db)).toBe(1);

    const records = getAppliedMigrations(db);
    expect(records).toHaveLength(1);
    expect(records[0]?.version).toBe(1);
    expect(records[0]?.name).toBe('0001_initial_schema');
  });

  it('creates all core schema tables, views, and indexes', () => {
    migrate(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('_schema_migrations');
    expect(tables).toContain('agents');
    expect(tables).toContain('tasks');
    expect(tables).toContain('leases');
    expect(tables).toContain('audits');
    expect(tables).toContain('findings');
    expect(tables).toContain('handoffs');
    expect(tables).toContain('questions');
    expect(tables).toContain('decisions');
    expect(tables).toContain('telemetry_samples');
    expect(tables).toContain('events');

    const views = db
      .prepare("SELECT name FROM sqlite_master WHERE type='view'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(views).toContain('v_task_dependencies');
  });

  it('enforces schema triggers (state machine transitions and two-agent rule)', () => {
    migrate(db);

    // Register two agents
    db.prepare(`
      INSERT INTO agents (id, name, platform, paradigm)
      VALUES ('claude-1', 'Claude 1', 'CLAUDE_CODE', 'CLI');
    `).run();

    db.prepare(`
      INSERT INTO agents (id, name, platform, paradigm)
      VALUES ('gemini-1', 'Gemini 1', 'ANTIGRAVITY', 'IDE');
    `).run();

    // Create a task
    db.prepare(`
      INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id)
      VALUES ('T1', 'Phase 1', 'Test Task', 'Tests pass', 'TODO', 'claude-1');
    `).run();

    // 1. Direct illegal transition from TODO -> PASSED must fail
    expect(() => {
      db.prepare("UPDATE tasks SET status = 'PASSED' WHERE id = 'T1'").run();
    }).toThrow(/Cannot transition task to PASSED without a corresponding PASSED audit record/);

    // 2. Legal transition to IN_PROGRESS then READY_FOR_REVIEW with diff_hash
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = 'T1'").run();
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'sha256-abc123' WHERE id = 'T1'").run();

    // 3. Two-agent rule: author cannot audit their own task
    expect(() => {
      db.prepare(`
        INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
        VALUES ('a1', 'T1', 'claude-1', 'PASSED', 'sha256-abc123', 1, 'Looks good');
      `).run();
    }).toThrow(/Two-agent rule violation/);

    // 4. Cross-platform audit by gemini-1 succeeds and transitions task to PASSED
    db.prepare(`
      INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
      VALUES ('a2', 'T1', 'gemini-1', 'PASSED', 'sha256-abc123', 1, 'Audited on Antigravity');
    `).run();

    const taskRow = db.prepare('SELECT status, reviewing_agent_id FROM tasks WHERE id = ?').get('T1') as {
      status: string;
      reviewing_agent_id: string;
    };
    expect(taskRow.status).toBe('PASSED');
    expect(taskRow.reviewing_agent_id).toBe('gemini-1');
  });

  it('is strictly idempotent when rerun multiple times', () => {
    const firstRun = migrate(db);
    expect(firstRun.applied).toHaveLength(1);
    expect(firstRun.currentVersion).toBe(1);

    // Second run
    const secondRun = migrate(db);
    expect(secondRun.applied).toHaveLength(0);
    expect(secondRun.currentVersion).toBe(1);

    // Third run
    const thirdRun = migrate(db);
    expect(thirdRun.applied).toHaveLength(0);
    expect(thirdRun.currentVersion).toBe(1);
  });

  it('migrateAsync works asynchronously with idempotency', async () => {
    const res1 = await migrateAsync(db, MIGRATIONS);
    expect(res1.applied).toHaveLength(1);
    expect(res1.currentVersion).toBe(1);

    const res2 = await migrateAsync(db, MIGRATIONS);
    expect(res2.applied).toHaveLength(0);
    expect(res2.currentVersion).toBe(1);
  });
});
