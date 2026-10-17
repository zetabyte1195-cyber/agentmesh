// Found by an independent review (Gemini, review A): gaps around cancelling, landing switched off, and a cooling-down mission.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, USAGE_MIGRATION } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { MISSION_MIGRATION, MissionService } from '../missions/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { BUDGET_MIGRATION, BudgetService } from './index.js';

let dir: string;
let db: SqliteDatabase;
let missions: MissionService;
let budget: BudgetService;
let human: Principal;
let runs = 0;

const mk = (agentId: string, platform: string): DispatchableAgent => ({ agentId, platform, rulebook: 'RULES.md', command: () => ({ platform, executable: process.execPath, args: [], parse: parseClaudeEvent }) });
const claude = mk('claude-1', 'CLAUDE_CODE');
const gemini = mk('gemini-1', 'ANTIGRAVITY');
const brief = 'Build a small web app for a car wash: customers pick a wash package and a time slot.';
const dispatcher = (extra: Record<string, unknown> = {}) => new Dispatcher({ db, identity: new IdentityService(db), agents: [claude, gemini], repoRoot: dir, missions, budget, ...extra });
const building = (id: string) => db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, reviewer_agent_ids, round) VALUES (?, 'T', ?, 'IMPLEMENTING', 'claude-1', '[]', 1)").run(id, brief);
const task = (id: string, missionId: string, status: string, owner?: string) =>
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, diff_hash) VALUES (?, ?, 'x', 'ac', ?, ?, ?)").run(id, `mission:${missionId}`, status, owner ?? null, status === 'READY_FOR_REVIEW' ? 'a'.repeat(64) : null);
const cancel = (id: string) => db.prepare("UPDATE missions SET status = 'CANCELLED' WHERE id = ?").run(id);
function spend(taskId: string, usd: number) {
  const id = `r${++runs}`;
  db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES (?, 'claude-1', ?, 'TASK', 'SUCCEEDED', '2020-01-01 00:00:00', '2020-01-01 00:05:00')").run(id, taskId);
  db.prepare('INSERT INTO run_usage (run_id, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES (?, 1, 1, 0, ?)').run(id, usd);
}
const taskOf = (w: { taskId: string | null } | null) => w?.taskId ?? null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-review-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, USAGE_MIGRATION, BUDGET_MIGRATION]);
  const ids = new IdentityService(db);
  human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  missions = new MissionService({ db, board: new BoardService({ db, worktrees: {} as never }) });
  budget = new BudgetService(db);
  runs = 0;
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('cancelling a mission stops its work (this was broken before: the tasks stayed on the board and kept being handed out)', () => {
  beforeEach(() => {
    building('M1');
    building('M2');
  });

  it('a new task of a cancelled mission is not handed out, and another mission\'s is', () => {
    task('M1-1', 'M1', 'TODO');
    task('M2-1', 'M2', 'TODO');
    const d = dispatcher();
    expect(taskOf(d.nextWork(claude))).toBe('M1-1');
    cancel('M1');
    expect(taskOf(d.nextWork(claude))).toBe('M2-1');
    cancel('M2');
    expect(d.nextWork(claude)).toBeNull();
  });

  it('nor a task in hand, a review, or a message about it', () => {
    task('M1-1', 'M1', 'IN_PROGRESS', 'claude-1');
    db.prepare("UPDATE tasks SET worktree_path = 'wt' WHERE id = 'M1-1'").run();
    task('M1-2', 'M1', 'READY_FOR_REVIEW', 'claude-1');
    db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES ('h1', 'M1-1', 'human', 'claude-1', 'please look')").run();
    const d = dispatcher();
    expect(d.nextWork(claude)).not.toBeNull();
    expect(d.nextWork(gemini)).not.toBeNull(); // the review
    cancel('M1');
    expect(d.nextWork(claude)).toBeNull();
    expect(d.nextWork(gemini)).toBeNull();
  });

  it('an over-budget mission stays stopped after it is cancelled (it must not start again)', () => {
    task('M1-1', 'M1', 'TODO');
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    const d = dispatcher();
    expect(d.nextWork(claude)).toBeNull();
    cancel('M1');
    expect(d.nextWork(claude)).toBeNull();
  });

  it('a review already claimed is not resumed for an over-budget mission', () => {
    task('M1-1', 'M1', 'READY_FOR_REVIEW', 'claude-1');
    db.prepare("UPDATE tasks SET status = 'AUDITING', reviewing_agent_id = 'gemini-1' WHERE id = 'M1-1'").run();
    const d = dispatcher();
    expect(taskOf(d.nextWork(gemini))).toBe('M1-1');
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    expect(d.nextWork(gemini)).toBeNull();
  });

  it('a "gave up" notice for a cancelled or over-budget mission is not shown (there is nothing to try again)', () => {
    task('M1-1', 'M1', 'TODO');
    task('M2-1', 'M2', 'TODO');
    for (const t of ['M1-1', 'M2-1']) {
      for (let i = 0; i < 3; i++) {
        const id = `f${++runs}`;
        db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, detail, started_at, ended_at) VALUES (?, 'claude-1', ?, (SELECT updated_at FROM tasks WHERE id = ?), 'TASK', 'FAILED', 'boom', datetime('now', '-20 minutes'), datetime('now', '-19 minutes'))").run(id, t, t);
      }
    }
    const d = dispatcher();
    expect(d.stuck().map((s) => s.subject).sort()).toEqual(['M1-1', 'M2-1']);
    cancel('M1');
    expect(d.stuck().map((s) => s.subject)).toEqual(['M2-1']);
    budget.set('M2', { maxCostUsd: 1 });
    spend('M2-1', 2);
    expect(d.stuck()).toEqual([]);
  });
});

