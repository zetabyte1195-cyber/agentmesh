import { describe, expect, it } from 'vitest';
import { budgetShare, describeBudget, parseLimits, usedPercent } from './budget';
import type { MissionBudget } from './types';

const b = (o: Partial<MissionBudget> = {}): MissionBudget => ({ maxCostUsd: null, maxTokens: null, usedCostUsd: null, usedTokens: 0, reached: null, ...o });

describe('what is typed into the limit boxes', () => {
  it('blank means no limit of that kind', () => {
    expect(parseLimits('', '')).toEqual({ ok: true, budgetUsd: null, budgetTokens: null });
    expect(parseLimits('  ', '  ')).toEqual({ ok: true, budgetUsd: null, budgetTokens: null });
  });

  it('reads dollars the way people write them', () => {
    expect(parseLimits('5', '')).toEqual({ ok: true, budgetUsd: 5, budgetTokens: null });
    expect(parseLimits('$7.50', '')).toMatchObject({ budgetUsd: 7.5 });
    expect(parseLimits(' 1,250 ', '')).toMatchObject({ budgetUsd: 1250 });
  });

  it('reads tokens as plain numbers, with commas, or as k and m', () => {
    expect(parseLimits('', '250000')).toMatchObject({ budgetTokens: 250_000 });
    expect(parseLimits('', '250,000')).toMatchObject({ budgetTokens: 250_000 });
    expect(parseLimits('', '250k')).toMatchObject({ budgetTokens: 250_000 });
    expect(parseLimits('', '2M')).toMatchObject({ budgetTokens: 2_000_000 });
    expect(parseLimits('', '1.5m')).toMatchObject({ budgetTokens: 1_500_000 });
  });

  it('keeps both when both are typed', () => {
    expect(parseLimits('5', '2m')).toEqual({ ok: true, budgetUsd: 5, budgetTokens: 2_000_000 });
  });

  it('says in plain words what is wrong with dollars', () => {
    for (const bad of ['five', '-3', '1e3', '5 dollars']) expect(parseLimits(bad, '')).toEqual({ ok: false, error: 'Type the dollars as a number, for example 5 or 7.50.' });
    expect(parseLimits('0', '')).toMatchObject({ ok: false, error: expect.stringContaining('more than 0') });
    expect(parseLimits('1000000', '')).toMatchObject({ ok: false, error: expect.stringContaining('at most 100,000') });
  });

  it('says in plain words what is wrong with tokens', () => {
    expect(parseLimits('', 'lots')).toEqual({ ok: false, error: 'Type the tokens as a number, for example 250000, 250k or 2m.' });
    expect(parseLimits('', '500')).toMatchObject({ ok: false, error: expect.stringContaining('from 10,000') });
    expect(parseLimits('', '99999999m')).toMatchObject({ ok: false, error: expect.stringContaining('10,000,000,000') });
  });
});

describe('what the limit says', () => {
  it('says nothing for no limit', () => {
    expect(describeBudget(null)).toBeNull();
  });

  it('gives the limit and what is used, for each kind that is set', () => {
    expect(describeBudget(b({ maxCostUsd: 5, usedCostUsd: 3.1 }))).toBe('Spending limit: $5.00 (used $3.10)');
    expect(describeBudget(b({ maxTokens: 2_000_000, usedTokens: 120_000 }))).toBe('Spending limit: 2,000,000 tokens (used 120,000)');
    expect(describeBudget(b({ maxCostUsd: 5, usedCostUsd: 3.1, maxTokens: 2_000_000, usedTokens: 120_000 }))).toBe('Spending limit: $5.00 (used $3.10) and 2,000,000 tokens (used 120,000)');
  });

  it('is honest when the tools have reported no cost yet', () => {
    expect(describeBudget(b({ maxCostUsd: 5 }))).toBe('Spending limit: $5.00 (used nothing reported yet)');
  });
});

describe('how much of the limit is used', () => {
  it('is the tighter of the two limits, never above all of it', () => {
    expect(budgetShare(null)).toBeNull();
    expect(budgetShare(b({ maxCostUsd: 10, usedCostUsd: 2.5 }))).toBe(0.25);
    expect(budgetShare(b({ maxCostUsd: 10, usedCostUsd: 2.5, maxTokens: 100_000, usedTokens: 80_000 }))).toBe(0.8);
    expect(budgetShare(b({ maxCostUsd: 1, usedCostUsd: 3 }))).toBe(1);
  });

  it('is unknown (no bar), not zero, when a dollar limit has nothing reported yet: an empty bar would claim nothing was spent', () => {
    expect(budgetShare(b({ maxCostUsd: 5 }))).toBeNull();
  });
});

describe('the share of the limit used, for the bar', () => {
  it('has no share when the only limit is in dollars and nothing has reported dollars (Antigravity, a local model): no bar rather than an empty one', () => {
    expect(budgetShare(b({ maxCostUsd: 5, usedCostUsd: null, usedTokens: 900_000 }))).toBeNull();
  });

  it('has a share of 0 when a limit can be seen and nothing is used yet', () => {
    expect(budgetShare(b({ maxTokens: 100_000 }))).toBe(0);
    expect(budgetShare(b({ maxCostUsd: 5, usedCostUsd: 0 }))).toBe(0);
  });

  it('uses the limit that can be seen when the other cannot', () => {
    expect(budgetShare(b({ maxCostUsd: 5, maxTokens: 100_000, usedCostUsd: null, usedTokens: 50_000 }))).toBe(0.5);
  });

  it('never says 100 percent until the limit is reached', () => {
    expect(usedPercent(0.996)).toBe(99);
    expect(usedPercent(0.9999)).toBe(99);
    expect(usedPercent(1)).toBe(100);
    expect(usedPercent(0)).toBe(0);
    expect(usedPercent(0.456)).toBe(45);
  });
});

describe('dollars with more than two decimals', () => {
  it('are accepted, because the daemon accepts them (a limit set as $0.125 must be savable again unchanged)', () => {
    expect(parseLimits('0.125', '')).toEqual({ ok: true, budgetUsd: 0.125, budgetTokens: null });
    expect(parseLimits('$12.3456', '')).toEqual({ ok: true, budgetUsd: 12.3456, budgetTokens: null });
  });
  it('still refuse what is not a number', () => {
    for (const bad of ['five', '5.', '.5', '1.2.3', '5 dollars']) expect(parseLimits(bad, '').ok, bad).toBe(false);
  });
});
