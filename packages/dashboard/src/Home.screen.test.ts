import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from './Home.svelte';
import { agent, fakeDaemon, mission } from './testing';
import type { Notice, Run } from './types';

afterEach(() => vi.unstubAllGlobals());

const run = (o: Partial<Run> = {}): Run => ({ id: 'r1', agentId: 'claude-1', kind: 'TASK', subject: 'M0-1', subjectTitle: 'Page layout', status: 'SUCCEEDED', detail: null, startedAt: '2026-10-15 09:00:00', endedAt: '2026-10-15 09:05:00', seconds: 300, inputTokens: null, outputTokens: null, costUsd: null, outcome: null, ...o });

function props(o: Record<string, unknown> = {}) {
  return {
    connected: true,
    agents: [agent(), agent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY' })],
    tasks: [],
    missions: [],
    notices: [],
    questions: [],
    schedules: null,
    usage: [],
    runs: [],
    backoffs: [],
    paused: false,
    landing: true,
    onNavigate: vi.fn(),
    onStop: vi.fn(),
    onChanged: vi.fn(),
    ...o,
  };
}

describe('the headline', () => {
  it('says the cockpit is reconnecting when the live connection is gone', () => {
    render(Home, props({ connected: false }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Reconnecting to AgentMesh');
  });

  it('counts the things that need the person', () => {
    const notices: Notice[] = [
      { key: 'a', kind: 'plan', urgent: true, title: 'Plan ready: A', text: 'x', missionId: 'M1' },
      { key: 'b', kind: 'question', urgent: true, title: 'gemini-1 has a question', text: 'q?', questionId: 'q1' },
    ];
    render(Home, props({ notices, questions: [{ id: 'q1', text: 'q?' }] }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Two things need you');
    expect(within(screen.getByRole('region', { name: 'Needs you' })).getAllByRole('article')).toHaveLength(2);
  });
});

describe('an agent at work', () => {
  const working = agent({ status: 'BUSY', currentTaskId: 'M0-2', doing: 'Writing the booking form' });

  it('shows what it is doing and lets the person stop that run', async () => {
    const onStop = vi.fn();
    render(Home, props({ agents: [working], onStop }));
    const card = screen.getByRole('article', { name: 'Claude' });
    expect(within(card).getByText('Working')).toBeTruthy();
    expect(within(card).getByText('Writing the booking form')).toBeTruthy();
    expect(within(card).getByText('M0-2')).toBeTruthy();
    await fireEvent.click(within(card).getByRole('button', { name: /Stop this run/ }));
    expect(onStop).toHaveBeenCalledWith('claude-1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('The agents are working');
  });

  it('an idle agent has no Stop button', () => {
    render(Home, props({ agents: [agent()] }));
    expect(screen.queryByRole('button', { name: /Stop this run/ })).toBeNull();
    expect(within(screen.getByRole('article', { name: 'Claude' })).getByText('Waiting for work')).toBeTruthy();
  });

  it('when work is paused, an idle agent says Paused and a running one still says Working, and can be stopped', () => {
    render(Home, props({ agents: [working, agent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY' })], paused: true }));
    expect(within(screen.getByRole('article', { name: 'Claude' })).getByText('Working')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Gemini' })).getByText('Paused')).toBeTruthy();
    expect(screen.getByText(/Work is paused/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop this run/ })).toBeTruthy();
  });
});

describe('a platform that ran out of quota', () => {
  it('says who is unavailable, until when, and why', () => {
    render(Home, props({ backoffs: [{ platform: 'ANTIGRAVITY', until: '2026-10-15T12:30:00.000Z', reason: 'Individual quota reached.' }] }));
    const banner = screen.getByText(/is unavailable until/).closest('p')!;
    expect(banner.textContent).toContain('ANTIGRAVITY');
    expect(banner.textContent).toContain('Individual quota reached.');
  });

  it('the agents on that platform say so on their own cards, and the others do not', () => {
    render(Home, props({ backoffs: [{ platform: 'ANTIGRAVITY', until: '2026-10-15T12:30:00.000Z', reason: 'Individual quota reached.' }] }));
    const gemini = within(screen.getByRole('article', { name: 'Gemini' }));
    expect(gemini.getByText('Unavailable')).toBeTruthy();
    expect(gemini.getByText(/Unavailable until/)).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Claude' })).getByText('Idle')).toBeTruthy();
  });
});

describe('the tiles lead to the screen that owns them', () => {
  it('tasks, spend and schedules', async () => {
    const onNavigate = vi.fn();
    render(Home, props({ onNavigate, tasks: [{ status: 'COMMITTED' }, { status: 'IN_PROGRESS' }] }));
    expect(screen.getByText('1 of 2 merged')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /Tasks/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Used so far/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Next scheduled mission/ }));
    expect(onNavigate.mock.calls.map((c) => c[0])).toEqual(['board', 'runs', 'schedules']);
  });

  it('adds up what the agents reported using', () => {
    const usage = [
      { agentId: 'claude-1', runs: 2, unreported: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, costUsd: 1.5 },
      { agentId: 'gemini-1', runs: 3, unreported: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null },
    ];
    render(Home, props({ usage }));
    expect(screen.getByText('$1.50')).toBeTruthy();
    expect(screen.getByText(/3 reported nothing/)).toBeTruthy();
  });

  it('shows input read from the cache apart from the tokens, as a limit on a mission counts them', () => {
    const usage = [{ agentId: 'claude-1', runs: 2, unreported: 0, inputTokens: 60_000, outputTokens: 5_000, cacheReadTokens: 3_700_000, costUsd: null }];
    render(Home, props({ usage }));
    const tiles = within(screen.getByRole('region', { name: 'At a glance' }));
    expect(tiles.getByText('65k tokens')).toBeTruthy();
    expect(tiles.getByText(/3\.7M read from cache/)).toBeTruthy();
    // the agent's own card says the same thing in the same words
    expect(within(screen.getByRole('article', { name: 'Claude' })).getByText(/60\.0k in \/ 5\.0k out · 3\.7M read from cache/)).toBeTruthy();
  });
});

describe('missions and runs', () => {
  it('lists missions in progress with who they wait on, in plain words ("you", not "human")', () => {
    render(Home, props({ missions: [mission()] }));
    const region = screen.getByRole('region', { name: 'Missions in progress' });
    expect(within(region).getByText('Car wash booking')).toBeTruthy();
    expect(within(region).getByText('Waiting on you')).toBeTruthy();
  });

  it('flags a run that finished without moving its task', () => {
    render(Home, props({ runs: [run({ outcome: 'no-change' })] }));
    expect(within(screen.getByRole('region', { name: 'Recent runs' })).getByText('nothing changed')).toBeTruthy();
  });
});

describe('the first steps', () => {
  it('guide a new project: connect an agent, say how it is checked, start a mission', async () => {
    const onNavigate = vi.fn();
    render(Home, props({ agents: [], landing: false, onNavigate }));
    const list = within(screen.getByRole('region', { name: 'Getting started' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('No agent is connected.', { exact: false })).toBeTruthy();
    await fireEvent.click(list.getAllByRole('button', { name: 'Open Setup' })[0]!);
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('mark what is done, and disappear once a mission exists', () => {
    const first = render(Home, props({ landing: true }));
    expect(screen.getByText('Connect an agent (done)')).toBeTruthy();
    first.unmount();
    render(Home, props({ missions: [mission()] }));
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });
});

describe('a mission that stopped at its spending limit', () => {
  const stopped = { ...mission({ id: 'M1', status: 'IMPLEMENTING', plan: null, waitingOn: ['claude-1'] }), budget: { reached: 'It has used $1.50 of its $1.00 limit.' } };
  const notice: Notice = { key: 'budget:M1:1:-', kind: 'budget', urgent: true, title: 'Spending limit reached: Car wash booking', text: 'It has used $1.50 of its $1.00 limit. No more runs start for it until you raise the limit or cancel it.', missionId: 'M1' };

  it('is one of the things that need you, with a button that opens that mission to raise the limit', async () => {
    const onNavigate = vi.fn();
    render(Home, props({ notices: [notice], missions: [stopped], onNavigate }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('One thing needs you');
    expect(screen.getByText(/No more runs start for it/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Raise the limit' }));
    expect(onNavigate).toHaveBeenCalledWith('missions', 'mission-M1');
  });

  it('is shown as stopped in the list of missions, not as being built', () => {
    render(Home, props({ missions: [stopped] }));
    const row = within(screen.getByRole('region', { name: 'Missions in progress' }));
    expect(row.getByText('Stopped: limit reached')).toBeTruthy();
    expect(row.queryByText('Being built')).toBeNull();
  });
});

describe('the list of missions', () => {
  it('opens the mission that was clicked, not just the top of the Missions screen', async () => {
    const onNavigate = vi.fn();
    render(Home, props({ missions: [mission({ id: 'M1', title: 'Car wash', status: 'IMPLEMENTING', plan: null }), mission({ id: 'M2', title: 'Bike shop', status: 'IMPLEMENTING', plan: null })], onNavigate }));
    await fireEvent.click(screen.getByRole('button', { name: /Bike shop/ }));
    expect(onNavigate).toHaveBeenCalledWith('missions', 'mission-M2');
  });
});

describe('answering from Home', () => {
  it('a question on Home can be answered without leaving it', async () => {
    const daemon = fakeDaemon({ '/api/answer': { ok: true } });
    const onChanged = vi.fn();
    const notices: Notice[] = [{ key: 'q:q1', kind: 'question', urgent: true, title: 'gemini-1 has a question', text: 'clipped…', questionId: 'q1' }];
    render(Home, props({ notices, questions: [{ id: 'q1', text: 'The whole question, unclipped.' }], onChanged }));
    expect(screen.getByText('The whole question, unclipped.')).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Your answer'), { target: { value: 'Yes.' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/answer')[0]!.body).toEqual({ questionId: 'q1', answer: 'Yes.' });
  });
});
