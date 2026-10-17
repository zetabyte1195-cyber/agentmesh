// A spending limit per mission: what counts, when it is reached, and what it cannot see.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, USAGE_MIGRATION } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { MISSION_MIGRATION } from '../missions/index.js';
import { BUDGET_MIGRATION, BudgetError, BudgetService } from './index.js';

let dir: string;
let db: SqliteDatabase;
let budget: BudgetService;
let runs = 0;

const mission = (id: string, status = 'IMPLEMENTING') =>
  db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, reviewer_agent_ids, round) VALUES (?, 'T', 'a brief long enough', ?, 'claude-1', '[]', 1)").run(id, status);
const task = (id: string, missionId: string) =>
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id) VALUES (?, ?, 'x', 'ac', 'IN_PROGRESS', 'claude-1')").run(id, `mission:${missionId}`);
/** A finished run on `subject` (a task id or "mission:<id>"), with what the tool reported (nothing, when `usage` is null). */
function run(subject: string, usage: { input?: number; output?: number; cache?: number; cost?: number | null } | null, status = 'SUCCEEDED') {
  const id = `r${++runs}`;
  db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES (?, 'claude-1', ?, ?, ?, '2026-10-15 09:00:00', ?)").run(id, subject, subject.startsWith('mission:') ? 'PLAN' : 'TASK', status, status === 'RUNNING' ? null : '2026-10-15 09:05:00');
  if (usage) db.prepare('INSERT INTO run_usage (run_id, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)').run(id, usage.input ?? 0, usage.output ?? 0, usage.cache ?? 0, usage.cost ?? null);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-budget-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, USAGE_MIGRATION, BUDGET_MIGRATION]);
  new IdentityService(db).registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  budget = new BudgetService(db);
  runs = 0;
  mission('M1');
  task('M1-1', 'M1');
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('setting a limit', () => {
  it('a mission has none until one is set, and setting both kinds keeps both', () => {
    expect(budget.status('M1')).toBeNull();
    expect(budget.set('M1', { maxCostUsd: 5, maxTokens: 2_000_000 })).toMatchObject({ maxCostUsd: 5, maxTokens: 2_000_000, usedTokens: 0, usedCostUsd: null, reached: null });
  });

  it('refuses nonsense in plain words, and an unknown mission', () => {
    for (const bad of [{ maxCostUsd: 0 }, { maxCostUsd: -1 }, { maxCostUsd: Number.NaN }, { maxCostUsd: 1_000_000 }]) {
      expect(() => budget.set('M1', bad)).toThrow(/dollar limit must be more than 0/);
    }
    for (const bad of [{ maxTokens: 5 }, { maxTokens: 1.5e4 + 0.5 }, { maxTokens: 20_000_000_000 }]) {
      expect(() => budget.set('M1', bad)).toThrow(/token limit must be a whole number/);
    }
    expect(() => budget.set('M9', { maxCostUsd: 5 })).toThrow(BudgetError);
    expect(budget.status('M1')).toBeNull(); // nothing half-saved
  });

  it('changing a limit replaces it, and setting neither removes it', () => {
    budget.set('M1', { maxCostUsd: 5 });
    budget.set('M1', { maxTokens: 50_000 });
    expect(budget.status('M1')).toMatchObject({ maxCostUsd: null, maxTokens: 50_000 });
    expect(budget.set('M1', {})).toBeNull();
    expect(budget.status('M1')).toBeNull();
  });
});

describe('what counts', () => {
  it('adds up the planning runs and the runs on the mission\'s tasks, and nothing from other missions', () => {
    mission('M2');
    task('M2-1', 'M2');
    run('mission:M1', { input: 1000, output: 200, cost: 0.5 });
    run('M1-1', { input: 3000, output: 800, cost: 1.25 });
    run('M2-1', { input: 999_999, output: 999_999, cost: 99 }); // someone else's
    run('mission:M2', { input: 999_999, output: 999_999, cost: 99 });
    budget.set('M1', { maxCostUsd: 100 });
    expect(budget.status('M1')).toMatchObject({ usedTokens: 5000, usedCostUsd: 1.75 });
  });

  it('does not count cached input, a run still going, or a run whose tool reported nothing', () => {
    run('M1-1', { input: 1000, output: 100, cache: 5_000_000, cost: 0.1 });
    run('M1-1', { input: 50_000, output: 50_000, cost: 50 }, 'RUNNING');
    run('M1-1', null, 'FAILED'); // reported nothing
    budget.set('M1', { maxTokens: 10_000 });
    expect(budget.status('M1')).toMatchObject({ usedTokens: 1100, usedCostUsd: 0.1, reached: null });
  });
});

