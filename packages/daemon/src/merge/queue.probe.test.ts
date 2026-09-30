import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync , readFileSync} from 'node:fs';
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
const FAIL = 'node -e "console.error(\'tests failed\'); process.exit(1)"';

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
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mq-probe-'));
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
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

/** Helper: create task with lease, submit for review, audit PASSED */
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

describe("MergeQueue regressions (from Gemini's P1.7 audit probes)", () => {
  it('REGRESSION 1: a pause for the wrong primary branch happens before any rebase, and a retry lands', async () => {
    const { wtPath } = await createPassedTask('T1', 't1.txt', 't1 content\n');
    writeFileSync(join(repo, 'unrelated.txt'), 'unrelated trunk change\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'trunk advances');
    g(repo, 'checkout', '-q', '-b', 'human-experiment');
    const mq = new MergeQueue({ db, repoRoot: repo, worktrees: wc, leases, verifyCommand: PASS });

    expect((await mq.processNext()).outcome).toBe('PAUSED');
    expect(status('T1')).toBe('PASSED');
    const audited = (db.prepare('SELECT head_commit FROM tasks WHERE id = ?').get('T1') as { head_commit: string }).head_commit;
    expect(g(wtPath, 'rev-parse', 'HEAD')).toBe(audited); // worktree untouched while paused

    g(repo, 'checkout', '-q', 'main');
    expect((await mq.processNext()).outcome).toBe('LANDED');
    expect(status('T1')).toBe('COMMITTED');
  });

  it('REGRESSION 1b: a pause after the rebase (Human edit overlaps) restores the audited commit, and a retry lands', async () => {
    const { wtPath } = await createPassedTask('T1', 't1.txt', 'task version\n');
    writeFileSync(join(repo, 'unrelated.txt'), 'trunk moved\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'trunk advances');
    writeFileSync(join(repo, 't1.txt'), 'human is editing this\n'); // untracked in primary, overlaps the task's new file
    const mq = new MergeQueue({ db, repoRoot: repo, worktrees: wc, leases, verifyCommand: PASS });
    const audited = (db.prepare('SELECT head_commit FROM tasks WHERE id = ?').get('T1') as { head_commit: string }).head_commit;

    expect((await mq.processNext()).outcome).toBe('PAUSED');
    expect(g(wtPath, 'rev-parse', 'HEAD')).toBe(audited);
    expect(readFileSync(join(repo, 't1.txt'), 'utf8')).toBe('human is editing this\n');

    rmSync(join(repo, 't1.txt')); // the Human resolves it
    expect((await mq.processNext()).outcome).toBe('LANDED');
  });

  it('REGRESSION 2: after a failed verification the author can fix and resubmit (worktree restored to audited base)', async () => {
    const { wtPath } = await createPassedTask('T2', 't2.txt', 't2 content\n');
    writeFileSync(join(repo, 'trunk_file.txt'), 'trunk content\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'trunk commit with trunk_file.txt');
    const mq = new MergeQueue({ db, repoRoot: repo, worktrees: wc, leases, verifyCommand: FAIL });
    expect((await mq.processNext()).outcome).toBe('VERIFY_FAILED');
    expect(status('T2')).toBe('IN_PROGRESS');

    writeFileSync(join(wtPath, 't2.txt'), 'fixed content\n');
    g(wtPath, 'add', '.');
    g(wtPath, 'commit', '-q', '-m', 'fix test failure');
    await expect(gate.submitForReview(CLAUDE_1, { taskId: 'T2' })).resolves.toMatchObject({ status: 'READY_FOR_REVIEW' });
  });
});
