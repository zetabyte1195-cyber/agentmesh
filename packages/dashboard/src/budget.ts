// Spending limits as the person types and reads them. No Svelte here, so every rule and sentence can be tested. The
// bounds match the daemon's (budget/service.ts), which checks them again: this only gives the answer sooner.
import type { MissionBudget } from './types';

export const MAX_COST_USD = 100_000;
export const MIN_TOKENS = 10_000;
export const MAX_TOKENS = 10_000_000_000;

export type Limits = { budgetUsd: number | null; budgetTokens: number | null };
export type Parsed = ({ ok: true } & Limits) | { ok: false; error: string };

const grouped = (n: number) => n.toLocaleString('en-US');

/**
 * What was typed into the two boxes. A blank box is "no limit of that kind". Dollars: 5, 7.50, $12. Tokens: 250000,
 * 250,000, 250k, 2m.
 */
export function parseLimits(usdText: string, tokensText: string): Parsed {
  let budgetUsd: number | null = null;
  let budgetTokens: number | null = null;

  const usd = usdText.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (usd) {
    if (!/^\d+(\.\d+)?$/.test(usd)) return { ok: false, error: 'Type the dollars as a number, for example 5 or 7.50.' };
    budgetUsd = Number(usd);
    if (budgetUsd <= 0 || budgetUsd > MAX_COST_USD) return { ok: false, error: `The dollar limit must be more than 0 and at most ${grouped(MAX_COST_USD)}.` };
  }

  const tok = tokensText.trim().replace(/[,\s]/g, '').toLowerCase();
  if (tok) {
    const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(tok);
    if (!m) return { ok: false, error: 'Type the tokens as a number, for example 250000, 250k or 2m.' };
    const n = Math.round(Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1));
    if (n < MIN_TOKENS || n > MAX_TOKENS) return { ok: false, error: `The token limit must be from ${grouped(MIN_TOKENS)} to ${grouped(MAX_TOKENS)}.` };
    budgetTokens = n;
  }
  return { ok: true, budgetUsd, budgetTokens };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** One line saying what the limit is and how much of it is used. Null when there is no limit. */
export function describeBudget(b: MissionBudget | null): string | null {
  if (!b) return null;
  const parts: string[] = [];
  if (b.maxCostUsd !== null) parts.push(`${money(b.maxCostUsd)} (used ${b.usedCostUsd === null ? 'nothing reported yet' : money(b.usedCostUsd)})`);
  if (b.maxTokens !== null) parts.push(`${grouped(b.maxTokens)} tokens (used ${grouped(b.usedTokens)})`);
  return `Spending limit: ${parts.join(' and ')}`;
}

/** The share of the limit used, for a bar. The tighter of the two limits when there are two. Null when no limit can be seen: a dollar limit alone, with nothing reporting dollars (Antigravity, a local model). */
export function budgetShare(b: MissionBudget | null): number | null {
  if (!b) return null;
  const shares: number[] = [];
  if (b.maxCostUsd !== null && b.usedCostUsd !== null) shares.push(b.usedCostUsd / b.maxCostUsd);
  if (b.maxTokens !== null) shares.push(b.usedTokens / b.maxTokens);
  return shares.length ? Math.min(1, Math.max(...shares)) : null;
}

/** The whole percent for a screen reader: 100 only once the limit is reached (99.6 percent is not "100 percent used"). */
export const usedPercent = (share: number): number => (share >= 1 ? 100 : Math.floor(share * 100));
