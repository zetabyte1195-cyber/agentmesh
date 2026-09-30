// G2 (gave up → Try again) and G4 (usage per run, agent and mission).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { MISSION_MIGRATION } from '../missions/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, MAX_ATTEMPTS_PER_TASK, RETRY_AFTER_MS } from './dispatcher.js';
import { USAGE_MIGRATION, usageSummary } from './usage.js';

// Claude Code's real result line carries usage and total_cost_usd.
const SCRIPTS = {
  ok: `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.25, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 } }));`,
  fail: `console.error('something broke'); process.exit(1);`,
};

let dir: string;
let db: SqliteDatabase;
let ids: IdentityService;
let clock: Date;
let behaviour: keyof typeof SCRIPTS;

function agent(agentId: string, platform: string): DispatchableAgent {
  return {
    agentId,
    platform,
    rulebook: 'RULES.md',
    command: () => {
      const file = join(dir, `${agentId}.mjs`);
      writeFileSync(file, SCRIPTS[behaviour]);
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent };
    },
  };
}
const newDispatcher = () => new Dispatcher({ db, identity: ids, agents: [agent('claude-1', 'CLAUDE_CODE')], repoRoot: dir, now: () => clock });
async function settle(d: Dispatcher): Promise<void> {
  for (let i = 0; i < 200 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-stuck-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, USAGE_MIGRATION]);
  ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'claude-1', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  clock = new Date('2026-10-01T09:00:00Z');
  const wt = join(dir, 'wt-A');
  mkdirSync(wt);
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES ('A', 'mission:M1', 'A', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(wt);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('gave up → Try again (G2)', () => {
  it('lists work an agent stopped trying, with the last reason, until the Human asks it to try again', async () => {
    behaviour = 'fail';
    const d = newDispatcher();
    for (let i = 0; i < MAX_ATTEMPTS_PER_TASK; i++) {
      expect(d.stuck()).toEqual([]);
      expect(d.tick().map((s) => s.work.taskId)).toEqual(['A']);
      await settle(d);
      clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    }
    expect(d.tick()).toEqual([]); // gave up
    const [stuck, ...rest] = d.stuck();
    expect(rest).toEqual([]);
    expect(stuck).toMatchObject({ agentId: 'claude-1', subject: 'A', tries: MAX_ATTEMPTS_PER_TASK, lastStatus: 'FAILED' });
    expect(stuck!.lastDetail).toContain('something broke');

    d.retry('claude-1', 'A');
    expect(d.stuck()).toEqual([]);
    behaviour = 'ok';
    expect(d.tick().map((s) => s.work.taskId)).toEqual(['A']); // at once, no ten-minute wait
    await settle(d);
  });

  it('work that has moved on (merged) is not shown as stuck', async () => {
    behaviour = 'fail';
    const d = newDispatcher();
    for (let i = 0; i < MAX_ATTEMPTS_PER_TASK; i++) {
      d.tick();
      await settle(d);
      clock = new Date(clock.getTime() + RETRY_AFTER_MS + 1000);
    }
    expect(d.stuck()).toHaveLength(1);
    // simulate the Human finishing it by hand: a new version of the task resets the count by itself
    db.prepare("UPDATE tasks SET updated_at = '2030-01-01 00:00:00' WHERE id = 'A'").run();
    expect(d.stuck()).toEqual([]);
  });
});

describe('usage (G4)', () => {
  it('records what each run reported, and totals it per agent and per mission', async () => {
    behaviour = 'ok';
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id) VALUES ('M1', 'Car wash', 'brief text', 'IMPLEMENTING', 'claude-1')").run();
    const d = newDispatcher();
    d.tick();
    await settle(d);
    const row = db.prepare('SELECT input_tokens AS i, output_tokens AS o, cache_read_tokens AS c, cost_usd AS usd FROM run_usage').get();
    expect(row).toEqual({ i: 1000, o: 200, c: 50, usd: 0.25 });

    // a run from before usage was recorded (no row) is counted as unreported, not as zero cost
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES ('old', 'claude-1', 'A', 'TASK', 'FAILED', '2026-09-01 00:00:00', '2026-09-01 00:01:00')").run();
    const s = usageSummary(db);
    expect(s.byAgent).toEqual([{ agentId: 'claude-1', runs: 2, unreported: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, costUsd: 0.25 }]);
    expect(s.byMission).toEqual([{ missionId: 'M1', runs: 2, unreported: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, costUsd: 0.25 }]);
  });
});
