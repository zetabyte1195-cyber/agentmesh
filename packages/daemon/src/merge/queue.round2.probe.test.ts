import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditGate } from '../audit/gate.js';
import {
  IDENTITY_MIGRATION,
  IdentityService,
  type Principal,
} from '../identity/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { MIGRATIONS, type SqliteDatabase, closeDatabase, migrate, openDatabase } from '../db/index.js';
import { WorktreeController } from '../git/worktrees.js';
import { MergeQueue } from './queue.js';

const PASS = 'node -e "process.exit(0)"';
const SLEEP_THEN_PASS = 'node -e "setTimeout(() => process.exit(0), 1000)"';

let repo: string;
let db: SqliteDatabase;
let wc: WorktreeController;
let leases: LeaseArbiter;
let gate: AuditGate;

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const status = (id: string) => (db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

const CLAUDE_1: Principal = { agentId: 'claude-1', platform: 'CLAUDE_CODE', paradigm: 'CLI', isHuman: false };
const GEMINI_1: Principal = { agentId: 'gemini-1', platform: 'ANTIGRAVITY', paradigm: 'CLI', isHuman: false };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mq-probe2-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@example.com');
  g(repo, 'config', 'user.name', 'test');
  g(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'base.txt'), 'base commit content\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'initial base commit');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  wc = new WorktreeController({ repoRoot: repo });
  leases = new LeaseArbiter(db);
  gate = new AuditGate({ db, repoRoot: repo, leases });
});

afterEach(async () => {
  for (const w of await wc.list()) {
    await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  }
  closeDatabase(db);
  await new Promise((r) => setTimeout(r, 200));
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function createPassedTask(id: string, file: string, content: string): Promise<{ wtPath: string; hash: string }> {
  const wt = await wc.allocate(id, `branch-${id}`);
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'p', ?, 'ac')").run(id, `task ${id}`);
  db.prepare(
    "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', branch_name = ?, worktree_path = ?, base_commit = ? WHERE id = ?",
  ).run(wt.branch, wt.path, wt.baseCommit, id);

  leases.acquire(CLAUDE_1, id, [{ type: 'FILE', path: file }]);
  writeFileSync(join(wt.path, file), content);
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-q', '-m', `${id}: work`);

  const sub = await gate.submitForReview(CLAUDE_1, { taskId: id });
  await gate.submitAudit(GEMINI_1, {
    taskId: id,
    verdict: 'PASSED',
    diffHash: sub.diffHash,
    testRunSuccess: true,
    notes: 'verified',
  });

  expect(status(id)).toBe('PASSED');
  return { wtPath: wt.path, hash: sub.diffHash };
}

describe('MergeQueue Round 2 Adversarial Probes', () => {
  it('Probe A: rebase conflict aborts cleanly, restores worktree to audited commit, and marks task IN_PROGRESS', async () => {
    const { wtPath } = await createPassedTask('T_CONFLICT', 'conflict.txt', 'branch content\n');
    const audited = (db.prepare('SELECT head_commit FROM tasks WHERE id = ?').get('T_CONFLICT') as { head_commit: string }).head_commit;

    // Advance trunk with conflicting change in the same file
    writeFileSync(join(repo, 'conflict.txt'), 'trunk conflicting content\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'conflicting trunk commit');

    const mq = new MergeQueue({ db, repoRoot: repo, worktrees: wc, leases, verifyCommand: PASS });
    const report = await mq.processNext();

    expect(report.outcome).toBe('REBASE_CONFLICT');
    expect(status('T_CONFLICT')).toBe('IN_PROGRESS');
    // Worktree should be cleanly on the audited commit after rebase --abort
    expect(g(wtPath, 'rev-parse', 'HEAD')).toBe(audited);
  });

  it('Probe B: FIFO sequential landing of multiple passed tasks preserves trunk linearity', async () => {
    await createPassedTask('T_FIFO_1', 'f1.txt', 'fifo 1\n');
    await createPassedTask('T_FIFO_2', 'f2.txt', 'fifo 2\n');

    const mq = new MergeQueue({ db, repoRoot: repo, worktrees: wc, leases, verifyCommand: PASS });

    expect(mq.pending()).toEqual(['T_FIFO_1', 'T_FIFO_2']);

    const r1 = await mq.processNext();
    expect(r1.outcome).toBe('LANDED');
    expect(r1.taskId).toBe('T_FIFO_1');
    expect(status('T_FIFO_1')).toBe('COMMITTED');

    expect(mq.pending()).toEqual(['T_FIFO_2']);

    const r2 = await mq.processNext();
    expect(r2.outcome).toBe('LANDED');
    expect(r2.taskId).toBe('T_FIFO_2');
    expect(status('T_FIFO_2')).toBe('COMMITTED');

    expect(mq.pending()).toEqual([]);
  });

  it('Probe C: concurrent processNext() returns BUSY', async () => {
    await createPassedTask('T_BUSY', 'busy.txt', 'busy content\n');

    const mq = new MergeQueue({ db, repoRoot: repo, worktrees: wc, leases, verifyCommand: SLEEP_THEN_PASS });
    const p1 = mq.processNext();
    const p2 = mq.processNext();

    const [res1, res2] = await Promise.all([p1, p2]);
    const outcomes = [res1.outcome, res2.outcome].sort();
    expect(outcomes).toEqual(['BUSY', 'LANDED']);
  });

  it('Probe D: fast-forward refusal restores worktree to audited commit and leaves task PASSED', async () => {
    const { wtPath } = await createPassedTask('T_FF_REFUSE', 'ff.txt', 'ff content\n');
    const audited = (db.prepare('SELECT head_commit FROM tasks WHERE id = ?').get('T_FF_REFUSE') as { head_commit: string }).head_commit;

    // Overlapping uncommitted file in primary repo causes git merge --ff-only to be refused
    writeFileSync(join(repo, 'ff.txt'), 'overlapping human content\n');

    const mq = new MergeQueue({
      db,
      repoRoot: repo,
      worktrees: wc,
      leases,
      verifyCommand: PASS,
    });

    const report = await mq.processNext();
    expect(report.outcome).toBe('PAUSED');
    expect(status('T_FF_REFUSE')).toBe('PASSED');
    // Worktree must be cleanly restored to audited commit
    expect(g(wtPath, 'rev-parse', 'HEAD')).toBe(audited);

    // Now when the human removes the conflicting file and retries, it lands cleanly!
    rmSync(join(repo, 'ff.txt'));
    const retryReport = await mq.processNext();
    expect(retryReport.outcome).toBe('LANDED');
    expect(status('T_FF_REFUSE')).toBe('COMMITTED');
  });
});
