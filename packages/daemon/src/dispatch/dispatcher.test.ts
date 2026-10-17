import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { AuthError, IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import type { RunResult } from '../runner/run.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, MAX_ATTEMPTS_PER_TASK, RETRY_AFTER_MS, TRANSIENT_BACKOFF_MS, isQuotaFailure, isTransientFailure, parseResetDelay } from './dispatcher.js';

// Fake agents (node scripts) standing in for claude/agy, including agy's REAL quota output from this build.
const SCRIPTS = {
  ok: `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'token=' + process.env.AGENTMESH_TOKEN }));`,
  slow: `setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })), 400);`,
  fail: `console.error('something broke'); process.exit(1);`,
  quota: `console.error('Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h51m46s.');
console.error('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true}');
process.exit(3);`,
  // agy's real outage line from live AC-8 run #2
  outage: `console.error('Print mode: run ended with error and no response: API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.'); process.exit(3);`,
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
      writeFileSync(file, SCRIPTS[behaviour[agentId] ?? 'ok']);
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

const runs = () => db.prepare('SELECT agent_id, task_id, kind, status FROM dispatch_runs ORDER BY started_at, rowid').all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-dispatch-'));
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

describe('quota parsing (agy output captured during this build)', () => {
  it('reads "Resets in 1h51m46s" and recognises RESOURCE_EXHAUSTED', () => {
    expect(parseResetDelay('... Resets in 1h51m46s.')).toBe((1 * 3600 + 51 * 60 + 46) * 1000);
    expect(parseResetDelay('resets in 12m')).toBe(12 * 60_000);
    expect(parseResetDelay('no timing here')).toBeNull();
    expect(isQuotaFailure('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}')).toBe(true);
    expect(isQuotaFailure('exited with code 1: something broke')).toBe(false);
  });
});

describe('Dispatcher', () => {
  it("routes a Claude task's audit to Gemini only, never to another Claude instance", async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    const started = d.tick();
    expect(started.map((s) => [s.agentId, s.work.kind, s.work.taskId])).toEqual([['gemini-1', 'AUDIT', 'T1']]);
    await settle(d);
    expect(runs()).toEqual([{ agent_id: 'gemini-1', task_id: 'T1', kind: 'AUDIT', status: 'SUCCEEDED' }]);
  });

  it('an audit the agent claimed but never finished (its run ended after a question) is resumed by that agent, under the retry limits', async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    db.prepare("UPDATE tasks SET status = 'AUDITING', reviewing_agent_id = 'gemini-1' WHERE id = 'T1'").run();
    const d = dispatcher();
    const first = d.tick();
    expect(first.map((s) => [s.agentId, s.work.kind, s.work.taskId])).toEqual([['gemini-1', 'AUDIT', 'T1']]);
    expect(first[0]!.work.job).toContain('already claimed the audit');
    await settle(d);
    expect(d.tick()).toEqual([]); // the brake holds it back for ten minutes
    clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    expect(d.tick().map((s) => s.agentId)).toEqual(['gemini-1']);
    await settle(d);
  });

  it('gives each run its own token and revokes it when the run ends', async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    d.tick();
    await settle(d);
    const token = String(finished[0]?.result.result?.text).replace('token=', '');
    expect(token).toMatch(/^amt_/);
    expect(() => ids.authenticate(token)).toThrow(AuthError);
  });

  it('never runs the same agent twice at once', async () => {
    behaviour['gemini-1'] = 'slow';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    task('T2', { author: 'claude-2', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    expect(d.tick().map((s) => s.agentId)).toEqual(['gemini-1']);
    expect(d.isBusy('gemini-1')).toBe(true);
    expect(d.tick()).toEqual([]); // still busy
    await settle(d);
  });

  // Gemini, P2.7 audit: a throw while removing the run folder skipped finish(), so the agent stayed busy forever.
  it.skipIf(process.platform !== 'win32')('finishes the run even when its folder is still locked (Windows EBUSY)', async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    let holder: ChildProcess | undefined;
    const gemini: DispatchableAgent = {
      ...agent('gemini-1', 'ANTIGRAVITY'),
      command: (prompt, cwd, run) => {
        holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: run.dir, stdio: 'ignore' }); // keeps run.dir locked
        return agent('gemini-1', 'ANTIGRAVITY').command(prompt, cwd, run);
      },
    };
    const d = new Dispatcher({ db, identity: ids, agents: [gemini], repoRoot: dir, now: () => clock, onRunFinished: (r) => finished.push(r) });
    try {
      d.tick();
      await settle(d);
      expect(d.isBusy('gemini-1')).toBe(false);
      expect(d.isTaskBusy('T1')).toBe(false);
      expect(runs()).toEqual([{ agent_id: 'gemini-1', task_id: 'T1', kind: 'AUDIT', status: 'SUCCEEDED' }]);
      const token = String(finished[0]?.result.result?.text).replace('token=', '');
      expect(() => ids.authenticate(token)).toThrow(AuthError); // revoked despite the leftover folder
    } finally {
      holder?.kill();
    }
  });

  it('reports a task busy until its run has exited (the merge queue waits on this)', async () => {
    behaviour['gemini-1'] = 'slow';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    d.tick();
    expect([d.isTaskBusy('T1'), d.isTaskBusy('T2')]).toEqual([true, false]);
    await settle(d);
    expect(d.isTaskBusy('T1')).toBe(false);
  });

  it('backs a platform off after a quota error until the reported reset, and the back-off survives a restart', async () => {
    behaviour['gemini-1'] = 'quota';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    let d = dispatcher();
    d.tick();
    await settle(d);
    expect(runs()).toEqual([{ agent_id: 'gemini-1', task_id: 'T1', kind: 'AUDIT', status: 'QUOTA' }]);
    const [b] = d.backoffs();
    expect(b?.platform).toBe('ANTIGRAVITY');
    expect(new Date(`${b!.until}Z`).getTime() - clock.getTime()).toBe((1 * 3600 + 51 * 60 + 46) * 1000);

    behaviour['gemini-1'] = 'ok';
    d = dispatcher(); // daemon restart
    expect(d.tick()).toEqual([]); // still backing off
    clock = new Date(clock.getTime() + (1 * 3600 + 52 * 60) * 1000);
    expect(d.tick().map((s) => s.agentId)).toEqual(['gemini-1']);
    await settle(d);
  });

  it("records why a run failed (the agent's stderr), not just the exit code (live run #4)", async () => {
    behaviour['gemini-1'] = 'fail';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    d.tick();
    await settle(d);
    const { detail } = db.prepare("SELECT detail FROM dispatch_runs WHERE task_id = 'T1'").get() as { detail: string };
    expect(detail).toContain('exited with code 1');
    expect(detail).toContain('something broke');
  });

  it('brakes retries: no retry within 10 minutes of a failure, and none after 3 failures', async () => {
    behaviour['gemini-1'] = 'fail';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TASK; attempt++) {
      expect(d.tick().length).toBe(1);
      await settle(d);
      expect(d.tick()).toEqual([]); // too soon
      clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    }
    expect(d.tick()).toEqual([]); // gave up: left for the Human
    expect(runs().filter((r) => (r as { status: string }).status === 'FAILED')).toHaveLength(MAX_ATTEMPTS_PER_TASK);
  });

  it('pause and resume, global and per agent, persist across restarts', async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    let d = dispatcher();
    d.pause();
    d = dispatcher();
    expect(d.isPaused()).toBe(true);
    expect(d.tick()).toEqual([]);
    d.resume();
    d.pause('gemini-1');
    expect(d.tick()).toEqual([]);
    d.resume('gemini-1');
    expect(d.tick().map((s) => s.agentId)).toEqual(['gemini-1']);
    await settle(d);
  });

  it('dispatches claimable tasks to their suggested owner only when prerequisites are done', async () => {
    task('A', { suggested: 'gemini-1' });
    task('B', { suggested: 'gemini-1', prereqs: ['A'] });
    const d = dispatcher();
    expect(d.nextWork(AGENTS()[2]!)).toMatchObject({ kind: 'TASK', taskId: 'A' });
    expect(d.nextWork(AGENTS()[0]!)).toBeNull(); // not suggested for Claude
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'gemini-1' WHERE id = 'A'").run();
    expect(d.nextWork(AGENTS()[2]!)).toBeNull(); // B still blocked on A
  });

  it('a task that builds on another waits until it has landed on trunk, not only passed its audit', () => {
    task('A', { suggested: 'claude-1', author: 'claude-1', status: 'READY_FOR_REVIEW' });
    task('B', { suggested: 'gemini-1', prereqs: ['A'] });
    const d = dispatcher();
    const gemini = AGENTS()[2]!;
    // A is audited and PASSED, but not yet on trunk: B's workspace would not have A's files.
    db.prepare("INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a1', 'A', 'gemini-1', 'PASSED', 'h', 1, 'ok')").run();
    expect((db.prepare("SELECT status FROM tasks WHERE id = 'A'").get() as { status: string }).status).toBe('PASSED');
    expect(d.nextWork(gemini)).toBeNull();
    db.prepare("UPDATE tasks SET status = 'COMMITTED' WHERE id = 'A'").run();
    expect(d.nextWork(gemini)).toMatchObject({ kind: 'TASK', taskId: 'B' });
  });

  it('dispatches an agent to read handoffs addressed to it', () => {
    task('T1');
    db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES ('h1', 'T1', 'gemini-1', 'claude-1', 'please look')").run();
    expect(dispatcher().nextWork(AGENTS()[0]!)).toMatchObject({ kind: 'HANDOFF', taskId: 'T1' });
  });

  it('skips handoffs that need no run of their own (dogfood: they cost runs and held up landing)', () => {
    const claude = AGENTS()[0]!;
    const hand = (id: string, task: string, from: string, at: string) =>
      db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message, created_at) VALUES (?, ?, ?, 'claude-1', 'm', ?)").run(id, task, from, at);
    // (1) an agent's note to the author of a task that already PASSED
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    db.prepare("INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a1', 'T1', 'gemini-1', 'PASSED', 'h', 1, 'ok')").run();
    expect((db.prepare("SELECT status FROM tasks WHERE id = 'T1'").get() as { status: string }).status).toBe('PASSED');
    hand('h1', 'T1', 'gemini-1', '2026-09-24 00:59:00');
    expect(dispatcher().nextWork(claude)).toBeNull();
    // ...but the Human's message about it still gets a run
    ids.registerAgent({ id: 'human', name: 'H', platform: 'HUMAN', paradigm: 'HUMAN' });
    hand('h2', 'T1', 'human', '2026-09-24 00:59:30');
    expect(dispatcher().nextWork(claude)).toMatchObject({ kind: 'HANDOFF', taskId: 'T1' });
    db.prepare("DELETE FROM handoffs WHERE id = 'h2'").run();
    // (2) delivery = a SUCCEEDED run of the recipient that STARTED after the handoff (every run reads the board first)
    task('T2');
    hand('h3', 'T2', 'gemini-1', '2026-09-24 00:58:00');
    const run = (id: string, kind: string, status: string, start: string, end: string) =>
      db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES (?, 'claude-1', 'T2', ?, ?, ?, ?)").run(id, kind, status, start, end);
    run('r1', 'AUDIT', 'SUCCEEDED', '2026-09-24 00:57:00', '2026-09-24 00:58:30'); // in flight when it arrived: never saw it
    expect(dispatcher().nextWork(claude)).toMatchObject({ kind: 'HANDOFF', taskId: 'T2' });
    run('r2', 'HANDOFF', 'FAILED', '2026-09-24 00:58:40', '2026-09-24 00:58:50'); // a failed delivery doesn't count...
    expect(dispatcher().nextWork(claude)?.kind).not.toBe('HANDOFF'); // ...but waits out the retry brake
    clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    expect(dispatcher().nextWork(claude)).toMatchObject({ kind: 'HANDOFF', taskId: 'T2' }); // retried
    run('r3', 'HANDOFF', 'SUCCEEDED', '2026-09-24 01:10:00', '2026-09-24 01:11:00');
    expect(dispatcher().nextWork(claude)?.kind).not.toBe('HANDOFF'); // delivered
    // (3) a handoff older than an unrelated later run is NOT lost (the old global filter dropped it)
    hand('h4', 'T2', 'human', '2026-09-24 01:12:00');
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES ('r4', 'claude-1', NULL, 'TASK', 'FAILED', '2026-09-24 01:13:00', '2026-09-24 01:14:00')").run();
    expect(dispatcher().nextWork(claude)).toMatchObject({ kind: 'HANDOFF', taskId: 'T2' });
  });

  it('marks runs left RUNNING by a previous daemon as ABANDONED', () => {
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at) VALUES ('r1', 'gemini-1', NULL, 'AUDIT', 'RUNNING', '2026-09-24 00:00:00')").run();
    dispatcher();
    expect((db.prepare("SELECT status FROM dispatch_runs WHERE id = 'r1'").get() as { status: string }).status).toBe('ABANDONED');
  });
});

