import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { AuthError, IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import type { RunResult } from '../runner/run.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, MAX_ATTEMPTS_PER_TASK, RETRY_AFTER_MS } from './dispatcher.js';

const SCRIPTS = {
  // Agent exits 0 with a valid result event, but does not mutate the task board
  noopSuccess: `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));`,
  ok: `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'token=' + process.env.AGENTMESH_TOKEN }));`,
};

let dir: string;
let db: SqliteDatabase;
let ids: IdentityService;
let clock: Date;
let finished: { agentId: string; result: RunResult }[];
let behaviour: Record<string, keyof typeof SCRIPTS>;

function agent(agentId: string, platform: string): DispatchableAgent {
  return {
    agentId,
    platform,
    rulebook: 'RULES.md',
    command: (prompt) => {
      const file = join(dir, `${agentId}.mjs`);
      writeFileSync(file, SCRIPTS[behaviour[agentId] ?? 'ok'] ?? SCRIPTS.ok);
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file, prompt.slice(0, 40)], parse: parseClaudeEvent };
    },
  };
}

const AGENTS = () => [agent('claude-1', 'CLAUDE_CODE'), agent('claude-2', 'CLAUDE_CODE'), agent('gemini-1', 'ANTIGRAVITY')];

function dispatcher(): Dispatcher {
  return new Dispatcher({ db, identity: ids, agents: AGENTS(), repoRoot: dir, now: () => clock, onRunFinished: (r) => finished.push(r) });
}

async function settle(d: Dispatcher): Promise<void> {
  for (let i = 0; i < 200 && AGENTS().some((a) => d.isBusy(a.agentId)); i++) await new Promise((r) => setTimeout(r, 25));
}

function task(id: string, opts: { author?: string; status?: 'TODO' | 'READY_FOR_REVIEW'; suggested?: string; prereqs?: string[] } = {}): void {
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, suggested_owner, prerequisites) VALUES (?, 'p', ?, 'ac', ?, ?)").run(
    id,
    id,
    opts.suggested ?? null,
    JSON.stringify(opts.prereqs ?? []),
  );
  if (opts.status === 'READY_FOR_REVIEW') {
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ? WHERE id = ?").run(opts.author ?? 'claude-1', id);
    db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h' WHERE id = ?").run(id);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-dispatch-probe-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
  ids = new IdentityService(db);
  for (const [id, platform] of [['claude-1', 'CLAUDE_CODE'], ['claude-2', 'CLAUDE_CODE'], ['gemini-1', 'ANTIGRAVITY']] as const) {
    ids.registerAgent({ id, name: id, platform, paradigm: 'CLI' });
  }
  clock = new Date('2026-09-24T01:00:00Z');
  finished = [];
  behaviour = {};
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("Dispatcher regressions (from Gemini's P2.5 audit probes)", () => {
  it('REGRESSION: a daemon restart revokes run tokens left by the previous process', () => {
    const runId = 'prev-run-123';
    const token = ids.issueToken('gemini-1', `dispatch:${runId}`);
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at) VALUES (?, 'gemini-1', 'T1', 'AUDIT', 'RUNNING', '2026-09-24 00:50:00')").run(runId);

    dispatcher(); // restart

    expect((db.prepare('SELECT status FROM dispatch_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('ABANDONED');
    expect(() => ids.authenticate(token)).toThrow(AuthError);
  });

  it('REGRESSION: a clean exit that made no progress is braked like a failure (no dispatch loop)', async () => {
    behaviour['gemini-1'] = 'noopSuccess';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();

    expect(d.tick().map((s) => [s.agentId, s.work.taskId])).toEqual([['gemini-1', 'T1']]);
    await settle(d);
    expect(d.tick()).toEqual([]); // no immediate re-dispatch

    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
      d.tick();
      await settle(d);
    }
    const total = (db.prepare("SELECT count(*) AS n FROM dispatch_runs WHERE task_id = 'T1'").get() as { n: number }).n;
    expect(total).toBe(MAX_ATTEMPTS_PER_TASK); // capped, then left for the Human
  });

  it('REGRESSION: tasks suggested for "Claude" / "Gemini" reach the right agent', () => {
    task('T_CLAUDE', { suggested: 'Claude' });
    task('T_GEMINI', { suggested: 'Gemini' });
    const d = dispatcher();
    expect(d.nextWork(AGENTS()[0]!)).toMatchObject({ kind: 'TASK', taskId: 'T_CLAUDE' });
    expect(d.nextWork(AGENTS()[2]!)).toMatchObject({ kind: 'TASK', taskId: 'T_GEMINI' });
  });

  it('two-platform rule for audits: same platform refused, other platform accepted', () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    expect(d.nextWork(AGENTS()[1]!)).toBeNull();
    expect(d.nextWork(AGENTS()[2]!)).toMatchObject({ kind: 'AUDIT', taskId: 'T1' });
  });

  it('REGRESSION: a synchronous launch failure revokes the token, records FAILED, and does not stop the tick', () => {
    const brokenAgent: DispatchableAgent = {
      agentId: 'broken-1',
      platform: 'CLAUDE_CODE',
      rulebook: 'RULES.md',
      command: () => {
        throw new Error('Command build failed');
      },
    };
    ids.registerAgent({ id: 'broken-1', name: 'broken-1', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
    task('T_FAIL');
    const d = new Dispatcher({ db, identity: ids, agents: [brokenAgent], repoRoot: dir, now: () => clock });

    expect(d.tick()).toEqual([]);

    const cred = db.prepare("SELECT revoked_at FROM agent_credentials WHERE agent_id = 'broken-1' AND label LIKE 'dispatch:%'").get() as { revoked_at: string | null };
    expect(cred.revoked_at).not.toBeNull();
    const run = db.prepare("SELECT status, detail FROM dispatch_runs WHERE agent_id = 'broken-1'").get() as { status: string; detail: string };
    expect(run).toMatchObject({ status: 'FAILED' });
    expect(run.detail).toContain('Command build failed');
  });
});
