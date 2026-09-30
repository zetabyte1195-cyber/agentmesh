import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { MISSION_MIGRATION } from './migration.js';
import { MissionService } from './service.js';

let dir: string;
let db: SqliteDatabase;
let board: BoardService;
let svc: MissionService;
let human: Principal;
let claude: Principal;
let gemini: Principal;
let codex: Principal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-missions-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION]);
  const ids = new IdentityService(db);
  human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  codex = ids.registerAgent({ id: 'codex-1', name: 'Codex', platform: 'CODEX', paradigm: 'CLI' }).principal;
  const late: { svc?: MissionService } = {};
  board = new BoardService({ db, worktrees: {} as never, taskGuard: (p, i) => late.svc?.guardTask(p, i) });
  svc = new MissionService({ db, board });
  late.svc = svc;
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const brief = 'Build a small web app for a car wash: customers pick a wash package and a time slot.';
const PLAN = '# Plan\n\nGoal: a booking page.\n\n1. Scaffold the app and tests.\n2. Packages and prices.\n3. Time slots.';
const start = (extra: object = {}) => svc.create(human, { title: 'Car wash app', brief, plannerAgentId: 'claude-1', ...extra });

describe('MissionService: who does what, in what order', () => {
  it('runs the whole flow: plan → reviews with gaps → revision → the Human approves → tasks → done', () => {
    const m = start();
    expect(m).toMatchObject({ id: 'M1', status: 'PLANNING', planner: 'claude-1', reviewers: ['codex-1', 'gemini-1'], round: 1, waitingOn: ['claude-1'] });
    expect(svc.workFor('claude-1')).toEqual({ kind: 'PLAN', missionId: 'M1' });
    expect(svc.workFor('gemini-1')).toBeNull(); // nothing to review yet

    expect(svc.submitPlan(claude, 'M1', PLAN)).toEqual({ missionId: 'M1', version: 1, status: 'REVIEWING' });
    expect(svc.workFor('claude-1')).toBeNull();
    expect(svc.workFor('gemini-1')).toEqual({ kind: 'PLAN_REVIEW', missionId: 'M1' });

    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'GAPS', gaps: 'No mention of payments or cancelling a booking.' });
    expect(svc.get('M1').waitingOn).toEqual(['codex-1']);
    expect(svc.workFor('gemini-1')).toBeNull(); // already answered this round
    expect(svc.submitReview(codex, 'M1', { planVersion: 1, verdict: 'OK' })).toEqual({ missionId: 'M1', status: 'REVISING' });
    expect(svc.workFor('claude-1')).toEqual({ kind: 'PLAN_REVISE', missionId: 'M1' });

    expect(svc.submitPlan(claude, 'M1', `${PLAN}\n\n## Changes from review\nAdded payments and cancellation.`)).toMatchObject({ version: 2, status: 'PLAN_READY' });
    expect(svc.get('M1')).toMatchObject({ status: 'PLAN_READY', waitingOn: ['human'], plan: { version: 2 } });
    expect(svc.workFor('claude-1')).toBeNull(); // now it is the Human's move

    expect(svc.approve(human, 'M1').status).toBe('SPLITTING');
    expect(svc.workFor('claude-1')).toEqual({ kind: 'SPLIT', missionId: 'M1' });
    board.createTask(claude, { id: 'M1-1', phase: 'mission:M1', title: 'Scaffold', acceptanceCriteria: 'tests run', suggestedOwner: 'gemini' });
    board.createTask(claude, { id: 'M1-2', phase: 'mission:M1', title: 'Packages', acceptanceCriteria: 'shown', prerequisites: ['M1-1'], suggestedOwner: 'Pair' });
    expect(db.prepare("SELECT suggested_owner AS o FROM tasks WHERE id = 'M1-1'").get()).toEqual({ o: 'Gemini' }); // canonical name, so the dispatcher can match it
    expect(svc.finishSplit(claude, 'M1')).toEqual({ missionId: 'M1', status: 'IMPLEMENTING', tasks: ['M1-1', 'M1-2'] });
    expect(svc.get('M1').progress).toEqual({ total: 2, committed: 0 });

    // committed for real: through the audit path the schema requires
    for (const id of ['M1-1', 'M1-2']) {
      db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1' WHERE id = ?").run(id);
      db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = ?").run(id);
      db.prepare("INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES (?, ?, 'gemini-1', 'PASSED', 'h', 1, 'ok')").run(`a-${id}`, id);
      db.prepare("UPDATE tasks SET status = 'COMMITTED' WHERE id = ?").run(id);
    }
    svc.sync();
    expect(svc.get('M1')).toMatchObject({ status: 'DONE', progress: { total: 2, committed: 2 } });
  });

  it('only the planner plans, only reviewers review, and only at the right time', () => {
    start();
    expect(() => svc.submitPlan(gemini, 'M1', PLAN)).toThrow(/Only the planner/);
    expect(() => svc.submitPlan(human, 'M1', PLAN)).toThrow(/Only the planner/);
    expect(() => svc.submitPlan(claude, 'M1', 'too short')).toThrow(/between 40/);
    expect(() => svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' })).toThrow(/REVIEWING/);
    svc.submitPlan(claude, 'M1', PLAN);
    expect(() => svc.submitPlan(claude, 'M1', PLAN)).toThrow(/expected only while PLANNING or REVISING/);
    expect(() => svc.submitReview(claude, 'M1', { planVersion: 1, verdict: 'OK' })).toThrow(/not a reviewer/);
    expect(() => svc.submitReview(gemini, 'M1', { planVersion: 2, verdict: 'OK' })).toThrow(/current plan is v1/);
    expect(() => svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'GAPS', gaps: 'meh' })).toThrow(/concrete gaps/);
    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    expect(() => svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' })).toThrow(/already reviewed/);
  });

  it('every Human decision is the Human\'s alone', () => {
    start();
    svc.submitPlan(claude, 'M1', PLAN);
    for (const agent of [claude, gemini]) {
      expect(() => svc.approve(agent, 'M1')).toThrow(/Only the Human/);
      expect(() => svc.cancel(agent, 'M1')).toThrow(/Only the Human/);
      expect(() => svc.create(agent, { title: 't', brief, plannerAgentId: 'claude-1' })).toThrow(/Only the Human/);
    }
    expect(() => svc.approve(human, 'M1')).toThrow(/only a ready plan can be approved/); // still being reviewed
  });

  it('all reviewers OK → straight to the Human, no revision', () => {
    start();
    svc.submitPlan(claude, 'M1', PLAN);
    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    expect(svc.submitReview(codex, 'M1', { planVersion: 1, verdict: 'OK' }).status).toBe('PLAN_READY');
    expect(svc.get('M1').plan?.version).toBe(1);
  });

  it('with no reviewers (one agent connected) the plan goes straight to the Human', () => {
    start({ reviewerAgentIds: [] });
    expect(svc.submitPlan(claude, 'M1', PLAN).status).toBe('PLAN_READY');
    expect(() => svc.anotherRound(human, 'M1')).toThrow(/no reviewers/);
  });

  it('the Human can ask for changes (planner revises with the note) or another review round (capped)', () => {
    start({ maxRounds: 2 });
    svc.submitPlan(claude, 'M1', PLAN);
    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    svc.submitReview(codex, 'M1', { planVersion: 1, verdict: 'OK' });

    svc.requestChanges(human, 'M1', 'Use a simple static site, no backend.');
    expect(svc.get('M1')).toMatchObject({ status: 'REVISING', waitingOn: ['claude-1'] });
    expect(svc.get('M1').reviews.at(-1)).toMatchObject({ reviewer: 'human', verdict: 'GAPS', gaps: 'Use a simple static site, no backend.' });
    svc.submitPlan(claude, 'M1', `${PLAN}\n\nRevised: static site only, per the Human's note.`);

    expect(svc.anotherRound(human, 'M1')).toMatchObject({ status: 'REVIEWING', round: 2, waitingOn: ['codex-1', 'gemini-1'] });
    svc.submitReview(gemini, 'M1', { planVersion: 2, verdict: 'OK' });
    svc.submitReview(codex, 'M1', { planVersion: 2, verdict: 'OK' });
    expect(() => svc.anotherRound(human, 'M1')).toThrow(/used its 2 review round/);
    expect(svc.approve(human, 'M1').status).toBe('SPLITTING');
  });

  it('the Human can skip a reviewer that keeps failing, and can cancel', () => {
    start();
    svc.submitPlan(claude, 'M1', PLAN);
    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    expect(() => svc.skipReviewer(human, 'M1', 'gemini-1')).toThrow(/not a reviewer we are waiting on/);
    expect(svc.skipReviewer(human, 'M1', 'codex-1').status).toBe('PLAN_READY');
    expect(svc.get('M1').reviews.at(-1)).toMatchObject({ reviewer: 'codex-1', gaps: expect.stringContaining('Skipped by the Human') });
    expect(svc.cancel(human, 'M1').status).toBe('CANCELLED');
    expect(() => svc.cancel(human, 'M1')).toThrow(/already CANCELLED/);
    expect(svc.workFor('claude-1')).toBeNull();
  });

  it('validates a new mission: brief, planner, reviewers', () => {
    expect(() => start({ plannerAgentId: 'nobody' })).toThrow(/Unknown planner/);
    expect(() => start({ plannerAgentId: 'human' })).toThrow(/Unknown planner/); // the Human is not an agent
    expect(() => start({ reviewerAgentIds: ['claude-1'] })).toThrow(/cannot review its own plan/);
    expect(() => start({ reviewerAgentIds: ['ghost'] })).toThrow(/Unknown reviewer/);
    expect(() => svc.create(human, { title: 'x', brief: 'short', plannerAgentId: 'claude-1' })).toThrow(/between 10 and/);
    expect(() => start({ maxRounds: 99 })).toThrow(/maxRounds/);
    expect(start().id).toBe('M1');
    expect(start().id).toBe('M2');
  });
});

