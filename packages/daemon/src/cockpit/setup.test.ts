import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { type RunningDaemon, startDaemon } from '../start/index.js';

let repo: string;
let d: RunningDaemon;
let cookie: string;
let origin: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const config = () => JSON.parse(readFileSync(join(repo, '.agentmesh', 'config.json'), 'utf8')) as Record<string, unknown> & { agents: { id: string; platform: string; rulebook: string }[] };

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: d.port, method, path, headers: { Host: `127.0.0.1:${d.port}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (c: string) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const post = (path: string, body: unknown) => send('POST', path, { Cookie: cookie, Origin: origin }, body);
const get = (path: string) => send('GET', path, { Cookie: cookie });

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-setup-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# new project\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  await initProject({
    repoRoot: repo,
    commit: true,
    agents: [{ id: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'CLAUDE.md' }],
    // a tool defined in config; node itself stands in for it (it answers --version)
    customPlatforms: [{ id: 'FAKE', label: 'Fake Tool', friendlyName: 'Fake', executable: process.execPath, args: ['-e', '0', '{prompt}'] }],
  });
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

describe('the cockpit setup panel', () => {
  it('a new project starts landing on review alone; the snapshot says so and suggests a check once one exists', async () => {
    const s = ((await get('/api/state')).json as { setup: { project: Record<string, unknown>; platforms: { id: string; agents: string[]; verified: boolean }[] } }).setup;
    expect(s.project).toMatchObject({ verifyCommand: null, landWithoutVerify: true, landing: true, suggestedVerifyCommand: null });
    expect(s.platforms.map((p) => [p.id, p.verified, p.agents])).toEqual([['CLAUDE_CODE', true, ['claude-1']], ['ANTIGRAVITY', true, []], ['FAKE', false, []]]);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const later = ((await get('/api/state')).json as { setup: { project: { suggestedVerifyCommand: string | null } } }).setup.project;
    expect(later.suggestedVerifyCommand).toBe('npm test'); // the cockpit offers it; the Human decides
  });

  it('changing the project check is live (no restart), saved to config.json, and recorded in the timeline', async () => {
    const r = await post('/api/settings', { verifyCommand: 'npm test' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ verifyCommand: 'npm test', landWithoutVerify: false, landing: true });
    expect(config().verifyCommand).toBe('npm test');
    expect(config().landWithoutVerify).toBeUndefined(); // a real check replaces the new-project shortcut
    expect((d.db.prepare("SELECT text FROM events WHERE kind = 'decision' ORDER BY rowid DESC LIMIT 1").get() as { text: string }).text).toContain('project check is now "npm test"');

    const off = await post('/api/settings', { verifyCommand: null, landWithoutVerify: false });
    expect(off.json).toMatchObject({ verifyCommand: null, landing: false }); // nothing lands until the Human decides
  });

  it('refuses anything that is not a one-line command, and unknown fields', async () => {
    expect((await post('/api/settings', { verifyCommand: 'npm test\nrm -rf /' })).status).toBe(400);
    expect((await post('/api/settings', { verifyCommand: '' })).status).toBe(400);
    expect((await post('/api/settings', { trunk: 'evil' })).status).toBe(400);
    expect((await post('/api/settings', {})).status).toBe(400);
    expect(config().trunk).toBe('main');
  });

  it('connects another agent while running: config, database, dispatcher and its rulebook (committed)', async () => {
    const r = await post('/api/agents', { platform: 'FAKE' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ agent: { id: 'fake-1', platform: 'FAKE', rulebook: 'AGENTS.md' }, verified: false });
    expect(config().agents.map((a) => a.id)).toEqual(['claude-1', 'fake-1']);
    expect(d.dispatcher.agentIds()).toContain('fake-1');
    expect(d.db.prepare("SELECT name, platform FROM agents WHERE id = 'fake-1'").get()).toEqual({ name: 'Fake', platform: 'FAKE' });
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain('come from Fake or the Human'); // the others learn about it
    expect(g('status', '--short')).toBe(''); // committed, so new workspaces have the rulebooks
    expect(g('log', '-1', '--format=%s')).toBe('AgentMesh setup (agentmesh init)');
    // a second one of the same platform gets the next number; a duplicate id is refused
    expect((await post('/api/agents', { platform: 'FAKE' })).json).toMatchObject({ agent: { id: 'fake-2' } });
    expect((await post('/api/agents', { platform: 'FAKE', id: 'fake-1' })).status).toBe(409);
  });

  it('will not connect what is not there', async () => {
    expect((await post('/api/agents', { platform: 'CURSOR' })).status).toBe(400);
    expect((await post('/api/agents', { platform: 'FAKE', id: 'Bad Id' })).status).toBe(400);
    const cfg = config();
    cfg.customPlatforms = [{ id: 'GHOST', label: 'Ghost', executable: 'definitely-not-installed-agent-xyz', args: ['{prompt}'] }];
    // (the running daemon keeps the config it started with; a missing tool is exercised through the registry directly)
    const missing = await import('../platforms/index.js').then((m) => m.createRegistry(cfg.customPlatforms as never).get('GHOST')!.detect());
    expect(missing.installed).toBe(false);
    expect(config().agents).toHaveLength(1);
  });

  it('lists what is installed (Claude Code is, the fake stand-in is, a real check answers)', async () => {
    const list = (await get('/api/platforms')).json as { id: string; installed: boolean; verified: boolean; needsFix: boolean }[];
    expect(list.map((p) => p.id)).toEqual(['CLAUDE_CODE', 'ANTIGRAVITY', 'FAKE']);
    expect(list.find((p) => p.id === 'FAKE')).toMatchObject({ installed: true, verified: false });
  });

  it('is the Human\'s: an agent token, or a session without the daemon\'s origin, is refused', async () => {
    const token = d.identity.issueToken('claude-1', 'test');
    for (const [method, path] of [['POST', '/api/settings'], ['POST', '/api/agents'], ['POST', '/api/platforms/test'], ['POST', '/api/platforms/fix'], ['GET', '/api/platforms']] as const) {
      expect((await send(method, path, { Authorization: `Bearer ${token}` }, method === 'POST' ? {} : undefined)).status).toBe(403);
    }
    expect((await send('POST', '/api/settings', { Cookie: cookie }, { verifyCommand: 'x' })).status).toBe(403); // no Origin
    expect(config().verifyCommand).toBeNull();
  });

  it('only Antigravity has a permission fix, and an unknown platform cannot be tested', async () => {
    expect((await post('/api/platforms/fix', { platform: 'CLAUDE_CODE' })).status).toBe(400);
    expect((await post('/api/platforms/test', { platform: 'CURSOR' })).status).toBe(400);
  });
});
