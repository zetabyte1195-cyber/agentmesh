import { describe, expect, it } from 'vitest';
import { resolveTheme } from './theme';

describe('theme', () => {
  it('Auto follows the system; a chosen theme wins over it', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
