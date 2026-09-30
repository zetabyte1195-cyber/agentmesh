import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { diffHash } from '../git/diff.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { MergeQueue } from './queue.js';

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.error(\'tests failed\'); process.exit(1)"';

let repo: string;
let db: SqliteDatabase;
let wc: WorktreeController;

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const status = (id: string) => (db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;
const queue = (verifyCommand = PASS) => new MergeQueue({ db, repoRoot: repo, worktrees: wc, verifyCommand });

/** Commit `files` on trunk in the primary tree (the Human or another landed task moving trunk). */
function commitOnTrunk(files: Record<string, string>, message: string): void {
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', message);
}

/** Claude authors a task in its own worktree; Gemini audits it; the task ends PASSED with its diff pinned. */
async function passedTask(id: string, files: Record<string, string>): Promise<string> {
  const wt = await wc.allocate(id, `task ${id}`);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(wt.path, f), c);
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-q', '-m', `${id}: work`);
  const head = g(wt.path, 'rev-parse', 'HEAD');
  const hash = await diffHash(wt.path, wt.baseCommit, head);
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'p', ?, 'ac')").run(id, `task ${id}`);
  db.prepare(
    "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', branch_name = ?, worktree_path = ?, base_commit = ?, head_commit = ? WHERE id = ?",
  ).run(wt.branch, wt.path, wt.baseCommit, head, id);
  db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = ? WHERE id = ?").run(hash, id);
  db.prepare(
    "INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES (?, ?, 'gemini-1', 'PASSED', ?, 1, 'ok')",
  ).run(`a-${id}`, id, hash);
  expect(status(id)).toBe('PASSED');
  return wt.path;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mq-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@example.com');
  g(repo, 'config', 'user.name', 'test');
  g(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'shared.txt'), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  wc = new WorktreeController({ repoRoot: repo });
});

