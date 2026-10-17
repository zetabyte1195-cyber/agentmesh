// The Missions screen: starting a mission (with an optional spending limit) and a mission that has stopped at one.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Missions from './Missions.svelte';
import { agent, fakeDaemon, mission } from './testing';

afterEach(() => vi.unstubAllGlobals());

const agents = [agent(), agent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY' })];
const props = (o: Record<string, unknown> = {}) => ({ missions: [], agents, usage: [], onChanged: vi.fn(), ...o });
const routes = { '/api/templates': { builtIn: [], mine: [] }, '/api/missions': { id: 'M1' } };
const fillIn = async () => {
  await fireEvent.input(await screen.findByLabelText('Name'), { target: { value: 'Car wash' } });
  await fireEvent.input(screen.getByLabelText('The brief'), { target: { value: 'Customers book a wash slot online.' } });
};

describe('starting a mission', () => {
  it('without a limit sends none', async () => {
    const daemon = fakeDaemon(routes);
    render(Missions, props());
    await fillIn();
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(daemon.posts('/api/missions')).toHaveLength(1));
    expect(Object.keys(daemon.posts('/api/missions')[0]!.body as object)).not.toContain('budgetUsd');
    expect(Object.keys(daemon.posts('/api/missions')[0]!.body as object)).not.toContain('budgetTokens');
  });

  it('with a limit sends it, as numbers, and empties the boxes afterwards', async () => {
    const daemon = fakeDaemon(routes);
    const onChanged = vi.fn();
    render(Missions, props({ onChanged }));
    await fillIn();
    await fireEvent.input(screen.getByLabelText(/Stop around this many dollars/), { target: { value: '$5' } });
    await fireEvent.input(screen.getByLabelText(/or around this many tokens/), { target: { value: '2m' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/missions')[0]!.body).toMatchObject({ title: 'Car wash', plannerAgentId: 'claude-1', budgetUsd: 5, budgetTokens: 2_000_000 });
    expect((screen.getByLabelText(/Stop around this many dollars/) as HTMLInputElement).value).toBe('');
  });

  it('a limit that cannot be read stops the start, in plain words, before anything is sent', async () => {
    const daemon = fakeDaemon(routes);
    render(Missions, props());
    await fillIn();
    await fireEvent.input(screen.getByLabelText(/or around this many tokens/), { target: { value: 'lots' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Type the tokens as a number, for example 250000, 250k or 2m.');
    expect(daemon.posts('/api/missions')).toHaveLength(0);
  });
});

describe('a mission and its limit', () => {
  const stopped = mission({ id: 'M1', status: 'IMPLEMENTING', plan: null, waitingOn: ['claude-1'], budget: { maxCostUsd: 1, maxTokens: null, usedCostUsd: 1.5, usedTokens: 10, reached: 'It has used $1.50 of its $1.00 limit.' } });

  it('shows a mission that stopped at its limit, in its heading and in its body', () => {
    fakeDaemon(routes);
    render(Missions, props({ missions: [stopped] }));
    const card = within(screen.getByRole('article', { name: /Mission M1/ }));
    expect(card.getByText('Stopped: limit reached')).toBeTruthy();
    expect(card.getByText('Stopped at its spending limit')).toBeTruthy();
  });

  it('a mission within its limit shows the limit but no warning', () => {
    fakeDaemon(routes);
    render(Missions, props({ missions: [mission({ status: 'IMPLEMENTING', plan: null, budget: { maxCostUsd: 5, maxTokens: null, usedCostUsd: 1, usedTokens: 10, reached: null } })] }));
    expect(screen.getByText('Spending limit: $5.00 (used $1.00)')).toBeTruthy();
    expect(screen.queryByText('Stopped: limit reached')).toBeNull();
  });

  it('a finished or cancelled mission has no limit controls', () => {
    fakeDaemon(routes);
    render(Missions, props({ missions: [mission({ id: 'M1', status: 'DONE' }), mission({ id: 'M2', status: 'CANCELLED' })] }));
    expect(screen.queryByRole('button', { name: /spending limit|Change the limit|Raise the limit/i })).toBeNull();
  });
});
