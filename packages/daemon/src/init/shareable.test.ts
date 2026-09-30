import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProject, isEmptyFolder } from './detect.js';
import { InitError, initProject } from './init.js';

let dir: string;
const put = (rel: string, text = '') => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-shareable-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

describe('working out how to test a project (any language, never guessing)', () => {
  it('node: prefers check over test, ignores the npm placeholder, picks the package manager by lockfile', () => {
    put('package.json', JSON.stringify({ scripts: { test: 'vitest run', check: 'npm run lint && npm test' }, devDependencies: { vitest: '1' } }));
    put('package-lock.json', '{}');
    expect(detectProject(dir)).toMatchObject({ kind: 'node', verifyCommand: 'npm run check', bootstrap: { strategy: 'install', installCommand: 'npm ci' } });

    put('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    rmSync(join(dir, 'package-lock.json'));
    expect(detectProject(dir)).toMatchObject({ verifyCommand: null, bootstrap: { strategy: 'none' } });
    expect(detectProject(dir).notes[0]).toContain('no "test" or "check" script');

    put('package.json', JSON.stringify({ scripts: { test: 'jest' }, dependencies: { a: '1' } }));
    put('pnpm-lock.yaml', '');
    expect(detectProject(dir)).toMatchObject({ verifyCommand: 'pnpm test', bootstrap: { installCommand: 'pnpm install --frozen-lockfile' } });
  });

  it('python, go, rust, java, dotnet, make', () => {
    put('pyproject.toml', '[tool.pytest.ini_options]\n');
    expect(detectProject(dir)).toMatchObject({ kind: 'python', verifyCommand: 'python -m pytest -q', bootstrap: { strategy: 'none' } });
    expect(detectProject(dir).notes[0]).toContain('not installed into new worktrees');
    rmSync(join(dir, 'pyproject.toml'));
    put('go.mod', 'module x');
    expect(detectProject(dir)).toMatchObject({ kind: 'go', verifyCommand: 'go test ./...' });
    rmSync(join(dir, 'go.mod'));
    put('Cargo.toml', '');
    expect(detectProject(dir).verifyCommand).toBe('cargo test');
    rmSync(join(dir, 'Cargo.toml'));
    put('pom.xml', '');
    expect(detectProject(dir).verifyCommand).toBe('mvn -q -B test');
    rmSync(join(dir, 'pom.xml'));
    put('App.csproj', '');
    expect(detectProject(dir).verifyCommand).toBe('dotnet test');
    rmSync(join(dir, 'App.csproj'));
    put('Makefile', 'test:\n\techo ok\n');
    expect(detectProject(dir)).toMatchObject({ kind: 'make', verifyCommand: 'make test' });
  });

  it('says so when it cannot tell, and treats a new folder as new', () => {
    expect(detectProject(dir)).toMatchObject({ kind: 'empty', verifyCommand: null });
    put('CLAUDE.md', 'written by agentmesh init');
    put('.mcp.json', '{}');
    expect(detectProject(dir).kind).toBe('empty'); // still a new project after init ran
    put('README.md', '# hi');
    expect(isEmptyFolder(dir)).toBe(true);
    put('notes.txt', 'x');
    expect(isEmptyFolder(dir)).toBe(false);
    expect(detectProject(dir)).toMatchObject({ kind: 'unknown', verifyCommand: null });
    expect(detectProject(dir).notes[0]).toContain('verifyCommand');
  });
});

describe('agentmesh init on a new or unusual folder', () => {
  const setIdentity = (cwd: string) => {
    g(cwd, 'config', 'user.email', 'friend@example.com');
    g(cwd, 'config', 'user.name', 'Friend');
  };

  it('starts a new repository in an EMPTY folder and makes the first commit, so worktrees have something to branch from', async () => {
    // identity comes from the environment here: nothing is configured in the new repo
    const env = { GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.com' };
    Object.assign(process.env, env);
    try {
      await expect(initProject({ repoRoot: dir })).rejects.toMatchObject({ code: 'NOT_A_REPO' }); // asks first
      const r = await initProject({ repoRoot: dir, createRepo: true, commit: true });
      expect(r).toMatchObject({ repoCreated: true, config: { trunk: 'main', verifyCommand: null, landWithoutVerify: true }, detected: { kind: 'empty' } });
      expect(r.committed).toMatch(/^[0-9a-f]{7,}$/);
      expect(g(dir, 'log', '--format=%s')).toBe('AgentMesh setup (agentmesh init)');
      expect(g(dir, 'ls-files').split('\n').sort()).toEqual(['.agents/mcp_config.json', '.mcp.json', 'CLAUDE.md', 'GEMINI.md']);
      expect(g(dir, 'status', '--short')).toBe(''); // .agentmesh/ is excluded, nothing left over
      expect(existsSync(join(dir, '.agentmesh', 'config.json'))).toBe(true);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it('never starts a repository over a folder that has files in it, or sweeps them into a commit', async () => {
    put('secrets.env', 'KEY=1');
    await expect(initProject({ repoRoot: dir })).rejects.toMatchObject({ code: 'NOT_A_REPO_NOT_EMPTY' });
    await expect(initProject({ repoRoot: dir, createRepo: true })).rejects.toMatchObject({ code: 'NOT_A_REPO_NOT_EMPTY' });
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('stops with the exact commands to run when git has no name/email (agents commit with it)', async () => {
    g(dir, 'init', '-q', '-b', 'main');
    const saved = { ...process.env };
    const emptyGlobal = join(dir, 'empty-gitconfig');
    writeFileSync(emptyGlobal, '');
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
    try {
      const err = await initProject({ repoRoot: dir }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InitError);
      expect((err as InitError).code).toBe('GIT_IDENTITY');
      expect((err as Error).message).toContain('git config user.name');
      expect(existsSync(join(dir, '.agentmesh'))).toBe(false); // nothing half-written
    } finally {
      process.env = saved;
    }
  });

  it('commits only the files it wrote: not the user\'s staged work, and not a rulebook the user has uncommitted edits in', async () => {
    g(dir, 'init', '-q', '-b', 'main');
    setIdentity(dir);
    put('CLAUDE.md', '# Mine\n');
    put('app.txt', 'v1');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    put('CLAUDE.md', '# Mine\nUncommitted rule I am still writing.\n'); // the user's own uncommitted edit
    put('app.txt', 'v2 staged');
    g(dir, 'add', 'app.txt'); // staged, unrelated
    const r = await initProject({ repoRoot: dir, commit: true });
    expect(r.warnings.join(' ')).toContain('CLAUDE.md had your own uncommitted changes');
    expect(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['.agents/mcp_config.json', '.mcp.json', 'GEMINI.md']);
    expect(g(dir, 'diff', '--cached', '--name-only')).toBe('app.txt'); // still staged, untouched
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('Uncommitted rule I am still writing.');
  });

  it('adds a platform defined in config: its own rulebook, its friendly name, and unknown platforms are refused', async () => {
    g(dir, 'init', '-q', '-b', 'main');
    setIdentity(dir);
    put('x.txt', '1');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    mkdirSync(join(dir, '.agentmesh'));
    writeFileSync(
      join(dir, '.agentmesh', 'config.json'),
      JSON.stringify({
        trunk: 'main',
        verifyCommand: 'true',
        bootstrap: { strategy: 'none' },
        daemon: { port: 8934 },
        checklist: { required: [] },
        customPlatforms: [{ id: 'CODEX', label: 'Codex CLI', friendlyName: 'Codex', executable: process.execPath, args: ['{prompt}'] }],
        agents: [
          { id: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'CLAUDE.md' },
          { id: 'codex-1', platform: 'CODEX', rulebook: 'AGENTS.md' },
        ],
      }),
    );
    const r = await initProject({ repoRoot: dir });
    expect(r.created).toContain('AGENTS.md');
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('`codex-1`');
    expect(agents).toContain('Audits of your work come from Claude or the Human.');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('Audits of your work come from Codex or the Human.');

    const cfg = JSON.parse(readFileSync(join(dir, '.agentmesh', 'config.json'), 'utf8')) as { agents: { id: string; platform: string; rulebook: string }[] };
    cfg.agents.push({ id: 'x-1', platform: 'CURSOR', rulebook: 'CURSOR.md' });
    writeFileSync(join(dir, '.agentmesh', 'config.json'), JSON.stringify(cfg));
    await expect(initProject({ repoRoot: dir })).rejects.toThrow(/x-1 uses platform "CURSOR"/);
  });
});
