import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { type RunningDaemon, startDaemon } from '../start/index.js';

let repo: string;
let d: RunningDaemon;
let cookie: string;
let origin: string;
const clients: Client[] = [];
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: d.port, method, path, headers: { Host: `127.0.0.1:${d.port}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (c: string) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? (JSON.parse(data) as Record<string, unknown>) : {} }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const asHuman = (path: string, body: unknown) => send('POST', path, { Cookie: cookie, Origin: origin }, body);
const state = async () => (await send('GET', '/api/state', { Cookie: cookie })).json as { missions: { id: string; status: string; tasks: { id: string; suggestedOwner: string | null }[]; waitingOn: string[]; plan: { version: number; body: string } | null }[] };

async function agent(id: string): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }> }> {
  const token = d.identity.issueToken(id, 'e2e');
  const client = new Client({ name: id, version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return {
    call: async (name, args) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: Boolean(r.isError), text: r.content[0]?.text ?? '' };
    },
  };
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mission-e2e-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  await initProject({ repoRoot: repo, commit: true });
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
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await d.stop();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

describe('a mission end to end: the Human through the cockpit API, agents through MCP', () => {
  it('brief → plan → gaps → revised plan → approval → tasks the dispatcher can run', async () => {
    const claude = await agent('claude-1');
    const gemini = await agent('gemini-1');

    const created = await asHuman('/api/missions', { title: 'Car wash app', brief: 'Build a small web app for a car wash: customers pick a package and a time slot.', plannerAgentId: 'claude-1' });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ id: 'M1', status: 'PLANNING', planner: 'claude-1', reviewers: ['gemini-1'] });

    // the planner reads the brief and hands in a plan
    const read = await claude.call('mesh_get_mission', { missionId: 'M1' });
    expect(read.text).toContain('car wash');
    expect((await claude.call('mesh_submit_plan', { missionId: 'M1', body: '# Plan\n\nA booking page with packages and slots, tested with node:test.' })).isError).toBe(false);
    expect((await state()).missions[0]).toMatchObject({ status: 'REVIEWING', waitingOn: ['gemini-1'] });

    // an agent cannot decide for the Human, and the planner cannot review itself
    expect((await claude.call('mesh_submit_plan_review', { missionId: 'M1', planVersion: 1, verdict: 'OK' })).text).toContain('not a reviewer');
    expect((await send('POST', '/api/missions/approve', { Authorization: `Bearer ${d.identity.issueToken('claude-1', 'x')}` }, { missionId: 'M1' })).status).toBe(403);

    // the reviewer finds gaps; the planner merges them
    expect((await gemini.call('mesh_submit_plan_review', { missionId: 'M1', planVersion: 1, verdict: 'GAPS', gaps: 'Nothing about cancelling a booking or double-booked slots.' })).isError).toBe(false);
    expect((await state()).missions[0]).toMatchObject({ status: 'REVISING', waitingOn: ['claude-1'] });
    const again = await claude.call('mesh_get_mission', { missionId: 'M1' });
    expect(again.text).toContain('double-booked');
    await claude.call('mesh_submit_plan', { missionId: 'M1', body: '# Plan v2\n\nAdds cancellation and a double-booking check.\n\n## Changes from review\nAdded both.' });
    expect((await state()).missions[0]).toMatchObject({ status: 'PLAN_READY', waitingOn: ['human'], plan: { version: 2 } });

    // tasks cannot be made before the Human approves
    const early = await claude.call('mesh_create_task', { id: 'M1-1', phase: 'mission:M1', title: 'Scaffold', acceptanceCriteria: 'tests run' });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('only while it is SPLITTING');

    expect((await asHuman('/api/missions/approve', { missionId: 'M1' })).json).toMatchObject({ status: 'SPLITTING' });

    // splitting: a bad owner is refused with the valid choices; a good one is stored the way the dispatcher matches it
    const bad = await claude.call('mesh_create_task', { id: 'M1-1', phase: 'mission:M1', title: 'Scaffold', acceptanceCriteria: 'tests run', suggestedOwner: 'Cursor' });
    expect(bad.text).toMatch(/matches no agent.*Claude.*Gemini.*Pair/s);
    expect((await claude.call('mesh_create_task', { id: 'M1-1', phase: 'mission:M1', title: 'Scaffold', acceptanceCriteria: 'tests run', suggestedOwner: 'gemini' })).isError).toBe(false);
    expect((await claude.call('mesh_create_task', { id: 'M1-2', phase: 'mission:M1', title: 'Packages', acceptanceCriteria: 'listed', prerequisites: ['M1-1'], suggestedOwner: 'Claude' })).isError).toBe(false);
    expect((await gemini.call('mesh_finish_split', { missionId: 'M1' })).text).toContain('Only the planner');
    expect((await claude.call('mesh_finish_split', { missionId: 'M1' })).isError).toBe(false);

    const m = (await state()).missions[0]!;
    expect(m.status).toBe('IMPLEMENTING');
    expect(m.tasks.map((t) => [t.id, t.suggestedOwner])).toEqual([['M1-1', 'Gemini'], ['M1-2', 'Claude']]);

    // and the normal engine can now pick the first task up: Gemini gets M1-1, and M1-2 waits for its prerequisite
    expect(d.dispatcher.nextWork({ agentId: 'gemini-1', platform: 'ANTIGRAVITY', ownerNames: ['Gemini'], rulebook: 'GEMINI.md', command: () => { throw new Error('unused'); } })).toMatchObject({ kind: 'TASK', taskId: 'M1-1' });
    expect(d.dispatcher.nextWork({ agentId: 'claude-1', platform: 'CLAUDE_CODE', ownerNames: ['Claude'], rulebook: 'CLAUDE.md', command: () => { throw new Error('unused'); } })).toBeNull();
  });

  it('only the Human, only with a real session and the daemon\'s own origin, may start or steer a mission', async () => {
    const body = { title: 'x', brief: 'Build something small and useful for testing.', plannerAgentId: 'claude-1' };
    expect((await send('POST', '/api/missions', { Cookie: cookie }, body)).status).toBe(403); // no Origin
    expect((await send('POST', '/api/missions', { Cookie: cookie, Origin: 'http://evil.example' }, body)).status).toBe(403);
    expect((await send('POST', '/api/missions', {}, body)).status).toBe(401);
    expect((await asHuman('/api/missions', { ...body, plannerAgentId: 'nobody' })).status).toBe(409);
    expect((await asHuman('/api/missions', { ...body, brief: 'short' })).status).toBe(400);
    expect((await asHuman('/api/missions/approve', { missionId: 'M9' })).status).toBe(409);
    expect((await asHuman('/api/missions', body)).status).toBe(200);
    expect((await asHuman('/api/missions/approve', { missionId: 'M1' })).status).toBe(409); // still PLANNING
    expect((await asHuman('/api/missions/cancel', { missionId: 'M1' })).json).toMatchObject({ status: 'CANCELLED' });
  });
});