describe('per-run MCP config (P2.7)', () => {
  it('gives the agent a config with its own token outside the repo, then deletes it and revokes the token', async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    let seen: { dir: string; token: string; claude: string; agy: string } | null = null;
    const gemini: DispatchableAgent = {
      agentId: 'gemini-1',
      platform: 'ANTIGRAVITY',
      rulebook: 'GEMINI.md',
      command: (_prompt, _cwd, run) => {
        seen = {
          dir: run.dir,
          token: run.token,
          claude: readFileSync(run.claudeMcpConfig, 'utf8'),
          agy: readFileSync(join(run.dir, '.agents', 'mcp_config.json'), 'utf8'),
        };
        const file = join(dir, 'ok.mjs');
        writeFileSync(file, SCRIPTS.ok);
        return { platform: 'ANTIGRAVITY', executable: process.execPath, args: [file], parse: parseClaudeEvent };
      },
    };
    const d = new Dispatcher({ db, identity: ids, agents: [gemini], repoRoot: dir, mcpUrl: 'http://127.0.0.1:9/mcp', now: () => clock });
    d.tick();
    await settle(d);
    const s = seen as unknown as { dir: string; token: string; claude: string; agy: string };
    expect(s.dir.startsWith(dir)).toBe(false); // outside the repository
    expect(JSON.parse(s.claude).mcpServers.agentmesh).toEqual({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${s.token}` } });
    expect(JSON.parse(s.agy).mcpServers.agentmesh).toEqual({ serverUrl: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${s.token}` }, disabled: false });
    expect(existsSync(s.dir)).toBe(false); // deleted after the run
    expect(() => ids.authenticate(s.token)).toThrow(AuthError); // and the token revoked
  });
});

