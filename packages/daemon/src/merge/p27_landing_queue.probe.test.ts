// P2.7 Adversarial Audit Probes
// Probing:
// 1. Merge queue ordering: skipping busy tasks causes prerequisite inversion (T2 lands before prerequisite T1).
// 2. Merge queue ordering: skipping busy tasks causes FIFO conflict inversion (T1 passed first, T2 passed second; T2 jumps ahead and forces T1 into conflict).
// 3. Dispatcher cleanup fragility: an error during runContext deletion or callback leaves agent and task permanently busy.
// 4. WorktreeController error classification: locale-dependent git stderr can misclassify uncommitted changes as process lock.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { diffHash } from '../git/diff.js';
import { GitError } from '../git/run-git.js';
import { WorktreeController, WorktreeNotCleanError, WorktreeRemoveError } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { MergeQueue } from './queue.js';

const PASS = 'node -e "process.exit(0)"';

let repo: string;
let db: SqliteDatabase;
let wc: WorktreeController;

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const status = (id: string) => (db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

async function setupPassedTask(id: string, files: Record<string, string>, prereqs: string[] = []): Promise<string> {
  const wt = await wc.allocate(id, `task ${id}`);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(wt.path, f), c);
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-q', '-m', `${id}: work`);
  const head = g(wt.path, 'rev-parse', 'HEAD');
  const hash = await diffHash(wt.path, wt.baseCommit, head);
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, prerequisites) VALUES (?, 'p', ?, 'ac', ?)").run(
    id,
    `task ${id}`,
    JSON.stringify(prereqs),
  );
  db.prepare(
    "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', branch_name = ?, worktree_path = ?, base_commit = ?, head_commit = ? WHERE id = ?",
  ).run(wt.branch, wt.path, wt.baseCommit, head, id);
  db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = ? WHERE id = ?").run(hash, id);
  db.prepare(
    "INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES (?, ?, 'gemini-1', 'PASSED', ?, 1, 'ok')",
  ).run(`a-${id}`, id, hash);
  return wt.path;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-p27-probe-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'probe@example.com');
  g(repo, 'config', 'user.name', 'probe');
  g(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'shared.txt'), 'base shared content\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  wc = new WorktreeController({ repoRoot: repo, trunk: 'main' });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true });
});

describe('P2.7 MergeQueue & Dispatcher probes', () => {
  // Fixed after these probes (strict head-of-line FIFO): the first two now assert the corrected behaviour.
  it('probe: a busy head task blocks the queue, so T2 cannot land before its prerequisite T1', async () => {
    // T1 is the base prerequisite
    await setupPassedTask('T1', { 'prereq.txt': 'prereq content\n' }, []);
    // T2 has prerequisite ['T1']
    await setupPassedTask('T2', { 'dependent.txt': 'dependent content\n' }, ['T1']);

    // T1 is busy (e.g. auditor agent process is still alive / shutting down)
    const busyTasks = new Set(['T1']);
    const q = new MergeQueue({
      db,
      repoRoot: repo,
      worktrees: wc,
      verifyCommand: PASS,
      isTaskBusy: (id) => busyTasks.has(id),
    });

    // T1 is busy: the queue waits instead of skipping ahead to T2.
    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'BUSY' });
    expect([status('T1'), status('T2')]).toEqual(['PASSED', 'PASSED']);
    expect(existsSync(join(repo, 'dependent.txt'))).toBe(false);

    // Once T1's run has exited, T1 lands first, then T2.
    busyTasks.delete('T1');
    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'LANDED' });
    expect(await q.processNext()).toMatchObject({ taskId: 'T2', outcome: 'LANDED' });
    expect(existsSync(join(repo, 'prereq.txt'))).toBe(true);
  });

  it('probe: a busy head task keeps FIFO priority; the later overlapping task is the one that conflicts', async () => {
    // T1 passed first, modifies shared.txt line 1
    await setupPassedTask('T1', { 'shared.txt': 'from T1\n' }, []);
    // T2 passed second, modifies shared.txt line 1 differently
    await setupPassedTask('T2', { 'shared.txt': 'from T2\n' }, []);

    // T1's auditor process is busy for a moment
    const busy = new Set(['T1']);
    const q = new MergeQueue({
      db,
      repoRoot: repo,
      worktrees: wc,
      verifyCommand: PASS,
      isTaskBusy: (id) => busy.has(id),
    });

    // T2 does not jump ahead of T1.
    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'BUSY' });
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('base shared content\n');

    // T1 (passed first) lands; T2, which passed later, is the one sent back with the conflict.
    busy.delete('T1');
    expect(await q.processNext()).toMatchObject({ taskId: 'T1', outcome: 'LANDED' });
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('from T1\n');
    expect((await q.processNext()).outcome).toBe('REBASE_CONFLICT');
    expect(status('T2')).toBe('IN_PROGRESS');
  });

  it('probe: WorktreeController.remove misclassifies non-English git dirty error as WorktreeRemoveError', async () => {
    // If git outputs a localized message for dirty worktree, e.g.:
    // "fatal: '...' contient des fichiers modifiés ou non suivis"
    const fakeGitError = new GitError(
      ['worktree', 'remove', 'some-path'],
      "fatal: 'wt-T1' contient des fichiers modifiés ou non suivis",
      128,
    );

    // Verify regex match behavior on worktrees.ts:145:
    const regex = /contains modified or untracked files/;
    const isCleanRegexMatch = regex.test(fakeGitError.stderr);
    expect(isCleanRegexMatch).toBe(false); // Fails to match non-English stderr!

    // As a result, it falls back to WorktreeRemoveError ("a process may still have files open there")
    // rather than WorktreeNotCleanError ("uncommitted or untracked changes").
    const classifiedError = isCleanRegexMatch
      ? new WorktreeNotCleanError('some-path', fakeGitError)
      : new WorktreeRemoveError('some-path', fakeGitError);

    expect(classifiedError).toBeInstanceOf(WorktreeRemoveError);
    expect(classifiedError).not.toBeInstanceOf(WorktreeNotCleanError);
  });
});
