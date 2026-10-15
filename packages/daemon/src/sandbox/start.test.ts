// Task 9 through the real daemon: refusing to start on a bad section, the second listener, the snapshot.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { callDaemon, projectRoot } from '../start/runtime.js';
import { startDaemon, type RunningDaemon } from '../start/start.js';

let repo: string;
let home: string;
let daemon: RunningDaemon | null = null;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const configPath = () => join(repo, '.agentmesh', 'config.json');
const setSandbox = (sandbox: unknown) => {
  const c = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  c.sandbox = sandbox;
  writeFileSync(configPath(), JSON.stringify(c, null, 2));
};
// "container-tool-for-tests" is not docker or podman, so AgentMesh makes no attempt to talk to a container engine here.
const GOOD = { image: 'my-agents:latest', checks: 'host', wrapper: ['container-tool-for-tests', 'run', '--name', '{name}', '--label', 'agentmesh.project={projectId}', '{env}', '{image}'], stop: ['container-tool-for-tests', 'rm', '{name}'], commands: { CLAUDE_CODE: 'claude' } };

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-sbxstart-'));
  home = mkdtempSync(join(tmpdir(), 'agentmesh-sbxhome-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  await initProject({ repoRoot: repo });
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('container mode in the daemon', () => {
  it('refuses to start on an invalid section: it never falls back to running agents outside a container', async () => {
    setSandbox({ image: 'x', checks: 'host', wrapper: ['docker', 'run', '{image}'] });
    await expect(startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} })).rejects.toThrow(/"sandbox" section .* not valid|name \{name\}/);
    setSandbox({ image: 'x', checks: 'host', wrapper: ['docker', 'run', '--name', '{name}', '{env}', '{image}'], surprise: 1 });
    await expect(startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} })).rejects.toThrow(/Unrecognized key/);
  });

  it('without the section, nothing changes: no second listener, and the snapshot says so', async () => {
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {}, record: true, runtimeDir: home });
    const state = await callDaemon<Record<string, unknown>>(await projectRoot(repo), 'GET', '/api/state', undefined, home);
    expect(state.sandbox).toBeNull();
  });

  it('with a valid section, serves MCP (and only MCP) on its own listener, and reports itself as experimental', async () => {
    setSandbox(GOOD);
    const lines: string[] = [];
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: (l) => lines.push(l), record: true, runtimeDir: home });
    const state = await callDaemon<{ sandbox: { enabled: boolean; experimental: boolean; image: string; listener: { host: string; port: number }; blockedReason: string | null; warnings: string[] } }>(await projectRoot(repo), 'GET', '/api/state', undefined, home);
    expect(state.sandbox).toMatchObject({ enabled: true, experimental: true, image: 'my-agents:latest', blockedReason: null });
    expect(state.sandbox.listener.host).toBe('127.0.0.1');
    expect(state.sandbox.listener.port).not.toBe(daemon.port);
    expect(state.sandbox.warnings.join(' ')).toContain('--memory'); // the sample wrapper has no limits: it says so
    expect(lines.join('\n')).toMatch(/Container mode \(experimental\)/);

    // a real MCP client with an agent's own token reaches the tools through the container listener
    const token = daemon.identity.issueToken('claude-1', 'test');
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${state.sandbox.listener.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    expect((await client.listTools()).tools.length).toBe(27);
    await client.close();

    // ...and the cockpit's own routes are not there
    for (const path of ['/', '/api/state', '/login', '/api/stop']) {
      const res = await fetch(`http://127.0.0.1:${state.sandbox.listener.port}${path}`, { method: path === '/api/stop' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(404);
    }
    // a Human token is refused on it, even a valid one
    const humanToken = daemon.identity.issueToken('human', 'test');
    const res = await fetch(`http://127.0.0.1:${state.sandbox.listener.port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('the cockpit cannot change the sandbox section (it decides what gets executed): settings reject it, and a save keeps it', async () => {
    setSandbox(GOOD);
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {}, record: true, runtimeDir: home });
    const root = await projectRoot(repo);
    await expect(callDaemon(root, 'POST', '/api/settings', { sandbox: { image: 'evil', wrapper: ['x', '--name', '{name}', '{env}'] } }, home)).rejects.toThrow();
    await callDaemon(root, 'POST', '/api/settings', { projectContext: 'hello' }, home); // any save rewrites the file...
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).sandbox).toEqual(GOOD); // ...and the section survives untouched
  });
});

describe('agentmesh doctor with container mode', () => {
  it('reports an invalid section as a failure that says AgentMesh will not start', async () => {
    const { runDoctor } = await import('../doctor/doctor.js');
    setSandbox({ image: 'x', checks: 'host', wrapper: ['docker', 'run', '{image}'] });
    const report = await runDoctor({ repoRoot: repo, port: 0 });
    const bad = report.checks.find((c) => c.title === 'The "sandbox" section is not valid');
    expect(bad).toMatchObject({ level: 'fail' });
    expect(bad!.fix).toMatch(/never falls back to running agents outside the container/);
    expect(report.ok).toBe(false);
  });

  it('runs the real probes through the wrapper, and says when the container command does not exist', async () => {
    const { runDoctor } = await import('../doctor/doctor.js');
    setSandbox(GOOD);
    const report = await runDoctor({ repoRoot: repo, port: 0 });
    const titles = report.checks.map((c) => `${c.level}: ${c.title}`).join('\n');
    expect(titles).toContain('warn: Container wrapper'); // no limits in the sample wrapper
    expect(titles).toMatch(/fail: The probe container did not run/);
    expect(report.checks.find((c) => /runs in the container/.test(c.title))).toBeDefined(); // Claude is checked in the image, not on this computer
  }, 60_000);
});
