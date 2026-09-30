import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher } from './dispatcher.js';

let dir: string;
let db: SqliteDatabase;
let ids: IdentityService;

function agent(agentId: string, platform: string): DispatchableAgent {
  return {
    agentId,
    platform,
    rulebook: 'RULES.md',
    command: (prompt) => {
      const file = join(dir, `${agentId}.mjs`);
      writeFileSync(file, `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));`);
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file, prompt.slice(0, 40)], parse: parseClaudeEvent };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-clock-probe-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
  ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'claude-1', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'gemini-1', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('REGRESSION (Gemini P2.5 clock-skew probe): the retry brake is immune to clock skew', () => {
  it('demonstrates that if clock < SQLite CURRENT_TIMESTAMP, r.started_at >= t.updated_at matches 0 runs', async () => {
    // When a task is inserted without explicit updated_at, SQLite sets updated_at = CURRENT_TIMESTAMP
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner) VALUES ('T1', 'p', 'T1', 'ac', 'Gemini')").run();
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1' WHERE id = 'T1'").run();
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = 'T1'").run();

    const taskRow = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('T1') as { updated_at: string };
    const taskUpdatedAt = taskRow.updated_at;

    // Suppose Dispatcher runs with a clock that is even 1 second behind SQLite's CURRENT_TIMESTAMP
    // (e.g. mock clock in test, or slight host clock / timezone skew)
    const pastClock = new Date(new Date(taskUpdatedAt + 'Z').getTime() - 1000);

    const d = new Dispatcher({
      db,
      identity: ids,
      agents: [agent('gemini-1', 'ANTIGRAVITY')],
      repoRoot: dir,
      now: () => pastClock,
    });

    // Run 1: gemini-1 is dispatched
    const started = d.tick();
    expect(started.length).toBe(1);

    // Wait for run 1 to finish
    while (d.isBusy('gemini-1')) await new Promise((r) => setTimeout(r, 25));

    // The run finished with status 'SUCCEEDED'
    const run = db.prepare("SELECT status, started_at FROM dispatch_runs WHERE task_id = 'T1'").get() as { status: string; started_at: string };
    expect(run.status).toBe('SUCCEEDED');

    // run.started_at comes from the skewed clock and is earlier than SQLite's updated_at...
    expect(run.started_at < taskUpdatedAt).toBe(true);

    // REGRESSION (was: re-dispatched immediately): the brake now compares the task_version recorded at
    // launch with tasks.updated_at (DB value vs DB value), so clock skew no longer disables it.
    expect(d.tick()).toEqual([]);
  });
});
