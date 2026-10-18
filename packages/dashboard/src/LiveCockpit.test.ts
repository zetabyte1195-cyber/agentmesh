// The live view inside the whole cockpit: what is pushed shows on the agent's card, the Board and a run, without reloading everything.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import Home from './Home.svelte';
import Runs from './Runs.svelte';
import { agent, FakeSocket, fakeDaemon, snapshot, stubScrolling } from './testing';
import type { ActivityChange, ActivityEntry, Run } from './types';

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.sockets.length = 0;
  stubScrolling();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('WebSocket', FakeSocket);
});

const entry = (seq: number, text: string, o: Partial<ActivityEntry> = {}): ActivityEntry => ({ seq, at: '2026-10-18T10:00:00Z', kind: 'tool', text, ...o });
const change = (o: Partial<ActivityChange> = {}): ActivityChange => ({ runId: 'r1', agentId: 'claude-1', taskId: 'M1-1', running: true, entries: [entry(1, 'Edited src/a.ts')], ...o });
const push = (c: ActivityChange) => FakeSocket.sockets.at(-1)!.onmessage?.({ data: JSON.stringify({ type: 'ACTIVITY', payload: c }) });
const run = (o: Partial<Run> = {}): Run => ({ id: 'r1', agentId: 'claude-1', kind: 'TASK', subject: 'M1-1', subjectTitle: 'Form', status: 'SUCCEEDED', detail: null, startedAt: '2026-10-18 09:00:00', endedAt: '2026-10-18 09:05:00', seconds: 300, outcome: 'moved', inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null, ...o } as Run);
const task = (o: Record<string, unknown>) => ({ id: 'M1-1', title: 'Booking form', status: 'IN_PROGRESS', assigned_agent_id: 'claude-1', suggested_owner: null, phase_id: 'mission:M1', prerequisites: '[]', worktree_path: '/w/wt', acceptance_criteria: 'A form.', ...o });
const stateCalls = (d: ReturnType<typeof fakeDaemon>) => d.calls.filter((c) => c.path === '/api/state').length;

describe('an agent\'s card on Home', () => {
  const props = (live: Record<string, unknown>) => ({ connected: true, agents: [agent({ status: 'BUSY', currentTaskId: 'M1-1', doing: 'Building the form' })], tasks: [], missions: [], notices: [], questions: [], schedules: null, usage: [], runs: [], backoffs: [], paused: false, landing: true, live, onNavigate: vi.fn(), onStop: vi.fn(), onChanged: vi.fn() });

  it('shows the latest steps of the agent that is working', () => {
    render(Home, props({ 'claude-1': { runId: 'r1', taskId: 'M1-1', entries: [entry(1, 'Read src/form.ts'), entry(2, 'Edited src/form.ts')] } }) as never);
    const card = within(screen.getByRole('article', { name: 'Claude' }));
    expect(card.getByText('Edited src/form.ts')).toBeTruthy();
    expect(card.getByText('Working now')).toBeTruthy();
  });

  it('shows nothing of the kind for an agent that is not working', () => {
    render(Home, { ...props({}), agents: [agent()] } as never);
    expect(within(screen.getByRole('article', { name: 'Claude' })).queryByRole('log')).toBeNull();
  });

  it('shows an agent whose run is going as working, with a way to stop it, even before it has said anything about itself (a planning run has no status yet)', () => {
    render(Home, { ...props({ 'claude-1': { runId: 'r1', taskId: null, entries: [entry(1, 'AgentMesh: get mission')] } }), agents: [agent({ status: 'IDLE' })] } as never);
    const card = within(screen.getByRole('article', { name: 'Claude' }));
    expect(card.getByText('AgentMesh: get mission')).toBeTruthy();
    expect(card.getAllByText('Working').length).toBeGreaterThan(0);
    expect(card.getByRole('button', { name: /Stop this run/ })).toBeTruthy();
  });
});

