import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { CommitService } from './commit.js';

let repo: string;
let db: SqliteDatabase;
let leases: LeaseArbiter;
let svc: CommitService;
let claude: Principal;
let gemini: Principal;
let human: Principal;
let base: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-commit-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  base = g('rev-parse', 'HEAD');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  claude = ids.registerAgent({ id: 'claude-1', name: 'C', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'G', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  human = ids.registerAgent({ id: 'human', name: 'H', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 't', 'ac')").run();
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'gemini-1', worktree_path = ?, base_commit = ? WHERE id = 'T1'").run(repo, base);
  leases = new LeaseArbiter(db);
  svc = new CommitService({ db, leases });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true });
});

describe('CommitService (mesh_commit, P3.5)', () => {
  it('commits every leased change for the author, with the agent recorded in the message', async () => {
    leases.acquire(gemini, 'T1', [{ type: 'FILE', path: 'a.txt' }, { type: 'FILE', path: 'new.txt' }]);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    const r = await svc.commit(gemini, 'T1', 'T1: greeting');
    expect(r.headCommit).toBe(g('rev-parse', 'HEAD'));
    expect(r.changedPaths.sort()).toEqual(['a.txt', 'new.txt']);
    expect(g('log', '-1', '--format=%B')).toBe('T1: greeting\n\nAgentMesh-Agent: gemini-1');
    expect(g('status', '--porcelain')).toBe('');
  });

  it('refuses a change outside the author\'s leases and leaves the files exactly as they were, unstaged', async () => {
    leases.acquire(gemini, 'T1', [{ type: 'FILE', path: 'a.txt' }]);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'sneaky.txt'), 'x\n');
    await expect(svc.commit(gemini, 'T1', 'try')).rejects.toMatchObject({ code: 'UNCOVERED_PATHS', message: expect.stringContaining('sneaky.txt') });
    expect(g('rev-parse', 'HEAD')).toBe(base); // nothing committed
    expect(g('diff', '--cached', '--name-only')).toBe(''); // nothing left staged
    expect(readFileSync(join(repo, 'sneaky.txt'), 'utf8')).toBe('x\n'); // work kept
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('two\n');
  });

  it('only the assigned author may commit: not another agent, not the Human', async () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    await expect(svc.commit(claude, 'T1', 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(svc.commit(human, 'T1', 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(svc.commit(gemini, 'nope', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only while the task is being worked on, and never an empty commit or message', async () => {
    await expect(svc.commit(gemini, 'T1', 'nothing')).rejects.toMatchObject({ code: 'NOTHING_TO_COMMIT' });
    await expect(svc.commit(gemini, 'T1', '   ')).rejects.toMatchObject({ code: 'INVALID' });
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = 'T1'").run();
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    await expect(svc.commit(gemini, 'T1', 'late')).rejects.toMatchObject({ code: 'NOT_WORKING' });
  });

  it('a message is passed to git as one argument, never parsed by a shell or as options', async () => {
    leases.acquire(gemini, 'T1', [{ type: 'FILE', path: 'a.txt' }]);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const msg = '--amend "$(touch pwned)" `x`; & | > out.txt';
    await svc.commit(gemini, 'T1', msg);
    expect(g('log', '-1', '--format=%s')).toBe(msg);
    expect(g('rev-list', '--count', 'HEAD')).toBe('2'); // a new commit, not an amend
    expect(g('ls-files', '--others')).toBe('');
  });
});
