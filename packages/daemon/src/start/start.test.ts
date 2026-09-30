import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { startDaemon, type RunningDaemon } from './start.js';

let repo: string;
let daemon: RunningDaemon | null = null;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-start-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

describe('agentmesh start', () => {
  it('refuses to start before `agentmesh init`', async () => {
    await expect(startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} })).rejects.toThrow('agentmesh init');
  });

  it('assembles DB, agents, server, MCP, cockpit and merge queue from the init config', async () => {
    await initProject({ repoRoot: repo });
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });

    const agents = daemon.db.prepare('SELECT id, platform FROM agents ORDER BY id').all();
    expect(agents).toEqual([
      { id: 'claude-1', platform: 'CLAUDE_CODE' },
      { id: 'gemini-1', platform: 'ANTIGRAVITY' },
      { id: 'human', platform: 'HUMAN' },
    ]);
    expect(daemon.mergeQueue).not.toBeNull(); // verifyCommand detected from package.json

    // Cockpit login works once; the snapshot is then available.
    const login = new URL(daemon.loginUrl);
    const first = await get(daemon.port, login.pathname + login.search);
    expect(first.status).toBe(303);
    const cookie = String(first.headers['set-cookie']).split(';')[0]!;
    expect((await get(daemon.port, '/api/state', { Cookie: cookie })).status).toBe(200);

    // An agent with a token reaches the MCP tools.
    const token = daemon.identity.issueToken('claude-1', 'test');
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.length).toBe(25); // 18 spec tools + mesh_get_diff + mesh_run_verification + mesh_commit + 4 mission tools
    expect(names).toContain('mesh_commit');
    expect(names).toEqual(expect.arrayContaining(['mesh_get_mission', 'mesh_submit_plan', 'mesh_submit_plan_review', 'mesh_finish_split']));
    await client.close();
  });

  it('restarts cleanly on the same repository (idempotent migrations, no duplicate agents)', async () => {
    await initProject({ repoRoot: repo });
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
    await daemon.stop();
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
    expect((daemon.db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number }).n).toBe(3);
  });

  it('refuses a platform it has no adapter for, instead of launching it as agy', async () => {
    await initProject({ repoRoot: repo });
    const configPath = join(repo, '.agentmesh', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { agents: { id: string; platform: string; rulebook: string }[] };
    config.agents.push({ id: 'cursor-1', platform: 'CURSOR', rulebook: 'CLAUDE.md' });
    writeFileSync(configPath, JSON.stringify(config));
    await expect(startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} })).rejects.toThrow('Unsupported platform in .agentmesh/config.json: cursor-1 (CURSOR)');
  });
});
