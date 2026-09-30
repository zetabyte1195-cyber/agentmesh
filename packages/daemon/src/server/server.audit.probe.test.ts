// New adversarial probes for DaemonServer (P2.6 audit).
// Testing edge cases in Host/Origin validation, cookie session handling, WebSocket upgrades, and static serving.
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { BIND_HOST, DaemonServer, SESSION_COOKIE } from './server.js';

let db: SqliteDatabase;
let ids: IdentityService;
let server: DaemonServer;
let port: number;
let agentToken: string;
let tempStaticDir: string;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: BIND_HOST,
        port,
        method,
        path,
        headers: { Host: `${BIND_HOST}:${port}`, ...headers },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8').on('data', (d: string) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
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
  return setCookie.split(';')[0]!;
}

beforeEach(async () => {
  tempStaticDir = mkdtempSync(join(tmpdir(), 'agentmesh-server-audit-static-'));
  writeFileSync(join(tempStaticDir, 'index.html'), '<html><body>Cockpit Shell</body></html>');
  writeFileSync(join(tempStaticDir, 'app.js'), 'console.log("ready");');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  agentToken = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });

  server = new DaemonServer({
    identity: ids,
    humanAgentId: 'human',
    maxBodyBytes: 1024,
    staticDir: tempStaticDir,
  });

  server.route('GET', '/api/identity', 'any', ({ principal }) => ({ agentId: principal?.agentId, isHuman: principal?.isHuman }));
  server.route('POST', '/api/mutate-human', 'human', async ({ body }) => ({ receivedLen: (await body()).length }));
  server.route('POST', '/api/mutate-agent', 'agent', async ({ body }) => ({ receivedLen: (await body()).length }));

  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  closeDatabase(db);
  rmSync(tempStaticDir, { recursive: true, force: true });
});

describe('P2.6 Audit Probe: Host Header Port Mismatch & Case Sensitivity', () => {
  it('rejects Host header pointing to wrong port on loopback', async () => {
    const wrongPort = port === 8999 ? 8998 : 8999;
    const r = await send('GET', '/api/identity', {
      Host: `${BIND_HOST}:${wrongPort}`,
      Authorization: `Bearer ${agentToken}`,
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'Forbidden host' });
  });

  it('rejects IPv6 loopback [::1] as Host header', async () => {
    const r = await send('GET', '/api/identity', {
      Host: `[::1]:${port}`,
      Authorization: `Bearer ${agentToken}`,
    });
    expect(r.status).toBe(403);
  });
});

describe('P2.6 Audit Probe: Session Revocation & Cookie Parsing Resilience', () => {
  it('revoking a session token immediately blocks subsequent cookie requests', async () => {
    const cookie = await loginCookie();
    const tokenVal = cookie.slice(`${SESSION_COOKIE}=`.length);

    // Initial check passes
    const r1 = await send('POST', '/api/mutate-human', { Cookie: cookie, Origin: origin() }, 'test');
    expect(r1.status).toBe(200);

    // Revoke token in identity service
    ids.revokeToken(tokenVal);

    // Subsequent call must fail with 401 REVOKED_TOKEN
    const r2 = await send('POST', '/api/mutate-human', { Cookie: cookie, Origin: origin() }, 'test');
    expect(r2.status).toBe(401);
    expect(JSON.parse(r2.body)).toEqual({ error: 'REVOKED_TOKEN' });
  });

  it('correctly extracts session cookie when multiple cookies surround it with whitespace', async () => {
    const cookie = await loginCookie();
    const tokenVal = cookie.slice(`${SESSION_COOKIE}=`.length);

    const r = await send('GET', '/api/identity', {
      Cookie: `  theme=light ;   ${SESSION_COOKIE}=${tokenVal}   ; tracking=off  `,
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ agentId: 'human', isHuman: true });
  });

  it('rejects request when cookie contains only whitespace or delimiter characters', async () => {
    const r = await send('POST', '/api/mutate-human', {
      Cookie: ' ; ; ; ',
      Origin: origin(),
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: 'MISSING_TOKEN' });
  });
});

describe('P2.6 Audit Probe: WebSocket Security & Lifecycle', () => {
  const connect = (headers: Record<string, string>, path = '/ws/cockpit') =>
    new Promise<{ ws: WebSocket | null; status: number | null }>((resolve) => {
      const ws = new WebSocket(`ws://${BIND_HOST}:${port}${path}`, { headers });
      ws.on('open', () => resolve({ ws, status: null }));
      ws.on('unexpected-response', (_req, res) => resolve({ ws: null, status: res.statusCode ?? 0 }));
      ws.on('error', () => resolve({ ws: null, status: -1 }));
    });

  it('rejects WebSocket upgrade if session token is revoked', async () => {
    const cookie = await loginCookie();
    const tokenVal = cookie.slice(`${SESSION_COOKIE}=`.length);
    ids.revokeToken(tokenVal);

    const res = await connect({ Cookie: cookie, Origin: origin() });
    expect(res.status).toBe(401);
  });

  it('WebSocket broadcast does not crash when client closes connection abruptly', async () => {
    const cookie = await loginCookie();
    const { ws } = await connect({ Cookie: cookie, Origin: origin() });
    expect(ws).not.toBeNull();

    // Terminate abruptly
    ws!.terminate();

    // Broadcast should succeed without throwing
    expect(() => {
      server.broadcast({ type: 'PING' });
    }).not.toThrow();
  });
});

describe('P2.6 Audit Probe: Static Serving & Path Traversal Protections', () => {
  it('serves static files with strict CSP and nosniff headers', async () => {
    const r = await send('GET', '/app.js');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/javascript');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toBe('console.log("ready");');
  });

  it('rejects directory traversal attempts outside staticDir', async () => {
    const r1 = await send('GET', '/../../package.json');
    // Either 404 or falls back to index.html within staticDir; must NOT leak package.json
    expect(r1.body).not.toContain('@agentmesh');

    const r2 = await send('GET', '/..%2f..%2fpackage.json');
    expect(r2.body).not.toContain('@agentmesh');
  });

  it('SPA fallback serves index.html for unknown frontend routes', async () => {
    const r = await send('GET', '/timeline/tasks/T1');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Cockpit Shell');
  });

  it('does NOT fallback to index.html for unknown /api/ routes', async () => {
    const r = await send('GET', '/api/nonexistent', {
      Authorization: `Bearer ${agentToken}`,
    });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'Not found' });
  });
});
