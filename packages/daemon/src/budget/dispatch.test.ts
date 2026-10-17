// The dispatcher starts nothing for a mission that has reached its spending limit, in every place work is chosen,
// and carries on with the other missions' work.
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

const claude: DispatchableAgent = { agentId: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'RULES.md', command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: [], parse: parseClaudeEvent }) };
const gemini: DispatchableAgent = { agentId: 'gemini-1', platform: 'ANTIGRAVITY', rulebook: 'RULES.md', command: () => ({ platform: 'ANTIGRAVITY', executable: process.execPath, args: [], parse: parseClaudeEvent }) };
const brief = 'Build a small web app for a car wash: customers pick a wash package and a time slot.';

const dispatcher = (withBudget = true) => new Dispatcher({ db, identity: new IdentityService(db), agents: [claude, gemini], repoRoot: dir, missions, ...(withBudget ? { budget } : {}) });

/** A mission already being built, so only its tasks are work. */
const building = (id: string) => db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, reviewer_agent_ids, round) VALUES (?, 'T', ?, 'IMPLEMENTING', 'claude-1', '[]', 1)").run(id, brief);
const task = (id: string, missionId: string, status: string, extra: { owner?: string; worktree?: string; priority?: number } = {}) =>
  db
    .prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path, priority, diff_hash) VALUES (?, ?, 'x', 'ac', ?, ?, ?, ?, ?)")
    .run(id, `mission:${missionId}`, status, extra.owner ?? null, extra.worktree ?? null, extra.priority ?? 2, status === 'READY_FOR_REVIEW' ? 'a'.repeat(64) : null); // a submitted task has its diff pinned
/** Use up `usd` on a mission's task, so a $1 limit is reached. */
function spend(taskId: string, usd: number) {
  const id = `r${++runs}`;
  db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES (?, 'claude-1', ?, 'TASK', 'SUCCEEDED', '2020-01-01 00:00:00', '2020-01-01 00:05:00')").run(id, taskId);
  db.prepare('INSERT INTO run_usage (run_id, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES (?, 1, 1, 0, ?)').run(id, usd);
}
const ofTask = (w: { taskId: string | null } | null) => w?.taskId ?? null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-budget-dispatch-'));
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

describe('mission steps', () => {
  it('a mission over its limit is not handed out, the next mission is, and raising the limit brings it back', () => {
    const first = missions.create(human, { title: 'First', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    const second = missions.create(human, { title: 'Second', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    const d = dispatcher();
    expect(d.nextWork(claude)?.job).toContain('First'); // the oldest first, as before
    budget.set(first.id, { maxCostUsd: 1 });
    spend(`mission:${first.id}`, 1.5);
    const picked = d.nextWork(claude);
    expect(picked?.job).toContain('Second');
    expect(picked?.job).not.toContain('First');
    budget.set(first.id, { maxCostUsd: 10 });
    expect(d.nextWork(claude)?.job).toContain('First');
    void second;
  });

  it('with no budget service the dispatcher behaves as it always did', () => {
    const first = missions.create(human, { title: 'First', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    budget.set(first.id, { maxCostUsd: 1 });
    spend(`mission:${first.id}`, 5);
    expect(dispatcher(false).nextWork(claude)?.job).toContain('First');
  });
});

describe('tasks', () => {
  beforeEach(() => {
    building('M1');
    building('M2');
  });

  it('new work is taken from missions within their limit, in the usual order, and from the stopped one again once raised', () => {
    task('M1-1', 'M1', 'TODO', { priority: 1 });
    task('M2-1', 'M2', 'TODO', { priority: 3 });
    const d = dispatcher();
    expect(ofTask(d.nextWork(claude))).toBe('M1-1');
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    expect(ofTask(d.nextWork(claude))).toBe('M2-1');
    budget.set('M1', { maxCostUsd: 50 });
    expect(ofTask(d.nextWork(claude))).toBe('M1-1');
  });

  it('when the only work belongs to a stopped mission there is nothing to start', () => {
    task('M1-1', 'M1', 'TODO');
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    expect(dispatcher().nextWork(claude)).toBeNull();
  });

  it('a task already in hand waits, and does not keep the agent from other missions\' work', () => {
    task('M1-1', 'M1', 'IN_PROGRESS', { owner: 'claude-1', worktree: 'wt' });
    task('M2-1', 'M2', 'TODO');
    const d = dispatcher();
    expect(d.nextWork(claude)).toMatchObject({ taskId: 'M1-1', resume: true });
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    expect(ofTask(d.nextWork(claude))).toBe('M2-1');
    budget.set('M1', { maxCostUsd: 50 });
    expect(d.nextWork(claude)).toMatchObject({ taskId: 'M1-1', resume: true });
  });

  it('a review of a stopped mission\'s task is not started, and another mission\'s is', () => {
    task('M1-1', 'M1', 'READY_FOR_REVIEW', { owner: 'claude-1' });
    task('M2-1', 'M2', 'READY_FOR_REVIEW', { owner: 'claude-1' });
    const d = dispatcher();
    expect(ofTask(d.nextWork(gemini))).toBe('M1-1');
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    expect(ofTask(d.nextWork(gemini))).toBe('M2-1');
  });

  it('a message about a stopped mission\'s task is not delivered, and one about another mission\'s is', () => {
    task('M1-1', 'M1', 'IN_PROGRESS', { owner: 'gemini-1' });
    task('M2-1', 'M2', 'IN_PROGRESS', { owner: 'gemini-1' });
    for (const [id, t] of [['h1', 'M1-1'], ['h2', 'M2-1']] as const) {
      db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES (?, ?, 'human', 'claude-1', 'please look')").run(id, t);
    }
    const d = dispatcher();
    budget.set('M1', { maxCostUsd: 1 });
    spend('M1-1', 2);
    expect(d.nextWork(claude)).toMatchObject({ kind: 'HANDOFF', taskId: 'M2-1' });
  });
});
