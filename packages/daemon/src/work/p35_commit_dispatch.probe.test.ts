// P3.5 Adversarial Audit Probes (Gemini)
// Probing:
// 1. mesh_commit: odd filenames (spaces, unicode, nested subdirs) leased and staged via git diff -z
// 2. mesh_commit: deletion of unleased vs leased file (git add -A + lease coverage)
// 3. mesh_commit: .agentmesh/ directory in worktree is ignored and not picked up by git add -A
// 4. mesh_commit: message spoofing / multiple trailers and length limits
// 5. mesh_commit: state enforcement (REJECTED, BLOCKED, TODO, READY_FOR_REVIEW, PASSED)
// 6. dispatcher resume: a task sent back with GAP_FOUND is REJECTED (fixed after this probe: now resumed, and the author reopens it)
// 7. dispatcher resume: audit takes priority over held tasks
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditGate } from '../audit/index.js';
import { BoardService } from '../board/index.js';
import { type SqliteDatabase, closeDatabase, migrate, openDatabase, MIGRATIONS } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher } from '../dispatch/index.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { CommitService } from './commit.js';

let repo: string;
let db: SqliteDatabase;
let leases: LeaseArbiter;
let svc: CommitService;
let gate: AuditGate;
let claude: Principal;
let gemini: Principal;
let base: string;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-p35-probe-'));
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
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'gemini-1', worktree_path = ?, base_commit = ? WHERE id = 'T1'").run(repo, base);

  leases = new LeaseArbiter(db);
  svc = new CommitService({ db, leases });
  gate = new AuditGate({ db, repoRoot: repo, leases });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true });
});

