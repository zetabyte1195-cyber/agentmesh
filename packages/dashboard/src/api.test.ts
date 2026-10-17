import { describe, expect, it } from 'vitest';
import { formatUsage } from './api';

const usage = (o: Partial<Parameters<typeof formatUsage>[0]> = {}) => ({ runs: 4, unreported: 0, inputTokens: 66_200, outputTokens: 19_900, cacheReadTokens: 0, costUsd: null, ...o });

describe('how usage is written', () => {
  it('counts new input and output as tokens, and shows input read from the cache apart', () => {
    expect(formatUsage(usage({ cacheReadTokens: 2_500_000, costUsd: 1.5 }))).toBe('4 runs · 66.2k in / 19.9k out · 2.5M read from cache · $1.50');
  });

  it('says nothing about a cache that was not used', () => {
    expect(formatUsage(usage())).toBe('4 runs · 66.2k in / 19.9k out');
  });

  it('says so when some runs reported nothing, and does not invent a cost', () => {
    expect(formatUsage(usage({ runs: 1, unreported: 1, inputTokens: 0, outputTokens: 0 }))).toBe('1 run · 1 not reported');
  });
});