describe('a run in the list of runs', () => {
  it('shows what it did, from what the page holds, with no request', async () => {
    const daemon = fakeDaemon({});
    render(Runs, { runs: [run()], byRun: { r1: [entry(1, 'Wrote src/a.ts'), entry(2, 'Finished', { kind: 'end' })] } });
    await fireEvent.click(screen.getByRole('button', { name: 'What it did' }));
    expect(screen.getByText('Wrote src/a.ts')).toBeTruthy();
    expect(daemon.calls).toHaveLength(0);
  });

  it('asks the daemon for a run the page did not watch, and says so when it is no longer kept', async () => {
    fakeDaemon({ '/api/activity': { runId: 'r1', kept: false, running: false, entries: [] } });
    render(Runs, { runs: [run()], byRun: {} });
    await fireEvent.click(screen.getByRole('button', { name: 'What it did' }));
    expect(await screen.findByText(/no longer kept/)).toBeTruthy();
  });

  it('shows a run that is going as going, and closes again', async () => {
    fakeDaemon({});
    render(Runs, { runs: [run({ status: 'RUNNING', endedAt: null, seconds: null, outcome: null })], byRun: { r1: [entry(1, 'Reading')] } });
    const button = screen.getByRole('button', { name: 'What it did' });
    await fireEvent.click(button);
    expect(screen.getByText('Working now')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Reading')).toBeNull();
  });
});

describe('the whole cockpit', () => {
  const start = async (snap: unknown) => {
    const daemon = fakeDaemon({ '/api/state': snap, '/api/templates': { builtIn: [], mine: [] }, '/api/changes': { taskId: 'M1-1', workspace: true, truncated: false, files: [{ path: 'src/a.ts', status: 'added', added: 3, removed: 0 }] }, '/api/activity': { runId: 'r1', kept: false, running: false, entries: [] } });
    render(App);
    await screen.findByRole('heading', { level: 1 });
    FakeSocket.sockets.at(-1)!.onopen?.();
    return daemon;
  };
  const working = () => snapshot({ agents: [agent({ status: 'BUSY', currentTaskId: 'M1-1', doing: 'Building' }), agent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY' })], tasks: [task({})], dispatch: { paused: false, backoffs: [], stuck: [], recentRuns: [run({ status: 'RUNNING', endedAt: null, seconds: null, outcome: null })] } });

  it('shows a step on the agent\'s card as it is pushed, without loading everything again', async () => {
    const daemon = await start(working());
    const before = stateCalls(daemon);
    push(change());
    expect(await screen.findByText('Edited src/a.ts')).toBeTruthy();
    push(change({ entries: [entry(2, 'Edited src/b.ts')] }));
    await screen.findByText('Edited src/b.ts');
    await new Promise((r) => setTimeout(r, 400));
    expect(stateCalls(daemon)).toBe(before); // steps are not a reason to reload the whole page
  });

  it('reloads once when the run is over, so the card and the board are exact', async () => {
    const daemon = await start(working());
    const before = stateCalls(daemon);
    push(change({ running: false, entries: [entry(9, 'Finished', { kind: 'end' })] }));
    await waitFor(() => expect(stateCalls(daemon)).toBe(before + 1));
  });

  it('puts the step on the task\'s card on the Board, and opens the task\'s panel with its files and feed', async () => {
    await start(working());
    push(change());
    await fireEvent.click(screen.getByRole('button', { name: /Board/ }));
    const col = within(await screen.findByRole('region', { name: 'Being built' }));
    expect(col.getByText('Edited src/a.ts')).toBeTruthy();
    await fireEvent.click(col.getByRole('button', { name: /^M1-1 / }));
    const panel = within(await screen.findByRole('complementary', { name: 'Task details' }));
    expect(await panel.findByText('src/a.ts')).toBeTruthy();
    expect(panel.getByRole('log', { name: 'What the agent is doing' }).textContent).toContain('Edited src/a.ts');
  });

  it('keeps showing what a run did after it is over, on its entry in Runs', async () => {
    await start(working());
    push(change());
    push(change({ running: false, entries: [entry(2, 'Finished', { kind: 'end' })] }));
    await fireEvent.click(screen.getByRole('button', { name: /Runs/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'What it did' }));
    expect(screen.getByText('Edited src/a.ts')).toBeTruthy();
    expect(screen.getByText('Finished')).toBeTruthy();
  });

  it('starts from what the daemon says each agent is doing, for a page opened in the middle of a run', async () => {
    await start({ ...working(), live: { 'claude-1': { runId: 'r1', taskId: 'M1-1', entries: [entry(4, 'Ran npm test')] } } });
    expect(await screen.findByText('Ran npm test')).toBeTruthy();
  });
});

describe('after the connection is lost', () => {
  const start = async (snap: unknown, extra: Record<string, unknown> = {}) => {
    const daemon = fakeDaemon({ '/api/state': snap, '/api/templates': { builtIn: [], mine: [] }, ...extra });
    render(App);
    await screen.findByRole('heading', { level: 1 });
    FakeSocket.sockets.at(-1)!.onopen?.();
    return daemon;
  };

  it('reads the page again before it reconnects, so what was missed is caught up', async () => {
    const daemon = await start(snapshot());
    await new Promise((r) => setTimeout(r, 400)); // the page has finished loading
    const sockets = FakeSocket.sockets.length;
    const before = stateCalls(daemon);
    FakeSocket.sockets.at(-1)!.onclose?.();
    await waitFor(() => expect(FakeSocket.sockets.length).toBe(sockets + 1), { timeout: 4000 });
    expect(stateCalls(daemon)).toBe(before + 1);
  });

  it('shows the sign-in screen, and stops reconnecting, when AgentMesh was restarted and the session ended with it', async () => {
    await start(snapshot());
    fakeDaemon({ '/api/state': { status: 401, body: { error: 'REVOKED_TOKEN' } } });
    const sockets = FakeSocket.sockets.length;
    FakeSocket.sockets.at(-1)!.onclose?.();
    expect(await screen.findByText(/one-time login link/, {}, { timeout: 4000 })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2500));
    expect(FakeSocket.sockets.length).toBe(sockets); // no new attempt at the live connection
  });
});
