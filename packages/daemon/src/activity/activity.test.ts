// The live feed of what an agent is doing: what the two tools' streams say, how that becomes entries a person can read,
// and what the log keeps.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type RunnerEvent, parseAgyEvent, parseClaudeEvent } from '../runner/events.js';
import { type ActivityChange, ActivityLog } from './index.js';

const agyFixture = readFileSync(join(__dirname, '..', 'runner', 'fixtures', 'agy-file-edit.jsonl'), 'utf8').trim().split('\n');
const agyEvents = (): RunnerEvent[] => agyFixture.flatMap((l) => parseAgyEvent(JSON.parse(l) as Record<string, unknown>));
const claudeUse = (name: string, input: unknown, id = 'toolu_1') => parseClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

describe('what Claude Code says it is touching', () => {
  it('names the file for a write, an edit and a read', () => {
    for (const [name, input] of [['Write', { file_path: 'src/a.ts', content: 'x' }], ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }], ['Read', { file_path: 'src/a.ts' }], ['NotebookEdit', { notebook_path: 'n.ipynb' }]] as const) {
      expect(claudeUse(name, input)[0], name).toMatchObject({ kind: 'tool_use', name, target: name === 'NotebookEdit' ? 'n.ipynb' : 'src/a.ts', targetKind: 'file' });
    }
  });

  it('shows a command and a search, clipped, and nothing for a tool that names neither', () => {
    expect(claudeUse('Bash', { command: 'npm test', description: 'run' })[0]).toMatchObject({ target: 'npm test', targetKind: 'command' });
    expect(claudeUse('Grep', { pattern: 'TODO' })[0]).toMatchObject({ target: 'TODO', targetKind: 'search' });
    const long = claudeUse('Bash', { command: 'x'.repeat(500) })[0] as { target: string };
    expect(long.target.length).toBeLessThanOrEqual(200);
    expect(long.target.endsWith('…')).toBe(true);
    const none = claudeUse('mcp__agentmesh__mesh_get_board', {})[0] as { target?: string };
    expect(none.target).toBeUndefined();
  });

  it('keeps the loop-protection fields exactly as before', () => {
    expect(claudeUse('Read', { file_path: 'a' }, 'toolu_9')[0]).toMatchObject({ id: 'toolu_9', inputHash: expect.any(String) });
  });
});