describe('daemon pre-claims TASK work (live AC-8 run #1 fix)', () => {
  const cwdScript = `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'cwd=' + process.cwd() }));`;
  const claude = (): DispatchableAgent => ({
    agentId: 'claude-1',
    platform: 'CLAUDE_CODE',
    rulebook: 'CLAUDE.md',
    command: () => {
      const file = join(dir, 'cwd.mjs');
      writeFileSync(file, cwdScript);
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent };
    },
  });

  it('the retry brake counts the claim run: no immediate re-run after a run that claimed but made no progress (dogfood V1.1)', async () => {
    task('T1', { suggested: 'Claude' });
    const worktree = mkdtempSync(join(tmpdir(), 'agentmesh-wt-'));
    const d = new Dispatcher({
      db, identity: ids, agents: [claude()], repoRoot: dir, now: () => clock,
      // like BoardService.claimTask: the claim moves the task on (new updated_at = new task version)
      claim: async (_p, taskId) => {
        db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', worktree_path = ?, updated_at = '2026-09-24 01:00:05' WHERE id = ?").run(worktree, taskId);
        return { worktree };
      },
      onRunFinished: (r) => finished.push(r),
    });
    expect(d.tick().map((s) => s.work.taskId)).toEqual(['T1']);
    await settle(d);
    expect(d.tick()).toEqual([]); // before the fix: an immediate resume run
    clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    expect(d.tick().map((s) => [s.work.taskId, s.work.resume])).toEqual([['T1', true]]);
    await settle(d);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('resumes a task its agent already holds (run died after the claim, live run #4), in its worktree, without claiming again', async () => {
    task('T1', { suggested: 'Claude' });
    task('T2', { suggested: 'Claude' }); // a fresh TODO task must wait until T1 is finished
    const worktree = mkdtempSync(join(tmpdir(), 'agentmesh-wt-'));
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1', worktree_path = ? WHERE id = 'T1'").run(worktree);
    const claimed: string[] = [];
    const d = new Dispatcher({
      db, identity: ids, agents: [claude()], repoRoot: dir, now: () => clock,
      claim: async (_p, taskId) => { claimed.push(taskId); return { worktree }; },
      onRunFinished: (r) => finished.push(r),
    });
    expect(d.tick().map((s) => [s.work.kind, s.work.taskId, s.work.resume])).toEqual([['TASK', 'T1', true]]);
    await settle(d);
    expect(claimed).toEqual([]); // never claimed again
    expect(String(finished[0]?.result.result?.text).replace('cwd=', '').toLowerCase()).toBe(worktree.toLowerCase());
    // the usual retry brake applies: no immediate re-run of T1, and T2 is not claimed meanwhile
    expect(d.tick()).toEqual([]);
    // after the last allowed attempt, T1 is left for the Human and the agent moves on to T2
    for (let attempt = 2; attempt <= MAX_ATTEMPTS_PER_TASK; attempt++) {
      clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
      expect(d.tick().map((s) => s.work.taskId)).toEqual(['T1']);
      await settle(d);
    }
    clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    expect(d.tick().map((s) => [s.work.taskId, s.work.resume])).toEqual([['T2', undefined]]);
    await settle(d);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('a run about a task whose workspace was deleted (it merged) starts in the project folder, not the missing one', async () => {
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    db.prepare("UPDATE tasks SET worktree_path = ? WHERE id = 'T1'").run(join(dir, 'gone', 'wt-T1'));
    db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES ('h9', 'T1', 'gemini-1', 'claude-1', 'about T1')").run();
    const d = new Dispatcher({ db, identity: ids, agents: [claude()], repoRoot: dir, now: () => clock, onRunFinished: (r) => finished.push(r) });
    expect(d.tick().map((s) => s.work.kind)).toEqual(['HANDOFF']);
    await settle(d);
    expect(finished[0]?.result.ok).toBe(true);
    expect(String(finished[0]?.result.result?.text).replace('cwd=', '').toLowerCase()).toBe(dir.toLowerCase());
  });

  it('claims first, then runs the agent inside the returned worktree', async () => {
    task('T1', { suggested: 'Claude' });
    const worktree = mkdtempSync(join(tmpdir(), 'agentmesh-wt-'));
    const claimedBy: string[] = [];
    const d = new Dispatcher({
      db, identity: ids, agents: [claude()], repoRoot: dir, now: () => clock,
      claim: async (principal, taskId) => { claimedBy.push(`${principal.agentId}:${taskId}`); return { worktree }; },
      onRunFinished: (r) => finished.push(r),
    });
    expect(d.tick().map((s) => s.work.kind)).toEqual(['TASK']);
    expect(d.isBusy('claude-1')).toBe(true); // busy while claiming
    await settle(d);
    expect(claimedBy).toEqual(['claude-1:T1']);
    expect(String(finished[0]?.result.result?.text).replace('cwd=', '').toLowerCase()).toBe(worktree.toLowerCase());
    rmSync(worktree, { recursive: true, force: true });
  });

  it('a failed claim records FAILED, revokes the token and frees the agent', async () => {
    task('T1', { suggested: 'Claude' });
    const d = new Dispatcher({
      db, identity: ids, agents: [claude()], repoRoot: dir, now: () => clock,
      claim: async () => { throw new Error('someone else claimed it'); },
    });
    d.tick();
    await settle(d);
    const run = db.prepare("SELECT status, detail FROM dispatch_runs WHERE task_id = 'T1'").get() as { status: string; detail: string };
    expect(run).toMatchObject({ status: 'FAILED' });
    expect(run.detail).toContain('claim failed: someone else claimed it');
    const cred = db.prepare("SELECT revoked_at FROM agent_credentials WHERE label LIKE 'dispatch:%'").get() as { revoked_at: string | null };
    expect(cred.revoked_at).not.toBeNull();
    expect(d.isBusy('claude-1')).toBe(false);
  });
});

describe('transient provider outage (live AC-8 run #2)', () => {
  it('recognises the 503 text and backs the platform off briefly', async () => {
    expect(isTransientFailure('API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.')).toBe(true);
    expect(isTransientFailure('exited with code 1')).toBe(false);
    behaviour['gemini-1'] = 'outage';
    task('T1', { author: 'claude-1', status: 'READY_FOR_REVIEW' });
    const d = dispatcher();
    d.tick();
    await settle(d);
    const [b] = d.backoffs();
    expect(b).toMatchObject({ platform: 'ANTIGRAVITY', reason: 'provider unavailable (transient)' });
    expect(new Date(`${b!.until}Z`).getTime() - clock.getTime()).toBe(TRANSIENT_BACKOFF_MS);
  });
});