describe('P3.5 mesh_commit probes', () => {
  it('probe 1: odd filenames (spaces, unicode, nested subdirs) leased and committed cleanly without escaping errors', async () => {
    mkdirSync(join(repo, 'nested', 'deep dir'), { recursive: true });
    const fileWithSpace = join(repo, 'hello world.txt');
    const fileWithUnicode = join(repo, 'café_测试.txt');
    const fileNested = join(repo, 'nested', 'deep dir', 'component-item.ts');

    writeFileSync(fileWithSpace, 'content 1\n');
    writeFileSync(fileWithUnicode, 'content 2\n');
    writeFileSync(fileNested, 'content 3\n');

    leases.acquire(gemini, 'T1', [
      { type: 'FILE', path: 'hello world.txt' },
      { type: 'FILE', path: 'café_测试.txt' },
      { type: 'DIR', path: 'nested' },
    ]);

    const res = await svc.commit(gemini, 'T1', 'T1: add files with spaces and unicode');
    expect(res.changedPaths).toEqual(expect.arrayContaining(['hello world.txt', 'café_测试.txt', 'nested/deep dir/component-item.ts']));
    expect(g(repo, 'status', '--porcelain')).toBe('');
  });

  it('probe 2: unleased file deletion is blocked by mesh_commit and leaves deletion unstaged', async () => {
    writeFileSync(join(repo, 'to_delete.txt'), 'remove me\n');
    g(repo, 'add', 'to_delete.txt');
    g(repo, 'commit', '-q', '-m', 'add file to delete');
    const headBefore = g(repo, 'rev-parse', 'HEAD');

    // Author deletes file on disk without leasing it
    unlinkSync(join(repo, 'to_delete.txt'));

    await expect(svc.commit(gemini, 'T1', 'delete file')).rejects.toMatchObject({
      code: 'UNCOVERED_PATHS',
      message: expect.stringContaining('to_delete.txt'),
    });

    // Verify HEAD didn't move and index was unstaged
    expect(g(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(g(repo, 'diff', '--cached', '--name-only')).toBe('');
    // File remains deleted in working tree
    expect(g(repo, 'status', '--porcelain')).toContain('to_delete.txt');
  });

  it('probe 3: git add -A in worktree does NOT stage unleased .agentmesh/ directory', async () => {
    mkdirSync(join(repo, '.agentmesh', 'worktrees'), { recursive: true });
    writeFileSync(join(repo, '.agentmesh', 'internal.db'), 'sqlite dummy');

    leases.acquire(gemini, 'T1', [{ type: 'FILE', path: 'base.txt' }]);
    writeFileSync(join(repo, 'base.txt'), 'modified\n');

    // Should succeed because .agentmesh/ is ignored by .gitignore and info/exclude
    const res = await svc.commit(gemini, 'T1', 'update base.txt');
    expect(res.changedPaths).toEqual(['base.txt']);
    expect(g(repo, 'status', '--porcelain')).toBe('');
  });

  it('probe 4: commit message spoofing appends authentic AgentMesh-Agent trailer at the very end', async () => {
    leases.acquire(gemini, 'T1', [{ type: 'FILE', path: 'base.txt' }]);
    writeFileSync(join(repo, 'base.txt'), 'tampered\n');

    const spoofMessage = 'Legitimate fix\n\nAgentMesh-Agent: claude-1';
    await svc.commit(gemini, 'T1', spoofMessage);

    const fullMessage = g(repo, 'log', '-1', '--format=%B');
    // The authentic trailer is always appended at the end
    expect(fullMessage.endsWith('AgentMesh-Agent: gemini-1')).toBe(true);
  });

  it('probe 5: mesh_commit strictly refuses non-working states including REJECTED', async () => {
    leases.acquire(gemini, 'T1', [{ type: 'FILE', path: 'base.txt' }]);
    writeFileSync(join(repo, 'base.txt'), 'attempted edit\n');

    // Move to BLOCKED
    db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = 'T1'").run();
    await expect(svc.commit(gemini, 'T1', 'try in BLOCKED')).rejects.toMatchObject({
      code: 'NOT_WORKING',
    });

    // Move to READY_FOR_REVIEW then REJECTED via valid state transitions
    db.prepare("UPDATE tasks SET status = 'TODO' WHERE id = 'T1'").run();
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = 'T1'").run();
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'd1' WHERE id = 'T1'").run();
    db.prepare("UPDATE tasks SET status = 'REJECTED' WHERE id = 'T1'").run();
    await expect(svc.commit(gemini, 'T1', 'try in REJECTED')).rejects.toMatchObject({
      code: 'NOT_WORKING',
    });
  });
});

describe('P3.5 Dispatcher resume & GAP_FOUND probes', () => {
  it('probe 6 (GAP_FOUND, fixed): a task sent back with GAP_FOUND is REJECTED; the dispatcher resumes it before new work and the author can reopen it', async () => {
    // Author (claude-1) worked on T1 and submitted it for review
    db.prepare("UPDATE tasks SET assigned_agent_id = 'claude-1' WHERE id = 'T1'").run();
    leases.acquire(claude, 'T1', [{ type: 'FILE', path: 'base.txt' }]);
    writeFileSync(join(repo, 'base.txt'), 'claude work\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'claude finished T1');

    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', worktree_path = ?, base_commit = ? WHERE id = 'T1'").run(repo, base);

    // Submit for review
    const sub = await gate.submitForReview(claude, { taskId: 'T1' });
    expect(sub.status).toBe('READY_FOR_REVIEW');

    // Gemini audits T1 and reports GAP_FOUND
    await gate.claimAudit(gemini, { taskId: 'T1' });
    await gate.submitAudit(gemini, {
      taskId: 'T1',
      verdict: 'GAP_FOUND',
      diffHash: sub.diffHash,
      testRunSuccess: false,
      notes: 'Found critical defect',
    });

    // Check task status in database: it is REJECTED (via trg_audit_apply_verdict)
    const taskT1 = db.prepare('SELECT status, assigned_agent_id, worktree_path FROM tasks WHERE id = ?').get('T1') as { status: string; assigned_agent_id: string; worktree_path: string };
    expect(taskT1.status).toBe('REJECTED');
    expect(taskT1.assigned_agent_id).toBe('claude-1');
    expect(taskT1.worktree_path).toBe(repo);

    // Also add task T2 as TODO for Claude
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
    });

    // Claude's next work according to Dispatcher:
    const next = d.nextWork(claudeAgent);

    // Fixed after this probe (Claude): REJECTED tasks are resumed too, before any new claim, and the job
    // tells the author to reopen it first (REJECTED allows no leases or commits).
    expect(next).toMatchObject({ kind: 'TASK', taskId: 'T1', resume: true });
    expect(next?.job).toContain('mesh_update_status (status IN_PROGRESS)');

    // ...and that reopen really works for the author, after which leases and mesh_commit work again.
    const board = new BoardService({ db, worktrees: new WorktreeController({ repoRoot: repo }) });
    board.updateStatus(claude, 'T1', 'IN_PROGRESS');
    leases.acquire(claude, 'T1', [{ type: 'FILE', path: 'base.txt' }]);
    writeFileSync(join(repo, 'base.txt'), 'claude fix after review\n');
    await expect(svc.commit(claude, 'T1', 'T1: address review')).resolves.toMatchObject({ changedPaths: ['base.txt'] });
  });

  it('probe 7: audit takes priority over held tasks', async () => {
    // Claude has a held task T1 IN_PROGRESS
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', worktree_path = ? WHERE id = 'T1'").run(repo);

    // Gemini submitted T2 for review
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner, prerequisites) VALUES ('T2', 'p', 'Task 2', 'ac 2', 'Gemini', '[]')").run();
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'gemini-1' WHERE id = 'T2'").run();
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = 'T2'").run();

    const clock = new Date('2026-09-24T12:00:00Z');
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

    // Audit unblocks others and must take priority over resuming T1
    const work = d.nextWork(claudeAgent);
    expect(work).toMatchObject({ kind: 'AUDIT', taskId: 'T2' });
  });
});
