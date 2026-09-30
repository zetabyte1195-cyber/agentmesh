import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { LeaseArbiter, LeaseConflictError, UncoveredPathsError } from './arbiter.js';
import { changedPathsBetween } from './changed-paths.js';
import { covers, normalizeLeasePath, overlaps } from './paths.js';

let db: SqliteDatabase;
let clock: Date;
let arbiter: LeaseArbiter;
let claude: Principal;
let gemini: Principal;

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

function task(id: string, author: string, status = 'IN_PROGRESS'): void {
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'p', 't', 'ac')").run(id);
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ? WHERE id = ?").run(author, id);
  if (status === 'READY_FOR_REVIEW') db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = ?").run(id);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  task('A', 'claude-1');
  task('B', 'gemini-1');
  clock = new Date('2026-09-23T12:00:00Z');
  arbiter = new LeaseArbiter(db, { now: () => clock, caseInsensitive: true });
});

afterEach(() => closeDatabase(db));

describe('lease paths', () => {
  it('normalizes to repo-relative forward-slash paths and rejects escapes', () => {
    expect(normalizeLeasePath('src\\db\\x.ts')).toBe('src/db/x.ts');
    expect(normalizeLeasePath('./src//db/')).toBe('src/db');
    expect(normalizeLeasePath('.')).toBe('.');
    for (const bad of ['', '  ', '../x', 'src/../../x', '/etc/passwd', 'C:\\Windows', 'c:/x']) expect(() => normalizeLeasePath(bad)).toThrow();
  });

  it('computes overlap and coverage for FILE and DIR', () => {
    expect(overlaps({ type: 'FILE', path: 'a/b.ts' }, { type: 'FILE', path: 'a/b.ts' })).toBe(true);
    expect(overlaps({ type: 'FILE', path: 'a/b.ts' }, { type: 'FILE', path: 'a/c.ts' })).toBe(false);
    expect(overlaps({ type: 'DIR', path: 'a' }, { type: 'FILE', path: 'a/b/c.ts' })).toBe(true);
    expect(overlaps({ type: 'DIR', path: 'a' }, { type: 'FILE', path: 'ab/c.ts' })).toBe(false); // prefix is not containment
    expect(overlaps({ type: 'DIR', path: 'a' }, { type: 'DIR', path: 'a/b' })).toBe(true);
    expect(overlaps({ type: 'DIR', path: '.' }, { type: 'FILE', path: 'x.ts' })).toBe(true);
    expect(covers({ type: 'DIR', path: 'src' }, 'src/x.ts')).toBe(true);
    expect(covers({ type: 'FILE', path: 'src/x.ts' }, 'src/y.ts')).toBe(false);
  });
});

