import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { BIND_HOST, DaemonServer, HttpError, SESSION_COOKIE } from './server.js';

let db: SqliteDatabase;
let ids: IdentityService;
let server: DaemonServer;
let port: number;
let agentToken: string;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP so tests can forge Host/Origin headers (fetch won't let you set Host). */
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: BIND_HOST, port, method, path, headers: { Host: `${BIND_HOST}:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (d: string) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const origin = () => `http://${BIND_HOST}:${port}`;

async function loginCookie(): Promise<string> {
  const url = new URL(server.issueCockpitUrl());
  const r = await send('GET', url.pathname + url.search);
  const setCookie = String(r.headers['set-cookie']);
  return setCookie.split(';')[0]!; // "agentmesh_session=…"
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  agentToken = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  server = new DaemonServer({ identity: ids, humanAgentId: 'human', maxBodyBytes: 1024 });
  server.route('GET', '/whoami', 'any', ({ principal }) => ({ agentId: principal?.agentId }));
  server.route('POST', '/agent-only', 'agent', async ({ principal, body }) => ({ agentId: principal?.agentId, got: (await body()).length }));
  server.route('POST', '/human-only', 'human', () => ({ ok: true }));
  server.route('GET', '/boom', 'any', () => {
    throw new Error('secret internal detail');
  });
  server.route('GET', '/teapot', 'any', () => {
    throw new HttpError(418, 'short and stout');
  });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  closeDatabase(db);
});

describe('DaemonServer', () => {
  it('listens on loopback only', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
  });

  it('rejects a foreign Host header even with a valid token (DNS rebinding)', async () => {
    const r = await send('GET', '/whoami', { Host: `evil.example:${port}`, Authorization: `Bearer ${agentToken}` });
    expect(r.status).toBe(403);
  });

  it('authenticates agents by Bearer token only', async () => {
    expect((await send('GET', '/whoami')).status).toBe(401);
    expect(JSON.parse((await send('GET', '/whoami', { Authorization: 'Bearer amt_not-a-real-token' })).body)).toEqual({ error: 'MALFORMED_TOKEN' });
    const ok = await send('GET', '/whoami', { Authorization: `Bearer ${agentToken}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ agentId: 'claude-1' });
    ids.revokeToken(agentToken);
    expect(JSON.parse((await send('GET', '/whoami', { Authorization: `Bearer ${agentToken}` })).body)).toEqual({ error: 'REVOKED_TOKEN' });
  });

  it('rejects a Bearer request coming from a foreign Origin', async () => {
    const r = await send('GET', '/whoami', { Authorization: `Bearer ${agentToken}`, Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });

  it('keeps Human-only and agent-only routes apart', async () => {
    expect((await send('POST', '/human-only', { Authorization: `Bearer ${agentToken}` })).status).toBe(403);
    const cookie = await loginCookie();
    expect((await send('POST', '/agent-only', { Cookie: cookie, Origin: origin() })).status).toBe(403);
  });

  it('the cockpit login link works exactly once and sets a hardened cookie', async () => {
    const url = new URL(server.issueCockpitUrl());
    const first = await send('GET', url.pathname + url.search);
    expect(first.status).toBe(303);
    const cookie = String(first.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE}=amt_`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect((await send('GET', url.pathname + url.search)).status).toBe(401); // replay
    expect((await send('GET', '/login?code=guess')).status).toBe(401);
  });

  it('cookie-authenticated writes require this daemon as Origin (CSRF); reads do not', async () => {
    const cookie = await loginCookie();
    expect((await send('GET', '/whoami', { Cookie: cookie })).status).toBe(200);
    expect((await send('POST', '/human-only', { Cookie: cookie })).status).toBe(403); // no Origin
    expect((await send('POST', '/human-only', { Cookie: cookie, Origin: 'http://evil.example' })).status).toBe(403);
    expect((await send('POST', '/human-only', { Cookie: cookie, Origin: origin() })).status).toBe(200);
  });

  it('enforces the body size limit', async () => {
    const r = await send('POST', '/agent-only', { Authorization: `Bearer ${agentToken}` }, 'x'.repeat(2048));
    expect(r.status).toBe(413);
    const ok = await send('POST', '/agent-only', { Authorization: `Bearer ${agentToken}` }, 'x'.repeat(100));
    expect(JSON.parse(ok.body)).toEqual({ agentId: 'claude-1', got: 100 });
  });

  it('never leaks internal error details; HttpError keeps its status', async () => {
    const boom = await send('GET', '/boom', { Authorization: `Bearer ${agentToken}` });
    expect(boom.status).toBe(500);
    expect(boom.body).not.toContain('secret');
    expect((await send('GET', '/teapot', { Authorization: `Bearer ${agentToken}` })).status).toBe(418);
    expect((await send('GET', '/nope', { Authorization: `Bearer ${agentToken}` })).status).toBe(404);
  });
});

describe('cockpit WebSocket', () => {
  const connect = (headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket | null; status: number | null }>((resolve) => {
      const ws = new WebSocket(`ws://${BIND_HOST}:${port}/ws/cockpit`, { headers });
      ws.on('open', () => resolve({ ws, status: null }));
      ws.on('unexpected-response', (_req, res) => resolve({ ws: null, status: res.statusCode ?? 0 }));
      ws.on('error', () => resolve({ ws: null, status: -1 }));
    });

  it('requires the Human session and this daemon as Origin', async () => {
    expect((await connect({ Origin: origin() })).status).toBe(401); // no session
    const cookie = await loginCookie();
    expect((await connect({ Cookie: cookie, Origin: 'http://evil.example' })).status).toBe(403); // hijack attempt
    expect((await connect({ Cookie: cookie })).status).toBe(403); // no Origin
    expect((await connect({ Cookie: `${SESSION_COOKIE}=${agentToken}`, Origin: origin() })).status).toBe(403); // agent, not Human
  });

  it('delivers broadcasts to an authenticated cockpit', async () => {
    const { ws } = await connect({ Cookie: await loginCookie(), Origin: origin() });
    expect(ws).not.toBeNull();
    const received = new Promise<unknown>((resolve) => ws!.once('message', (d) => resolve(JSON.parse(String(d)))));
    expect(server.broadcast({ type: 'EVENT', payload: { text: 'hello' } })).toBe(1);
    expect(await received).toEqual({ type: 'EVENT', payload: { text: 'hello' } });
    ws!.close();
  });
});

describe('body limit hardening (from Gemini P2.4 probe)', () => {
  it('rejects a declared oversized body even on a route that never reads the body', async () => {
    server.route('POST', '/ignores-body', 'agent', () => ({ ok: true }));
    const r = await send('POST', '/ignores-body', { Authorization: `Bearer ${agentToken}` }, 'x'.repeat(2048));
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe('close');
    const small = await send('POST', '/ignores-body', { Authorization: `Bearer ${agentToken}` }, 'x'.repeat(10));
    expect(small.status).toBe(200);
  });
});
