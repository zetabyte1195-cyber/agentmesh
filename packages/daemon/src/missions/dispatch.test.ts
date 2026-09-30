import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, MAX_ATTEMPTS_PER_TASK, RETRY_AFTER_MS } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import type { RunResult } from '../runner/run.js';
import { MISSION_MIGRATION } from './migration.js';
import { MissionService } from './service.js';

let dir: string;
let db: SqliteDatabase;
let svc: MissionService;
let human: Principal;
let clock: Date;
let finished: { agentId: string; work: { kind: string; taskId: string | null; job: string }; result: RunResult }[];
let behaviour: 'ok' | 'fail';
let created: string[];
let removed: string[];

const PRINT_CWD = "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'cwd=' + process.cwd() }));";
const FAIL = "console.error('boom'); process.exit(1);";

function agent(agentId: string, platform: string): DispatchableAgent {
  return {
    agentId,
    platform,
    rulebook: 'RULES.md',
    command: () => {
      const file = join(dir, `${agentId}.mjs`);
      writeFileSync(file, behaviour === 'ok' ? PRINT_CWD : FAIL);
      return { platform, executable: process.execPath, args: [file], parse: parseClaudeEvent };
    },
  };
}
const AGENTS = () => [agent('claude-1', 'CLAUDE_CODE'), agent('gemini-1', 'ANTIGRAVITY')];

function dispatcher(): Dispatcher {
  return new Dispatcher({
    db,
    identity: new IdentityService(db),
    agents: AGENTS(),
    repoRoot: dir,
    now: () => clock,
    missions: svc,
    scratch: {
      create: async (name) => {
        const p = join(dir, 'scratch', name);
        mkdirSync(p, { recursive: true });
        created.push(p);
        return p;
      },
      remove: async (p) => {
        removed.push(p);
        rmSync(p, { recursive: true, force: true });
      },
    },
    onRunFinished: (r) => finished.push(r),
  });
}
const settle = async (d: Dispatcher) => {
  for (let i = 0; i < 200 && AGENTS().some((a) => d.isBusy(a.agentId)); i++) await new Promise((r) => setTimeout(r, 25));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-mission-dispatch-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION]);
  const ids = new IdentityService(db);
  human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  svc = new MissionService({ db, board: new BoardService({ db, worktrees: {} as never }) });
  clock = new Date('2026-09-30T01:00:00Z');
  finished = [];
  created = [];
  removed = [];
  behaviour = 'ok';
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const brief = 'Build a small web app for a car wash: customers pick a wash package and a time slot.';

describe('dispatching mission steps', () => {
  it('sends the planner to write the plan, in a disposable checkout that is removed afterwards', async () => {
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    const d = dispatcher();
    const started = d.tick();
    expect(started.map((s) => [s.agentId, s.work.kind, s.work.taskId])).toEqual([['claude-1', 'PLAN', 'mission:M1']]); // Gemini has nothing yet
    expect(started[0]!.work.job).toContain('mesh_get_mission');
    expect(started[0]!.work.job).toContain('mesh_submit_plan');
    expect(d.isBusy('claude-1')).toBe(true); // busy while the checkout is made
    await settle(d);
    expect(created).toHaveLength(1);
    expect(String(finished[0]?.result.result?.text).replace('cwd=', '').toLowerCase()).toBe(created[0]!.toLowerCase()); // ran THERE
    expect(removed).toEqual(created);
    expect(existsSync(created[0]!)).toBe(false);
  });

  it('then asks the reviewers, each once per round, and the planner to revise and to split', async () => {
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    const d = dispatcher();
    d.tick();
    await settle(d);
    svc.submitPlan({ agentId: 'claude-1', platform: 'CLAUDE_CODE', paradigm: 'CLI', isHuman: false }, 'M1', '# Plan\n\nBuild the booking page with packages and time slots, tested.');
    clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    const review = d.tick();
    expect(review.map((s) => [s.agentId, s.work.kind])).toEqual([['gemini-1', 'PLAN_REVIEW']]);
    expect(review[0]!.work.job).toContain('planVersion');
    await settle(d);
    // the run ended without a review: the brake holds it back; nothing else is due
    expect(d.tick()).toEqual([]);
  });

  it('comes before ordinary task work', async () => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner) VALUES ('T1', 'p', 'a task', 'ac', 'Claude')").run();
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    const d = dispatcher();
    expect(d.tick().map((s) => s.work.kind)).toEqual(['PLAN']); // not the TODO task
    await settle(d);
  });

  it('follows the same retry limits as tasks: a wait after a failure, and after three it is left for the Human', async () => {
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    behaviour = 'fail';
    const d = dispatcher();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TASK; attempt++) {
      expect(d.tick().map((s) => s.work.kind)).toEqual(['PLAN']);
      await settle(d);
      expect(d.tick()).toEqual([]); // too soon to try again
      clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    }
    expect(d.tick()).toEqual([]); // used up: the cockpit shows it is stuck and the Human decides
    expect(created).toHaveLength(MAX_ATTEMPTS_PER_TASK);
    expect(removed).toEqual(created); // every checkout removed, even after failures
  });

  it('while a plan is cooling down after a failure the agent does other available work', async () => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner) VALUES ('T1', 'p', 'a task', 'ac', 'Claude')").run();
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    behaviour = 'fail';
    const d = dispatcher();
    expect(d.tick().map((s) => s.work.kind)).toEqual(['PLAN']);
    await settle(d);
    expect(d.tick().map((s) => [s.work.kind, s.work.taskId])).toEqual([['TASK', 'T1']]);
    await settle(d);
  });

  it('a mission that changes resets the brake (progress is not a retry)', async () => {
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    behaviour = 'fail';
    const d = dispatcher();
    d.tick();
    await settle(d);
    expect(d.tick()).toEqual([]);
    // the Human cancels and starts over: a new mission is new work immediately
    svc.cancel(human, 'M1');
    svc.create(human, { title: 'Car wash 2', brief, plannerAgentId: 'claude-1' });
    expect(d.tick().map((s) => [s.work.kind, s.work.taskId])).toEqual([['PLAN', 'mission:M2']]);
    await settle(d);
  });

  it('cannot plan without a scratch checkout: the run fails visibly instead of touching the working tree', async () => {
    svc.create(human, { title: 'Car wash', brief, plannerAgentId: 'claude-1' });
    const d = new Dispatcher({ db, identity: new IdentityService(db), agents: AGENTS(), repoRoot: dir, now: () => clock, missions: svc });
    expect(d.tick()).toEqual([]);
    expect(db.prepare("SELECT status, detail FROM dispatch_runs WHERE kind = 'PLAN'").get()).toMatchObject({ status: 'FAILED', detail: expect.stringContaining('scratch checkout') });
    expect(d.isBusy('claude-1')).toBe(false);
  });
});