describe('sub-agents', () => {
  const asst = (content: unknown[], parent: string | null) => parseClaudeEvent({ type: 'assistant', parent_tool_use_id: parent, message: { content } });

  it('marks what a sub-agent does as the sub-agent\'s (Claude Code says so with the call that started it)', () => {
    expect(asst([{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.ts' } }], 'toolu_parent')[0]).toMatchObject({ kind: 'tool_use', sub: true });
    expect(asst([{ type: 'text', text: 'found it' }], 'toolu_parent')[0]).toEqual({ kind: 'text', text: 'found it', sub: true });
    expect(asst([{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'x.ts' } }], null)[0] as { sub?: boolean }).not.toHaveProperty('sub');
    expect(asst([{ type: 'text', text: 'hi' }], null)[0]).toEqual({ kind: 'text', text: 'hi' });
  });

  it('describes the call that starts one, with what it was asked to do', () => {
    const log = new ActivityLog({ now: () => new Date('2026-10-18T10:00:00Z') });
    log.begin('r1', { agentId: 'claude-1', taskId: null, cwd: '/w' });
    log.record('r1', { kind: 'tool_use', name: 'Agent', id: 'a', target: 'Read hello.html', targetKind: 'note' });
    log.record('r1', { kind: 'tool_use', name: 'Task', id: 'b' });
    expect(log.entries('r1')!.slice(1).map((e) => e.text)).toEqual(['Started a sub-agent: Read hello.html', 'Started a sub-agent']);
  });

  it('keeps a sub-agent\'s steps apart from the agent\'s own, in the feed and in what is joined or counted', () => {
    const log = new ActivityLog({ now: () => new Date('2026-10-18T10:00:00Z') });
    log.begin('r1', { agentId: 'claude-1', taskId: null, cwd: '/w' });
    log.record('r1', { kind: 'text', text: 'Main says ' });
    log.record('r1', { kind: 'text', text: 'one', sub: true });
    log.record('r1', { kind: 'tool_use', name: 'Read', id: 'u1', target: 'a.ts', targetKind: 'file' });
    log.record('r1', { kind: 'tool_use', name: 'Read', id: 'u2', target: 'a.ts', targetKind: 'file', sub: true });
    log.record('r1', { kind: 'tool_use', name: 'Read', id: 'u3', target: 'a.ts', targetKind: 'file', sub: true });
    expect(log.entries('r1')!.slice(1).map((e) => [e.text, e.sub ?? false, e.repeat ?? 1])).toEqual([
      ['Main says ', false, 1],
      ['one', true, 1],
      ['Read a.ts', false, 1],
      ['Read a.ts', true, 2],
    ]);
  });
});

describe('what Antigravity says it is touching (a real stream, recorded)', () => {
  it('turns each tool step into one event when it starts, with the file it names', () => {
    const uses = agyEvents().filter((e) => e.kind === 'tool_use');
    expect(uses).toEqual([
      { kind: 'tool_use', name: 'write_to_file', id: null, target: '/work\\hello.txt', targetKind: 'file' },
      { kind: 'tool_use', name: 'view_file', id: null, target: '/work\\a.txt', targetKind: 'file' },
    ]);
  });

  it('still reads its answer as text and its end as a result, and gives no loop-protection fields', () => {
    const events = agyEvents();
    expect(events.filter((e) => e.kind === 'text').length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ kind: 'result', ok: true });
    expect(events.filter((e) => e.kind === 'tool_use').every((e) => (e as { inputHash?: string }).inputHash === undefined)).toBe(true);
  });

  it('names a call to an AgentMesh tool the way Claude Code does (recorded from a real run: one generic tool, the real name in its parameters)', () => {
    const call = (parameters: Record<string, unknown>) => parseAgyEvent({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters } } })[0];
    expect(call({ Arguments: {}, ServerName: 'agentmesh', ToolName: 'mesh_list_playbooks' })).toEqual({ kind: 'tool_use', name: 'mcp__agentmesh__mesh_list_playbooks', id: null });
    expect(call({ ServerName: 'a b', ToolName: 'x' })).toMatchObject({ name: 'call_mcp_tool' }); // not a name it can trust: left as it came
    expect(call({ ServerName: 'agentmesh' })).toMatchObject({ name: 'call_mcp_tool' });
  });

  it('knows other tools by the parameter that names their target', () => {
    const step = (tool_name: string, parameters: Record<string, string>) => parseAgyEvent({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name, tool_info: { name: tool_name, parameters } } })[0];
    expect(step('run_command', { CommandLine: 'npm test' })).toMatchObject({ target: 'npm test', targetKind: 'command' });
    expect(step('grep_search', { Query: 'TODO' })).toMatchObject({ target: 'TODO', targetKind: 'search' });
    expect(step('list_dir', {})).toMatchObject({ kind: 'tool_use', name: 'list_dir' });
    expect(parseAgyEvent({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'x' } })[0]).toMatchObject({ kind: 'other' }); // reported when it starts, not twice
  });
});

