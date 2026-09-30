// G6b (was V1.5): what a crash leaves behind is recovered without the Human. The state below is exactly
// what a daemon that died mid-run leaves in the database: a RUNNING run, its live token, the agent's
// task IN_PROGRESS in its worktree, and the agent's file lease.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { AuthError, IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { LeaseArbiter, LeaseConflictError } from '../leases/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, MAX_ATTEMPTS_PER_TASK } from './dispatcher.js';

let dir: string;
let db: SqliteDatabase;
let ids: IdentityService;
let clock: Date;
let launches: { agentId: string; cwd: string; prompt: string }[];

const sql = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

function agent(agentId: string, platform: string): DispatchableAgent {
  return {
    agentId,
    platform,
    rulebook: 'RULES.md',
    command: (prompt, cwd) => {
      launches.push({ agentId, cwd, prompt });
      const file = join(dir, `${agentId}.mjs`);
      writeFileSync(file, `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));`);
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent };
    },
  };
}

const newDaemon = (leases: LeaseArbiter) =>
  new Dispatcher({ db, identity: ids, leases, agents: [agent('claude-1', 'CLAUDE_CODE'), agent('gemini-1', 'ANTIGRAVITY')], repoRoot: dir, now: () => clock });

async function settle(d: Dispatcher): Promise<void> {
  for (let i = 0; i < 200 && (d.isBusy('claude-1') || d.isBusy('gemini-1')); i++) await new Promise((r) => setTimeout(r, 25));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-crash-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
  ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'claude-1', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'gemini-1', name: 'gemini-1', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  clock = new Date('2026-10-01T09:00:00Z');
  launches = [];
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('crash recovery (G6b)', () => {
  it('an agent killed mid-task: its lease expires, the restart cleans up, and the task resumes in its own worktree', async () => {
    const leases = new LeaseArbiter(db, { now: () => clock, ttlSeconds: 120 });
    const worktree = join(dir, 'wt-A');
    mkdirSync(worktree);
    for (const [id, owner] of [['A', 'claude-1'], ['B', 'gemini-1']] as const) {
      db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES (?, 'p', ?, 'ac', 'IN_PROGRESS', ?, ?)").run(id, id, owner, id === 'A' ? worktree : join(dir, 'wt-B'));
    }

    // ── what the crashed daemon left: a RUNNING run with a live token, and claude-1's lease on x.ts ──
    const runToken = ids.issueToken('claude-1', 'dispatch:crashed-run');
    const version = (db.prepare("SELECT updated_at FROM tasks WHERE id = 'A'").get() as { updated_at: string }).updated_at;
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at) VALUES ('crashed-run', 'claude-1', 'A', ?, 'TASK', 'RUNNING', ?)").run(version, sql(clock));
    leases.acquire(ids.authenticate(runToken), 'A', [{ type: 'FILE', path: 'x.ts' }]);
    const gemini = ids.authenticate(ids.issueToken('gemini-1', 'test'));

    // 1. Nobody renews the dead agent's lease: it blocks others only until its time-to-live runs out.
    advance(60_000);
    expect(() => leases.acquire(gemini, 'B', [{ type: 'FILE', path: 'x.ts' }])).toThrow(LeaseConflictError);
    advance(60_000);
    expect(leases.acquire(gemini, 'B', [{ type: 'FILE', path: 'x.ts' }])).toHaveLength(1);

    // 2. AgentMesh comes back (the supervisor restarts it): the run is ABANDONED and its token is dead.
    const d = newDaemon(leases);
    expect((db.prepare("SELECT status FROM dispatch_runs WHERE id = 'crashed-run'").get() as { status: string }).status).toBe('ABANDONED');
    expect(() => ids.authenticate(runToken)).toThrow(AuthError);

    // 3. The same agent picks its half-done task up again at once, in its own worktree, told to continue.
    const started = d.tick().filter((s) => s.agentId === 'claude-1');
    expect(started.map((s) => [s.work.kind, s.work.taskId, s.work.resume])).toEqual([['TASK', 'A', true]]);
    expect(launches.find((l) => l.agentId === 'claude-1')).toMatchObject({ cwd: worktree });
    expect(launches.find((l) => l.agentId === 'claude-1')!.prompt).toContain('Continue task A');
    await settle(d);
    expect((db.prepare("SELECT status FROM dispatch_runs WHERE agent_id = 'claude-1' ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as { status: string }).status).toBe('SUCCEEDED');
  });

  it('a task whose runs keep crashing AgentMesh is not retried forever', () => {
    const leases = new LeaseArbiter(db, { now: () => clock });
    const worktree = join(dir, 'wt-A');
    mkdirSync(worktree);
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES ('A', 'p', 'A', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(worktree);
    const version = (db.prepare("SELECT updated_at FROM tasks WHERE id = 'A'").get() as { updated_at: string }).updated_at;
    for (let i = 0; i < MAX_ATTEMPTS_PER_TASK; i++) {
      db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at) VALUES (?, 'claude-1', 'A', ?, 'TASK', 'RUNNING', ?)").run(`r${i}`, version, sql(clock));
      newDaemon(leases); // each restart abandons the run that was going
      advance(5_000);
    }
    expect(newDaemon(leases).tick().filter((s) => s.agentId === 'claude-1')).toEqual([]);
  });
});
