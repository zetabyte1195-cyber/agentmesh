// Task 7: loop detection. The parser is checked against a REAL Claude stream captured on this machine
// (sanitized), then the detector, then a real process that repeats itself and must be killed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher } from '../dispatch/dispatcher.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { type RunnerEvent, parseAgyEvent, parseClaudeEvent } from './events.js';
import { LoopDetector, inputSignature, stableHash } from './loop.js';
import { startAgent } from './run.js';

const fixture = readFileSync(join(__dirname, 'fixtures', 'claude-two-identical-tool-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

const use = (id: string, name = 'Bash', input: unknown = { command: 'npm test' }): RunnerEvent => ({ kind: 'tool_use', name, id, inputHash: inputSignature(input) });
const result = (id: string, text = 'FAIL 1 test', isError = false): RunnerEvent => ({ kind: 'tool_result', id, isError, outputHash: stableHash(text) });
const feed = (d: LoopDetector, events: RunnerEvent[]) => events.map((e) => d.observe(e));

describe('the real Claude stream', () => {
  const events = fixture.flatMap((l) => parseClaudeEvent(l));
  const uses = events.filter((e) => e.kind === 'tool_use') as Extract<RunnerEvent, { kind: 'tool_use' }>[];
  const results = events.filter((e) => e.kind === 'tool_result') as Extract<RunnerEvent, { kind: 'tool_result' }>[];

  it('gives each tool call an id and each result the id of its call', () => {
    expect(uses).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(uses.map((u) => u.name)).toEqual(['Bash', 'Bash']);
    expect(results.map((r) => r.id)).toEqual(uses.map((u) => u.id));
    expect(results.every((r) => r.isError === false)).toBe(true);
  });

  it('sees the two calls as the same call although Claude worded the description differently each time', () => {
    const [a, b] = uses.map((u) => (u as unknown as { inputHash: string }).inputHash);
    expect(a).toBe(b);
    const raw = fixture.filter((l) => l.type === 'assistant').flatMap((l) => (l.message as { content: { input?: { description?: string } }[] }).content.map((c) => c.input?.description)).filter(Boolean);
    expect(new Set(raw).size).toBe(2); // the descriptions really did differ in the captured run
    expect(results[0]!.outputHash).toBe(results[1]!.outputHash);
  });

  it('would have been stopped on the third repeat of exactly this pattern', () => {
    const d = new LoopDetector(2); // the capture has two pairs
    const out = feed(d, events);
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(out.find(Boolean)).toMatch(/^no_progress: Bash was called 2 times in a row/);
  });

  it('ignores the final result and other lines, and the Antigravity stream carries no tool calls to compare', () => {
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    expect(parseAgyEvent({ event: 'step_update', step_update: { type: 'TOOL_CALL', name: 'x' } }).some((e) => e.kind === 'tool_use' && Boolean((e as { id?: string }).id))).toBe(false);
  });

  it('reads a tool result whose content is a list of text blocks the same as plain text', () => {
    const asText = parseClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'hello', is_error: false }] } });
    const asBlocks = parseClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'hello' }], is_error: false }] } });
    expect(asText).toEqual(asBlocks);
  });
});

