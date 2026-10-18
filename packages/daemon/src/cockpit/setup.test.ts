import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listenFree } from '../server/ports.js';
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
    customPlatforms: [
      { id: 'FAKE', label: 'Fake Tool', friendlyName: 'Fake', executable: process.execPath, args: ['-e', '0', '{prompt}'] },
      { id: 'GHOST', label: 'Ghost Tool', friendlyName: 'Ghost', executable: 'definitely-not-installed-agent-xyz', args: ['{prompt}'] },
    ],
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
    expect(s.project).toMatchObject({ name: basename(repo), verifyCommand: null, landWithoutVerify: true, landing: true, suggestedVerifyCommand: null }); // the folder's name, for the cockpit's title block
    expect(s.platforms.map((p) => [p.id, p.verified, p.agents])).toEqual([['CLAUDE_CODE', true, ['claude-1']], ['ANTIGRAVITY', true, []], ['FAKE', false, []], ['GHOST', false, []]]);
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

  it('says which program is missing, by its own name and not by the platform\'s id', async () => {
    const r = await post('/api/agents', { platform: 'GHOST' });
    expect(r.status).toBe(409);
    const msg = (r.json as { error: string }).error;
    expect(msg).toContain('Ghost Tool is not installed on this machine');
    expect(msg).not.toContain('no "GHOST" command'); // the platform's id is not a command anyone could type
    expect(msg).toContain('Install it and sign in once');
    expect(config().agents).toHaveLength(1);
  });

  it('lists what is installed (Claude Code is, the fake stand-in is, a real check answers)', async () => {
    const list = (await get('/api/platforms')).json as { id: string; installed: boolean; verified: boolean; needsFix: boolean }[];
    expect(list.map((p) => p.id)).toEqual(['CLAUDE_CODE', 'ANTIGRAVITY', 'FAKE', 'GHOST']);
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

describe('adding Claude Code on a local model (Ollama) from its recipe', () => {
  type RecipeInfo = { id: string; added: boolean; fields: { id: string; label: string; default: string; suggest: string | null; pattern?: string }[] };
  const recipes = async () => ((await get('/api/state')).json as { setup: { recipes: RecipeInfo[] } }).setup.recipes;

  it('is offered with the choices to make (and not the patterns that check them)', async () => {
    const r = (await recipes()).find((x) => x.id === 'CLAUDE_OLLAMA')!;
    expect(r.added).toBe(false);
    expect(r.fields.map((f) => [f.id, f.default, f.suggest])).toEqual([['model', '', 'ollama-models'], ['address', 'http://127.0.0.1:11434', null]]);
    expect(r.fields.every((f) => f.pattern === undefined)).toBe(true);
  });

  it('refuses without a model, says why, and adds nothing', async () => {
    const before = JSON.stringify(config().customPlatforms ?? []);
    const res = await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: {} });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/Model: Type the name of a model you have pulled/);
    expect(JSON.stringify(config().customPlatforms ?? [])).toBe(before);
    expect((await recipes()).find((x) => x.id === 'CLAUDE_OLLAMA')!.added).toBe(false);
  });

  it('refuses a bad address', async () => {
    const res = await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b', address: 'http://127.0.0.1:11434/v1' } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/Ollama address:/);
  });

  it('adds it with the chosen model and address, writes it to the config as "not verified", and records it', async () => {
    const res = await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b', address: 'http://127.0.0.1:11500' } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: 'CLAUDE_OLLAMA', verified: false });
    const saved = (config().customPlatforms as { id: string; args: string[]; env: Record<string, string>; reportsCost: boolean }[]).find((c) => c.id === 'CLAUDE_OLLAMA')!;
    expect(saved.args).toContain('qwen3:8b');
    expect(saved.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:11500');
    expect(saved.reportsCost).toBe(false);
    expect((await recipes()).find((x) => x.id === 'CLAUDE_OLLAMA')!.added).toBe(true);
    const timeline = ((await get('/api/state')).json as { events: { text: string }[] }).events.map((e) => e.text);
    expect(timeline.some((t) => t.includes('Claude Code on a local model (Ollama)') && t.includes('not verified'))).toBe(true);
    expect((await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b' } })).status).toBe(200); // adding it again is changing it, below
    expect((await post('/api/platforms/recipe', { id: 'CODEX' })).status).toBe(200);
    expect((await post('/api/platforms/recipe', { id: 'CODEX' })).status).toBe(409); // nothing to choose in this one: it cannot be "changed"
  });

  it('refuses a choice the recipe does not have, and a port or octet that is not one, with a 400 and nothing added', async () => {
    const before = JSON.stringify(config().customPlatforms ?? []);
    for (const values of [{ model: 'qwen3:8b', url: 'http://127.0.0.1:11500' }, { model: 'qwen3:8b', address: 'http://127.0.0.1:99999' }, { model: 'qwen3:8b', address: 'http://127.0.0.256:11434' }]) {
      const res = await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values });
      expect(res.status, JSON.stringify(values)).toBe(400);
    }
    expect((await post('/api/platforms/recipe', { id: 'CODEX', values: { model: 'x' } })).status).toBe(400);
    expect(JSON.stringify(config().customPlatforms ?? [])).toBe(before);
  });

  it('says in the timeline when the address is not this computer, and what the choices were', async () => {
    await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b', address: 'http://192.168.1.50:11434' } });
    const timeline = ((await get('/api/state')).json as { events: { text: string }[] }).events.map((e) => e.text);
    expect(timeline.some((t) => t.includes('192.168.1.50:11434') && t.includes('not this computer'))).toBe(true);
  });

  it('offers what is set on an added recipe, so it can be changed', async () => {
    type Info = { id: string; added: boolean; current: Record<string, string> | null };
    const info = async () => ((await get('/api/state')).json as { setup: { recipes: Info[] } }).setup.recipes.find((x) => x.id === 'CLAUDE_OLLAMA')!;
    expect((await info()).current).toBeNull(); // not added: nothing is set
    await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b', address: 'http://127.0.0.1:11500' } });
    expect(await info()).toMatchObject({ added: true, current: { model: 'qwen3:8b', address: 'http://127.0.0.1:11500' } });
  });

  it('changes the model of one that is added: the same entry is replaced, not a second one added, the platform is live at once, and it is recorded', async () => {
    await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b-typo' } });
    const res = await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b', address: 'http://127.0.0.1:11500' } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: 'CLAUDE_OLLAMA', verified: false, changed: true });
    const saved = (config().customPlatforms as { id: string; args: string[]; env: Record<string, string> }[]).filter((c) => c.id === 'CLAUDE_OLLAMA');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.args).toContain('qwen3:8b');
    expect(saved[0]!.args).not.toContain('qwen3:8b-typo');
    expect(saved[0]!.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:11500');
    const live = d.registry.get('CLAUDE_OLLAMA')!;
    expect(live.verified).toBe(false);
    const timeline = ((await get('/api/state')).json as { events: { text: string }[] }).events.map((e) => e.text);
    expect(timeline.some((t) => t.includes('changed') && t.includes('qwen3:8b') && t.includes('not verified'))).toBe(true);
  });

  it('a change that fails leaves the old definition, and a refused one is not saved', async () => {
    await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'keep-me' } });
    expect((await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: '' } })).status).toBe(400);
    const saved = (config().customPlatforms as { id: string; args: string[] }[]).find((c) => c.id === 'CLAUDE_OLLAMA')!;
    expect(saved.args).toContain('keep-me');
  });

  it('when the settings file cannot be written the answer is an error, nothing half-done is kept, and trying again works', async () => {
    const file = join(repo, '.agentmesh', 'config.json');
    const text = readFileSync(file, 'utf8');
    rmSync(file);
    mkdirSync(file); // a folder where the file should be: writing it fails
    const failed = await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b' } });
    expect(failed.status).toBe(500);
    expect(d.registry.has('CLAUDE_OLLAMA')).toBe(false); // not added in memory either
    expect(((await get('/api/state')).json as { setup: { recipes: { id: string; added: boolean }[] } }).setup.recipes.find((x) => x.id === 'CLAUDE_OLLAMA')!.added).toBe(false);
    rmSync(file, { recursive: true });
    writeFileSync(file, text);
    expect((await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'qwen3:8b' } })).status).toBe(200); // not "already added"
    // and a failed CHANGE keeps the old one in memory as well as on disk
    rmSync(file);
    mkdirSync(file);
    expect((await post('/api/platforms/recipe', { id: 'CLAUDE_OLLAMA', values: { model: 'changed' } })).status).toBe(500);
    const now = ((await get('/api/state')).json as { setup: { recipes: { id: string; current: { model: string } | null }[] } }).setup.recipes.find((x) => x.id === 'CLAUDE_OLLAMA')!;
    expect(now.current!.model).toBe('qwen3:8b'); // what is shown is what is saved: the failed change left no trace
    rmSync(file, { recursive: true });
    writeFileSync(file, text);
  });
});

