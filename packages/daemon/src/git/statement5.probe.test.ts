import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './run-git.js';
import { WorktreeController } from './worktrees.js';

describe('statement 5 probe', () => {
  it('modifies .git/worktrees when createScratch and cleanScratch are run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-test-s5-'));
    try {
      await git(dir, ['init', '-q', '-b', 'main']);
      await git(dir, ['config', 'user.name', 'Tester']);
      await git(dir, ['config', 'user.email', 'tester@example.com']);
      await git(dir, ['commit', '--allow-empty', '-m', 'Initial']);

      const wt = new WorktreeController({ repoRoot: dir, trunk: 'main' });
      const scratchPath = await wt.createScratch('test-scratch');

      // Check if .git/worktrees was touched
      const gitWorktreeMeta = join(dir, '.git', 'worktrees', 'test-scratch');
      expect(existsSync(gitWorktreeMeta)).toBe(true); // Touched .git/worktrees, outside .agentmesh/scratch!

      await wt.removeScratch(scratchPath);
      expect(existsSync(gitWorktreeMeta)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