describe('LeaseArbiter', () => {
  it('grants non-overlapping leases to different tasks', () => {
    expect(arbiter.acquire(claude, 'A', [{ type: 'DIR', path: 'src/db' }])).toHaveLength(1);
    expect(arbiter.acquire(gemini, 'B', [{ type: 'DIR', path: 'src/git' }])).toHaveLength(1);
  });

  it('rejects an overlapping lease and names the holder', () => {
    arbiter.acquire(claude, 'A', [{ type: 'DIR', path: 'packages/daemon/src/git' }]);
    try {
      arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'packages/daemon/src/git/worktrees.ts' }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseConflictError);
      const [c] = (err as LeaseConflictError).conflicts;
      expect(c?.heldBy).toMatchObject({ agentId: 'claude-1', taskId: 'A', type: 'DIR', path: 'packages/daemon/src/git' });
    }
  });

  it('is all-or-nothing: one conflicting target means nothing is granted', () => {
    arbiter.acquire(claude, 'A', [{ type: 'FILE', path: 'x.ts' }]);
    expect(() => arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'free.ts' }, { type: 'FILE', path: 'x.ts' }])).toThrow(LeaseConflictError);
    expect(arbiter.activeLeases('B')).toHaveLength(0);
  });

  it('treats paths differing only in case as the same file (Windows)', () => {
    arbiter.acquire(claude, 'A', [{ type: 'FILE', path: 'src/Store.ts' }]);
    expect(() => arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'SRC/store.ts' }])).toThrow(LeaseConflictError);
  });

  it("a task's own leases never conflict with each other", () => {
    arbiter.acquire(claude, 'A', [{ type: 'DIR', path: 'src' }]);
    expect(arbiter.acquire(claude, 'A', [{ type: 'FILE', path: 'src/x.ts' }])).toHaveLength(1);
  });

  it('expires after the TTL so a crashed agent cannot block the repo (AC-4)', () => {
    arbiter.acquire(claude, 'A', [{ type: 'FILE', path: 'x.ts' }]);
    advance(119);
    expect(() => arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'x.ts' }])).toThrow(LeaseConflictError);
    advance(1); // exactly 120 s
    expect(arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'x.ts' }])).toHaveLength(1);
    const statuses = db.prepare("SELECT status FROM leases WHERE task_id = 'A'").all() as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(['EXPIRED']);
  });

  it('heartbeat renewal keeps a lease alive; expired leases cannot be renewed', () => {
    const [lease] = arbiter.acquire(claude, 'A', [{ type: 'FILE', path: 'x.ts' }]);
    for (let i = 0; i < 10; i++) {
      advance(30);
      expect(arbiter.renew(claude, [lease!.id])).toBe(1);
    }
    expect(() => arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'x.ts' }])).toThrow(LeaseConflictError);
    advance(121);
    expect(arbiter.renew(claude, [lease!.id])).toBe(0);
  });

  it('only the owner can renew or release; release frees the path', () => {
    const [lease] = arbiter.acquire(claude, 'A', [{ type: 'FILE', path: 'x.ts' }]);
    expect(arbiter.renew(gemini, [lease!.id])).toBe(0);
    expect(arbiter.release(gemini, [lease!.id])).toBe(0);
    expect(arbiter.release(claude, [lease!.id])).toBe(1);
    expect(arbiter.acquire(gemini, 'B', [{ type: 'FILE', path: 'x.ts' }])).toHaveLength(1);
  });

  it("only the task's author may lease, and only while working on it", () => {
    expect(() => arbiter.acquire(gemini, 'A', [{ type: 'FILE', path: 'x.ts' }])).toThrow(/Only the task's author/);
    task('C', 'claude-1', 'READY_FOR_REVIEW');
    expect(() => arbiter.acquire(claude, 'C', [{ type: 'FILE', path: 'x.ts' }])).toThrow(/READY_FOR_REVIEW/);
    expect(() => arbiter.acquire(claude, 'nope', [{ type: 'FILE', path: 'x.ts' }])).toThrow(/Unknown task/);
  });

  it('enforces coverage at submission: un-leased and expired paths block it', () => {
    arbiter.acquire(claude, 'A', [{ type: 'DIR', path: 'src/db' }]);
    expect(() => arbiter.assertSubmissionCovered(claude, 'A', ['src/db/a.ts', 'src\\db\\b.ts'])).not.toThrow();
    try {
      arbiter.assertSubmissionCovered(claude, 'A', ['src/db/a.ts', 'README.md', 'src/dbx/c.ts']);
      expect.unreachable();
    } catch (err) {
      expect((err as UncoveredPathsError).paths).toEqual(['README.md', 'src/dbx/c.ts']);
    }
    advance(120);
    expect(() => arbiter.assertSubmissionCovered(claude, 'A', ['src/db/a.ts'])).toThrow(UncoveredPathsError);
  });

  it("another task's lease does not count as coverage", () => {
    arbiter.acquire(gemini, 'B', [{ type: 'DIR', path: 'src' }]);
    expect(() => arbiter.assertSubmissionCovered(claude, 'A', ['src/x.ts'])).toThrow(UncoveredPathsError);
  });
});

describe('changedPathsBetween', () => {
  it('lists both sides of a rename, so a deleted path must be leased too', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agentmesh-changed-'));
    try {
      const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@example.com');
      g('config', 'user.name', 't');
      writeFileSync(join(repo, 'old name.ts'), 'export const x = 1;\n'.repeat(20));
      writeFileSync(join(repo, 'keep.ts'), 'k\n');
      g('add', '.');
      g('commit', '-q', '-m', 'base');
      const base = g('rev-parse', 'HEAD');
      g('mv', 'old name.ts', 'new-name.ts');
      writeFileSync(join(repo, 'added.ts'), 'a\n');
      g('add', '.');
      g('commit', '-q', '-m', 'change');
      expect((await changedPathsBetween(repo, base, 'HEAD')).sort()).toEqual(['added.ts', 'new-name.ts', 'old name.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
