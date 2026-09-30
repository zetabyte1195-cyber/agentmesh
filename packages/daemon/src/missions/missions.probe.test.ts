import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { MISSION_MIGRATION, MissionError, MissionService } from './index.js';
import { ReviewService, ReviewError } from '../review/index.js';

describe('Scope B probe tests: missions, dispatch, migration, review', () => {
  let dir: string;
  let db: SqliteDatabase;
  let ids: IdentityService;
  let board: BoardService;
  let svc: MissionService;
  let human: Principal;
  let claude: Principal;
  let gemini: Principal;
  let codex: Principal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentmesh-probe-'));
    db = openDatabase(join(dir, 'mesh.db'));
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION]);
    ids = new IdentityService(db);
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

  const brief = 'Test brief for mission verification and edge-case probing.';
  const PLAN = '# Plan\n\n1. Step one of test plan.\n2. Step two of test plan.';

  function commitTask(taskId: string) {
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1' WHERE id = ?").run(taskId);
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = ?").run(taskId);
    db.prepare("INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES (?, ?, 'gemini-1', 'PASSED', 'h', 1, 'ok')").run(`a-${taskId}`, taskId);
    db.prepare("UPDATE tasks SET status = 'COMMITTED' WHERE id = ?").run(taskId);
  }

  // ── 1. State machine races and transitions ────────────────────────────────
  it('1.1 races: approve twice is rejected', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    svc.submitPlan(claude, 'M1', PLAN); // 0 reviewers -> goes straight to PLAN_READY
    expect(svc.get('M1').status).toBe('PLAN_READY');

    expect(svc.approve(human, 'M1').status).toBe('SPLITTING');
    expect(() => svc.approve(human, 'M1')).toThrow(MissionError);
    expect(() => svc.approve(human, 'M1')).toThrow(/only a ready plan can be approved/);
  });

  it('1.2 races: planner submits while Human cancels', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1' });
    expect(svc.get('M1').status).toBe('PLANNING');

    svc.cancel(human, 'M1');
    expect(svc.get('M1').status).toBe('CANCELLED');

    expect(() => svc.submitPlan(claude, 'M1', PLAN)).toThrow(MissionError);
    expect(() => svc.submitPlan(claude, 'M1', PLAN)).toThrow(/expected only while PLANNING or REVISING/);
  });

  it('1.3 races: two reviewers submit concurrently', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: ['gemini-1', 'codex-1'] });
    svc.submitPlan(claude, 'M1', PLAN);
    expect(svc.get('M1').status).toBe('REVIEWING');

    // Reviewer 1 submits OK
    const r1 = svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    expect(r1.status).toBe('REVIEWING');
    expect(svc.get('M1').waitingOn).toEqual(['codex-1']);

    // Reviewer 1 cannot submit again
    expect(() => svc.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' })).toThrow(/already reviewed/);

    // Reviewer 2 submits GAPS -> advances to REVISING
    const r2 = svc.submitReview(codex, 'M1', { planVersion: 1, verdict: 'GAPS', gaps: 'Missing detailed architecture diagrams' });
    expect(r2.status).toBe('REVISING');
    expect(svc.get('M1').waitingOn).toEqual(['claude-1']);
  });

  it('1.4 advanceAfterReview with skipReviewer', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: ['gemini-1', 'codex-1'] });
    svc.submitPlan(claude, 'M1', PLAN);

    // Human skips gemini-1
    svc.skipReviewer(human, 'M1', 'gemini-1');
    expect(svc.get('M1').status).toBe('REVIEWING');
    expect(svc.get('M1').waitingOn).toEqual(['codex-1']);

    // Human skips codex-1 as well -> all answered/skipped -> PLAN_READY (since skips count as OK)
    svc.skipReviewer(human, 'M1', 'codex-1');
    expect(svc.get('M1').status).toBe('PLAN_READY');
  });

  it('1.5 0 reviewers: goes PLANNING -> PLAN_READY directly; anotherRound rejected', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    expect(svc.get('M1').status).toBe('PLANNING');
    expect(svc.get('M1').reviewers).toEqual([]);

    svc.submitPlan(claude, 'M1', PLAN);
    expect(svc.get('M1').status).toBe('PLAN_READY');

    expect(() => svc.anotherRound(human, 'M1')).toThrow(/has no reviewers/);
  });

  it('1.6 resurrection: cannot resurrect CANCELLED or DONE mission', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    svc.cancel(human, 'M1');
    expect(svc.get('M1').status).toBe('CANCELLED');

    expect(() => svc.cancel(human, 'M1')).toThrow(/already CANCELLED/);
    expect(() => svc.approve(human, 'M1')).toThrow(MissionError);
    expect(() => svc.requestChanges(human, 'M1', 'change this please')).toThrow(MissionError);
    expect(() => svc.anotherRound(human, 'M1')).toThrow(MissionError);
    expect(() => svc.submitPlan(claude, 'M1', PLAN)).toThrow(MissionError);
    expect(() => svc.finishSplit(claude, 'M1')).toThrow(MissionError);
  });

  it('1.7 sync() behavior and task addition', () => {
    svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    svc.submitPlan(claude, 'M1', PLAN);
    svc.approve(human, 'M1');

    board.createTask(claude, { id: 'M1-1', phase: 'mission:M1', title: 'Task 1', acceptanceCriteria: 'ok', suggestedOwner: 'claude' });
    svc.finishSplit(claude, 'M1');
    expect(svc.get('M1').status).toBe('IMPLEMENTING');

    // While task is not committed, sync does not mark DONE
    svc.sync();
    expect(svc.get('M1').status).toBe('IMPLEMENTING');

    // If human adds a task M1-2 while IMPLEMENTING
    board.createTask(human, { id: 'M1-2', phase: 'mission:M1', title: 'Task 2', acceptanceCriteria: 'ok', suggestedOwner: 'claude' });
    
    // Commit M1-1
    commitTask('M1-1');
    svc.sync();
    // M1-2 is not committed, so M1 remains IMPLEMENTING
    expect(svc.get('M1').status).toBe('IMPLEMENTING');

    // Commit M1-2
    commitTask('M1-2');
    svc.sync();
    expect(svc.get('M1').status).toBe('DONE');
  });

  // ── 2. Migration 4 safety ────────────────────────────────────────────────
  it('2.1 migration 4 idempotency and dispatch_runs rebuild', () => {
    // Check table exists and columns match
    const cols = db.prepare("PRAGMA table_info('dispatch_runs')").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('kind')).toBe(true);
    expect(names.has('task_version')).toBe(true);

    // Insert a mission run into dispatch_runs to verify CHECK constraint
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at) VALUES ('r1', 'claude-1', 'mission:M1', 'v1', 'PLAN', 'RUNNING', '2026-09-30 12:00:00')").run();
    const row = db.prepare("SELECT * FROM dispatch_runs WHERE id = 'r1'").get() as { kind: string };
    expect(row.kind).toBe('PLAN');

    // Running migration again is a no-op (migrator ignores applied migrations)
    const applied = migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION]);
    expect(applied.applied).toEqual([]);
  });

  // ── 3. Dispatcher attempts & versionOf ────────────────────────────────────
  it('3.1 dispatcher CASE WHEN substr matching for missions', () => {
    const m = svc.create(human, { title: 'M', brief, plannerAgentId: 'claude-1', reviewerAgentIds: [] });
    const version = db.prepare('SELECT updated_at FROM missions WHERE id = ?').get(m.id) as { updated_at: string };

    // Insert completed run
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at, ended_at) VALUES ('r-test', 'claude-1', 'mission:M1', ?, 'PLAN', 'FAILED', '2026-09-30 12:00:00', '2026-09-30 12:05:00')").run(version.updated_at);

    // Test the exact SQL used by Dispatcher.attempts
    const sql = `SELECT count(*) AS n, max(r.ended_at) AS last FROM dispatch_runs r
      WHERE r.agent_id = ? AND r.task_id = ? AND r.status != 'RUNNING'
        AND r.task_version IS (CASE WHEN r.task_id LIKE 'mission:%' THEN (SELECT updated_at FROM missions WHERE id = substr(r.task_id, 9)) ELSE (SELECT updated_at FROM tasks WHERE id = r.task_id) END)`;
    const res = db.prepare(sql).get('claude-1', 'mission:M1') as { n: number; last: string };
    expect(res.n).toBe(1);
    expect(res.last).toBe('2026-09-30 12:05:00');

    // Now touch mission (status or timestamp change)
    db.prepare("UPDATE missions SET updated_at = '2026-09-30 13:00:00' WHERE id = 'M1'").run();
    const res2 = db.prepare(sql).get('claude-1', 'mission:M1') as { n: number };
    expect(res2.n).toBe(0); // Resets because version changed!
  });

  // ── 4. ReviewService verification ────────────────────────────────────────
  it('4.1 ReviewService: author can verify own in-progress task, not others', async () => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, status, assigned_agent_id, worktree_path, base_commit, head_commit, acceptance_criteria) VALUES ('T1', 'p', 'Title', 'IN_PROGRESS', 'claude-1', ?, 'base', 'head', 'ac')").run(dir);

    const review = new ReviewService({ db, verifyCommand: 'node -e "process.exit(0)"' });

    // Author (claude-1) can run verification
    const res = await review.runVerification(claude, 'T1');
    expect(res.ok).toBe(true);

    // Other agent (gemini-1) CANNOT run verification on in-progress task of claude-1
    await expect(review.runVerification(gemini, 'T1')).rejects.toThrow(ReviewError);
    await expect(review.runVerification(gemini, 'T1')).rejects.toThrow(/only a submitted task/);
  });
});
