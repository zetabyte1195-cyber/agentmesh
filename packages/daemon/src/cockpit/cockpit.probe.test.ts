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
let humanToken: string;

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
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-cockpit-probe-'));
  const staticDir = join(dir, 'dist');
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>cockpit probe</title>');
  writeFileSync(join(staticDir, 'assets', 'bundle.js'), 'console.log("probe")');
  writeFileSync(join(dir, 'sensitive-outside.txt'), 'PRIVATE_DATA_DO_NOT_SERVE');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  const regClaude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  claude = regClaude.principal;
  agentToken = regClaude.token;

  const regHuman = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  humanToken = regHuman.token;

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

describe('P3.1 Cockpit Audit Probes', () => {
  describe('1. Content Security Policy and Security Headers', () => {
    it('enforces strict CSP with frame-ancestors none, base-uri none, no unsafe-inline', async () => {
      const res = await get('/');
      expect(res.status).toBe(200);

      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain('ws://127.0.0.1:*');

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('2. Path Handling and Path Traversal Defenses', () => {
    it('refuses path traversal across various encodings and never leaks files outside staticDir', async () => {
      const probePaths = [
        '/../sensitive-outside.txt',
        '/..%2fsensitive-outside.txt',
        '/%2e%2e/sensitive-outside.txt',
        '/%2e%2e%2fsensitive-outside.txt',
        '/assets/../../sensitive-outside.txt',
        '/assets/..%2f..%2fsensitive-outside.txt',
        '/assets/%2e%2e%2f%2e%2e%2fsensitive-outside.txt',
        '/..\\sensitive-outside.txt',
        '/..%5csensitive-outside.txt',
        '/%2e%2e%5csensitive-outside.txt',
      ];

      for (const p of probePaths) {
        const res = await get(p);
        expect(res.body).not.toContain('PRIVATE_DATA_DO_NOT_SERVE');
      }
    });

    it('falls back to index.html for SPA routes but returns 404 JSON for /api, /mcp, and /ws', async () => {
      const spaRes = await get('/cockpit/tasks/view/P3.1');
      expect(spaRes.status).toBe(200);
      expect(spaRes.body).toContain('cockpit probe');

      const api404 = await get('/api/nonexistent');
      expect(api404.status).toBe(404);
      expect(api404.headers['content-type']).toContain('application/json');
      expect(JSON.parse(api404.body)).toEqual({ error: 'Not found' });

      const mcp404 = await get('/mcp/nonexistent');
      expect(mcp404.status).toBe(404);
      expect(mcp404.headers['content-type']).toContain('application/json');
      expect(JSON.parse(mcp404.body)).toEqual({ error: 'Not found' });

      const ws404 = await get('/ws/nonexistent');
      expect(ws404.status).toBe(404);
      expect(ws404.headers['content-type']).toContain('application/json');
      expect(JSON.parse(ws404.body)).toEqual({ error: 'Not found' });
    });
  });

  describe('3. Human-Only Snapshot Authorization', () => {
    it('rejects unauthenticated requests to /api/state with 401', async () => {
      const res = await get('/api/state');
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'MISSING_TOKEN' });
    });

    it('rejects agent Bearer tokens to /api/state with 403', async () => {
      const res = await get('/api/state', { Authorization: `Bearer ${agentToken}` });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'Human only' });
    });

    it('rejects agent cookie tokens to /api/state with 403', async () => {
      const res = await get('/api/state', { Cookie: `agentmesh_session=${agentToken}` });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'Human only' });
    });

    it('allows valid human session cookie and returns full snapshot without credential leaks', async () => {
      const c = await cookie();
      const res = await get('/api/state', { Cookie: c });
      expect(res.status).toBe(200);

      const data = JSON.parse(res.body) as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(['agents', 'dispatch', 'events', 'leases', 'missions', 'openQuestions', 'tasks', 'usage']);

      // Ensure no tokens/credentials appear in the returned state
      expect(res.body).not.toMatch(/amt_[A-Za-z0-9_-]{20,}/);
      expect(res.body).not.toContain(agentToken);
      expect(res.body).not.toContain(humanToken);
    });
  });

  describe('4. Live WebSocket Events and Anti-Hijacking', () => {
    it('rejects WebSocket upgrades without valid Origin (CSWSH prevention)', async () => {
      const c = await cookie();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: { Cookie: c, Origin: 'http://evil-attacker.com' },
      });

      const err = await new Promise<number | Error>((resolve) => {
        ws.once('unexpected-response', (_, res) => resolve(res.statusCode ?? 0));
        ws.once('error', resolve);
      });
      expect(err).toBe(403);
    });

    it('rejects WebSocket upgrades from agent credentials with 403', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: { Cookie: `agentmesh_session=${agentToken}`, Origin: `http://127.0.0.1:${port}` },
      });

      const status = await new Promise<number>((resolve) => {
        ws.once('unexpected-response', (_, res) => resolve(res.statusCode ?? 0));
      });
      expect(status).toBe(403);
    });

    it('delivers live board events to authenticated WebSocket connections', async () => {
      const c = await cookie();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: { Cookie: c, Origin: `http://127.0.0.1:${port}` },
      });

      await new Promise((resolve) => ws.once('open', resolve));

      const eventPromise = new Promise<{ type: string; payload: { text: string; agentId: string } }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(String(data))));
      });

      board.setStatus(claude, 'Working on audit verification');
      const received = await eventPromise;

      expect(received.type).toBe('EVENT');
      expect(received.payload.text).toBe('Working on audit verification');
      expect(received.payload.agentId).toBe('claude-1');

      ws.close();
    });
  });
});
