import { describe, expect, it } from 'vitest';
import { gitInstallHint, platformInstaller } from './install.js';

describe('what AgentMesh offers to install (G16)', () => {
  it('uses each vendor\'s documented command, per operating system', () => {
    expect(platformInstaller('CLAUDE_CODE', 'win32')).toMatchObject({ display: 'npm install -g @anthropic-ai/claude-code', shell: true, binary: 'claude' });
    expect(platformInstaller('CLAUDE_CODE', 'darwin')).toMatchObject({ executable: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'], shell: false });
    expect(platformInstaller('ANTIGRAVITY', 'win32')?.args.at(-1)).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(platformInstaller('ANTIGRAVITY', 'darwin')?.args).toEqual(['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash']);
  });

  it('offers nothing it has no verified way to install (the person installs those)', () => {
    expect(platformInstaller('MYTOOL')).toBeNull();
    expect(gitInstallHint('linux')).toMatch(/package manager/);
  });
});
