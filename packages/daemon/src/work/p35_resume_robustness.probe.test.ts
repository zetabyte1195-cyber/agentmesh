// P3.5 Adversarial Resume Robustness Probes (Gemini)
// Probing edge cases and failure modes around Dispatcher's REJECTED task resumption:
// 1. Author-only reopen: non-author principal cannot reopen REJECTED task
// 2. Strict pre-reopen gates: lease acquire, mesh_commit, and submitForReview are blocked while REJECTED
// 3. Retry exhaustion: after MAX_ATTEMPTS_PER_TASK failures, REJECTED task is left for Human and author can move on to TODO
// 4. Audit priority: pending review of another agent's task takes priority over resuming REJECTED task
// 5. Version-based retry reset: reopening REJECTED -> IN_PROGRESS updates updated_at and resets attempt counts
// 6. Resume bypasses claim: Dispatcher launch for resumed REJECTED task does not invoke the claim hook
// 7. Cool-down protection: cooling-down REJECTED task prevents claiming new TODO tasks before cooldown expires
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditGate } from '../audit/index.js';
import { BoardError, BoardService } from '../board/index.js';
import { type SqliteDatabase, closeDatabase, migrate, openDatabase, MIGRATIONS } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, MAX_ATTEMPTS_PER_TASK, RETRY_AFTER_MS } from '../dispatch/index.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { LeaseArbiter, LeaseError } from '../leases/index.js';
import { CommitService } from './commit.js';

let repo: string;
let db: SqliteDatabase;
let leases: LeaseArbiter;
let svc: CommitService;
let gate: AuditGate;
let board: BoardService;
let claude: Principal;
let gemini: Principal;
let base: string;
let clock: Date;

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

async function settle(d: Dispatcher, agentId: string): Promise<void> {
  for (let i = 0; i < 200 && d.isBusy(agentId); i++) await new Promise((r) => setTimeout(r, 25));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-p35-robustness-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'probe@example.com');
  g(repo, 'config', 'user.name', 'probe');
  writeFileSync(join(repo, '.gitignore'), '.agentmesh/\n*.tmp\n');
  writeFileSync(join(repo, 'base.txt'), 'initial\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base commit');
  base = g(repo, 'rev-parse', 'HEAD');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
  const ids = new IdentityService(db);
  claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;

  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 'Task 1', 'ac 1')").run();
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', worktree_path = ?, base_commit = ? WHERE id = 'T1'").run(repo, base);

  leases = new LeaseArbiter(db);
  svc = new CommitService({ db, leases });
  gate = new AuditGate({ db, repoRoot: repo, leases });
  board = new BoardService({ db, worktrees: new WorktreeController({ repoRoot: repo }) });
  clock = new Date('2026-09-24T12:00:00Z');
});

afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

