import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { DaemonServer } from '../server/index.js';
import { cockpitEventPusher, registerCockpit } from './cockpit.js';

let dir: string;
let db: SqliteDatabase;
let server: DaemonServer;
let port: number;
let board: BoardService;
let claude: Principal;
let agentToken: string;

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function cookie(): Promise<string> {
  const url = new URL(server.issueCockpitUrl());
  const r = await get(url.pathname + url.search);
  return String(r.headers['set-cookie']).split(';')[0]!;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-cockpit-'));
  const staticDir = join(dir, 'dist');
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>cockpit</title>');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'outside the static dir');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  const reg = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  claude = reg.principal;
  agentToken = reg.token;
  ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  server = new DaemonServer({ identity: ids, humanAgentId: 'human', staticDir });
  board = new BoardService({ db, worktrees: new WorktreeController({ repoRoot: dir }), onEvent: cockpitEventPusher(server) });
  registerCockpit({ server, board, db });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('cockpit static files', () => {
  it('serves the app with a strict CSP and SPA fallback', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('cockpit');
    expect(String(index.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(index.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect((await get('/assets/app.js')).headers['content-type']).toContain('javascript');
    expect((await get('/some/client/route')).body).toContain('cockpit'); // SPA fallback
  });

  it('never serves files outside the static dir, and keeps API paths out of the SPA fallback', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const r = await get(p);
      expect(r.body).not.toContain('outside the static dir');
    }
    expect((await get('/api/nope')).status).toBe(404);
  });
});

describe('cockpit data', () => {
  it('snapshot is Human-only', async () => {
    expect((await get('/api/state', { Authorization: `Bearer ${agentToken}` })).status).toBe(403);
    const r = await get('/api/state', { Cookie: await cookie() });
    expect(r.status).toBe(200);
    expect(Object.keys(JSON.parse(r.body)).sort()).toEqual(['agents', 'dispatch', 'events', 'leases', 'missions', 'openQuestions', 'tasks', 'usage']);
  });

  it('pushes board events to the cockpit live, p95 under 100 ms (AC-3)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, { headers: { Cookie: await cookie(), Origin: `http://127.0.0.1:${port}` } });
    await new Promise((r) => ws.once('open', r));
    const SAMPLES = 100; // "many events" (spec v1.1 §16 AC-3): enough that p95 isn't just the top few samples.
    const latencies: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const got = new Promise<{ type: string; payload: { text: string } }>((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
      const t0 = performance.now();
      board.setStatus(claude, `step ${i}`);
      const msg = await got;
      latencies.push(performance.now() - t0);
      expect(msg).toMatchObject({ type: 'EVENT', payload: { text: `step ${i}` } });
    }
    ws.close();
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)]!;
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    const max = latencies[latencies.length - 1]!;
    // Reported (not just asserted) so the measured event-to-browser latency is visible in test
    // output for AC-3's "logged as a finding" requirement, without re-deriving it by hand.
    console.log(`[AC-3] event-to-browser latency over ${SAMPLES} events: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`);
    expect(p95).toBeLessThan(100);
  });
});