describe('creating a mission\'s tasks (guardTask): a task nobody could run must not exist', () => {
  const approved = () => {
    start();
    svc.submitPlan(claude, 'M1', PLAN);
    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    svc.submitReview(codex, 'M1', { planVersion: 1, verdict: 'OK' });
    svc.approve(human, 'M1');
  };
  const task = (id: string, extra: object = {}) => ({ id, phase: 'mission:M1', title: 't', acceptanceCriteria: 'ok', ...extra });

  it('only the planner, only while SPLITTING, ids prefixed with the mission, owners that exist', () => {
    start();
    expect(() => board.createTask(claude, task('M1-1'))).toThrow(/only while it is SPLITTING/);
    approved.call(null);
    expect(() => board.createTask(gemini, task('M1-1'))).toThrow(/Only the planner/);
    expect(() => board.createTask(claude, task('T9'))).toThrow(/must start with "M1-"/);
    expect(() => board.createTask(claude, task('M1-1', { suggestedOwner: 'Cursor' }))).toThrow(/matches no agent.*Claude.*Codex.*Gemini.*Pair/s);
    expect(board.createTask(claude, task('M1-1', { suggestedOwner: 'CODEX' }))).toMatchObject({ suggested_owner: 'Codex' });
    expect(() => board.createTask(claude, { ...task('M1-2'), phase: 'mission:M9' })).toThrow(/does not exist/);
    // the Human may add a task to a mission, but not for an owner that does not exist
    expect(() => board.createTask(human, task('M1-7', { suggestedOwner: 'Cursor' }))).toThrow(/matches no agent/);
    expect(board.createTask(human, task('M1-7', { suggestedOwner: 'gemini' }))).toMatchObject({ suggested_owner: 'Gemini' });
  });

  it('cannot finish without tasks; ordinary phases are untouched', () => {
    start();
    svc.submitPlan(claude, 'M1', PLAN);
    svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    svc.submitReview(codex, 'M1', { planVersion: 1, verdict: 'OK' });
    svc.approve(human, 'M1');
    expect(() => svc.finishSplit(claude, 'M1')).toThrow(/No tasks yet/);
    expect(() => svc.finishSplit(gemini, 'M1')).toThrow(/Only the planner/);
    expect(board.createTask(gemini, { id: 'X1', phase: 'plain', title: 't', acceptanceCriteria: 'ok' })).toMatchObject({ id: 'X1' });
  });
});

describe('migration 4 on a database that already has runs', () => {
  it('keeps existing dispatch_runs rows and now allows planning run kinds', () => {
    const old = openDatabase(':memory:');
    migrate(old, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
    new IdentityService(old).registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
    old.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, detail, started_at, ended_at) VALUES ('r1', 'claude-1', 'T1', 'v', 'AUDIT', 'FAILED', 'why', 's', 'e')").run();
    expect(() => old.prepare("INSERT INTO dispatch_runs (id, agent_id, kind, status, started_at) VALUES ('r2', 'claude-1', 'PLAN', 'RUNNING', 's')").run()).toThrow(/CHECK/);
    migrate(old, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION]);
    expect(old.prepare("SELECT id, kind, status, detail, task_version AS v FROM dispatch_runs WHERE id = 'r1'").get()).toEqual({ id: 'r1', kind: 'AUDIT', status: 'FAILED', detail: 'why', v: 'v' });
    old.prepare("INSERT INTO dispatch_runs (id, agent_id, kind, status, started_at) VALUES ('r2', 'claude-1', 'PLAN', 'RUNNING', 's')").run();
    expect(old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dispatch_runs_agent'").get()).toBeTruthy();
    closeDatabase(old);
  });
});
