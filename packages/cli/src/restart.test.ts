import { describe, expect, it } from 'vitest';
import { RESTART_LIMIT, RESTART_WINDOW_MS, shouldRestart } from './runtime-commands.js';

describe('background supervisor restart brake', () => {
  it(`restarts up to ${RESTART_LIMIT} crashes in the window, then gives up`, () => {
    const now = 1_000_000_000;
    const crashes = (n: number, spacing = 1000) => Array.from({ length: n }, (_v, i) => now - i * spacing);
    expect(shouldRestart(crashes(1), now)).toBe(true);
    expect(shouldRestart(crashes(RESTART_LIMIT), now)).toBe(true);
    expect(shouldRestart(crashes(RESTART_LIMIT + 1), now)).toBe(false);
  });

  it('forgets crashes older than the window', () => {
    const now = 1_000_000_000;
    const old = Array.from({ length: 20 }, (_v, i) => now - RESTART_WINDOW_MS - 1 - i);
    expect(shouldRestart([...old, now], now)).toBe(true);
  });
});
