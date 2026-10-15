// Tasks 1, 2, 3, 5 through a real daemon: the Setup routes and what the cockpit snapshot carries.
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { signBody } from '../notify/index.js';
import { callDaemon, projectRoot } from './runtime.js';
import { startDaemon, type RunningDaemon } from './start.js';

let repo: string;
let home: string;
let root: string;
let daemon: RunningDaemon | null = null;
let hook: Server | null = null;
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const post = <T = unknown>(path: string, body?: unknown) => callDaemon<T>(root, 'POST', path, body, home);
const state = () => callDaemon<Record<string, any>>(root, 'GET', '/api/state', undefined, home); // eslint-disable-line @typescript-eslint/no-explicit-any
const configOnDisk = () => JSON.parse(readFileSync(join(root, '.agentmesh', 'config.json'), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-set-'));
  home = mkdtempSync(join(tmpdir(), 'agentmesh-sethome-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  await initProject({ repoRoot: repo });
  daemon = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {}, record: true, runtimeDir: home, version: '0.1.0' });
  root = await projectRoot(repo);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  await new Promise<void>((r) => (hook ? hook.close(() => r()) : r()));
  hook = null;
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('project context (task 2)', () => {
  it('is saved to the config, shown in the snapshot, limited in length, and can be cleared', async () => {
    expect((await state()).setup.project).toMatchObject({ context: '', maxContext: 3500 });
    await post('/api/settings', { projectContext: '  Plain JavaScript only.  ' });
    expect(configOnDisk().projectContext).toBe('Plain JavaScript only.');
    expect((await state()).setup.project.context).toBe('Plain JavaScript only.');
    await expect(post('/api/settings', { projectContext: 'x'.repeat(3501) })).rejects.toThrow(/under 3500 characters/);
    await post('/api/settings', { projectContext: '   ' });
    expect(configOnDisk().projectContext).toBeUndefined();
    const timeline = (daemon!.db.prepare("SELECT text FROM events WHERE agent_id = 'human'").all() as { text: string }[]).map((e) => e.text).join('\n');
    expect(timeline).toContain('updated the project context (22 characters)');
    expect(timeline).toContain('removed the project context');
  });
});

describe('notification webhook (task 1)', () => {
  it('validates the address, never returns the secret, and the test message arrives signed', async () => {
    const got: { sig: string | undefined; body: string }[] = [];
    hook = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ sig: req.headers['x-agentmesh-signature'] as string | undefined, body: b });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hook!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

    await expect(post('/api/notifications', { webhookUrl: 'ftp://x/y' })).rejects.toThrow(/https:\/\//);
    await expect(post('/api/notifications', { webhookUrl: 'https://u:p@example.com/x' })).rejects.toThrow(/secret/);
    expect(await post('/api/notifications/test')).toMatchObject({ ok: false, error: 'No webhook address is set.' });

    const saved = await post<Record<string, unknown>>('/api/notifications', { webhookUrl: url, webhookSecret: 'topsecret' });
    expect(saved).toEqual({ webhookUrl: url, hasSecret: true, last: null });
    expect(JSON.stringify(await state())).not.toContain('topsecret'); // never sent to the page
    expect(configOnDisk().notifications).toEqual({ webhookUrl: url, webhookSecret: 'topsecret' });

    expect(await post('/api/notifications/test')).toMatchObject({ ok: true });
    expect(got).toHaveLength(1);
    expect(got[0]!.sig).toBe(signBody('topsecret', got[0]!.body));
    expect((await state()).setup.notifications.last).toMatchObject({ ok: true, event: 'test' });

    // saving again without a secret keeps the old one; an empty address removes everything
    await post('/api/notifications', { webhookUrl: url });
    expect(configOnDisk().notifications.webhookSecret).toBe('topsecret');
    await post('/api/notifications', { webhookUrl: null });
    expect(configOnDisk().notifications).toBeUndefined();
  });
});

describe('what needs the Human, in the snapshot (task 1)', () => {
  it('lists a plan to approve, a question, and a finished mission; a mission long finished is not news', async () => {
    const db = daemon!.db;
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id) VALUES ('M1', 'Car wash', 'a brief of ten', 'PLAN_READY', 'claude-1')").run();
    db.prepare("INSERT INTO mission_plans (id, mission_id, version, author_agent_id, body) VALUES ('p1', 'M1', 2, 'claude-1', 'plan')").run();
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, updated_at) VALUES ('M2', 'Fresh', 'a brief of ten', 'DONE', 'claude-1', CURRENT_TIMESTAMP)").run();
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, updated_at) VALUES ('M3', 'Old', 'a brief of ten', 'DONE', 'claude-1', '2020-01-01 00:00:00')").run();
    db.prepare("INSERT INTO questions (id, from_agent_id, to_role, text) VALUES ('q1', 'claude-1', 'Human', 'Which colour?')").run();
    const notices = (await state()).notices as { key: string; kind: string; urgent: boolean; title: string }[];
    expect(notices.map((n) => [n.key, n.kind, n.urgent])).toEqual([
      ['plan:M1:v2:r1', 'plan', true],
      ['q:q1', 'question', true],
      ['done:M2', 'done', false],
    ]);
    expect(notices[0]!.title).toBe('Plan ready: Car wash');
  });
});

