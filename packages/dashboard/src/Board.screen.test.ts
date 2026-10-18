import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Board from './Board.svelte';
import { agent, fakeDaemon } from './testing';
import type { BoardTask, LiveRun, Run } from './types';

afterEach(() => vi.unstubAllGlobals());

const task = (o: Partial<BoardTask> & { id: string }): BoardTask => ({ title: `Task ${o.id}`, status: 'TODO', assigned_agent_id: null, suggested_owner: null, phase_id: 'mission:M1', prerequisites: '[]', worktree_path: null, acceptance_criteria: 'It works.', ...o });
const run = (o: Partial<Run> = {}): Run => ({ id: 'r1', agentId: 'claude-1', kind: 'TASK', subject: 'M1-1', subjectTitle: 'x', status: 'SUCCEEDED', detail: null, startedAt: '2026-10-18 09:00:00', endedAt: '2026-10-18 09:05:00', seconds: 300, outcome: 'moved', inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null, ...o } as Run);

function props(o: Record<string, unknown> = {}) {
  return {
    tasks: [] as BoardTask[],
    agents: [agent(), agent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY' })],
    leases: [] as { id: string; taskId: string; agentId: string; path: string; type: string }[],
    live: {} as Record<string, LiveRun>,
    byRun: {},
    runs: [] as Run[],
    onReleaseLocks: vi.fn(),
    ...o,
  };
}
const column = (name: string) => screen.getByRole('region', { name });
const tasks = [
  task({ id: 'M1-1', title: 'Booking form', status: 'IN_PROGRESS', assigned_agent_id: 'claude-1', worktree_path: '/w/wt-M1-1', acceptance_criteria: 'A form with name and time.' }),
  task({ id: 'M1-2', title: 'Slot logic', status: 'TODO', suggested_owner: 'gemini-1', prerequisites: '["M1-1","M1-0"]' }),
  task({ id: 'M2-1', title: 'Landing page', status: 'COMMITTED', phase_id: 'mission:M2', assigned_agent_id: 'gemini-1' }),
  task({ id: 'M1-3', title: 'Tests', status: 'REJECTED', assigned_agent_id: 'gemini-1' }),
];

describe('the board', () => {
  it('shows every stage even when it is empty, so the board keeps its shape', () => {
    render(Board, props());
    for (const name of ['Waiting', 'Being built', 'In review', 'Passed', 'Needs attention', 'Merged']) expect(within(column(name)).getByText('0')).toBeTruthy();
    expect(screen.getByText('No tasks yet. They appear when you approve a mission\'s plan.')).toBeTruthy();
  });

  it('puts each task in its stage, with its mission, owner and what it waits for', () => {
    render(Board, props({ tasks }));
    expect(within(column('Being built')).getByText('Booking form')).toBeTruthy();
    const waiting = within(column('Waiting'));
    expect(waiting.getByText('Slot logic')).toBeTruthy();
    expect(waiting.getByText('Blocked by M1-1, M1-0')).toBeTruthy(); // M1-1 is not merged; M1-0 is not on the board
    expect(waiting.getByText(/gemini-1/)).toBeTruthy();
    expect(within(column('Merged')).getByText('Landing page')).toBeTruthy();
    expect(within(column('Needs attention')).getByText('Tests')).toBeTruthy();
    expect(within(column('Being built')).getByText('M1')).toBeTruthy();
  });

  it('shows, on the card, what the agent working on it is doing right now', () => {
    const live = { 'claude-1': { runId: 'r1', taskId: 'M1-1', entries: [{ seq: 1, at: '2026-10-18T10:00:00Z', kind: 'tool' as const, text: 'Edited src/form.ts' }] } };
    render(Board, props({ tasks, live }));
    const card = within(column('Being built'));
    expect(card.getByText('Working now')).toBeTruthy();
    expect(card.getByText('Edited src/form.ts')).toBeTruthy();
  });

  it('filters by mission, by agent and by words, and can leave out what has merged', async () => {
    render(Board, props({ tasks }));
    await fireEvent.change(screen.getByLabelText('Mission'), { target: { value: 'M2' } });
    expect(screen.queryByText('Booking form')).toBeNull();
    expect(screen.getByText('Landing page')).toBeTruthy();
    await fireEvent.change(screen.getByLabelText('Mission'), { target: { value: 'all' } });
    await fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'claude-1' } });
    expect(screen.getByText('Booking form')).toBeTruthy();
    expect(screen.queryByText('Slot logic')).toBeNull();
    await fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'all' } });
    await fireEvent.input(screen.getByLabelText('Find a task'), { target: { value: 'slot' } });
    expect(screen.getByText('Slot logic')).toBeTruthy();
    expect(screen.queryByText('Booking form')).toBeNull();
    await fireEvent.input(screen.getByLabelText('Find a task'), { target: { value: '' } });
    await fireEvent.click(screen.getByLabelText('Hide merged'));
    expect(screen.queryByText('Landing page')).toBeNull();
    expect(within(column('Merged')).getByText('0')).toBeTruthy();
  });

  it('says when the filters leave nothing, and how to get everything back', async () => {
    render(Board, props({ tasks }));
    await fireEvent.input(screen.getByLabelText('Find a task'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No task matches. Clear the filters to see all 4.')).toBeTruthy();
  });
});

