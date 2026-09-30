import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { ReviewService } from './review.js';

let repo: string;
let db: SqliteDatabase;
let author: Principal;
let other: Principal;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-verify-author-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  author = ids.registerAgent({ id: 'gemini-1', name: 'G', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  other = ids.registerAgent({ id: 'claude-1', name: 'C', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 't', 'ac')").run();
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'gemini-1', worktree_path = ?, base_commit = ? WHERE id = 'T1'").run(repo, g('rev-parse', 'HEAD'));
});
afterEach(() => {
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true });
});

const command = 'node -e "console.log(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').trim())"';

describe('mesh_run_verification for the author (Antigravity has no shell rule to run tests itself)', () => {
  it('lets the assigned author check its own in-progress task, in its worktree', async () => {
    const r = await new ReviewService({ db, verifyCommand: command }).runVerification(author, 'T1');
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect((r as { output: string }).output).toContain('one');
  });

  it('nobody else may run it on a task that is still being written (only submitted work is reviewable)', async () => {
    await expect(new ReviewService({ db, verifyCommand: command }).runVerification(other, 'T1')).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' });
  });

  it('the author cannot use it once the task is done or was never theirs', async () => {
    db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = 'T1'").run();
    await expect(new ReviewService({ db, verifyCommand: command }).runVerification(author, 'T1')).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' });
  });

  it('reads the command each time, so the Human can change it while the daemon runs', async () => {
    let current: string | null = null;
    const svc = new ReviewService({ db, verifyCommand: () => current });
    await expect(svc.runVerification(author, 'T1')).rejects.toMatchObject({ code: 'NO_VERIFY_COMMAND' });
    current = command;
    await expect(svc.runVerification(author, 'T1')).resolves.toMatchObject({ ok: true });
  });
});