describe('choosing the model and sub-agents of an agent', () => {
  type S = { id: string; platform: string; model: string | null; subAgents: boolean; canChooseModel: boolean; canUseSubAgents: boolean };
  const settings = async () => ((await get('/api/state')).json as { setup: { agentSettings: S[] } }).setup.agentSettings;
  const saved = () => (config().agents as { id: string; model?: string; subAgents?: boolean }[]).find((a) => a.id === 'claude-1')!;
  const timeline = async () => ((await get('/api/state')).json as { events: { text: string }[] }).events.map((e) => e.text);

  it('offers what can be chosen for each agent, and nothing is chosen at first', async () => {
    expect((await settings()).find((s) => s.id === 'claude-1')).toEqual({ id: 'claude-1', platform: 'CLAUDE_CODE', model: null, subAgents: false, canChooseModel: true, canUseSubAgents: true });
  });

  it('sets the model and sub-agents, saves them in the settings file, shows them, and records it in the timeline', async () => {
    const r = await post('/api/agents/settings', { agentId: 'claude-1', model: 'opus', subAgents: true });
    expect(r).toMatchObject({ status: 200, json: { id: 'claude-1', model: 'opus', subAgents: true } });
    expect(saved()).toMatchObject({ model: 'opus', subAgents: true });
    expect((await settings()).find((s) => s.id === 'claude-1')).toMatchObject({ model: 'opus', subAgents: true });
    const t = await timeline();
    expect(t.some((x) => x.includes('set the model of claude-1 to opus') && x.includes('from its next run'))).toBe(true);
    expect(t.some((x) => x.includes('allowed sub-agents for claude-1'))).toBe(true);
  });

  it('puts it back on the default: nothing is left in the settings file', async () => {
    await post('/api/agents/settings', { agentId: 'claude-1', model: 'opus', subAgents: true });
    expect((await post('/api/agents/settings', { agentId: 'claude-1', model: null, subAgents: false })).status).toBe(200);
    expect(saved()).not.toHaveProperty('model');
    expect(saved()).not.toHaveProperty('subAgents');
    expect((await timeline()).some((x) => x.includes('back on its tool\'s default model'))).toBe(true);
    // a blank box means the same, and one thing can be changed without the other
    await post('/api/agents/settings', { agentId: 'claude-1', model: 'haiku' });
    await post('/api/agents/settings', { agentId: 'claude-1', subAgents: true });
    expect(saved()).toMatchObject({ model: 'haiku', subAgents: true });
    await post('/api/agents/settings', { agentId: 'claude-1', model: '   ' });
    expect(saved()).not.toHaveProperty('model');
    expect(saved()).toMatchObject({ subAgents: true });
  });

  it('refuses a model that is not a name, an agent that is not there, and an agent whose tool is defined by hand, saving nothing', async () => {
    for (const model of ['--help', 'a b', 'x;rm -rf', '$(x)']) {
      const r = await post('/api/agents/settings', { agentId: 'claude-1', model });
      expect(r.status, model).toBe(409);
      expect((r.json as { error: string }).error).toMatch(/not a model name/);
    }
    expect((await post('/api/agents/settings', { agentId: 'nobody-1', model: 'opus' })).status).toBe(404);
    expect((await post('/api/agents/settings', { agentId: 'claude-1', extra: 1 })).status).toBe(400);
    expect((await post('/api/agents/settings', { agentId: 'Bad Id', model: 'opus' })).status).toBe(400);
    await post('/api/agents', { platform: 'FAKE' }); // a tool defined in the configuration
    const custom = await post('/api/agents/settings', { agentId: 'fake-1', model: 'opus' });
    expect(custom.status).toBe(409);
    expect((custom.json as { error: string }).error).toMatch(/own definition/);
    expect(saved()).not.toHaveProperty('model');
  });

  it('is kept when AgentMesh is started again', async () => {
    await post('/api/agents/settings', { agentId: 'claude-1', model: 'sonnet', subAgents: true });
    await d.stop();
    d = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
    const login = new URL(d.loginUrl);
    cookie = await new Promise<string>((resolve) => {
      request({ host: '127.0.0.1', port: d.port, path: login.pathname + login.search, headers: { Host: `127.0.0.1:${d.port}` } }, (r) => {
        r.resume();
        resolve(String(r.headers['set-cookie']).split(';')[0]!);
      }).end();
    });
    origin = `http://127.0.0.1:${d.port}`;
    expect((await settings()).find((s) => s.id === 'claude-1')).toMatchObject({ model: 'sonnet', subAgents: true });
  });

  it('is the Human\'s: an agent, no session, or a request from another page is refused', async () => {
    const token = d.identity.issueToken('claude-1', 'test');
    const body = { agentId: 'claude-1', model: 'opus' };
    expect((await send('POST', '/api/agents/settings', { Authorization: `Bearer ${token}` }, body)).status).toBe(403);
    expect((await send('POST', '/api/agents/settings', { Origin: origin }, body)).status).toBe(401);
    expect((await send('POST', '/api/agents/settings', { Cookie: cookie }, body)).status).toBe(403);
    expect(saved()).not.toHaveProperty('model');
  });

  it('lists the models to offer for a platform (Claude\'s are the aliases; a tool defined by hand has none), for the Human only', async () => {
    const claude = (await post('/api/models', { platform: 'CLAUDE_CODE' })).json as { models: { id: string }[]; note: string };
    expect(claude.models.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(((await post('/api/models', { platform: 'FAKE' })).json as { models: unknown[] }).models).toEqual([]);
    expect((await post('/api/models', {})).status).toBe(400);
    expect((await send('POST', '/api/models', { Origin: origin }, { platform: 'CLAUDE_CODE' })).status).toBe(401);
  });
});

describe('the cockpit session', () => {
  const loginAgain = async () => {
    origin = `http://127.0.0.1:${d.port}`;
    const login = new URL(d.loginUrl);
    cookie = await new Promise<string>((resolve) => {
      request({ host: '127.0.0.1', port: d.port, path: login.pathname + login.search, headers: { Host: `127.0.0.1:${d.port}` } }, (r) => {
        r.resume();
        resolve(String(r.headers['set-cookie']).split(';')[0]!);
      }).end();
    });
  };

  it('stops working when AgentMesh is stopped and started again, so a copied cookie does not outlive the run it was made for', async () => {
    expect((await get('/api/state')).status).toBe(200);
    const old = cookie;
    await d.stop();
    d = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
    expect((await send('GET', '/api/state', { Cookie: old })).status).toBe(401); // the old cookie is dead
    await loginAgain();
    expect((await get('/api/state')).status).toBe(200); // and a new login link works as before
  });

  it('only the cockpit sessions end that way', async () => {
    const live = (db: typeof d.db) => (db.prepare("SELECT count(*) AS n FROM agent_credentials WHERE label = 'cockpit-session' AND revoked_at IS NULL").get() as { n: number }).n;
    expect(live(d.db)).toBeGreaterThan(0);
    await d.stop();
    d = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
    expect(live(d.db)).toBe(0);
    await loginAgain();
    expect(live(d.db)).toBe(1);
  });
});

describe('listing the models Ollama has', () => {
  type Models = { checked: boolean; reachable: boolean | null; models: { name: string; sizeGb: number | null; cloud: boolean }[]; note?: string };
  let fake: ReturnType<typeof createServer>;
  let address: string;
  let asked: string[];
  beforeEach(async () => {
    asked = [];
    fake = createServer((req, res) => {
      asked.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'gemma4:e2b', size: 7_200_000_000 }, { name: 'minimax-m3:cloud', size: 0, remote_host: 'https://ollama.com:443' }, { size: 5 }] }));
    });
    await listenFree(fake, '127.0.0.1');
    address = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => fake.close(() => r()));
  });
  const models = async (body: unknown) => post('/api/platforms/ollama-models', body);

  it('lists them with their size, and marks a model that runs in the cloud, not on this computer', async () => {
    const res = await models({ address });
    expect(res.status).toBe(200);
    const j = res.json as Models;
    expect(j).toMatchObject({ checked: true, reachable: true });
    expect(j.models).toEqual([{ name: 'gemma4:e2b', sizeGb: 7.2, cloud: false }, { name: 'minimax-m3:cloud', sizeGb: 0, cloud: true }]);
    expect(asked).toEqual(['/api/tags']);
  });

  it('says plainly when Ollama is not answering', async () => {
    const dead = createServer();
    await listenFree(dead, '127.0.0.1');
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const j = (await models({ address: `http://127.0.0.1:${port}` })).json as Models;
    expect(j).toMatchObject({ checked: true, reachable: false, models: [] });
    expect(j.note).toContain('Ollama did not answer');
  });

  it('only ever asks this computer: another address is not looked at', async () => {
    const j = (await models({ address: 'http://192.168.1.50:11434' })).json as Models;
    expect(j).toMatchObject({ checked: false, reachable: null, models: [] });
    expect(j.note).toContain('only listed for Ollama on this computer');
    expect(asked).toEqual([]);
  });

  it('does not follow a redirect to another address: the list is only ever asked of this computer', async () => {
    const elsewhere: string[] = [];
    const target = createServer((req, res) => {
      elsewhere.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'from-another-machine' }] }));
    });
    await listenFree(target, '127.0.0.1');
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/tags`;
    const bounce = createServer((_req, res) => {
      res.writeHead(302, { Location: targetUrl });
      res.end();
    });
    await listenFree(bounce, '127.0.0.1');
    try {
      const j = (await models({ address: `http://127.0.0.1:${(bounce.address() as AddressInfo).port}` })).json as Models;
      expect(j).toMatchObject({ checked: true, reachable: false, models: [] });
      expect(j.note).toMatch(/send AgentMesh somewhere else/);
      expect(elsewhere).toEqual([]); // the second address was never contacted
    } finally {
      await new Promise<void>((r) => bounce.close(() => r()));
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it('an address that looks right but is not one is a 400 in plain words, not a crash', async () => {
    for (const bad of ['http://127.0.0.1:99999', 'http://localhost:65536', 'http://127.0.0.256:11434', 'http://4294967296:11434']) {
      const r = await models({ address: bad });
      expect(r.status, bad).toBe(400);
      expect((r.json as { error: string }).error).toMatch(/does not look like an address/);
    }
  });

  it('a blank address means the default one, as it does when adding the recipe', async () => {
    for (const address of ['', '   ']) expect((await models({ address })).status, JSON.stringify(address)).toBe(200);
  });

  it('an answer of an unexpected shape is "answered, but no models", not "did not answer"', async () => {
    for (const body of ['null', '{"models":"none"}', '{"models":{}}', '{"models":[null,5,"x",{"name":5},{"name":"ok:1","size":"big"},{"name":"inf","size":1e999}]}', '[]']) {
      fake.removeAllListeners('request');
      fake.on('request', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
      const j = (await models({ address })).json as Models;
      expect(j.reachable, body).toBe(true);
      expect(j.models.every((m) => typeof m.name === 'string'), body).toBe(true);
      expect(j.models.every((m) => m.sizeGb === null || Number.isFinite(m.sizeGb)), body).toBe(true);
    }
  });

  it('says so when what answers is not Ollama (not even JSON)', async () => {
    fake.removeAllListeners('request');
    fake.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>hello</html>');
    });
    const j = (await models({ address })).json as Models;
    expect(j).toMatchObject({ checked: true, reachable: false, models: [] });
    expect(j.note).toMatch(/not Ollama/);
  });

  it('does not read an answer without end: past a size no list of models reaches, it stops', async () => {
    fake.removeAllListeners('request');
    fake.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"models":[');
      const chunk = ' '.repeat(256 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 40) {
          sent++;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    const started = Date.now();
    const j = (await models({ address })).json as Models;
    expect(j).toMatchObject({ checked: true, reachable: false, models: [] });
    expect(j.note).toMatch(/too long/);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('refuses an address that is not plainly an address', async () => {
    for (const bad of ['http://127.0.0.1:11434/x', 'file:///etc/passwd', 'http://user:pw@127.0.0.1:1', 'javascript:alert(1)']) {
      expect((await models({ address: bad })).status, bad).toBe(400);
    }
    expect((await models({ address: 5 })).status).toBe(400);
  });

  it('is for the Human only', async () => {
    expect((await send('POST', '/api/platforms/ollama-models', { Origin: origin }, { address })).status).toBe(401);
    expect(asked).toEqual([]);
  });
});