describe('when a limit is reached', () => {
  it('a dollar limit says so, at the limit and above it, and not before', () => {
    budget.set('M1', { maxCostUsd: 5 });
    run('M1-1', { cost: 4.99 });
    expect(budget.status('M1')!.reached).toBeNull();
    run('M1-1', { cost: 0.11 });
    expect(budget.status('M1')!.reached).toBe('It has used $5.10 of its $5.00 limit.');
  });

  it('a token limit says so', () => {
    budget.set('M1', { maxTokens: 20_000 });
    run('M1-1', { input: 15_000, output: 5_000 });
    expect(budget.status('M1')!.reached).toBe('It has used 20,000 of its 20,000 token limit.');
  });

  it('when both are reached it says both', () => {
    budget.set('M1', { maxCostUsd: 1, maxTokens: 10_000 });
    run('M1-1', { input: 20_000, cost: 2 });
    expect(budget.status('M1')!.reached).toBe('It has used $2.00 of its $1.00 limit and it has used 20,000 of its 10,000 token limit.');
  });

  it('a dollar limit cannot see a tool that reports no cost (Antigravity), but a token limit can', () => {
    run('M1-1', { input: 900_000, output: 100_000, cost: null });
    budget.set('M1', { maxCostUsd: 1 });
    expect(budget.status('M1')).toMatchObject({ usedCostUsd: null, reached: null });
    budget.set('M1', { maxTokens: 500_000 });
    expect(budget.status('M1')!.reached).toMatch(/1,000,000 of its 500,000 token limit/);
  });

  it('raising the limit lets the mission carry on', () => {
    budget.set('M1', { maxCostUsd: 1 });
    run('M1-1', { cost: 1.5 });
    expect(budget.reached().has('M1')).toBe(true);
    budget.set('M1', { maxCostUsd: 3 });
    expect(budget.reached().has('M1')).toBe(false);
  });

  it('lists only missions still in progress', () => {
    mission('M2', 'DONE');
    mission('M3', 'CANCELLED');
    mission('M4', 'PLAN_READY');
    for (const id of ['M1', 'M2', 'M3', 'M4']) {
      budget.set(id, { maxTokens: 10_000 });
      db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id) VALUES (?, ?, 'x', 'ac', 'IN_PROGRESS', 'claude-1')").run(`${id}-t`, `mission:${id}`);
      run(`${id}-t`, { input: 20_000 });
    }
    expect([...budget.reached().keys()].sort()).toEqual(['M1', 'M4']);
  });

  it('a mission that is deleted takes its limit with it', () => {
    budget.set('M1', { maxCostUsd: 1 });
    db.prepare("DELETE FROM missions WHERE id = 'M1'").run();
    expect((db.prepare('SELECT count(*) AS n FROM mission_budgets').get() as { n: number }).n).toBe(0);
  });

  it('costs are floating-point sums: $0.10 and $0.70 of a $0.80 limit is used up (0.1 + 0.7 is 0.7999999999999999 in a computer)', () => {
    budget.set('M1', { maxCostUsd: 0.8 });
    run('M1-1', { cost: 0.1 });
    run('M1-1', { cost: 0.7 });
    expect(budget.status('M1')!.usedCostUsd).toBeLessThan(0.8); // the sum really is slightly under
    expect(budget.status('M1')!.reached).toBe('It has used $0.80 of its $0.80 limit.');
    budget.set('M1', { maxCostUsd: 0.81 }); // a whole cent more is not used up
    expect(budget.status('M1')!.reached).toBeNull();
  });

  it('says which limits are used up, so the other one can be edited without it looking like a new event', () => {
    budget.set('M1', { maxCostUsd: 1, maxTokens: 1_000_000 });
    run('M1-1', { input: 100, cost: 1.4 });
    expect(budget.status('M1')!.reachedLimits).toEqual({ costUsd: 1 });
    budget.set('M1', { maxCostUsd: 1, maxTokens: 2_000_000 });
    expect(budget.status('M1')!.reachedLimits).toEqual({ costUsd: 1 });
  });

  it('reached() hands back the status, not only the reason, so nobody works it out twice', () => {
    budget.set('M1', { maxCostUsd: 1 });
    run('M1-1', { cost: 2 });
    expect(budget.reached().get('M1')).toMatchObject({ maxCostUsd: 1, usedCostUsd: 2, reached: 'It has used $2.00 of its $1.00 limit.' });
  });

  it('what a mission has used is looked up through indexes, not by reading every run', () => {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT sum(u.cost_usd) FROM dispatch_runs r JOIN run_usage u ON u.run_id = r.id WHERE r.status != 'RUNNING' AND (r.task_id = 'mission:M1' OR r.task_id IN (SELECT id FROM tasks WHERE phase_id = 'mission:M1'))").all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/idx_dispatch_runs_task|idx_tasks_phase/);
  });
});
