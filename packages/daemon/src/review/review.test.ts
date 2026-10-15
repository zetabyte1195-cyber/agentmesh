import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { diffHash } from '../git/diff.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { ReviewError, ReviewService } from './review.js';

let repo: string;
let db: SqliteDatabase;
let gemini: Principal;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-review-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  writeFileSync(join(repo, 'b.txt'), 'new\n');
  g('add', '.');
  g('commit', '-q', '-m', 'change');
  const head = g('rev-parse', 'HEAD');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'C', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'G', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 't', 'ac')").run();
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', worktree_path = ?, base_commit = ?, head_commit = ? WHERE id = 'T1'").run(repo, base, head);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true });
});

const submit = async () => {
  const t = db.prepare("SELECT base_commit, head_commit FROM tasks WHERE id = 'T1'").get() as { base_commit: string; head_commit: string };
  db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = ? WHERE id = 'T1'").run(await diffHash(repo, t.base_commit, t.head_commit));
};

describe('ReviewService', () => {
  it('returns the exact pinned diff (its hash equals the pinned diff_hash)', async () => {
    await submit();
    const r = await new ReviewService({ db, verifyCommand: null }).getDiff(gemini, 'T1');
    expect(r.changedPaths.sort()).toEqual(['a.txt', 'b.txt']);
    expect(r.diff).toContain('-one');
    expect(r.diff).toContain('+two');
    expect(r.truncated).toBe(false);
    expect(await diffHash(repo, r.baseCommit!, r.headCommit!)).toBe(r.diffHash);
  });

  it('only works on submitted tasks', async () => {
    const svc = new ReviewService({ db, verifyCommand: 'node -e "process.exit(0)"' });
    await expect(svc.getDiff(gemini, 'T1')).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' });
    await expect(svc.runVerification(gemini, 'T1')).rejects.toBeInstanceOf(ReviewError);
    await expect(svc.getDiff(gemini, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runs the check through an injected runner (container mode), never on this computer, and reports its pass/fail the same way', async () => {
    await submit();
    const calls: { command: string; cwd: string }[] = [];
    const ran = new ReviewService({ db, verifyCommand: 'npm test', runCheck: async (command, o) => (calls.push({ command, cwd: o.cwd }), { stdout: 'all 3 passed', stderr: '' }) });
    expect(await ran.runVerification(gemini, 'T1')).toMatchObject({ ok: true, output: 'all 3 passed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('npm test');
    const failed = await new ReviewService({ db, verifyCommand: 'npm test', runCheck: async () => { throw Object.assign(new Error('x'), { code: 3, killed: false, stdout: 'out', stderr: '2 failed' }); } }).runVerification(gemini, 'T1');
    expect(failed).toMatchObject({ ok: false, exitCode: 3, output: 'out2 failed' });
  });

  it('runs the CONFIGURED command in the worktree and reports pass/fail with output', async () => {
    await submit();
    const pass = await new ReviewService({ db, verifyCommand: 'node -e "console.log(require(\'fs\').readFileSync(\'b.txt\',\'utf8\'))"' }).runVerification(gemini, 'T1');
    expect(pass).toMatchObject({ ok: true, exitCode: 0 });
    expect(pass.output).toContain('new'); // ran inside the worktree
    const fail = await new ReviewService({ db, verifyCommand: 'node -e "console.error(\'2 tests failed\'); process.exit(1)"' }).runVerification(gemini, 'T1');
    expect(fail).toMatchObject({ ok: false, exitCode: 1 });
    expect(fail.output).toContain('2 tests failed');
  });

  it('refuses without a configured command, and runs one verification per task at a time', async () => {
    await submit();
    await expect(new ReviewService({ db, verifyCommand: null }).runVerification(gemini, 'T1')).rejects.toMatchObject({ code: 'NO_VERIFY_COMMAND' });
    const svc = new ReviewService({ db, verifyCommand: 'node -e "setTimeout(() => {}, 400)"' });
    const first = svc.runVerification(gemini, 'T1');
    await expect(svc.runVerification(gemini, 'T1')).rejects.toMatchObject({ code: 'BUSY' });
    expect((await first).ok).toBe(true);
  });
});
