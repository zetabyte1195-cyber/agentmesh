import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { callDaemon, daemonFile, NotRunningError, projectRoot, readDaemonRecord } from './runtime.js';
import { startDaemon, type RunningDaemon } from './start.js';
import { formatStatus, projectStatus } from './status.js';

let repo: string;
let home: string;
let daemon: RunningDaemon | null = null;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-rt-'));
  home = mkdtempSync(join(tmpdir(), 'agentmesh-home-'));
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

describe('command line ↔ running daemon', () => {
  it('status works with AgentMesh stopped, read-only', async () => {
    const s = await projectStatus(repo, { runtimeDir: home });
    expect(s.running).toBeNull();
    expect(s.agents.map((a) => a.id)).toEqual(['claude-1', 'gemini-1']);
    expect(formatStatus(s)).toContain('AgentMesh is not running');
  });

  it('records itself, answers the command line with its Human token, and cleans up on stop', async () => {
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {}, record: true, runtimeDir: home });
    const root = await projectRoot(repo);
    const rec = readDaemonRecord(root, home)!;
    expect(rec).toMatchObject({ port: daemon.port, pid: process.pid });

    // a fresh cockpit link, usable once
    const { url } = await callDaemon<{ url: string }>(root, 'POST', '/api/login-link', undefined, home);
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${daemon.port}/`));

    // dispatch pause/resume goes through the same route (and timeline) as the cockpit button
    expect(await callDaemon(root, 'POST', '/api/dispatch', { paused: true, agentId: 'gemini-1' }, home)).toEqual({ paused: true });
    let s = await projectStatus(repo, { runtimeDir: home });
    expect(s.running).toEqual({ port: daemon.port, pid: process.pid });
    expect(s.agents.find((a) => a.id === 'gemini-1')?.status).toBe('PAUSED');
    expect(s.dispatchPaused).toBe(false);
    await callDaemon(root, 'POST', '/api/dispatch', { paused: true }, home);
    s = await projectStatus(repo, { runtimeDir: home });
    expect(s.dispatchPaused).toBe(true);
    expect(formatStatus(s)).toContain('Dispatching: PAUSED');

    // stop: answered first, then stopRequested resolves
    await callDaemon(root, 'POST', '/api/stop', undefined, home);
    await daemon.stopRequested;
    const timeline = daemon.db.prepare("SELECT text FROM events WHERE agent_id = 'human' ORDER BY created_at, rowid").all() as { text: string }[];
    expect(timeline.map((e) => e.text).join('\n')).toMatch(/stopped AgentMesh/);
    await daemon.stop();
    daemon = null;
    expect(existsSync(daemonFile(root, home))).toBe(false);
    await expect(callDaemon(root, 'POST', '/api/login-link', undefined, home)).rejects.toBeInstanceOf(NotRunningError);
  });

  it('Human controls: release a task\'s file locks (G5), try stuck work again (G2); the snapshot shows locks, stuck work and usage', async () => {
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {}, record: true, runtimeDir: home });
    const root = await projectRoot(repo);
    const db = daemon.db;
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id) VALUES ('T1', 'p', 'T1', 'ac', 'IN_PROGRESS', 'claude-1')").run();
    db.prepare("INSERT INTO leases (id, task_id, agent_id, resource_type, resource_path, expires_at) VALUES ('L1', 'T1', 'claude-1', 'FILE', 'src/a.ts', '2999-01-01 00:00:00')").run();

    type State = { leases: { taskId: string; path: string }[]; usage: { byAgent: unknown[] }; dispatch: { stuck: unknown[] } };
    let state = await callDaemon<State>(root, 'GET', '/api/state', undefined, home);
    expect(state.leases.map((l) => [l.taskId, l.path])).toEqual([['T1', 'src/a.ts']]);
    expect(state.usage).toEqual({ byAgent: [], byMission: [] });
    expect(state.dispatch.stuck).toEqual([]);

    expect(await callDaemon(root, 'POST', '/api/leases/release', { taskId: 'T1' }, home)).toEqual({ released: 1 });
    state = await callDaemon<State>(root, 'GET', '/api/state', undefined, home);
    expect(state.leases).toEqual([]);

    expect(await callDaemon(root, 'POST', '/api/retry', { agentId: 'claude-1', subject: 'T1' }, home)).toEqual({ ok: true });
    await expect(callDaemon(root, 'POST', '/api/retry', { agentId: 'nobody', subject: 'T1' }, home)).rejects.toThrow('No connected agent');
    const timeline = (db.prepare("SELECT text FROM events WHERE agent_id = 'human'").all() as { text: string }[]).map((e) => e.text).join('\n');
    expect(timeline).toContain('released 1 file lock held for task T1');
    expect(timeline).toContain('asked claude-1 to try task T1 again');
  });

  it('a stale record (process gone) reads as not running', async () => {
    const root = await projectRoot(repo);
    const { writeDaemonRecord } = await import('./runtime.js');
    writeDaemonRecord({ root, port: 1, pid: 2 ** 22 + 12345, token: 'x', startedAt: new Date().toISOString() }, home);
    await expect(callDaemon(root, 'GET', '/api/state', undefined, home)).rejects.toBeInstanceOf(NotRunningError);
    expect((await projectStatus(repo, { runtimeDir: home })).running).toBeNull();
  });

  it('the command-line token stops working when the daemon stops', async () => {
    daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {}, record: true, runtimeDir: home });
    const root = await projectRoot(repo);
    const { token, port } = readDaemonRecord(root, home)!;
    await daemon.stop();
    daemon = null;
    // Same database, new daemon on the same port: the old token must be refused.
    daemon = await startDaemon({ repoRoot: repo, port, autoDispatch: false, log: () => {} });
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});