describe('update check switch (task 5)', () => {
  it('is off by default, can be turned on, and shows the running version', async () => {
    const s = await state();
    expect(s.version).toBe('0.1.0');
    expect(s.setup.update).toEqual({ enabled: false, info: null, error: null });
    await post('/api/settings', { updateCheck: true });
    expect((await state()).setup.update.enabled).toBe(true);
    expect(configOnDisk().updateCheck).toBe(true);
    await post('/api/settings', { updateCheck: false });
    expect(configOnDisk().updateCheck).toBeUndefined();
  });
});

describe('runs in the snapshot (task 3)', () => {
  it('carries the enriched run list', async () => {
    const db = daemon!.db;
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id) VALUES ('T1', 'p', 'Build it', 'ac', 'IN_PROGRESS', 'claude-1')").run();
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, kind, status, started_at, ended_at) VALUES ('r1', 'claude-1', 'T1', 'TASK', 'FAILED', '2026-10-14 10:00:00', '2026-10-14 10:00:40')").run();
    const runs = (await state()).dispatch.recentRuns as Record<string, unknown>[];
    expect(runs[0]).toMatchObject({ id: 'r1', subjectTitle: 'Build it', seconds: 40, status: 'FAILED', outcome: null });
  });
});

describe('mission templates (task 6)', () => {
  it('lists the built-in ones, saves and deletes mine, and records it in the timeline', async () => {
    type T = { builtIn: { id: string; brief: string }[]; mine: { id: string; title: string }[] };
    const first = await callDaemon<T>(root, 'GET', '/api/templates', undefined, home);
    expect(first.builtIn.map((t) => t.id)).toContain('booking-page');
    expect(first.mine).toEqual([]);

    const saved = await post<{ id: string; title: string }>('/api/templates/save', { title: 'My idea', brief: 'A small tool that does one thing well.' });
    expect((await callDaemon<T>(root, 'GET', '/api/templates', undefined, home)).mine.map((t) => t.title)).toEqual(['My idea']);
    await expect(post('/api/templates/save', { title: 'x', brief: 'short' })).rejects.toThrow(/brief/);
    await expect(post('/api/templates/delete', { id: 'booking-page' })).rejects.toThrow(/built-in templates cannot be deleted/);
    await post('/api/templates/delete', { id: saved.id });
    expect((await callDaemon<T>(root, 'GET', '/api/templates', undefined, home)).mine).toEqual([]);

    const timeline = (daemon!.db.prepare("SELECT text FROM events WHERE agent_id = 'human'").all() as { text: string }[]).map((e) => e.text).join('\n');
    expect(timeline).toContain('saved the mission template "My idea"');
    expect(timeline).toContain('deleted one of my mission templates');
  });
});

