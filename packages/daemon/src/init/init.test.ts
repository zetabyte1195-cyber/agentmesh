import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECTION_BEGIN, SECTION_END, initProject } from './init.js';

let repo: string;
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const read = (f: string) => readFileSync(join(repo, f), 'utf8');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-init-'));
  g('init', '-q', '-b', 'trunk');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', check: 'npm run lint && npm test' } }));
  writeFileSync(join(repo, 'package-lock.json'), '{}');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('agentmesh init', () => {
  it('creates config, MCP entries for both CLIs, rulebooks and the git exclude on a fresh repo', async () => {
    const r = await initProject({ repoRoot: repo, port: 9999 });
    expect(r.created.sort()).toEqual(['.agentmesh/config.json', '.agents/mcp_config.json', '.mcp.json', 'CLAUDE.md', 'GEMINI.md']);
    expect(r.updated).toEqual(['.git/info/exclude']); // git init already creates info/exclude
    expect(r.config).toMatchObject({ trunk: 'trunk', verifyCommand: 'npm run check', bootstrap: { strategy: 'install', installCommand: 'npm ci' }, daemon: { port: 9999 } });

    // Formats verified against `claude mcp add --transport http` and `agy mcp add --header`.
    expect(JSON.parse(read('.mcp.json')).mcpServers.agentmesh).toEqual({ type: 'http', url: 'http://127.0.0.1:9999/mcp', headers: { Authorization: 'Bearer ${AGENTMESH_TOKEN}' } });
    expect(JSON.parse(read('.agents/mcp_config.json')).mcpServers.agentmesh).toEqual({ serverUrl: 'http://127.0.0.1:9999/mcp', headers: { Authorization: 'Bearer ${AGENTMESH_TOKEN}' }, disabled: false });

    expect(read('CLAUDE.md')).toContain('`claude-1`');
    expect(read('CLAUDE.md')).toContain('Gemini or the Human'); // friendly platform names
    expect(read('GEMINI.md')).toContain('`gemini-1`');
    expect(read('.git/info/exclude').split(/\r?\n/)).toContain('/.agentmesh/');
    expect(g('status', '--short')).not.toContain('.agentmesh'); // excluded
  });

  it('never writes a token to disk', async () => {
    await initProject({ repoRoot: repo });
    for (const f of ['.mcp.json', '.agents/mcp_config.json', '.agentmesh/config.json', 'CLAUDE.md', 'GEMINI.md']) expect(read(f)).not.toMatch(/amt_[A-Za-z0-9_-]{20,}/);
  });

  it("keeps the user's own rulebook text and other MCP servers, and replaces only its own section", async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# My project\n\nHouse rules stay.\n');
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: 1 }));
    await initProject({ repoRoot: repo });
    const claude = read('CLAUDE.md');
    expect(claude.startsWith('# My project\n\nHouse rules stay.\n')).toBe(true);
    expect(claude.split(SECTION_BEGIN)).toHaveLength(2);
    const mcp = JSON.parse(read('.mcp.json'));
    expect(mcp.mcpServers.other).toEqual({ command: 'x' });
    expect(mcp.extra).toBe(1);

    // A user edit INSIDE the section is replaced on re-run; outside edits survive.
    writeFileSync(join(repo, 'CLAUDE.md'), claude.replace('Every session', 'HAND EDIT') + '\nTrailing user note.\n');
    await initProject({ repoRoot: repo });
    const again = read('CLAUDE.md');
    expect(again).not.toContain('HAND EDIT');
    expect(again).toContain('Trailing user note.');
    expect(again.split(SECTION_BEGIN)).toHaveLength(2);
    expect(again.split(SECTION_END)).toHaveLength(2);
  });

  it('is idempotent and never overwrites a tuned config.json', async () => {
    await initProject({ repoRoot: repo });
    const tuned = { ...JSON.parse(read('.agentmesh/config.json')), verifyCommand: 'make verify' };
    writeFileSync(join(repo, '.agentmesh', 'config.json'), JSON.stringify(tuned));
    const second = await initProject({ repoRoot: repo });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.config.verifyCommand).toBe('make verify');
  });

  it('leaves verifyCommand unset when the project has no test script (the Human must set it)', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: {} }));
    expect((await initProject({ repoRoot: repo })).config.verifyCommand).toBeNull();
  });

  it('refuses to run outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'agentmesh-nogit-'));
    await expect(initProject({ repoRoot: plain })).rejects.toThrow();
    rmSync(plain, { recursive: true, force: true });
  });
});
