// Spending limits through the real daemon: starting a mission with one, changing it, and being told when it is reached.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../db/index.js';
import { initProject } from '../init/index.js';
import { type RunningDaemon, startDaemon } from '../start/index.js';

let repo: string;
let d: RunningDaemon;
let cookie: string;
let origin: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

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
type Mission = { id: string; title: string; budget: { maxCostUsd: number | null; maxTokens: number | null; usedCostUsd: number | null; usedTokens: number; reached: string | null } | null };
type Notice = { key: string; kind: string; urgent: boolean; title: string; text: string; missionId?: string };
const state = async () => (await send('GET', '/api/state', { Cookie: cookie })).json as { missions: Mission[]; notices: Notice[] };
const brief = 'Build a small web app for a car wash: customers pick a wash package and a time slot.';
const start = (extra: Record<string, unknown> = {}) => post('/api/missions', { title: 'Car wash', brief, plannerAgentId: 'claude-1', ...extra });

/** What a finished run on the mission reported, written the way the daemon does (a second connection to the same file). */
function spend(missionId: string, usd: number, tokens = 100) {
  const db = openDatabase(join(repo, '.agentmesh', 'mesh.db'));
  try {
    const id = `r-${Math.random().toString(16).slice(2)}`;
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES (?, 'claude-1', ?, 'PLAN', 'SUCCEEDED', '2020-01-01 00:00:00', '2020-01-01 00:05:00')").run(id, `mission:${missionId}`);
    db.prepare('INSERT INTO run_usage (run_id, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES (?, ?, 0, 0, ?)').run(id, tokens, usd);
  } finally {
    closeDatabase(db);
  }
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-budget-http-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# new project\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
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

describe('starting a mission with a limit', () => {
  it('keeps the limit with the mission, and shows what it has used', async () => {
    expect((await start({ budgetUsd: 5, budgetTokens: 2_000_000 })).status).toBe(200);
    const m = (await state()).missions[0]!;
    expect(m.budget).toEqual({ maxCostUsd: 5, maxTokens: 2_000_000, usedCostUsd: null, usedTokens: 0, reached: null, reachedLimits: {} });
  });

  it('a mission without one has none', async () => {
    await start();
    expect((await state()).missions[0]!.budget).toBeNull();
  });

  it('every bound is checked in one place, with one kind of answer and words a person can act on', async () => {
    for (const [body, words] of [
      [{ budgetUsd: 0 }, /dollar limit must be more than 0/],
      [{ budgetUsd: -5 }, /dollar limit must be more than 0/],
      [{ budgetUsd: 100_001 }, /dollar limit must be more than 0 and at most 100,000/],
      [{ budgetTokens: 0 }, /token limit must be a whole number/],
      [{ budgetTokens: 10_000.5 }, /token limit must be a whole number/],
      [{ budgetTokens: 20_000_000_000 }, /token limit must be a whole number/],
    ] as const) {
      const r = await start(body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect((r.json as { error: string }).error).toMatch(words);
    }
    expect((await state()).missions).toHaveLength(0);
  });

  it('null means "no limit", also when starting a mission, and the answer says what limit the mission has', async () => {
    const none = await start({ budgetUsd: null, budgetTokens: null });
    expect(none.status).toBe(200);
    expect((none.json as { budget: unknown }).budget).toBeNull();
    const some = await start({ title: 'Second', budgetUsd: 5 });
    expect((some.json as { budget: { maxCostUsd: number } }).budget).toMatchObject({ maxCostUsd: 5, maxTokens: null, reached: null });
  });

  it('a limit that is not usable is refused in plain words, and no mission is left behind', async () => {
    const r = await start({ budgetTokens: 5 });
    expect(r.status).toBe(409);
    expect((r.json as { error: string }).error).toMatch(/token limit must be a whole number/);
    expect((await state()).missions).toHaveLength(0);
  });
});

describe('changing a limit', () => {
  it('raises, lowers and removes it, and refuses an unknown mission', async () => {
    await start({ budgetUsd: 5 });
    const id = (await state()).missions[0]!.id;
    expect((await post('/api/missions/budget', { missionId: id, budgetUsd: 20 })).status).toBe(200);
    expect((await state()).missions[0]!.budget).toMatchObject({ maxCostUsd: 20, maxTokens: null });
    await post('/api/missions/budget', { missionId: id, budgetTokens: 50_000 });
    expect((await state()).missions[0]!.budget).toMatchObject({ maxCostUsd: null, maxTokens: 50_000 });
    await post('/api/missions/budget', { missionId: id, budgetUsd: null, budgetTokens: null });
    expect((await state()).missions[0]!.budget).toBeNull();
    const unknown = await post('/api/missions/budget', { missionId: 'M99', budgetUsd: 5 });
    expect(unknown.status).toBe(409);
    expect((unknown.json as { error: string }).error).toContain('Unknown mission');
  });

  it('is recorded in the timeline as the Human\'s doing', async () => {
    await start();
    const id = (await state()).missions[0]!.id;
    await post('/api/missions/budget', { missionId: id, budgetUsd: 7.5 });
    const events = ((await send('GET', '/api/state', { Cookie: cookie })).json as { events: { text: string }[] }).events;
    expect(events.some((e) => e.text.includes(`spending limit of mission ${id} to $7.5`))).toBe(true);
  });

  it('is worded properly in the timeline whichever limits are set', async () => {
    await start();
    const id = (await state()).missions[0]!.id;
    const said = async () => ((await send('GET', '/api/state', { Cookie: cookie })).json as { events: { text: string }[] }).events.map((e) => e.text);
    await post('/api/missions/budget', { missionId: id, budgetTokens: 50_000 });
    await post('/api/missions/budget', { missionId: id, budgetUsd: 5, budgetTokens: 50_000 });
    await post('/api/missions/budget', { missionId: id, budgetUsd: null, budgetTokens: null });
    const text = await said();
    expect(text).toContain(`set the spending limit of mission ${id} to 50,000 tokens`);
    expect(text).toContain(`set the spending limit of mission ${id} to $5 and 50,000 tokens`);
    expect(text).toContain(`removed the spending limit of mission ${id}`);
  });

  it('only the Human may change it', async () => {
    await start({ budgetUsd: 5 });
    const id = (await state()).missions[0]!.id;
    expect((await send('POST', '/api/missions/budget', { Origin: origin }, { missionId: id, budgetUsd: 999 })).status).toBe(401); // no session
    expect((await state()).missions[0]!.budget).toMatchObject({ maxCostUsd: 5 });
  });
});

describe('when the limit is reached', () => {
  it('the mission is flagged and the Human is told, urgently, with the reason', async () => {
    await start({ budgetUsd: 1 });
    const id = (await state()).missions[0]!.id;
    expect((await state()).notices.filter((n) => n.kind === 'budget')).toHaveLength(0);
    spend(id, 1.4);
    const s = await state();
    expect(s.missions[0]!.budget).toMatchObject({ usedCostUsd: 1.4, reached: 'It has used $1.40 of its $1.00 limit.' });
    const notice = s.notices.find((n) => n.kind === 'budget')!;
    expect(notice).toMatchObject({ urgent: true, missionId: id, title: 'Spending limit reached: Car wash' });
    expect(notice.text).toContain('It has used $1.40 of its $1.00 limit.');
    expect(notice.text).toContain('raise the limit or cancel it');
  });

  it('raising the limit clears the notice, and reaching the new limit is a new notice', async () => {
    await start({ budgetUsd: 1 });
    const id = (await state()).missions[0]!.id;
    spend(id, 1.4);
    const first = (await state()).notices.find((n) => n.kind === 'budget')!;
    await post('/api/missions/budget', { missionId: id, budgetUsd: 3 });
    expect((await state()).notices.filter((n) => n.kind === 'budget')).toHaveLength(0);
    spend(id, 2);
    const second = (await state()).notices.find((n) => n.kind === 'budget')!;
    expect(second.key).not.toBe(first.key); // not mistaken for the one already seen
  });

  it('editing the OTHER limit does not announce the same thing again; changing the one that is used up does', async () => {
    await start({ budgetUsd: 1, budgetTokens: 1_000_000 });
    const id = (await state()).missions[0]!.id;
    spend(id, 1.4);
    const key = async () => (await state()).notices.find((n) => n.kind === 'budget')?.key;
    const first = await key();
    expect(first).toBeDefined();
    await post('/api/missions/budget', { missionId: id, budgetUsd: 1, budgetTokens: 2_000_000 }); // only the unreached limit changed
    expect(await key()).toBe(first);
    await post('/api/missions/budget', { missionId: id, budgetUsd: 1.2, budgetTokens: 2_000_000 }); // the used-up one: still over, a different limit
    expect(await key()).not.toBe(first);
  });

  it('a cancelled mission is not a notice', async () => {
    await start({ budgetUsd: 1 });
    const id = (await state()).missions[0]!.id;
    spend(id, 5);
    await post('/api/missions/cancel', { missionId: id });
    expect((await state()).notices.filter((n) => n.kind === 'budget')).toHaveLength(0);
  });
});