describe('playbooks (task 8)', () => {
  it('saves, reads, lists and deletes through the Human routes, and shows names (not bodies) in the snapshot', async () => {
    const meta = await post<{ name: string }>('/api/playbooks/save', { name: 'release-notes', description: 'When writing release notes', body: 'Be brief.' });
    expect(meta.name).toBe('release-notes');
    expect((await post<{ body: string }>('/api/playbooks/get', { name: 'release-notes' })).body).toBe('Be brief.');
    const snap = (await state()).playbooks;
    expect(snap).toMatchObject({ max: 50, maxBytes: 20480, overflow: 0, invalid: [] });
    expect(snap.items.map((i: { name: string }) => i.name)).toEqual(['release-notes']);
    expect(JSON.stringify(snap)).not.toContain('Be brief'); // bodies are fetched one at a time
    await expect(post('/api/playbooks/save', { name: '../evil', description: 'd', body: 'b' })).rejects.toThrow(/lower-case letters/);
    await expect(post('/api/playbooks/get', { name: 'nope' })).rejects.toThrow(/There is no playbook/);
    await post('/api/playbooks/delete', { name: 'release-notes' });
    expect((await state()).playbooks.items).toEqual([]);
    const timeline = (daemon!.db.prepare("SELECT text FROM events WHERE agent_id = 'human'").all() as { text: string }[]).map((e) => e.text).join('\n');
    expect(timeline).toContain('saved the playbook "release-notes"');
    expect(timeline).toContain('deleted the playbook "release-notes"');
  });
});

