// The files a task's workspace differs by, from git, with how many lines were added and removed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, trustedWorkspace } from './changes.js';

let repo: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const put = (rel: string, text: string) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-changes-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  put('keep.txt', 'one\ntwo\nthree\n');
  put('gone.txt', 'bye\n');
  put('old-name.txt', 'same text\nline two\nline three\nline four\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'mesh/t1');
});
afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5 }));

describe('what a workspace changed', () => {
  it('nothing, when nothing was', async () => {
    expect(await changedFiles(repo, 'main')).toEqual({ files: [], truncated: false });
  });

  it('lists edited, added (new and not yet added to git), deleted and renamed files with their line counts', async () => {
    put('keep.txt', 'one\nTWO\nthree\nfour\n'); // 2 added, 1 removed (uncommitted)
    put('new.txt', 'a\nb\n'); // untracked
    g('rm', '-q', 'gone.txt'); // deleted
    g('mv', 'old-name.txt', 'new-name.txt'); // renamed
    const { files, truncated } = await changedFiles(repo, 'main');
    expect(truncated).toBe(false);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by['keep.txt']).toMatchObject({ status: 'modified', added: 2, removed: 1 });
    expect(by['new.txt']).toMatchObject({ status: 'added', added: 2, removed: 0 });
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', added: 0, removed: 1 });
    expect(by['new-name.txt']).toMatchObject({ status: 'renamed', from: 'old-name.txt' });
  });

  it('includes what was already committed on the task\'s branch, not only what is uncommitted', async () => {
    put('keep.txt', 'one\ntwo\nthree\nfour\n');
    g('commit', '-qam', 'work');
    put('later.txt', 'x\n');
    const paths = (await changedFiles(repo, 'main')).files.map((f) => f.path).sort();
    expect(paths).toEqual(['keep.txt', 'later.txt']);
  });

  it('says a binary file has no line counts', async () => {
    writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    g('add', 'pic.bin');
    expect((await changedFiles(repo, 'main')).files.find((f) => f.path === 'pic.bin')).toMatchObject({ status: 'added', added: null, removed: null });
  });

  it('keeps a long list short and says so', async () => {
    for (let i = 0; i < 30; i++) put(`many/f${i}.txt`, 'x\n');
    const r = await changedFiles(repo, 'main', { max: 10 });
    expect(r.files).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('handles file names with spaces and non-ASCII letters', async () => {
    put('my file é.txt', 'x\n');
    expect((await changedFiles(repo, 'main')).files.map((f) => f.path)).toEqual(['my file é.txt']);
  });

  it('copes with a trunk that does not exist (a repository still on another branch name)', async () => {
    put('a.txt', 'x\n');
    const r = await changedFiles(repo, 'no-such-branch');
    expect(r.files.map((f) => f.path)).toContain('a.txt');
  });

  it('copes with a folder that is not a repository at all', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'agentmesh-plain-'));
    try {
      await expect(changedFiles(plain, 'main')).resolves.toEqual({ files: [], truncated: false });
    } finally {
      rmSync(plain, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

// The workspace is a folder an agent can write to. Nothing it leaves there may make AgentMesh read what it should not, wait for ever,
// or run a program.
describe('a workspace that an agent has tampered with', () => {
  it('does not follow a link it left, and does not count the lines of what the link points to', async () => {
    put('outside/secret.txt', 'a\nb\nc\nd\ne\n');
    try {
      symlinkSync(join(repo, 'outside', 'secret.txt'), join(repo, 'link.txt'));
    } catch {
      return; // this system does not let this user make links: nothing to try
    }
    const link = (await changedFiles(repo, 'main')).files.find((f) => f.path === 'link.txt');
    expect(link).toBeDefined();
    expect(link!.added).toBeNull(); // listed, but not read
  });

  it('does not read a file of a size nobody has written by hand', async () => {
    writeFileSync(join(repo, 'big.txt'), 'x\n'.repeat(600_000)); // 1.2 MB
    expect((await changedFiles(repo, 'main')).files.find((f) => f.path === 'big.txt')).toMatchObject({ status: 'added', added: null });
  });

  it('does not let the repository\'s own settings run a program (a file-system monitor, named in its configuration)', async () => {
    const marker = join(repo, 'ran.txt');
    const script = join(repo, '..', `agentmesh-fsmonitor-${Date.now()}.cjs`);
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nprocess.stdout.write('')\n`);
    try {
      g('config', 'core.fsmonitor', `node "${script.replace(/\\/g, '/')}"`);
      put('a.txt', 'x\n');
      await changedFiles(repo, 'main');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(script, { force: true });
    }
  });
});

describe('which workspaces git is run in', () => {
  const root = () => repo;
  it('trusts one made by git for this project, and refuses one whose link back was changed, or that is a repository of its own', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T1');
    g('worktree', 'add', '-q', '-b', 'mesh/wt', wt, 'main');
    expect(trustedWorkspace(wt, root())).toBe(true);
    // the link is rewritten to name some other repository
    const other = mkdtempSync(join(tmpdir(), 'agentmesh-other-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other });
      rmSync(join(wt, '.git'), { force: true }); // git hides this file, so on Windows it cannot be written over: it is replaced
      writeFileSync(join(wt, '.git'), `gitdir: ${join(other, '.git')}\n`);
      expect(trustedWorkspace(wt, root())).toBe(false);
      // ...or it was replaced by a whole repository
      rmSync(join(wt, '.git'));
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: wt });
      expect(trustedWorkspace(wt, root())).toBe(false);
      expect(trustedWorkspace(join(repo, 'no-such-folder'), root())).toBe(false);
      expect(trustedWorkspace(wt)).toBe(true); // with no project given there is nothing to compare with
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('refuses a workspace whose folder in the project does not belong to this project, or has a configuration of its own', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T5');
    g('worktree', 'add', '-q', '-b', 'mesh/wt5', wt, 'main');
    expect(trustedWorkspace(wt, root())).toBe(true);
    const gitdir = join(repo, '.git', 'worktrees', 'wt-T5');
    writeFileSync(join(gitdir, 'config.worktree'), '[core]\n\tfsmonitor = true\n');
    expect(trustedWorkspace(wt, root())).toBe(false); // a configuration only this workspace has
    rmSync(join(gitdir, 'config.worktree'));
    expect(trustedWorkspace(wt, root())).toBe(true);
    writeFileSync(join(gitdir, 'commondir'), '../../../somewhere-else\n');
    expect(trustedWorkspace(wt, root())).toBe(false); // it does not lead back to this project's own .git
  });

  it('never runs git in a workspace pointed at another repository, even one set to run a program', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T2');
    g('worktree', 'add', '-q', '-b', 'mesh/wt2', wt, 'main');
    const evil = mkdtempSync(join(tmpdir(), 'agentmesh-evil-'));
    const marker = join(evil, 'ran.txt');
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: evil });
      writeFileSync(join(evil, 'm.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
      execFileSync('git', ['config', 'core.fsmonitor', `node "${join(evil, 'm.cjs').replace(/\\/g, '/')}"`], { cwd: evil });
      rmSync(join(wt, '.git'), { force: true });
      writeFileSync(join(wt, '.git'), `gitdir: ${join(evil, '.git')}\n`);
      expect(await changedFiles(wt, 'main', { projectRoot: root() })).toEqual({ files: [], truncated: false });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(evil, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