afterEach(async () => {
  for (const w of await wc.list()) await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

describe('MergeQueue', { timeout: 60_000 }, () => {
  it('is idle with nothing PASSED', async () => {
    expect(await queue().processNext()).toMatchObject({ outcome: 'IDLE' });
  });

  it('lands two PASSED tasks serially, in the order they passed, on a repo with no remote', async () => {
    await passedTask('T1', { 'a.txt': 'from T1\n' });
    await passedTask('T2', { 'b.txt': 'from T2\n' });
    const q = queue();
    expect(q.pending()).toEqual(['T1', 'T2']);

    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'LANDED' });
    expect(await q.processNext()).toMatchObject({ taskId: 'T2', outcome: 'LANDED' }); // rebased onto T1
    expect(await q.processNext()).toMatchObject({ outcome: 'IDLE' });

    expect(g(repo, 'log', '--format=%s', 'main')).toBe('T2: work\nT1: work\nbase');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('from T1\n');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('from T2\n');
    expect([status('T1'), status('T2')]).toEqual(['COMMITTED', 'COMMITTED']);
    expect(await wc.list()).toEqual([]); // worktrees removed
    expect(g(repo, 'branch', '--list', 'mesh/*')).toBe(''); // merged branches deleted
    expect(g(repo, 'remote')).toBe('');
  });

  it('lands without running any check ONLY when no verifyCommand is set (a project that cannot be tested yet; the Human opts in)', async () => {
    await passedTask('T1', { 'a.txt': 'new project file\n' });
    const q = new MergeQueue({ db, repoRoot: repo, worktrees: wc, verifyCommand: null });
    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'LANDED' });
    expect(status('T1')).toBe('COMMITTED');
  });

  it('a failing verification never reaches trunk', async () => {
    await passedTask('T1', { 'a.txt': 'broken\n' });
    const before = g(repo, 'rev-parse', 'main');
    const r = await queue(FAIL).processNext();
    expect(r).toMatchObject({ taskId: 'T1', outcome: 'VERIFY_FAILED' });
    expect(r.detail).toContain('tests failed');
    expect(g(repo, 'rev-parse', 'main')).toBe(before);
    expect(status('T1')).toBe('IN_PROGRESS');
  });

  it('a rebase conflict is aborted cleanly and handed back to the author', async () => {
    const wt = await passedTask('T1', { 'shared.txt': 'task version\n' });
    commitOnTrunk({ 'shared.txt': 'trunk version\n' }, 'conflicting trunk change');
    const before = g(repo, 'rev-parse', 'main');
    expect(await queue().processNext()).toMatchObject({ taskId: 'T1', outcome: 'REBASE_CONFLICT' });
    expect(status('T1')).toBe('IN_PROGRESS');
    expect(g(repo, 'rev-parse', 'main')).toBe(before);
    expect(g(wt, 'status', '--porcelain')).toBe(''); // not left mid-rebase
  });

  it('a rebase that changes the patch forces a re-review, and the old audit can no longer pass it', async () => {
    // Task edits line 6; trunk then edits line 4 (inside the diff context): a clean rebase, a different patch-id (verified in S0.4).
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    await passedTask('T1', { 'shared.txt': lines.map((l, i) => (i === 5 ? 'SIX' : l)).join('\n') + '\n' });
    const auditedHash = (db.prepare("SELECT diff_hash FROM tasks WHERE id = 'T1'").get() as { diff_hash: string }).diff_hash;
    commitOnTrunk({ 'shared.txt': lines.map((l, i) => (i === 3 ? 'FOUR' : l)).join('\n') + '\n' }, 'trunk edits line 4');
    const before = g(repo, 'rev-parse', 'main');

    expect(await queue().processNext()).toMatchObject({ taskId: 'T1', outcome: 'PATCH_CHANGED' });

    expect(status('T1')).toBe('READY_FOR_REVIEW');
    expect(g(repo, 'rev-parse', 'main')).toBe(before);
    const newHash = (db.prepare("SELECT diff_hash FROM tasks WHERE id = 'T1'").get() as { diff_hash: string }).diff_hash;
    expect(newHash).not.toBe(auditedHash);
    expect(() => db.prepare("UPDATE tasks SET status = 'PASSED' WHERE id = 'T1'").run()).toThrow(); // stale audit is useless
  });

  it('a branch that moved after the audit goes back to review', async () => {
    const wt = await passedTask('T1', { 'a.txt': 'audited\n' });
    writeFileSync(join(wt, 'a.txt'), 'sneaked in after the audit\n');
    g(wt, 'commit', '-q', '-am', 'post-audit change');
    const before = g(repo, 'rev-parse', 'main');
    expect(await queue().processNext()).toMatchObject({ taskId: 'T1', outcome: 'PATCH_CHANGED' });
    expect(g(repo, 'rev-parse', 'main')).toBe(before);
  });

  it("pauses (task stays PASSED) when the primary tree isn't on trunk", async () => {
    await passedTask('T1', { 'a.txt': 'x\n' });
    g(repo, 'checkout', '-q', '-b', 'human-experiment');
    const r = await queue().processNext();
    expect(r).toMatchObject({ taskId: 'T1', outcome: 'PAUSED' });
    expect(r.detail).toContain('human-experiment');
    expect(status('T1')).toBe('PASSED');
  });

  it("never touches the Human's overlapping uncommitted work: pauses, task stays PASSED", async () => {
    await passedTask('T1', { 'shared.txt': 'task version\n' });
    writeFileSync(join(repo, 'shared.txt'), 'human is editing this\n');
    const r = await queue().processNext();
    expect(r).toMatchObject({ taskId: 'T1', outcome: 'PAUSED' });
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('human is editing this\n');
    expect(status('T1')).toBe('PASSED');
  });

  it("lands alongside the Human's unrelated uncommitted work and leaves it alone", async () => {
    await passedTask('T1', { 'a.txt': 'task\n' });
    writeFileSync(join(repo, 'notes.txt'), 'human notes\n');
    expect(await queue().processNext()).toMatchObject({ outcome: 'LANDED' });
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('human notes\n');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  });

  it('is serial: a concurrent call gets BUSY', async () => {
    await passedTask('T1', { 'a.txt': 'x\n' });
    const q = queue();
    const [first, second] = await Promise.all([q.processNext(), q.processNext()]);
    expect([first.outcome, second.outcome].sort()).toEqual(['BUSY', 'LANDED']);
  });

  it('waits while an agent run is still inside the head task (live AC-8 run #3), never skipping ahead of it', async () => {
    await passedTask('T1', { 'a.txt': 'from T1\n' });
    await passedTask('T2', { 'b.txt': 'from T2\n' });
    const busy = new Set(['T1']);
    const q = new MergeQueue({ db, repoRoot: repo, worktrees: wc, verifyCommand: PASS, isTaskBusy: (id) => busy.has(id) });

    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'BUSY' });
    expect([status('T1'), status('T2')]).toEqual(['PASSED', 'PASSED']); // T2 did not jump the queue
    busy.delete('T1');
    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'LANDED' });
    expect(await q.processNext()).toMatchObject({ taskId: 'T2', outcome: 'LANDED' });
    expect(await wc.list()).toEqual([]);
  });
});
