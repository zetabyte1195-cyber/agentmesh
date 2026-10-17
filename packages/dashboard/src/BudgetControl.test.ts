import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BudgetControl from './BudgetControl.svelte';
import { fakeDaemon } from './testing';
import type { MissionBudget } from './types';

afterEach(() => vi.unstubAllGlobals());

const budget = (o: Partial<MissionBudget> = {}): MissionBudget => ({ maxCostUsd: null, maxTokens: null, usedCostUsd: null, usedTokens: 0, reached: null, ...o });
const mount = (b: MissionBudget | null, onChanged = vi.fn()) => ({ onChanged, ...render(BudgetControl, { missionId: 'M1', budget: b, onChanged }) });
const type = (label: string | RegExp, value: string) => fireEvent.input(screen.getByLabelText(label), { target: { value } });

describe('the open form', () => {
  const both = () => budget({ maxCostUsd: 5, maxTokens: 100_000, usedTokens: 1000 });

  it('keeps what was on screen when it was opened, even if the saved limit changes underneath (another tab, an API call)', async () => {
    const daemon = fakeDaemon({ '/api/missions/budget': { budget: {} } });
    const view = mount(both());
    await fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));
    await type(/Dollars/, '10');
    await view.rerender({ missionId: 'M1', budget: budget({ maxCostUsd: 5, maxTokens: 500_000 }), onChanged: view.onChanged });
    expect((screen.getByLabelText(/Tokens/) as HTMLInputElement).value).toBe('100000'); // not silently the new value
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    await waitFor(() => expect(view.onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/missions/budget')[0]!.body).toEqual({ missionId: 'M1', budgetUsd: 10, budgetTokens: 100_000 });
  });

  it('closing it throws away what was typed and the error, and opening it again shows what is saved', async () => {
    fakeDaemon({});
    mount(both());
    const toggle = () => screen.getByRole('button', { name: 'Change the limit' });
    await fireEvent.click(toggle());
    await type(/Dollars/, 'abc');
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Type the dollars as a number/);
    await fireEvent.click(toggle()); // close
    expect(screen.queryByRole('alert')).toBeNull(); // the error does not stay on the card
    await fireEvent.click(toggle()); // open again
    expect((screen.getByLabelText(/Dollars/) as HTMLInputElement).value).toBe('5');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a limit set through the API with more decimals can be saved again unchanged', async () => {
    const daemon = fakeDaemon({ '/api/missions/budget': { budget: {} } });
    const { onChanged } = mount(budget({ maxCostUsd: 0.125 }));
    await fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));
    expect((screen.getByLabelText(/Dollars/) as HTMLInputElement).value).toBe('0.125');
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/missions/budget')[0]!.body).toEqual({ missionId: 'M1', budgetUsd: 0.125, budgetTokens: null });
  });
});

describe('the bar', () => {
  it('says 99 percent, not 100, just short of the limit', () => {
    fakeDaemon({});
    mount(budget({ maxTokens: 10_000, usedTokens: 9_960 }));
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('99 percent of the limit used');
  });

  it('is not drawn when the only limit is in dollars and no dollars were reported', () => {
    fakeDaemon({});
    mount(budget({ maxCostUsd: 5, usedCostUsd: null, usedTokens: 800_000 }));
    expect(screen.getByText(/used nothing reported yet/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('a mission with no limit', () => {
  it('offers to set one, and says nothing about spending until it does', () => {
    fakeDaemon({});
    mount(null);
    expect(screen.getByRole('button', { name: 'Set a spending limit' })).toBeTruthy();
    expect(screen.queryByText(/Spending limit:/)).toBeNull();
  });

  it('sets dollars and tokens, tells the page to refresh, and closes the form', async () => {
    const daemon = fakeDaemon({ '/api/missions/budget': { budget: {} } });
    const { onChanged } = mount(null);
    await fireEvent.click(screen.getByRole('button', { name: 'Set a spending limit' }));
    await type(/Dollars/, '$5');
    await type(/Tokens/, '2m');
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(daemon.posts('/api/missions/budget')[0]!.body).toEqual({ missionId: 'M1', budgetUsd: 5, budgetTokens: 2_000_000 });
    expect(screen.queryByRole('button', { name: 'Save the limit' })).toBeNull();
  });

  it('says what is wrong with what was typed, and sends nothing', async () => {
    const daemon = fakeDaemon({});
    mount(null);
    await fireEvent.click(screen.getByRole('button', { name: 'Set a spending limit' }));
    await type(/Dollars/, 'five');
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Type the dollars as a number, for example 5 or 7.50.');
    expect(daemon.calls).toHaveLength(0);
  });

  it('asks for something to be typed rather than saving an empty limit', async () => {
    const daemon = fakeDaemon({});
    mount(null);
    await fireEvent.click(screen.getByRole('button', { name: 'Set a spending limit' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Type a dollar amount or a number of tokens/);
    expect(daemon.calls).toHaveLength(0);
  });

  it('shows the daemon\'s refusal and keeps what was typed', async () => {
    fakeDaemon({ '/api/missions/budget': { status: 409, body: { error: 'Unknown mission M1' } } });
    const { onChanged } = mount(null);
    await fireEvent.click(screen.getByRole('button', { name: 'Set a spending limit' }));
    await type(/Dollars/, '5');
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Unknown mission M1');
    expect(onChanged).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Dollars/) as HTMLInputElement).value).toBe('5');
  });
});

describe('a mission with a limit', () => {
  const some = budget({ maxCostUsd: 10, usedCostUsd: 5, maxTokens: 1_000_000, usedTokens: 250_000 });

  it('says what it is and how much is used, with a bar at the tighter share', () => {
    fakeDaemon({});
    mount(some);
    expect(screen.getByText('Spending limit: $10.00 (used $5.00) and 1,000,000 tokens (used 250,000)')).toBeTruthy();
    expect(screen.getByRole('img', { name: '50 percent of the limit used' })).toBeTruthy();
  });

  it('opens with the saved values to change, and "Remove the limit" removes both', async () => {
    const daemon = fakeDaemon({ '/api/missions/budget': { budget: null } });
    const { onChanged } = mount(some);
    await fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));
    expect((screen.getByLabelText(/Dollars/) as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText(/Tokens/) as HTMLInputElement).value).toBe('1000000');
    await fireEvent.click(screen.getByRole('button', { name: 'Remove the limit' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/missions/budget')[0]!.body).toEqual({ missionId: 'M1', budgetUsd: null, budgetTokens: null });
  });

  it('changing one box keeps the other as saved', async () => {
    const daemon = fakeDaemon({ '/api/missions/budget': { budget: {} } });
    const { onChanged } = mount(some);
    await fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));
    await type(/Dollars/, '25');
    await fireEvent.click(screen.getByRole('button', { name: 'Save the limit' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/missions/budget')[0]!.body).toEqual({ missionId: 'M1', budgetUsd: 25, budgetTokens: 1_000_000 });
  });
});

describe('a mission that has stopped at its limit', () => {
  it('says so, says what to do, and offers to raise it', () => {
    fakeDaemon({});
    mount(budget({ maxCostUsd: 1, usedCostUsd: 1.5, reached: 'It has used $1.50 of its $1.00 limit.' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Stopped at its spending limit');
    expect(alert.textContent).toContain('It has used $1.50 of its $1.00 limit.');
    expect(alert.textContent).toContain('Raise the limit to let it carry on, or cancel it');
    expect(screen.getByRole('button', { name: 'Raise the limit' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '100 percent of the limit used' })).toBeTruthy();
  });
});