describe('a task opened from the board', () => {
  const open = async (id: string, p = props({ tasks })) => {
    const view = render(Board, p);
    await fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + id + ' ') }));
    return { view, panel: await screen.findByRole('complementary', { name: 'Task details' }) };
  };

  it('shows what it should do, who has it, what it waits for, and the files it changed', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [{ path: 'src/form.ts', status: 'added', added: 20, removed: 0 }] }, '/api/activity': { runId: 'r1', kept: false, running: false, entries: [] } });
    const { panel } = await open('M1-1');
    const p = within(panel);
    expect(p.getByRole('heading', { name: /Booking form/ })).toBeTruthy();
    expect(p.getByText('A form with name and time.')).toBeTruthy();
    expect(p.getByText('Being built')).toBeTruthy();
    expect(await p.findByText('src/form.ts')).toBeTruthy();
  });

  it('shows the feed of the run that is going, as it comes', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [] } });
    const live = { 'claude-1': { runId: 'r5', taskId: 'M1-1', entries: [] } };
    const byRun = { r5: [{ seq: 1, at: '2026-10-18T10:00:00Z', kind: 'tool' as const, text: 'Wrote src/form.ts' }] };
    const { panel } = await open('M1-1', props({ tasks, live, byRun }));
    expect(within(panel).getByRole('log', { name: 'What the agent is doing' }).textContent).toContain('Wrote src/form.ts');
    expect(within(panel).getByText('Working now')).toBeTruthy();
  });

  it('shows the feed of the last run on it when nobody is working on it now', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [] }, '/api/activity': { runId: 'r1', kept: true, running: false, entries: [{ seq: 1, at: '2026-10-18T10:00:00Z', kind: 'tool', text: 'Read old.ts' }] } });
    const { panel } = await open('M1-1', props({ tasks, runs: [run({ id: 'r0', startedAt: '2026-10-17 09:00:00' }), run({ id: 'r1' })] }));
    expect(await within(panel).findByText('Read old.ts')).toBeTruthy();
    expect(within(panel).getByText(/Last run/)).toBeTruthy();
  });

  it('lists the locks it holds and releases them on request', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: false, truncated: false, files: [] } });
    const onReleaseLocks = vi.fn();
    const leases = [{ id: 'l1', taskId: 'M1-1', agentId: 'claude-1', path: 'src/form.ts', type: 'FILE' }];
    const { panel } = await open('M1-1', props({ tasks, leases, onReleaseLocks }));
    expect(within(panel).getByText('src/form.ts')).toBeTruthy();
    await fireEvent.click(within(panel).getByRole('button', { name: 'Release the locks' }));
    expect(onReleaseLocks).toHaveBeenCalledWith('M1-1');
  });

  it('opens the workspace in the editor, and says if that did not work', async () => {
    const daemon = fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [] }, '/api/workspace/open': { status: 409, body: { error: 'VS Code (the "code" command) was not found.' } } });
    const { panel } = await open('M1-1');
    await fireEvent.click(within(panel).getByRole('button', { name: 'Open in editor' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain('was not found');
    expect(daemon.posts('/api/workspace/open')[0]!.body).toEqual({ taskId: 'M1-1' });
  });

  it('reminds the person, before they click, that what is in the folder was written by an agent and has not been reviewed', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [] } });
    const { panel } = await open('M1-1');
    expect(within(panel).getByText(/written by an agent and not reviewed/)).toBeTruthy();
  });

  it('asks first when the folder has editor settings the agent wrote, and opens it only on a yes', async () => {
    const daemon = fakeDaemon({
      '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [] },
      '/api/workspace/open': (body: unknown) => ((body as { confirm?: boolean }).confirm ? { ok: true, editor: 'code' } : { ok: false, needsConfirm: true, found: ['.vscode'], message: 'This folder has editor settings the agent wrote (.vscode).' }),
    });
    const { panel } = await open('M1-1');
    await fireEvent.click(within(panel).getByRole('button', { name: 'Open in editor' }));
    expect(await within(panel).findByText(/editor settings the agent wrote/)).toBeTruthy();
    expect(daemon.posts('/api/workspace/open')).toHaveLength(1);
    await fireEvent.click(within(panel).getByRole('button', { name: 'Open anyway' }));
    await waitFor(() => expect(daemon.posts('/api/workspace/open')).toHaveLength(2));
    expect(daemon.posts('/api/workspace/open')[1]!.body).toEqual({ taskId: 'M1-1', confirm: true });
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Open anyway' })).toBeNull());
  });

  it('cannot open a workspace that does not exist yet', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-2', workspace: false, truncated: false, files: [] } });
    const { panel } = await open('M1-2');
    expect((within(panel).getByRole('button', { name: 'Open in editor' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says a merged task\'s files are on the main branch, and does not look for a workspace that was removed', async () => {
    const daemon = fakeDaemon({});
    const { panel } = await open('M2-1');
    expect(within(panel).getByText(/merged: its files are on your main branch/)).toBeTruthy();
    expect(daemon.calls.filter((c) => c.path === '/api/changes')).toHaveLength(0);
  });

  it('closes when a click lands outside it', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: false, truncated: false, files: [] } });
    await open('M1-1');
    await fireEvent.click(screen.getByRole('button', { name: 'Close the task details' }));
    expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull();
  });

  it('takes the keyboard focus when it opens, so it can be read and closed without a mouse', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: false, truncated: false, files: [] } });
    const { panel } = await open('M1-1');
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it('closes with the button or the Escape key', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: false, truncated: false, files: [] } });
    const { panel } = await open('M1-1');
    await fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /^M1-1 / }));
    await screen.findByRole('complementary', { name: 'Task details' });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull());
  });

  it('is not left open on a task that is gone', async () => {
    fakeDaemon({ '/api/changes': { taskId: 'M1-1', workspace: false, truncated: false, files: [] } });
    const { view } = await open('M1-1');
    await view.rerender(props({ tasks: tasks.slice(1) }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull());
  });
});
