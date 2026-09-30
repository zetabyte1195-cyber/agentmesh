import { describe, expect, it } from 'vitest';
import { VERSION, run } from './index.js';

describe('agentmesh cli', () => {
  it('prints usage with no command', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Usage: agentmesh <command>');
    for (const c of ['init', 'start', 'status', 'dispatch', 'export']) expect(r.output).toContain(c);
  });

  it('prints the version', () => {
    expect(run(['--version'])).toEqual({ code: 0, output: VERSION });
  });

  it('rejects unknown commands with exit code 1', () => {
    const r = run(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Unknown command "frobnicate"');
  });

  it('says which task implements a not-yet-built command, with exit code 2', () => {
    expect(run(['init'])).toEqual({ code: 2, output: 'agentmesh init: not available in this version.' });
  });
});
