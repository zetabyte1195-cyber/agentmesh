import { describe, expect, it } from 'vitest';
import { applyChange, mergeEntries } from './activity';
import { COLUMNS, blockedBy, filterTasks, groupTasks, missionOf, prerequisitesOf, statusLabel } from './board';
import type { ActivityEntry, BoardTask } from './types';

const task = (o: Partial<BoardTask> & { id: string }): BoardTask => ({ title: `Task ${o.id}`, status: 'TODO', assigned_agent_id: null, suggested_owner: null, phase_id: 'mission:M1', prerequisites: '[]', worktree_path: null, ...o });

describe('which mission a task belongs to, and what it waits for', () => {
  it('reads the mission from the phase, and nothing for a task that belongs to none', () => {
    expect(missionOf(task({ id: 'a', phase_id: 'mission:M12' }))).toBe('M12');
    expect(missionOf(task({ id: 'a', phase_id: 'p1' }))).toBeNull();
    expect(missionOf(task({ id: 'a', phase_id: null }))).toBeNull();
  });

  it('reads the prerequisites, whatever state the text is in', () => {
    expect(prerequisitesOf(task({ id: 'a', prerequisites: '["x","y"]' }))).toEqual(['x', 'y']);
    for (const bad of ['', 'not json', '{"a":1}', 'null', '[1,2]']) expect(prerequisitesOf(task({ id: 'a', prerequisites: bad })), bad).toEqual([]);
  });

  it('says a task is blocked by the prerequisites that have not landed (merged), by name', () => {
    const all = [task({ id: 'A', status: 'PASSED' }), task({ id: 'B', status: 'COMMITTED' }), task({ id: 'C', prerequisites: '["A","B","Z"]' })];
    expect(blockedBy(all[2]!, all)).toEqual(['A', 'Z']); // A passed but did not merge; Z is not on the board at all
    expect(blockedBy(all[1]!, all)).toEqual([]);
  });
});

describe('the columns', () => {
  it('always show every stage, in the order work moves through them, so the board does not rearrange itself', () => {
    expect(groupTasks([]).map((c) => c.column.id)).toEqual(['waiting', 'building', 'review', 'ready', 'attention', 'merged']);
    expect(COLUMNS.flatMap((c) => c.statuses).sort()).toEqual(['AUDITING', 'BLOCKED', 'COMMITTED', 'IN_PROGRESS', 'PASSED', 'READY_FOR_REVIEW', 'REJECTED', 'TODO']);
  });

  it('puts each task where its status says, and a status nobody knows under "needs attention" rather than losing it', () => {
    const g = groupTasks([task({ id: 'a', status: 'IN_PROGRESS' }), task({ id: 'b', status: 'AUDITING' }), task({ id: 'c', status: 'READY_FOR_REVIEW' }), task({ id: 'd', status: 'FROZEN' }), task({ id: 'e', status: 'REJECTED' })]);
    const ids = Object.fromEntries(g.map((c) => [c.column.id, c.tasks.map((t) => t.id)]));
    expect(ids).toMatchObject({ building: ['a'], review: ['b', 'c'], attention: ['d', 'e'] });
  });

  it('say statuses in words', () => {
    expect(statusLabel('READY_FOR_REVIEW')).toBe('Waiting for review');
    expect(statusLabel('COMMITTED')).toBe('Merged');
    expect(statusLabel('SOMETHING_NEW')).toBe('Something new');
  });
});

