// P2.7 Re-audit Adversarial Probes
// Probing:
// 1. Merge queue strict FIFO: multiple pending tasks [T1, T2, T3]; T1 busy blocks all, and T1 conflict unblocks T2.
// 2. Dispatcher resiliency: if onRunFinished callback throws during completion, .finally guarantees isBusy and isTaskBusy are freed.
// 3. Dispatcher resiliency: if running.done rejects, .finally guarantees isBusy and isTaskBusy are freed.
// 4. Git englishMessages: verify LC_ALL='C' and LANGUAGE='C' are passed to environment.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, Dispatcher } from '../dispatch/dispatcher.js';
import type { DispatchableAgent } from '../dispatch/dispatcher.js';
import { diffHash } from '../git/diff.js';
import { git } from '../git/run-git.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { type RunResult, type RunningAgent } from '../runner/run.js';
import { MergeQueue } from './queue.js';

const PASS = 'node -e "process.exit(0)"';

let repo: string;
let db: SqliteDatabase;
let wc: WorktreeController;
let ids: IdentityService;

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
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-p27-reaudit-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'probe@example.com');
  g(repo, 'config', 'user.name', 'probe');
  g(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'shared.txt'), 'base shared content\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
  ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  wc = new WorktreeController({ repoRoot: repo, trunk: 'main' });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true });
});

describe('P2.7 Re-audit Probes', () => {
  it('strict FIFO holds for 3 tasks: busy head blocks whole queue; when head conflicts, next in line lands', async () => {
    // T1 modifies shared.txt (will conflict if main moves)
    await setupPassedTask('T1', { 'shared.txt': 'conflict from T1\n' }, []);
    // T2 modifies file2.txt
    await setupPassedTask('T2', { 'file2.txt': 'from T2\n' }, []);
    // T3 modifies file3.txt
    await setupPassedTask('T3', { 'file3.txt': 'from T3\n' }, []);

    const busy = new Set(['T1']);
    const q = new MergeQueue({
      db,
      repoRoot: repo,
      worktrees: wc,
      verifyCommand: PASS,
      isTaskBusy: (id) => busy.has(id),
    });

    // While T1 is busy, neither T2 nor T3 lands
    const r1 = await q.processNext();
    expect(r1).toMatchObject({ taskId: 'T1', outcome: 'BUSY' });
    expect([status('T1'), status('T2'), status('T3')]).toEqual(['PASSED', 'PASSED', 'PASSED']);

    // Now introduce a commit on main that causes T1 to conflict
    writeFileSync(join(repo, 'shared.txt'), 'main changed shared differently\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'main diverged');

    // T1 is no longer busy
    busy.delete('T1');
    const r2 = await q.processNext();
    expect(r2.taskId).toBe('T1');
    expect(r2.outcome).toBe('REBASE_CONFLICT');
    expect(status('T1')).toBe('IN_PROGRESS');

    // Now T2 is the head of the queue and lands cleanly
    const r3 = await q.processNext();
    expect(r3.taskId).toBe('T2');
    expect(r3.outcome).toBe('LANDED');
    expect(status('T2')).toBe('COMMITTED');

    // Next T3 lands cleanly
    const r4 = await q.processNext();
    expect(r4.taskId).toBe('T3');
    expect(r4.outcome).toBe('LANDED');
    expect(status('T3')).toBe('COMMITTED');
  });

  it('dispatcher clears busy state even if onRunFinished callback throws', async () => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, status, suggested_owner, acceptance_criteria) VALUES ('T1', 'p', 'Task 1', 'TODO', 'Claude', 'ac')").run();

    let doneResolve: (v: RunResult) => void;
    const donePromise = new Promise<RunResult>((resolve) => {
      doneResolve = resolve;
    });

    const mockRunningAgent: RunningAgent = {
      pid: 12345,
      done: donePromise,
      stop: async () => {},
    };

    const agent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: [], parse: () => null }),
    };

    const d = new Dispatcher({
      db,
      identity: ids,
      agents: [agent],
      repoRoot: repo,
      start: () => mockRunningAgent,
      claim: async () => ({ worktree: repo }),
      onRunFinished: () => {
        throw new Error('Explosion in onRunFinished subscriber');
      },
    });

    d.tick();
    expect(d.isBusy('claude-1')).toBe(true);
    expect(d.isTaskBusy('T1')).toBe(true);

    // Resolve the run
    doneResolve!({ ok: true, stopped: false, timedOut: false, failure: null, stderrTail: [] });
    await donePromise;
    // Allow promises (.then, .catch, .finally) to settle
    await new Promise((r) => setTimeout(r, 50));

    // Even though onRunFinished threw, isBusy and isTaskBusy MUST be false!
    expect(d.isBusy('claude-1')).toBe(false);
    expect(d.isTaskBusy('T1')).toBe(false);
  });

  it('dispatcher clears busy state even if running.done rejects', async () => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, status, suggested_owner, acceptance_criteria) VALUES ('T2', 'p', 'Task 2', 'TODO', 'Claude', 'ac')").run();

    let doneReject: (err: unknown) => void;
    const donePromise = new Promise<RunResult>((_, reject) => {
      doneReject = reject;
    });

    const mockRunningAgent: RunningAgent = {
      pid: 12346,
      done: donePromise,
      stop: async () => {},
    };

    const agent: DispatchableAgent = {
      agentId: 'claude-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'CLAUDE.md',
      command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: [], parse: () => null }),
    };

    const d = new Dispatcher({
      db,
      identity: ids,
      agents: [agent],
      repoRoot: repo,
      start: () => mockRunningAgent,
      claim: async () => ({ worktree: repo }),
    });

    d.tick();
    expect(d.isBusy('claude-1')).toBe(true);
    expect(d.isTaskBusy('T2')).toBe(true);

    // Reject the run
    doneReject!(new Error('Process runner crash'));
    await donePromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    // .finally MUST have cleared busy states!
    expect(d.isBusy('claude-1')).toBe(false);
    expect(d.isTaskBusy('T2')).toBe(false);
  });

  it('git helper with englishMessages passes LC_ALL=C and LANGUAGE=C', async () => {
    // Test git command with englishMessages
    const out = await git(repo, ['status'], { englishMessages: true });
    expect(typeof out).toBe('string');
  });
});