describe('a prerequisite must have landed, unless nothing can land', () => {
  const setup = () => {
    building('M1');
    task('M1-1', 'M1', 'READY_FOR_REVIEW', 'claude-1');
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, prerequisites) VALUES ('M1-2', 'mission:M1', 'x', 'ac', 'TODO', '[\"M1-1\"]')").run();
    db.prepare("INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a1', 'M1-1', 'gemini-1', 'PASSED', ?, 1, 'ok')").run('a'.repeat(64));
  };

  it('with landing on, a dependent task waits until its prerequisite is COMMITTED', () => {
    setup();
    const d = dispatcher({ landing: () => true });
    expect(d.nextWork(gemini)).toBeNull();
    db.prepare("UPDATE tasks SET status = 'COMMITTED' WHERE id = 'M1-1'").run();
    expect(taskOf(d.nextWork(gemini))).toBe('M1-2');
  });

  it('with landing OFF (no project check set, and not opted in) nothing ever lands, so PASSED is enough: the mission must not wait forever', () => {
    setup();
    expect(taskOf(dispatcher({ landing: () => false }).nextWork(gemini))).toBe('M1-2');
  });
});

describe('a mission that is cooling down after a failure does not hold up the next one', () => {
  it('the next mission waiting on the same agent is started', () => {
    const first = missions.create(human, { title: 'First', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    missions.create(human, { title: 'Second', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    const d = dispatcher();
    expect(d.nextWork(claude)?.job).toContain('First');
    // the first one's planning run failed a minute ago: it is cooling down for ten minutes
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, detail, started_at, ended_at) VALUES ('c1', 'claude-1', ?, (SELECT updated_at FROM missions WHERE id = ?), 'PLAN', 'FAILED', 'boom', datetime('now', '-2 minutes'), datetime('now', '-1 minutes'))").run(`mission:${first.id}`, first.id);
    const picked = d.nextWork(claude);
    expect(picked?.job).toContain('Second');
    expect(picked?.job).not.toContain('First');
  });
});
