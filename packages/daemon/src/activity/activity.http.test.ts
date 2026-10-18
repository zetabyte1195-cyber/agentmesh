// The live feed through the real daemon: what the cockpit reads, what it is pushed, and who may ask.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { type RunningDaemon, startDaemon } from '../start/index.js';

let repo: string;
let d: RunningDaemon;
let cookie: string;
let origin: string;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: d.port, method, path, headers: { Host: `127.0.0.1:${d.port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (c: string) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const get = (path: string) => send('GET', path, { Cookie: cookie });
const post = (path: string, body: unknown) => send('POST', path, { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body);

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-activity-http-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@example.com');
  g(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# project\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  await initProject({ repoRoot: repo, commit: true, agents: [{ id: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'CLAUDE.md' }] });
  d = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
  origin = `http://127.0.0.1:${d.port}`;
  const login = new URL(d.loginUrl);
  cookie = await new Promise<string>((resolve) => {
    request({ host: '127.0.0.1', port: d.port, path: login.pathname + login.search, headers: { Host: `127.0.0.1:${d.port}` } }, (r) => {
      r.resume();
      resolve(String(r.headers['set-cookie']).split(';')[0]!);
    }).end();
  });
});
afterEach(async () => {
  await d.stop();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

const feed = (runId = 'r1') => {
  d.activity.begin(runId, { agentId: 'claude-1', taskId: null, cwd: repo });
  d.activity.record(runId, { kind: 'tool_use', name: 'Edit', id: 'u1', target: join(repo, 'src', 'a.ts'), targetKind: 'file' });
};

describe('reading a run\'s activity', () => {
  it('gives the entries, only the newer ones when asked, and says plainly when a run is not kept', async () => {
    feed();
    const all = (await get('/api/activity?runId=r1')).json as { kept: boolean; running: boolean; agentId: string; entries: { seq: number; text: string }[] };
    expect(all).toMatchObject({ kept: true, running: true, agentId: 'claude-1' });
    expect(all.entries.map((e) => e.text)).toEqual(['Started', 'Edited src/a.ts']);
    expect(((await get('/api/activity?runId=r1&after=1')).json as typeof all).entries.map((e) => e.seq)).toEqual([2]);
    expect((await get('/api/activity?runId=nope')).json).toEqual({ runId: 'nope', kept: false, running: false, entries: [] });
    expect((await get('/api/activity')).status).toBe(400);
  });

  it('is the Human\'s: an agent token or no session is refused', async () => {
    feed();
    expect((await send('GET', '/api/activity?runId=r1', {})).status).toBe(401);
    const token = d.identity.issueToken('claude-1', 'test');
    expect((await send('GET', '/api/activity?runId=r1', { Authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await send('GET', '/api/changes?taskId=T', { Authorization: `Bearer ${token}` })).status).toBe(403);
  });
});

describe('the snapshot and the live push', () => {
  it('says what each working agent is doing right now, and nothing once its run is over', async () => {
    feed();
    const s = (await get('/api/state')).json as { live: Record<string, { runId: string; entries: { text: string }[] }> };
    expect(s.live['claude-1']).toMatchObject({ runId: 'r1' });
    expect(s.live['claude-1']!.entries.map((e) => e.text)).toEqual(['Started', 'Edited src/a.ts']);
    d.activity.end('r1', 'SUCCEEDED');
    expect(((await get('/api/state')).json as { live: object }).live).toEqual({});
  });

  it('pushes the changes to an open cockpit as they happen', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws/cockpit`, { headers: { Cookie: cookie, Origin: origin } });
    await new Promise((r) => ws.once('open', r));
    const got = new Promise<{ type: string; payload: { runId: string; running: boolean; entries: { text: string }[] } }>((resolve) =>
      ws.on('message', (m) => {
        const msg = JSON.parse(String(m)) as { type: string; payload: { entries: { text: string }[] } };
        if (msg.type === 'ACTIVITY' && msg.payload.entries.some((e) => e.text === 'Edited src/a.ts')) resolve(msg as never);
      }),
    );
    feed();
    const msg = await got;
    ws.close();
    expect(msg.payload).toMatchObject({ runId: 'r1', running: true });
  });
});

describe('the files a task changed', () => {
  const addTask = (id: string, worktree: string | null) =>
    d.db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES (?, 'p', 't', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(id, worktree);

  it('reads them from the task\'s workspace', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T1');
    g(repo, 'worktree', 'add', '-q', '-b', 'mesh/t1', wt, 'main');
    writeFileSync(join(wt, 'new.txt'), 'a\nb\n');
    writeFileSync(join(wt, 'README.md'), '# project\nmore\n');
    addTask('T1', wt);
    const r = (await get('/api/changes?taskId=T1')).json as { workspace: boolean; files: { path: string; status: string; added: number }[] };
    expect(r.workspace).toBe(true);
    expect(r.files.map((f) => [f.path, f.status, f.added])).toEqual([['new.txt', 'added', 2], ['README.md', 'modified', 1]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it('a task with no workspace yet has no files, and an unknown task is a 404', async () => {
    addTask('T2', null);
    expect((await get('/api/changes?taskId=T2')).json).toEqual({ taskId: 'T2', workspace: false, files: [], truncated: false });
    expect((await get('/api/changes?taskId=NOPE')).status).toBe(404);
    expect((await get('/api/changes')).status).toBe(400);
  });

  it('will not read a folder that is not inside this project, whatever the database says', async () => {
    addTask('T3', tmpdir());
    const r = (await get('/api/changes?taskId=T3')).json as { workspace: boolean; files: unknown[] };
    expect(r).toMatchObject({ workspace: false, files: [] });
  });
});

describe('opening a task in the editor', () => {
  const addTask = (id: string, worktree: string | null) =>
    d.db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES (?, 'p', 't', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(id, worktree);
  const saved = { editor: process.env['AGENTMESH_EDITOR'], path: process.env['PATH'] };
  afterEach(() => {
    if (saved.editor === undefined) delete process.env['AGENTMESH_EDITOR'];
    else process.env['AGENTMESH_EDITOR'] = saved.editor;
    process.env['PATH'] = saved.path;
  });

  it('refuses in plain words: no such task, no workspace yet, a folder outside the project, an editor that is not installed', async () => {
    addTask('T1', null);
    addTask('T2', tmpdir());
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T3');
    g(repo, 'worktree', 'add', '-q', '-b', 'mesh/t3', wt, 'main'); // a real workspace, as AgentMesh makes them
    addTask('T3', wt);
    expect((await post('/api/workspace/open', { taskId: 'NOPE' })).status).toBe(404);
    expect((await post('/api/workspace/open', {})).status).toBe(400);
    expect(((await post('/api/workspace/open', { taskId: 'T1' })).json as { error: string }).error).toMatch(/no workspace yet/);
    expect(((await post('/api/workspace/open', { taskId: 'T2' })).json as { error: string }).error).toMatch(/not inside the project/);
    process.env['AGENTMESH_EDITOR'] = 'no-such-editor-xyz';
    expect(((await post('/api/workspace/open', { taskId: 'T3' })).json as { error: string }).error).toContain('"no-such-editor-xyz" was not found');
  });

  it('is the Human\'s, from the cockpit page itself: an agent, no session, or a request from another page is refused', async () => {
    addTask('T1', null);
    const token = d.identity.issueToken('claude-1', 'test');
    expect((await send('POST', '/api/workspace/open', { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, { taskId: 'T1' })).status).toBe(403);
    expect((await send('POST', '/api/workspace/open', { Origin: origin, 'Content-Type': 'application/json' }, { taskId: 'T1' })).status).toBe(401);
    expect((await send('POST', '/api/workspace/open', { Cookie: cookie, 'Content-Type': 'application/json' }, { taskId: 'T1' })).status).toBe(403); // no Origin
    expect((await send('POST', '/api/workspace/open', { Cookie: cookie, Origin: 'http://evil.example', 'Content-Type': 'application/json' }, { taskId: 'T1' })).status).toBe(403);
  });

  it('does not open a workspace whose link back to the project was rewritten', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T7');
    g(repo, 'worktree', 'add', '-q', '-b', 'mesh/t7', wt, 'main');
    addTask('T7', wt);
    process.env['AGENTMESH_EDITOR'] = 'no-such-editor-xyz'; // if it got as far as the editor, this is what would be said
    const fine = await post('/api/workspace/open', { taskId: 'T7' });
    expect((fine.json as { error: string }).error).toContain('"no-such-editor-xyz" was not found'); // a genuine one gets as far as the editor
    const other = mkdtempSync(join(tmpdir(), 'agentmesh-other-'));
    try {
      g(other, 'init', '-q', '-b', 'main');
      rmSync(join(wt, '.git'), { force: true });
      writeFileSync(join(wt, '.git'), `gitdir: ${join(other, '.git')}\n`);
      const r = await post('/api/workspace/open', { taskId: 'T7' });
      expect(r.status).toBe(409);
      expect((r.json as { error: string }).error).toMatch(/no longer linked to this project/);
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('does not open a folder with editor settings the agent wrote (they can run programs once the folder is trusted) until the person says yes', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T6');
    g(repo, 'worktree', 'add', '-q', '-b', 'mesh/t6', wt, 'main'); // a real workspace, as AgentMesh makes them
    mkdirSync(join(wt, '.vscode'), { recursive: true });
    writeFileSync(join(wt, '.vscode', 'tasks.json'), '{}');
    addTask('T6', wt);
    const bin = mkdtempSync(join(tmpdir(), 'agentmesh-fake-editor-'));
    const report = join(bin, 'argv.json');
    try {
      writeFileSync(join(bin, 'report.cjs'), "require('fs').writeFileSync(process.env.REPORT, JSON.stringify(process.argv.slice(2)))");
      writeFileSync(join(bin, process.platform === 'win32' ? 'fake-editor.cmd' : 'fake-editor'), process.platform === 'win32' ? '@node "%~dp0report.cjs" %*\r\n' : '#!/bin/sh\nexec node "$(dirname "$0")/report.cjs" "$@"\n', { mode: 0o755 });
      const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      process.env[key] = `${bin}${delimiter}${process.env[key] ?? ''}`;
      process.env['REPORT'] = report;
      process.env['AGENTMESH_EDITOR'] = 'fake-editor';
      const first = await post('/api/workspace/open', { taskId: 'T6' });
      expect(first).toMatchObject({ status: 200, json: { ok: false, needsConfirm: true, found: ['.vscode'] } });
      expect((first.json as { message: string }).message).toMatch(/\.vscode/);
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(report)).toBe(false); // nothing was started
      const second = await post('/api/workspace/open', { taskId: 'T6', confirm: true });
      expect(second).toMatchObject({ status: 200, json: { ok: true, editor: 'fake-editor' } });
      for (let i = 0; i < 80 && !existsSync(report); i++) await new Promise((res) => setTimeout(res, 50));
      expect(existsSync(report)).toBe(true);
    } finally {
      delete process.env['REPORT'];
      rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('opens the task\'s folder, from the task and not from the request, and records it in the timeline', async () => {
    const wt = join(repo, '.agentmesh', 'worktrees', 'wt-T4');
    g(repo, 'worktree', 'add', '-q', '-b', 'mesh/t4', wt, 'main'); // a real workspace, as AgentMesh makes them
    addTask('T4', wt);
    const bin = mkdtempSync(join(tmpdir(), 'agentmesh-fake-editor-'));
    const report = join(bin, 'argv.json');
    try {
      writeFileSync(join(bin, 'report.cjs'), "require('fs').writeFileSync(process.env.REPORT, JSON.stringify(process.argv.slice(2)))");
      writeFileSync(join(bin, process.platform === 'win32' ? 'fake-editor.cmd' : 'fake-editor'), process.platform === 'win32' ? '@node "%~dp0report.cjs" %*\r\n' : '#!/bin/sh\nexec node "$(dirname "$0")/report.cjs" "$@"\n', { mode: 0o755 });
      const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      process.env[key] = `${bin}${delimiter}${process.env[key] ?? ''}`;
      process.env['REPORT'] = report;
      process.env['AGENTMESH_EDITOR'] = 'fake-editor';
      const r = await post('/api/workspace/open', { taskId: 'T4', path: '/etc' }); // a path in the request is not looked at
      expect(r).toMatchObject({ status: 200, json: { ok: true, editor: 'fake-editor' } });
      for (let i = 0; i < 80 && !existsSync(report); i++) await new Promise((res) => setTimeout(res, 50));
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual([wt]);
      const events = ((await get('/api/state')).json as { events: { text: string }[] }).events.map((e) => e.text);
      expect(events.some((t) => t.includes('opened the workspace of T4 in fake-editor'))).toBe(true);
    } finally {
      delete process.env['REPORT'];
      rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