describe('the log of a run', () => {
  const at = () => new Date('2026-10-18T10:00:00Z');
  const begin = (log: ActivityLog, runId = 'r1') => log.begin(runId, { agentId: 'claude-1', taskId: 'M1-1', cwd: '/work' });
  const use = (name: string, target?: string, targetKind?: 'file' | 'command' | 'search', id = 'u1'): RunnerEvent => ({ kind: 'tool_use', name, id, ...(target ? { target, targetKind } : {}) } as RunnerEvent);

  it('says what was written, edited, read, run and searched, with paths relative to the workspace', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    log.record('r1', use('Write', '/work/src/a.ts', 'file'));
    log.record('r1', use('Edit', '/work/src/b.ts', 'file', 'u2'));
    log.record('r1', use('Read', 'D:\\elsewhere\\c.ts', 'file', 'u3'));
    log.record('r1', use('Bash', 'npm test', 'command', 'u4'));
    log.record('r1', use('Grep', 'TODO', 'search', 'u5'));
    log.record('r1', use('write_to_file', '/work\\d.txt', 'file', 'u6'));
    log.record('r1', use('mcp__agentmesh__mesh_commit', undefined, undefined, 'u7'));
    log.record('r1', use('ToolSearch', 'select:mcp__agentmesh__mesh_get_board', 'search', 'u8'));
    log.record('r1', use('mcp__github__create_issue', undefined, undefined, 'u9'));
    expect(log.entries('r1')!.map((e) => [e.kind, e.text, e.path ?? null])).toEqual([
      ['start', 'Started', null],
      ['tool', 'Wrote src/a.ts', 'src/a.ts'],
      ['tool', 'Edited src/b.ts', 'src/b.ts'],
      ['tool', 'Read D:/elsewhere/c.ts', 'D:/elsewhere/c.ts'],
      ['tool', 'Ran npm test', null],
      ['tool', 'Searched for TODO', null],
      ['tool', 'Wrote d.txt', 'd.txt'],
      ['tool', 'AgentMesh: commit', null],
      ['tool', 'Looked up its tools', null],
      ['tool', 'Used github: create_issue', null],
    ]);
  });

  it('shows the same step several times in a row as one line with a count, and a different step in between starts a new line', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    for (let i = 0; i < 3; i++) log.record('r1', use('ToolSearch', 'x', 'search', `u${i}`));
    log.record('r1', use('Read', 'a.ts', 'file', 'ua'));
    log.record('r1', use('ToolSearch', 'x', 'search', 'ub'));
    const tools = log.entries('r1')!.filter((e) => e.kind === 'tool');
    expect(tools.map((e) => [e.text, e.repeat ?? 1])).toEqual([['Looked up its tools', 3], ['Read a.ts', 1], ['Looked up its tools', 1]]);
  });

  it('does not hide a failure inside a count: a step that failed stays its own line', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    log.record('r1', use('Bash', 'npm test', 'command', 'u1'));
    log.record('r1', { kind: 'tool_result', id: 'u1', isError: true, outputHash: 'h' });
    log.record('r1', use('Bash', 'npm test', 'command', 'u2'));
    const tools = log.entries('r1')!.filter((e) => e.kind === 'tool');
    expect(tools.map((e) => [e.failed ?? false, e.repeat ?? 1])).toEqual([[true, 1], [false, 1]]);
  });

  it('joins the pieces of one answer into one line, and starts a new one after a tool call', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    for (const t of ['Created hello.txt', ' with `hello`.']) log.record('r1', { kind: 'text', text: t });
    log.record('r1', use('Read', 'a', 'file'));
    log.record('r1', { kind: 'text', text: 'Done.' });
    expect(log.entries('r1')!.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['Created hello.txt with `hello`.', 'Done.']);
  });

  it('says which model the tool really started on, when it says so', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    log.record('r1', { kind: 'init', sessionId: 's', model: 'claude-haiku-4-5' });
    expect(log.entries('r1')![0]!.text).toBe('Started (model claude-haiku-4-5)');
    const none = new ActivityLog({ now: at });
    begin(none);
    none.record('r1', { kind: 'init', sessionId: 's', model: null });
    expect(none.entries('r1')![0]!.text).toBe('Started');
  });

  it('keeps a long answer short', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    log.record('r1', { kind: 'text', text: 'y'.repeat(5000) });
    expect(log.entries('r1')!.find((e) => e.kind === 'text')!.text.length).toBeLessThanOrEqual(600);
  });

  it('marks a tool call that failed, and says how the run ended', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    log.record('r1', use('Bash', 'npm test', 'command', 'u9'));
    log.record('r1', { kind: 'tool_result', id: 'u9', isError: true, outputHash: 'h' });
    log.end('r1', 'FAILED');
    const e = log.entries('r1')!;
    expect(e.find((x) => x.kind === 'tool')!.failed).toBe(true);
    expect(e.at(-1)).toMatchObject({ kind: 'end', text: 'Failed', failed: true });
    expect(log.isRunning('r1')).toBe(false);
  });

  it('numbers the entries and can give only the ones after a number', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    log.record('r1', use('Read', 'a', 'file'));
    log.record('r1', use('Read', 'b', 'file', 'u2'));
    expect(log.entries('r1')!.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.entries('r1', 2)!.map((e) => e.seq)).toEqual([3]);
  });

  it('keeps at most so many entries of a run, dropping the oldest', () => {
    const log = new ActivityLog({ now: at, maxEntries: 5 });
    begin(log);
    for (let i = 0; i < 20; i++) log.record('r1', use('Read', `f${i}`, 'file', `u${i}`));
    const e = log.entries('r1')!;
    expect(e).toHaveLength(5);
    expect(e.at(-1)!.text).toBe('Read f19');
    expect(e[0]!.seq).toBeGreaterThan(1);
  });

  it('keeps at most so many runs, forgetting the oldest that have finished and never one still going', () => {
    const log = new ActivityLog({ now: at, maxRuns: 3 });
    begin(log, 'running-one');
    for (const id of ['a', 'b', 'c', 'd']) {
      begin(log, id);
      log.end(id, 'SUCCEEDED');
    }
    expect(log.entries('running-one')).not.toBeNull();
    expect(log.entries('a')).toBeNull();
    expect(log.entries('d')).not.toBeNull();
  });

  it('says what each agent that is working is doing right now, the latest few entries', () => {
    const log = new ActivityLog({ now: at });
    begin(log);
    for (let i = 0; i < 10; i++) log.record('r1', use('Read', `f${i}`, 'file', `u${i}`));
    log.begin('r2', { agentId: 'gemini-1', taskId: null, cwd: '/w' });
    log.end('r2', 'SUCCEEDED');
    const live = log.live(4);
    expect(Object.keys(live)).toEqual(['claude-1']); // r2 is over
    expect(live['claude-1']!.runId).toBe('r1');
    expect(live['claude-1']!.entries.map((e) => e.text)).toEqual(['Read f6', 'Read f7', 'Read f8', 'Read f9']);
  });

  it('knows nothing of a run it was not told about, and ignores its events', () => {
    const log = new ActivityLog({ now: at });
    log.record('ghost', { kind: 'text', text: 'x' });
    expect(log.entries('ghost')).toBeNull();
  });
});