describe('filtering', () => {
  const tasks = [
    task({ id: 'M1-1', title: 'Booking form', phase_id: 'mission:M1', assigned_agent_id: 'claude-1', status: 'IN_PROGRESS' }),
    task({ id: 'M1-2', title: 'Slot logic', phase_id: 'mission:M1', suggested_owner: 'gemini-1' }),
    task({ id: 'M2-1', title: 'Landing page', phase_id: 'mission:M2', assigned_agent_id: 'gemini-1', status: 'COMMITTED' }),
  ];
  const all = { mission: 'all', agent: 'all', text: '', hideMerged: false };

  it('by mission, by agent (owner, or suggested owner while nobody owns it), and by words in the id or title', () => {
    expect(filterTasks(tasks, { ...all, mission: 'M2' }).map((t) => t.id)).toEqual(['M2-1']);
    expect(filterTasks(tasks, { ...all, agent: 'gemini-1' }).map((t) => t.id)).toEqual(['M1-2', 'M2-1']);
    expect(filterTasks(tasks, { ...all, text: 'SLOT' }).map((t) => t.id)).toEqual(['M1-2']);
    expect(filterTasks(tasks, { ...all, text: 'm2-1' }).map((t) => t.id)).toEqual(['M2-1']);
    expect(filterTasks(tasks, { ...all, text: '  ' })).toHaveLength(3);
  });

  it('can leave out what has merged, and all of them combine', () => {
    expect(filterTasks(tasks, { ...all, hideMerged: true }).map((t) => t.id)).toEqual(['M1-1', 'M1-2']);
    expect(filterTasks(tasks, { mission: 'M1', agent: 'gemini-1', text: 'slot', hideMerged: true }).map((t) => t.id)).toEqual(['M1-2']);
  });
});

describe('merging the live feed', () => {
  const e = (seq: number, text = `e${seq}`): ActivityEntry => ({ seq, at: '2026-10-18T10:00:00Z', kind: 'tool', text });

  it('adds new entries, replaces one that was extended, keeps the order, and keeps a bounded number', () => {
    expect(mergeEntries([e(1), e(2, 'a')], [e(2, 'a b'), e(3)]).map((x) => [x.seq, x.text])).toEqual([[1, 'e1'], [2, 'a b'], [3, 'e3']]);
    expect(mergeEntries([], [e(3), e(1), e(2)]).map((x) => x.seq)).toEqual([1, 2, 3]);
    const many = mergeEntries([], Array.from({ length: 50 }, (_, i) => e(i + 1)), 10);
    expect(many).toHaveLength(10);
    expect(many[0]!.seq).toBe(41);
  });

  it('keeps the agent\'s current run while it works, and drops it when the run is over', () => {
    const start = applyChange({ live: {}, byRun: {} }, { runId: 'r1', agentId: 'claude-1', taskId: 'T1', running: true, entries: [e(1), e(2)] });
    expect(start.live['claude-1']).toMatchObject({ runId: 'r1', taskId: 'T1' });
    expect(start.live['claude-1']!.entries.map((x) => x.seq)).toEqual([1, 2]);
    const more = applyChange(start, { runId: 'r1', agentId: 'claude-1', taskId: 'T1', running: true, entries: [e(3)] });
    expect(more.byRun['r1']!.map((x) => x.seq)).toEqual([1, 2, 3]);
    const over = applyChange(more, { runId: 'r1', agentId: 'claude-1', taskId: 'T1', running: false, entries: [{ ...e(4), kind: 'end', text: 'Finished' }] });
    expect(over.live['claude-1']).toBeUndefined();
    expect(over.byRun['r1']!.at(-1)!.text).toBe('Finished'); // the feed of a finished run is still readable
  });

  it('does not let a late message about an old run remove the agent\'s newer one', () => {
    const state = applyChange({ live: {}, byRun: {} }, { runId: 'r2', agentId: 'claude-1', taskId: null, running: true, entries: [e(1)] });
    const after = applyChange(state, { runId: 'r1', agentId: 'claude-1', taskId: null, running: false, entries: [e(9)] });
    expect(after.live['claude-1']).toMatchObject({ runId: 'r2' });
  });

  it('shows only the latest few entries on an agent\'s card', () => {
    const s = applyChange({ live: {}, byRun: {} }, { runId: 'r1', agentId: 'a', taskId: null, running: true, entries: Array.from({ length: 20 }, (_, i) => e(i + 1)) });
    expect(s.live['a']!.entries.map((x) => x.seq)).toEqual([15, 16, 17, 18, 19, 20]);
  });
});