describe('hashes', () => {
  it('do not depend on key order, and ignore only the prose description', () => {
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(stableHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(inputSignature({ command: 'npm test', description: 'Run the tests' })).toBe(inputSignature({ description: 'Run them again', command: 'npm test' }));
    expect(inputSignature({ command: 'npm test' })).not.toBe(inputSignature({ command: 'npm test -- --watch' }));
    expect(inputSignature({ file_path: 'a.ts', old_string: 'x' })).not.toBe(inputSignature({ file_path: 'a.ts', old_string: 'y' }));
    expect(inputSignature('plain')).toBe(stableHash('plain'));
  });
});

describe('LoopDetector', () => {
  it('trips on the third identical call with an identical result, and says so without quoting the call or its output', () => {
    const d = new LoopDetector();
    const out = feed(d, [use('1'), result('1'), use('2'), result('2'), use('3'), result('3')]);
    expect(out.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(out[5]).toMatch(/^no_progress: Bash was called 3 times in a row with the same input and the same result \(fingerprint [0-9a-f]{8}\); the run was stopped$/);
    expect(out[5]).not.toContain('npm test');
    expect(out[5]).not.toContain('FAIL');
  });

  it('does not trip when anything differs: another call, another input, another result', () => {
    const noTrip = (events: RunnerEvent[]) => expect(feed(new LoopDetector(), events).filter(Boolean)).toEqual([]);
    noTrip([use('1'), result('1'), use('2'), result('2'), use('3', 'Read', { file_path: 'a' }), result('3'), use('4'), result('4')]); // a different call breaks the streak
    noTrip([use('1'), result('1', 'a'), use('2'), result('2', 'b'), use('3'), result('3', 'c')]); // same call, progress in the output
    noTrip([use('1', 'Bash', { command: 'a' }), result('1'), use('2', 'Bash', { command: 'b' }), result('2'), use('3', 'Bash', { command: 'c' }), result('3')]);
    noTrip([use('1'), result('1', 'x', true), use('2'), result('2', 'x', false), use('3'), result('3', 'x', true)]); // an error and a success are not the same result
  });

  it('trips on a call that keeps failing the same way', () => {
    const out = feed(new LoopDetector(), [use('1'), result('1', 'boom', true), use('2'), result('2', 'boom', true), use('3'), result('3', 'boom', true)]);
    expect(out[5]).toMatch(/^no_progress:/);
  });

  it('pairs parallel calls with their results by id, whatever order the results arrive in', () => {
    const out = feed(new LoopDetector(2), [use('a'), use('b'), result('b'), result('a')]);
    expect(out.filter(Boolean)).toHaveLength(1); // both are the same call and result: a streak of 2
    const mixed = feed(new LoopDetector(3), [use('a', 'Bash', { command: '1' }), use('b', 'Bash', { command: '2' }), result('b'), result('a'), use('c', 'Bash', { command: '1' }), result('c')]);
    expect(mixed.filter(Boolean)).toEqual([]); // 2,1,1 is not three the same
  });

  it('ignores results it never saw the call for, text in between, and unknown events', () => {
    const d = new LoopDetector();
    expect(d.observe(result('ghost'))).toBeNull();
    const out = feed(d, [use('1'), result('1'), { kind: 'text', text: 'trying again' }, use('2'), result('2'), { kind: 'other', label: 'rate_limit_event' }, use('3'), result('3')]);
    expect(out[out.length - 1]).toMatch(/^no_progress:/); // chatter between the calls does not reset the streak
  });

  it('does not detect alternating loops (A, B, A, B...): documented, the per-task limit is the backstop', () => {
    const events: RunnerEvent[] = [];
    for (let i = 0; i < 8; i++) events.push(use(`u${i}`, 'Bash', { command: i % 2 ? 'b' : 'a' }), result(`u${i}`, i % 2 ? 'B' : 'A'));
    expect(feed(new LoopDetector(), events).filter(Boolean)).toEqual([]);
  });

  it('is off with a threshold below 2, and cannot see a stream with no ids (plain text, Antigravity)', () => {
    expect(feed(new LoopDetector(0), [use('1'), result('1'), use('2'), result('2'), use('3'), result('3')]).filter(Boolean)).toEqual([]);
    expect(feed(new LoopDetector(), [{ kind: 'tool_use', name: 'Bash' }, { kind: 'tool_use', name: 'Bash' }, { kind: 'tool_use', name: 'Bash' }]).filter(Boolean)).toEqual([]);
  });
});

describe('a real process that repeats itself', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'agentmesh-loop-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  const script = (repeats: number, then: 'hang' | 'finish') => {
    const file = join(dir, `agent-${repeats}-${then}.mjs`);
    writeFileSync(
      file,
      `const out = (o) => console.log(JSON.stringify(o));
for (let i = 0; i < ${repeats}; i++) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: { command: 'npm test', description: 'Run the tests ' + i } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'FAIL 1 test', is_error: false }] } });
}
${then === 'finish' ? "out({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });" : 'setInterval(() => {}, 1000); // waits to be killed'}
`,
    );
    return file;
  };
  const run = (file: string, loopThreshold?: number) =>
    startAgent({ command: { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent }, cwd: dir, timeoutMs: 20_000, ...(loopThreshold !== undefined ? { loopThreshold } : {}) });

  it('is killed on the third repeat, quickly, and reported as no_progress rather than as an ordinary stop', async () => {
    const started = Date.now();
    const r = await run(script(3, 'hang')).done;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r).toMatchObject({ ok: false, stopped: true, timedOut: false });
    expect(r.noProgress).toMatch(/^no_progress: Bash was called 3 times/);
    expect(r.failure).toBe(r.noProgress);
  });

  it('is left alone when it repeats only twice and then finishes', async () => {
    const r = await run(script(2, 'finish')).done;
    expect(r).toMatchObject({ ok: true, noProgress: null });
  });

  it('is left alone when protection is switched off', async () => {
    const r = await run(script(5, 'finish'), 0).done;
    expect(r).toMatchObject({ ok: true, noProgress: null });
  });

  it('never flags a plain-text tool that prints the same line again and again', async () => {
    const file = join(dir, 'text.mjs');
    writeFileSync(file, `for (let i = 0; i < 20; i++) console.log('working...');`);
    const r = await startAgent({ command: { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: () => [], textOutput: true }, cwd: dir }).done;
    expect(r).toMatchObject({ ok: true, noProgress: null });
  });

  describe('in the dispatcher', () => {
    let db: SqliteDatabase;
    let ids: IdentityService;
    beforeEach(() => {
      db = openDatabase(join(dir, 'mesh.db'));
      migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
      ids = new IdentityService(db);
      ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
      mkdirSync(join(dir, 'wt'));
      db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES ('T1', 'p', 'T1', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(join(dir, 'wt'));
    });
    afterEach(() => closeDatabase(db));

    it('records the run as FAILED with the reason first, does not back the platform off, and the task becomes "gave up" after three', async () => {
      const file = script(3, 'hang');
      const agent: DispatchableAgent = { agentId: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'CLAUDE.md', command: () => ({ platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse: parseClaudeEvent }) };
      let clock = new Date('2026-10-14T10:00:00Z');
      const d = new Dispatcher({ db, identity: ids, agents: [agent], repoRoot: dir, now: () => clock, runTimeoutMs: 20_000 });
      for (let i = 0; i < 3; i++) {
        expect(d.tick()).toHaveLength(1);
        for (let k = 0; k < 400 && d.isBusy('claude-1'); k++) await new Promise((r) => setTimeout(r, 50));
        clock = new Date(clock.getTime() + 11 * 60_000);
      }
      const rows = db.prepare('SELECT status, detail FROM dispatch_runs ORDER BY started_at').all() as { status: string; detail: string }[];
      expect(rows.map((r) => r.status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
      expect(rows[0]!.detail).toMatch(/^no_progress: Bash was called 3 times/);
      expect(db.prepare('SELECT count(*) AS n FROM platform_backoff').get()).toEqual({ n: 0 });
      expect(d.stuck().map((s) => [s.agentId, s.subject, s.tries, s.lastStatus])).toEqual([['claude-1', 'T1', 3, 'FAILED']]);
    }, 60_000);
  });
});
