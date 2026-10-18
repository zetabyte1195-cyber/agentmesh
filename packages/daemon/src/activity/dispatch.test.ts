// The dispatcher feeds the live log from the events of each run it starts (here with small node scripts standing in for an
// agent, printing what Claude Code prints), and tells it when the run is over.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { type ActivityChange, ActivityLog } from './index.js';

const SCRIPT = (body: string) => `
const out = (o) => console.log(JSON.stringify(o));
const file = require('node:path').join(process.cwd(), 'src', 'a.ts');
out({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the code.' }] } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: { file_path: file, content: 'SECRET-CONTENT' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'SECRET-OUTPUT', is_error: false }] } });
${body}
`;
const OK = SCRIPT(`out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });`);
const FAIL = SCRIPT(`console.error('something broke'); process.exit(1);`);
const SLOW = SCRIPT(`setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'done' }), 700);`);

let dir: string;
let db: SqliteDatabase;
let script: string;
let log: ActivityLog;
let changes: ActivityChange[];

const agent = (): DispatchableAgent => ({
  agentId: 'claude-1',
  platform: 'CLAUDE_CODE',
  rulebook: 'RULES.md',
  command: () => {
    const file = join(dir, 'agent.cjs');
    writeFileSync(file, script);
    return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent };
  },
});

async function runOnce(): Promise<string> {
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 'T1', 'ac')").run();
  db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES ('h1', 'T1', 'human', 'claude-1', 'please look')").run();
  const d = new Dispatcher({ db, identity: new IdentityService(db), agents: [agent()], repoRoot: dir, activity: log });
  const started = d.tick();
  expect(started).toHaveLength(1);
  for (let i = 0; i < 200 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
  return started[0]!.runId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-activity-dispatch-'));
  mkdirSync(join(dir, 'src'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
  const ids = new IdentityService(db);
  ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  changes = [];
  log = new ActivityLog({ flushMs: 20, onChange: (c) => changes.push(c) });
  script = OK;
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('a run feeds the log', () => {
  it('records what the agent said and which file it wrote, relative to its folder, and how the run ended', async () => {
    const runId = await runOnce();
    const e = log.entries(runId)!;
    expect(e.map((x) => [x.kind, x.text])).toEqual([
      ['start', 'Started (model m)'], // the script says which model it started on
      ['text', 'Looking at the code.'],
      ['tool', 'Wrote src/a.ts'],
      ['end', 'Finished'],
    ]);
    expect(e[2]!.path).toBe('src/a.ts');
    expect(log.isRunning(runId)).toBe(false);
    expect(log.info(runId)).toMatchObject({ agentId: 'claude-1', taskId: 'T1', running: false });
  });

  it('never keeps what a tool was given to write or what it returned', async () => {
    const runId = await runOnce();
    const all = JSON.stringify(log.entries(runId)) + JSON.stringify(changes);
    expect(all).not.toContain('SECRET-CONTENT');
    expect(all).not.toContain('SECRET-OUTPUT');
  });

  it('says a run failed, and that is the last thing the feed says', async () => {
    script = FAIL;
    const runId = await runOnce();
    expect(log.entries(runId)!.at(-1)).toMatchObject({ kind: 'end', text: 'Failed', failed: true });
  });

  it('shows the agent as working while the run goes on, and pushes the changes as they happen', async () => {
    script = SLOW;
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 'T1', 'ac')").run();
    db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES ('h1', 'T1', 'human', 'claude-1', 'x')").run();
    const d = new Dispatcher({ db, identity: new IdentityService(db), agents: [agent()], repoRoot: dir, activity: log });
    const [started] = d.tick();
    await new Promise((r) => setTimeout(r, 450));
    expect(log.live()['claude-1']).toMatchObject({ runId: started!.runId, taskId: 'T1' });
    expect(log.live()['claude-1']!.entries.some((x) => x.text === 'Wrote src/a.ts')).toBe(true);
    expect(changes.some((c) => c.running && c.entries.some((x) => x.text === 'Wrote src/a.ts'))).toBe(true); // before the run ended
    for (let i = 0; i < 200 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
    expect(log.live()).toEqual({});
    expect(changes.at(-1)).toMatchObject({ running: false });
  });

  it('works as before without a log', async () => {
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('T1', 'p', 'T1', 'ac')").run();
    db.prepare("INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message) VALUES ('h1', 'T1', 'human', 'claude-1', 'x')").run();
    const d = new Dispatcher({ db, identity: new IdentityService(db), agents: [agent()], repoRoot: dir });
    expect(d.tick()).toHaveLength(1);
    for (let i = 0; i < 200 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
    expect((db.prepare('SELECT status FROM dispatch_runs').get() as { status: string }).status).toBe('SUCCEEDED');
  });
});
