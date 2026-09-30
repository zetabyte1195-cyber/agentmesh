import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExternalLinks } from './links.js';
import { WorktreeController, WorktreeNotCleanError, WorktreeRemoveError, branchName } from './worktrees.js';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let repo: string;
let wc: WorktreeController;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-wt-'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'test');
  sh(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ninstalled.txt\n.env\n');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'base');
  // The primary tree's dependencies: what the data-loss bug destroyed.
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  wc = new WorktreeController({ repoRoot: repo });
});

afterEach(async () => {
  // Worktrees first (link-safe), then the temp repo.
  for (const id of ['T1', 'T2', 'P1.6']) await wc.remove(id, { deleteBranch: 'force' }).catch(() => undefined);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

describe('branchName', () => {
  it('builds mesh/<id>-<slug>', () => {
    expect(branchName('P1.6', 'Git worktree controller')).toBe('mesh/p1-6-git-worktree-controller');
    expect(branchName('S0.1', '!!!')).toBe('mesh/s0-1');
  });
});

describe('WorktreeController', { timeout: 30_000 }, () => {
  it('allocates a worktree on a new branch from local trunk, with no remote', async () => {
    const wt = await wc.allocate('P1.6', 'Git worktree controller');
    expect(wt.branch).toBe('mesh/p1-6-git-worktree-controller');
    expect(wt.baseCommit).toBe(sh(repo, 'rev-parse', 'main'));
    expect(sh(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(wt.branch);
    expect(readFileSync(join(wt.path, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(sh(repo, 'remote')).toBe('');
  });

  it('keeps worktrees out of the primary tree status via .git/info/exclude, idempotently', async () => {
    await wc.allocate('T1', 'one');
    await wc.allocate('T2', 'two');
    expect(sh(repo, 'status', '--short')).toBe('');
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split(/\r?\n/).filter((l) => l === '/.agentmesh/')).toHaveLength(1);
  });

  it('rejects unsafe task ids and double allocation', async () => {
    // 'T1.' is refused up front: Windows strips the trailing dot, so git worktree add would fail (P2.4, verified).
    for (const bad of ['', '../x', 'a/b', 'a\\b', '..', 'T1.']) await expect(wc.allocate(bad, 't')).rejects.toThrow('Invalid task id');
    await wc.allocate('T1', 't');
    await expect(wc.allocate('T1', 't')).rejects.toThrow('already exists');
  });

  it('REGRESSION (data loss): removing a worktree with an ignored node_modules junction leaves the primary node_modules intact', async () => {
    const wt = await wc.allocate('T1', 'junction', { strategy: 'junction' });
    const link = join(wt.path, 'node_modules');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, 'pkg', 'index.js'))).toBe(true);
    expect(sh(wt.path, 'status', '--short')).toBe(''); // ignored → git would remove without --force

    const { unlinked } = await wc.remove('T1');

    expect(unlinked.map((l) => l.path)).toEqual([link]);
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
  });

  it('removing a planning (scratch) checkout never deletes through a link an agent made inside it', async () => {
    const outside = join(repo, 'precious');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep me');
    const scratch = await wc.createScratch('plan-abc');
    expect(existsSync(join(scratch, 'README.md')) || existsSync(scratch)).toBe(true);
    symlinkSync(outside, join(scratch, 'link-out'), LINK_TYPE);
    await wc.removeScratch(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep me');
    await expect(wc.removeScratch(repo)).rejects.toThrow(/not a scratch checkout/);
    await expect(wc.createScratch('../escape')).rejects.toThrow(/Invalid scratch name/);
  });

  it('also unlinks nested outward links but leaves inward links alone', async () => {
    const wt = await wc.allocate('T1', 'nested');
    mkdirSync(join(wt.path, 'packages', 'x'), { recursive: true });
    symlinkSync(join(repo, 'node_modules'), join(wt.path, 'packages', 'x', 'node_modules'), LINK_TYPE); // outward
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true });
    symlinkSync(join(wt.path, 'packages', 'x'), join(wt.path, 'node_modules', 'x'), LINK_TYPE); // inward (workspace-style)

    const found = await findExternalLinks(wt.path);
    expect(found.map((l) => l.path)).toEqual([join(wt.path, 'packages', 'x', 'node_modules')]);

    writeFileSync(join(wt.path, '.gitignore'), 'node_modules/\ninstalled.txt\n.env\npackages/\n');
    sh(wt.path, 'commit', '-q', '-am', 'ignore packages');
    await wc.remove('T1');
    expect(existsSync(join(repo, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('copies (never links) configured files and rejects paths escaping the repo', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    const wt = await wc.allocate('T1', 'env', { strategy: 'none', copyFiles: ['.env', 'missing.env'] });
    expect(lstatSync(join(wt.path, '.env')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wt.path, '.env'), 'utf8')).toBe('SECRET=1\n');
    await expect(wc.allocate('T2', 'escape', { strategy: 'none', copyFiles: ['../outside.txt'] })).rejects.toThrow('escapes');
    expect(existsSync(wc.pathFor('T2'))).toBe(false); // failed bootstrap cleaned up
  });

  it('runs the install command inside the new worktree', async () => {
    const wt = await wc.allocate('T1', 'install', {
      strategy: 'install',
      installCommand: `node -e "require('fs').writeFileSync('installed.txt','ok')"`,
    });
    expect(readFileSync(join(wt.path, 'installed.txt'), 'utf8')).toBe('ok');
  });

  it('refuses to remove a worktree with uncommitted work and keeps that work', async () => {
    const wt = await wc.allocate('T1', 'dirty');
    writeFileSync(join(wt.path, 'a.txt'), 'agent edit\n');
    await expect(wc.remove('T1')).rejects.toBeInstanceOf(WorktreeNotCleanError);
    expect(readFileSync(join(wt.path, 'a.txt'), 'utf8')).toBe('agent edit\n');
  });

  // Live AC-8 run #3: the auditor's process still had the worktree as its cwd; git said
  // "Permission denied", which must not be reported as uncommitted work.
  it.skipIf(process.platform !== 'win32')('reports a worktree held open by a process as not removable, not as dirty', async () => {
    const wt = await wc.allocate('T1', 'locked');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: wt.path, stdio: 'ignore' });
    await new Promise((r) => holder.once('spawn', r));
    try {
      const err = await wc.remove('T1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeRemoveError);
      expect(err).not.toBeInstanceOf(WorktreeNotCleanError);
    } finally {
      holder.kill();
      await new Promise((r) => holder.once('exit', r));
    }
  });

  it('deletes the branch only when asked, and never an unmerged one unless forced', async () => {
    const kept = await wc.allocate('T1', 'keep');
    await wc.remove('T1');
    expect(sh(repo, 'branch', '--list', kept.branch)).toContain(kept.branch);

    const unmerged = await wc.allocate('T2', 'unmerged');
    sh(unmerged.path, 'commit', '-q', '--allow-empty', '-m', 'unmerged work');
    await expect(wc.remove('T2', { deleteBranch: 'if-merged' })).rejects.toThrow(); // git branch -d refuses
    expect(sh(repo, 'branch', '--list', unmerged.branch)).toContain(unmerged.branch);

    const forced = await wc.allocate('T1', 'forced');
    sh(forced.path, 'commit', '-q', '--allow-empty', '-m', 'discard me');
    await wc.remove('T1', { deleteBranch: 'force' });
    expect(sh(repo, 'branch', '--list', forced.branch)).toBe('');
  });

  it('reconciles after a crash: prunes vanished worktrees, reports orphans and missing ones', async () => {
    await wc.allocate('T1', 'orphan');
    const crashed = await wc.allocate('T2', 'crashed');
    rmSync(crashed.path, { recursive: true, force: true }); // simulate a crash that lost the directory

    const { orphaned, missing } = await wc.reconcile(['T2', 'P9']);

    expect(orphaned.map((w) => w.taskId)).toEqual(['T1']);
    expect(missing.sort()).toEqual(['P9', 'T2']);
    expect(sh(repo, 'worktree', 'list')).not.toContain('wt-T2');
  });
});
