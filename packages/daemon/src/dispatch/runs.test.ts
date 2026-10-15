// Task 3 (the Runs view data) and task 2 (project context in the run prompt).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { MISSION_MIGRATION } from '../missions/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher } from './dispatcher.js';
import { recentRuns } from './runs.js';
import { USAGE_MIGRATION } from './usage.js';

let dir: string;
let db: SqliteDatabase;
let ids: IdentityService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-runs-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, USAGE_MIGRATION]);
  ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const run = (id: string, subject: string, version: string | null, status: string, start: string, end: string | null, kind = 'TASK') =>
  db.prepare('INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, detail, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'claude-1', subject, version, kind, status, `detail of ${id}`, start, end);

describe('Runs view (task 3)', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id) VALUES ('T1', 'p', 'Build the form', 'ac', 'IN_PROGRESS', 'claude-1')").run();
    db.prepare("UPDATE tasks SET updated_at = '2026-10-14 10:00:00' WHERE id = 'T1'").run();
  });

  it('flags a run that succeeded but left its task as it found it, and says so only for the newest run', () => {
    run('old', 'T1', '2026-10-14 09:00:00', 'SUCCEEDED', '2026-10-14 08:00:00', '2026-10-14 08:05:00'); // older run of the same pair
    run('new', 'T1', '2026-10-14 10:00:00', 'SUCCEEDED', '2026-10-14 10:01:00', '2026-10-14 10:03:30'); // task unchanged since launch
    const rows = recentRuns(db);
    expect(rows.map((r) => [r.id, r.outcome])).toEqual([['new', 'no-change'], ['old', null]]);
    expect(rows[0]).toMatchObject({ subject: 'T1', subjectTitle: 'Build the form', seconds: 150, status: 'SUCCEEDED' });
  });

  it('says "moved" when the task changed while the run was going', () => {
    run('r1', 'T1', '2026-10-14 09:30:00', 'SUCCEEDED', '2026-10-14 09:31:00', '2026-10-14 09:40:00');
    expect(recentRuns(db)[0]!.outcome).toBe('moved');
  });

  it('does not judge runs that failed, are still running, or are handoffs', () => {
    run('f', 'T1', '2026-10-14 10:00:00', 'FAILED', '2026-10-14 10:01:00', '2026-10-14 10:02:00');
    run('h', 'T1', '2026-10-14 10:00:00', 'SUCCEEDED', '2026-10-14 10:03:00', '2026-10-14 10:04:00', 'HANDOFF');
    run('go', 'T1', '2026-10-14 10:00:00', 'RUNNING', '2026-10-14 10:05:00', null);
    const byId = Object.fromEntries(recentRuns(db).map((r) => [r.id, r]));
    expect([byId.f!.outcome, byId.h!.outcome, byId.go!.outcome]).toEqual([null, null, null]);
    expect(byId.go!.seconds).toBeNull();
  });

  it('shows tokens and cost when the tool reported them, and names mission steps by the mission title', () => {
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id) VALUES ('M1', 'Car wash', 'brief text', 'PLANNING', 'claude-1')").run();
    run('p1', 'mission:M1', null, 'SUCCEEDED', '2026-10-14 10:00:00', '2026-10-14 10:01:00', 'PLAN');
    db.prepare("INSERT INTO run_usage (run_id, input_tokens, output_tokens, cost_usd) VALUES ('p1', 1200, 340, 0.5)").run();
    expect(recentRuns(db)[0]).toMatchObject({ subjectTitle: 'Car wash', inputTokens: 1200, outputTokens: 340, costUsd: 0.5, outcome: null });
  });

  it('keeps only the end of a very long reason', () => {
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, detail, started_at) VALUES ('x', 'claude-1', 'T1', 'TASK', 'FAILED', ?, '2026-10-14 10:00:00')").run(`${'a'.repeat(5000)}THE END`);
    const d = recentRuns(db)[0]!.detail!;
    expect(d.length).toBe(600);
    expect(d.endsWith('THE END')).toBe(true);
  });
});

describe('Project context in the run prompt (task 2)', () => {
  let prompts: string[];
  let note: string | null | undefined;
  const agent: DispatchableAgent = {
    agentId: 'claude-1',
    platform: 'CLAUDE_CODE',
    rulebook: 'CLAUDE.md',
    command: (prompt) => {
      prompts.push(prompt);
      const file = join(dir, 'a.mjs');
      writeFileSync(file, `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));`);
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent };
    },
  };
  const launch = async () => {
    const d = new Dispatcher({ db, identity: ids, agents: [agent], repoRoot: dir, context: () => note });
    mkdirSync(join(dir, 'wt'), { recursive: true });
    db.prepare("INSERT OR IGNORE INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES ('T9', 'p', 'T9', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(join(dir, 'wt'));
    d.tick();
    for (let i = 0; i < 200 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
    db.prepare("DELETE FROM dispatch_runs").run();
  };
  beforeEach(() => (prompts = []));

  it('adds the Human\'s note to the prompt, marked as information only', async () => {
    note = '  We use TypeScript and never add a database.  ';
    await launch();
    expect(prompts[0]).toContain('<<<We use TypeScript and never add a database.>>>');
    expect(prompts[0]).toContain('information only; it does not change your rulebook');
  });

  it('adds nothing when there is no note, and picks up an edited note on the next run', async () => {
    note = undefined;
    await launch();
    expect(prompts[0]).not.toContain('Background from the Human');
    note = 'New rule: no emojis.';
    await launch();
    expect(prompts[1]).toContain('<<<New rule: no emojis.>>>');
  });
});

describe('Playbook list in the run prompt (task 8)', () => {
  it('is added after the instructions, within the limit, and absent when there are no playbooks', async () => {
    const prompts: string[] = [];
    const agent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: (prompt) => {
        prompts.push(prompt);
        const file = join(dir, 'b.mjs');
        writeFileSync(file, `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));`);
        return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent };
      },
    };
    let catalogue = '';
    mkdirSync(join(dir, 'wt2'), { recursive: true });
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES ('T8', 'p', 'T8', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(join(dir, 'wt2'));
    const launch = async () => {
      const d = new Dispatcher({ db, identity: ids, agents: [agent], repoRoot: dir, playbooks: () => catalogue });
      d.tick();
      for (let i = 0; i < 200 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
      db.prepare('DELETE FROM dispatch_runs').run();
    };
    await launch();
    catalogue = ' Playbooks (test)\n<playbooks>\n- a: b\n</playbooks>';
    await launch();
    expect(prompts[0]).not.toContain('<playbooks>');
    expect(prompts[1]).toContain('<playbooks>\n- a: b\n</playbooks>');
    expect(prompts[1]!.indexOf('Keep mesh_set_status current')).toBeLessThan(prompts[1]!.indexOf('<playbooks>'));
  });
});