describe('P3.5 REJECTED task resumption robustness probes', () => {
  it('probe 1: author-only reopen: non-author cannot reopen REJECTED task to IN_PROGRESS', async () => {
    // T1 is audited with GAP_FOUND -> REJECTED
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    const row = db.prepare('SELECT status, assigned_agent_id FROM tasks WHERE id = ?').get('T1') as { status: string; assigned_agent_id: string };
    expect(row.status).toBe('REJECTED');
    expect(row.assigned_agent_id).toBe('claude-1');

    // Gemini (other agent / auditor) attempts to reopen Claude's task
    expect(() => board.updateStatus(gemini, 'T1', 'IN_PROGRESS')).toThrow(BoardError);
    expect(() => board.updateStatus(gemini, 'T1', 'IN_PROGRESS')).toThrow(/not authorized/);

    // Claude (author) can successfully reopen
    board.updateStatus(claude, 'T1', 'IN_PROGRESS');
    const updated = db.prepare('SELECT status FROM tasks WHERE id = ?').get('T1') as { status: string };
    expect(updated.status).toBe('IN_PROGRESS');
  });

  it('probe 2: strict pre-reopen enforcement: lease acquire, mesh_commit, and submitForReview are blocked while REJECTED', async () => {
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    // 1. Lease acquire must fail in REJECTED state
    expect(() => leases.acquire(claude, 'T1', [{ type: 'FILE', path: 'base.txt' }])).toThrow(LeaseError);

    // 2. mesh_commit must fail in REJECTED state
    await expect(svc.commit(claude, 'T1', 'try commit while rejected')).rejects.toMatchObject({
      code: 'NOT_WORKING',
    });

    // 3. submitForReview must fail in REJECTED state (cannot transition REJECTED -> READY_FOR_REVIEW)
    await expect(gate.submitForReview(claude, { taskId: 'T1' })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('probe 3: retry exhaustion: after MAX_ATTEMPTS_PER_TASK failures, REJECTED task is unblocked and author can move on to TODO', async () => {
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    // Insert task T2 as TODO for Claude
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner, prerequisites) VALUES ('T2', 'p', 'Task 2', 'ac 2', 'Claude', '[]')").run();

    const claudeAgent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: ['-e', 'process.exit(0)'], parse: () => [] }),
    };

    const d = new Dispatcher({
      db,
      identity: new IdentityService(db),
      agents: [claudeAgent],
      repoRoot: repo,
      now: () => clock,
    });

    // First attempt resumes T1
    expect(d.nextWork(claudeAgent)).toMatchObject({ kind: 'TASK', taskId: 'T1', resume: true });

    // Simulate 3 failed runs on T1 without changing task updated_at
    const taskVersion = (db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('T1') as { updated_at: string }).updated_at;
    for (let i = 1; i <= MAX_ATTEMPTS_PER_TASK; i++) {
      db.prepare(
        "INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at, ended_at) VALUES (?, 'claude-1', 'T1', ?, 'TASK', 'FAILED', ?, ?)",
      ).run(`run-${i}`, taskVersion, '2026-09-24 12:00:00', '2026-09-24 12:05:00');
    }

    // Now attempts on T1 are exhausted: T1 is left for Human, and Claude is dispatched to T2!
    clock = new Date('2026-09-24T12:20:00Z');
    const nextAfterExhaustion = d.nextWork(claudeAgent);
    expect(nextAfterExhaustion).toMatchObject({ kind: 'TASK', taskId: 'T2' });
  });

  it('probe 4: audit priority: pending review of another agent task takes priority over resuming REJECTED task', async () => {
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    // Gemini submits T2 for review
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner, prerequisites) VALUES ('T2', 'p', 'Task 2', 'ac 2', 'Gemini', '[]')").run();
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'gemini-1' WHERE id = 'T2'").run();
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h2' WHERE id = 'T2'").run();

    const claudeAgent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: ['-e', 'process.exit(0)'], parse: () => [] }),
    };

    const d = new Dispatcher({
      db,
      identity: new IdentityService(db),
      agents: [claudeAgent],
      repoRoot: repo,
      now: () => clock,
    });

    // AUDIT takes priority over resuming T1
    expect(d.nextWork(claudeAgent)).toMatchObject({ kind: 'AUDIT', taskId: 'T2' });
  });

  it('probe 5: version-based retry reset: reopening REJECTED -> IN_PROGRESS updates updated_at and resets attempt counts', async () => {
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    const initialVersion = (db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('T1') as { updated_at: string }).updated_at;

    // Simulate 3 failures on the REJECTED version
    for (let i = 1; i <= MAX_ATTEMPTS_PER_TASK; i++) {
      db.prepare(
        "INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at, ended_at) VALUES (?, 'claude-1', 'T1', ?, 'TASK', 'FAILED', ?, ?)",
      ).run(`run-${i}`, initialVersion, '2026-09-24 12:00:00', '2026-09-24 12:05:00');
    }

    const claudeAgent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: ['-e', 'process.exit(0)'], parse: () => [] }),
    };

    const d = new Dispatcher({
      db,
      identity: new IdentityService(db),
      agents: [claudeAgent],
      repoRoot: repo,
      now: () => clock,
    });

    // Reopen task
    board.updateStatus(claude, 'T1', 'IN_PROGRESS');

    // Ensure updated_at changed to reset attempt match
    db.prepare("UPDATE tasks SET updated_at = '2026-09-24 12:15:00' WHERE id = 'T1'").run();

    // Since version changed, previous failures don't count against this new version
    clock = new Date('2026-09-24T12:20:00Z');
    expect(d.nextWork(claudeAgent)).toMatchObject({ kind: 'TASK', taskId: 'T1', resume: true });
  });

  it('probe 6: resume bypasses claim: Dispatcher launch for resumed REJECTED task does not invoke the claim hook', async () => {
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    let claimCalled = false;
    const claudeAgent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: ['-e', 'process.exit(0)'], parse: () => [] }),
    };

    const d = new Dispatcher({
      db,
      identity: new IdentityService(db),
      agents: [claudeAgent],
      repoRoot: repo,
      claim: async () => {
        claimCalled = true;
        return { worktree: repo };
      },
      now: () => clock,
    });

    const work = d.nextWork(claudeAgent);
    expect(work).toMatchObject({ kind: 'TASK', taskId: 'T1', resume: true });

    d.tick();
    expect(claimCalled).toBe(false); // Resumed task MUST NOT trigger claim
    await settle(d, 'claude-1');
  });

  it('probe 7: cool-down protection: cooling-down REJECTED task prevents claiming new TODO tasks before cooldown expires', async () => {
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, { taskId: 'T1', verdict: 'GAP_FOUND', diffHash: sub.diffHash, testRunSuccess: false, notes: 'rejected' });

    // Also add task T2 as TODO for Claude
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner, prerequisites) VALUES ('T2', 'p', 'Task 2', 'ac 2', 'Claude', '[]')").run();

    const claudeAgent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: ['-e', 'process.exit(0)'], parse: () => [] }),
    };

    const taskVersion = (db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('T1') as { updated_at: string }).updated_at;

    // Simulate 1 failed run on T1 at 12:00:00 (cooling down until 12:10:00)
    db.prepare(
      "INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at, ended_at) VALUES ('run-1', 'claude-1', 'T1', ?, 'TASK', 'FAILED', '2026-09-24 11:55:00', '2026-09-24 12:00:00')",
    ).run(taskVersion);

    const d = new Dispatcher({
      db,
      identity: new IdentityService(db),
      agents: [claudeAgent],
      repoRoot: repo,
      now: () => clock, // 12:00:00
    });

    // During cooldown (clock = 12:00:00), T1 cannot be retried yet, AND T2 cannot be claimed!
    expect(d.nextWork(claudeAgent)).toBeNull();

    // After cooldown (clock = 12:11:00), T1 can be retried!
    clock = new Date(clock.getTime() + RETRY_AFTER_MS + 60_000);
    expect(d.nextWork(claudeAgent)).toMatchObject({ kind: 'TASK', taskId: 'T1', resume: true });
  });
});