describe('telling the cockpit', () => {
  it('sends what changed once in a short while, not once per event', () => {
    vi.useFakeTimers();
    try {
      const sent: ActivityChange[] = [];
      const log = new ActivityLog({ now: () => new Date('2026-10-18T10:00:00Z'), flushMs: 200, onChange: (c) => sent.push(c) });
      log.begin('r1', { agentId: 'claude-1', taskId: 'M1-1', cwd: '/w' });
      for (let i = 0; i < 50; i++) log.record('r1', { kind: 'text', text: 'a' });
      log.record('r1', { kind: 'tool_use', name: 'Read', id: 'u', target: 'a', targetKind: 'file' } as RunnerEvent);
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(250);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ runId: 'r1', agentId: 'claude-1', taskId: 'M1-1' });
      expect(sent[0]!.entries.map((e) => e.kind)).toEqual(['start', 'text', 'tool']);
      log.record('r1', { kind: 'text', text: 'b' });
      vi.advanceTimersByTime(250);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.entries.map((e) => e.text)).toEqual(['b']); // only what is new or changed
      vi.advanceTimersByTime(1000);
      expect(sent).toHaveLength(2); // and nothing when nothing happened
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the end of a run at once, so a card does not say "working" after the work is over', () => {
    const sent: ActivityChange[] = [];
    const log = new ActivityLog({ flushMs: 60_000, onChange: (c) => sent.push(c) });
    log.begin('r1', { agentId: 'claude-1', taskId: null, cwd: '/w' });
    log.end('r1', 'SUCCEEDED');
    expect(sent.at(-1)).toMatchObject({ running: false });
    expect(sent.at(-1)!.entries.at(-1)).toMatchObject({ kind: 'end', text: 'Finished' });
  });
});