describe('schedules (task 7)', () => {
  const brief = 'Check the project for outdated dependencies and write a short report.';
  const body = { name: 'Nightly check', brief, plannerAgentId: 'claude-1', trigger: { kind: 'daily', time: '02:00' } };

  it('creates, shows, runs now, edits, switches off and deletes through the Human routes, with timeline entries', async () => {
    const s = await post<{ id: string; when: string }>('/api/schedules', body);
    expect(s).toMatchObject({ id: 'S1', when: 'every day at 02:00' });
    const snap = (await state()).schedules;
    expect(snap).toMatchObject({ max: 20, timezone: expect.any(String) });
    expect(snap.items[0]).toMatchObject({ id: 'S1', enabled: true, plannerConnected: true, nextRunAt: expect.any(String) });

    expect(await post('/api/schedules/run', { id: 'S1' })).toMatchObject({ trigger: 'manual', outcome: 'started', missionId: 'M1' });
    expect(await post('/api/schedules/run', { id: 'S1' })).toMatchObject({ outcome: 'skipped:overlap' });
    expect((await state()).missions.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([['M1', 'PLANNING']]);
    expect((await state()).schedules.runs.map((r: { outcome: string }) => r.outcome)).toEqual(['skipped:overlap', 'started']);

    expect((await post<{ brief: string }>('/api/schedules/get', { id: 'S1' })).brief).toBe(brief);
    await post('/api/schedules/update', { ...body, id: 'S1', name: 'Renamed', trigger: { kind: 'cron', cron: '0 6 * * 1-5' } });
    expect((await state()).schedules.items[0]).toMatchObject({ name: 'Renamed', when: 'cron: 0 6 * * 1-5' });
    await post('/api/schedules/enable', { id: 'S1', enabled: false });
    expect((await state()).schedules.items[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await post('/api/schedules/delete', { id: 'S1' });
    expect((await state()).schedules.items).toEqual([]);

    const timeline = (daemon!.db.prepare("SELECT text FROM events WHERE agent_id = 'human'").all() as { text: string }[]).map((e) => e.text).join('\n');
    for (const part of ['created schedule S1 "Nightly check" (every day at 02:00)', 'ran schedule S1 now: started M1', 'ran schedule S1 now: skipped overlap', 'changed schedule S1 "Renamed"', 'switched off schedule S1', 'deleted schedule S1']) expect(timeline).toContain(part);
  });

  it('says what is wrong in plain words', async () => {
    await expect(post('/api/schedules', { ...body, trigger: { kind: 'cron', cron: 'every day' } })).rejects.toThrow(/exactly 5 fields/);
    await expect(post('/api/schedules', { ...body, plannerAgentId: 'ghost-9' })).rejects.toThrow(/not a connected agent/);
    await expect(post('/api/schedules/run', { id: 'S9' })).rejects.toThrow(/no schedule S9/);
    await expect(post('/api/schedules/run', { id: 'not-an-id' })).rejects.toThrow();
  });

  it('an agent\'s token is refused on every schedule route', async () => {
    const token = daemon!.identity.issueToken('claude-1', 'test');
    const port = (readDaemonPort());
    for (const path of ['/api/schedules', '/api/schedules/get', '/api/schedules/update', '/api/schedules/enable', '/api/schedules/run', '/api/schedules/delete', '/api/playbooks/save', '/api/templates/save', '/api/notifications']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status, path).toBe(403);
    }
  });
});

function readDaemonPort(): number {
  return daemon!.port;
}

describe('missions only use connected agents', () => {
  it('refuses a planner or reviewer that is only a row in the database', async () => {
    daemon!.db.prepare("INSERT INTO agents (id, name, platform, paradigm) VALUES ('ghost-1', 'Ghost', 'CODEX', 'CLI')").run();
    const brief = 'Build a small page that shows the opening hours of a shop.';
    await expect(post('/api/missions', { title: 'x', brief, plannerAgentId: 'ghost-1' })).rejects.toThrow(/ghost-1 is not a connected agent/);
    await expect(post('/api/missions', { title: 'x', brief, plannerAgentId: 'claude-1', reviewerAgentIds: ['ghost-1'] })).rejects.toThrow(/ghost-1 is not a connected agent/);
    expect(await post('/api/missions', { title: 'x', brief, plannerAgentId: 'claude-1', reviewerAgentIds: ['gemini-1'] })).toMatchObject({ id: 'M1', status: 'PLANNING' });
  });
});

describe('adding a tool from a recipe (task 10)', () => {
  it('lists the recipes, adds one as not verified, saves it to the config, and refuses duplicates and unknown ones', async () => {
    type R = { id: string; added: boolean; caveats: string[] };
    const before = (await state()).setup.recipes as R[];
    expect(before.map((r) => [r.id, r.added])).toEqual([['CODEX', false], ['GEMINI_CLI', false], ['OPENCODE', false]]);
    expect(before.every((r) => r.caveats.length > 0)).toBe(true);

    expect(await post('/api/platforms/recipe', { id: 'OPENCODE' })).toMatchObject({ id: 'OPENCODE', verified: false });
    expect((await state()).setup.recipes.find((r: R) => r.id === 'OPENCODE').added).toBe(true);
    expect(configOnDisk().customPlatforms.map((p: { id: string }) => p.id)).toEqual(['OPENCODE']);
    const platforms = (await state()).setup.platforms as { id: string; verified: boolean; loopProtection: boolean }[];
    expect(platforms.find((p) => p.id === 'OPENCODE')).toMatchObject({ verified: false, loopProtection: false });

    await expect(post('/api/platforms/recipe', { id: 'OPENCODE' })).rejects.toThrow(/already added/);
    await expect(post('/api/platforms/recipe', { id: 'NOPE' })).rejects.toThrow(/no recipe/);
    const timeline = (daemon!.db.prepare("SELECT text FROM events WHERE agent_id = 'human'").all() as { text: string }[]).map((e) => e.text).join('\n');
    expect(timeline).toContain('added opencode from a recipe (not verified yet)');
  });
});
