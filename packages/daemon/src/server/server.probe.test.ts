// Adversarial security & robustness probes for DaemonServer (P2.6).
// Auditing Host/Origin validation, cookie parsing, auth separation, WebSocket upgrades, body limits.
import { request } from 'node:http';
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
let humanToken: string;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
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
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  agentToken = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  const humanReg = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  humanToken = humanReg.token;

  server = new DaemonServer({ identity: ids, humanAgentId: 'human', maxBodyBytes: 512 });
  server.route('GET', '/whoami', 'any', ({ principal }) => ({ agentId: principal?.agentId, isHuman: principal?.isHuman }));
  server.route('POST', '/agent-only', 'agent', async ({ principal, body }) => ({ agentId: principal?.agentId, len: (await body()).length }));
  server.route('POST', '/human-only', 'human', async ({ principal, body }) => ({ agentId: principal?.agentId, len: (await body()).length }));
  server.route('GET', '/unprotected', 'none', () => ({ public: true }));
  server.route('POST', '/echo', 'any', async ({ body }) => ({ echoed: await body() }));

  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  closeDatabase(db);
});

describe('DaemonServer Probe: Host Header Adversarial Tests', () => {
  it('rejects Host without port', async () => {
    const r = await send('GET', '/unprotected', { Host: BIND_HOST });
    expect(r.status).toBe(403);
  });

  it('rejects Host localhost without port', async () => {
    const r = await send('GET', '/unprotected', { Host: 'localhost' });
    expect(r.status).toBe(403);
  });

  it('rejects arbitrary external domain Host', async () => {
    const r = await send('GET', '/unprotected', { Host: `attacker.evil:${port}` });
    expect(r.status).toBe(403);
  });

  it('rejects Host with credentials / userinfo', async () => {
    const r = await send('GET', '/unprotected', { Host: `admin:pass@${BIND_HOST}:${port}` });
    expect(r.status).toBe(403);
  });

  it('rejects 0.0.0.0 Host even on loopback port', async () => {
    const r = await send('GET', '/unprotected', { Host: `0.0.0.0:${port}` });
    expect(r.status).toBe(403);
  });

  it('accepts localhost with port as valid Host', async () => {
    const r = await send('GET', '/unprotected', { Host: `localhost:${port}` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ public: true });
  });
});

describe('DaemonServer Probe: Origin Header Adversarial Tests', () => {
  it('rejects null Origin for mutating cookie-authenticated request', async () => {
    const cookie = await loginCookie();
    const r = await send('POST', '/human-only', { Cookie: cookie, Origin: 'null' });
    expect(r.status).toBe(403);
  });

  it('rejects trailing slash in Origin header', async () => {
    const cookie = await loginCookie();
    const r = await send('POST', '/human-only', { Cookie: cookie, Origin: `${origin()}/` });
    expect(r.status).toBe(403);
  });

  it('rejects https scheme in Origin when daemon runs on http', async () => {
    const cookie = await loginCookie();
    const r = await send('POST', '/human-only', { Cookie: cookie, Origin: `https://${BIND_HOST}:${port}` });
    expect(r.status).toBe(403);
  });

  it('rejects prefix/suffix subdomains matching loopback string', async () => {
    const cookie = await loginCookie();
    const r1 = await send('POST', '/human-only', { Cookie: cookie, Origin: `http://${BIND_HOST}:${port}.attacker.com` });
    expect(r1.status).toBe(403);
    const r2 = await send('POST', '/human-only', { Cookie: cookie, Origin: `http://attacker.com?${origin()}` });
    expect(r2.status).toBe(403);
  });

  it('allows Bearer requests without Origin (CLI / non-browser)', async () => {
    const r = await send('POST', '/agent-only', { Authorization: `Bearer ${agentToken}` }, 'hello');
    expect(r.status).toBe(200);
  });

  it('rejects Bearer requests with foreign Origin (browser fetch with forged/stolen Bearer)', async () => {
    const r = await send('POST', '/agent-only', { Authorization: `Bearer ${agentToken}`, Origin: 'http://malicious.org' }, 'hello');
    expect(r.status).toBe(403);
  });

  it('allows Bearer requests with valid Origin', async () => {
    const r = await send('POST', '/agent-only', { Authorization: `Bearer ${agentToken}`, Origin: origin() }, 'hello');
    expect(r.status).toBe(200);
  });
});

describe('DaemonServer Probe: Cookie & Session Hardening', () => {
  it('rejects similar cookie names (e.g. fake_agentmesh_session)', async () => {
    const r = await send('POST', '/human-only', {
      Cookie: `fake_agentmesh_session=${humanToken}`,
      Origin: origin(),
    });
    expect(r.status).toBe(401);
  });

  it('rejects empty cookie value', async () => {
    const r = await send('POST', '/human-only', {
      Cookie: `${SESSION_COOKIE}=`,
      Origin: origin(),
    });
    expect(r.status).toBe(401);
  });

  it('rejects malformed token in cookie', async () => {
    const r = await send('POST', '/human-only', {
      Cookie: `${SESSION_COOKIE}=not-a-valid-token`,
      Origin: origin(),
    });
    expect(r.status).toBe(401);
  });

  it('rejects agent token attempting human-only route via cookie', async () => {
    const r = await send('POST', '/human-only', {
      Cookie: `${SESSION_COOKIE}=${agentToken}`,
      Origin: origin(),
    });
    expect(r.status).toBe(403);
  });

  it('rejects human token attempting agent-only route via cookie', async () => {
    const cookie = await loginCookie();
    const r = await send('POST', '/agent-only', {
      Cookie: cookie,
      Origin: origin(),
    });
    expect(r.status).toBe(403);
  });

  it('rejects human token attempting agent-only route via Bearer', async () => {
    const r = await send('POST', '/agent-only', {
      Authorization: `Bearer ${humanToken}`,
    });
    expect(r.status).toBe(403);
  });

  it('parses cookie among multiple semi-colon separated cookies', async () => {
    const cookie = await loginCookie();
    const tokenVal = cookie.split('=')[1];
    const r = await send('POST', '/human-only', {
      Cookie: `theme=dark; ${SESSION_COOKIE}=${tokenVal}; track=none`,
      Origin: origin(),
    });
    expect(r.status).toBe(200);
  });
});

describe('DaemonServer Probe: Cockpit Login Link Hardening', () => {
  it('login link cannot be reused (one-time token)', async () => {
    const link = server.issueCockpitUrl();
    const url = new URL(link);
    const r1 = await send('GET', url.pathname + url.search);
    expect(r1.status).toBe(303);
    const r2 = await send('GET', url.pathname + url.search);
    expect(r2.status).toBe(401);
  });

  it('login request without code parameter returns 401', async () => {
    const r = await send('GET', '/login');
    expect(r.status).toBe(401);
  });

  it('login request with empty code parameter returns 401', async () => {
    const r = await send('GET', '/login?code=');
    expect(r.status).toBe(401);
  });

  it('login cookie has HttpOnly, SameSite=Strict and Path=/', async () => {
    const link = server.issueCockpitUrl();
    const url = new URL(link);
    const r = await send('GET', url.pathname + url.search);
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);
  });
});

describe('DaemonServer Probe: WebSocket Security Hardening', () => {
  const connect = (headers: Record<string, string>, path = '/ws/cockpit') =>
    new Promise<{ ws: WebSocket | null; status: number | null }>((resolve) => {
      const ws = new WebSocket(`ws://${BIND_HOST}:${port}${path}`, { headers });
      ws.on('open', () => resolve({ ws, status: null }));
      ws.on('unexpected-response', (_req, res) => resolve({ ws: null, status: res.statusCode ?? 0 }));
      ws.on('error', () => resolve({ ws: null, status: -1 }));
    });

  it('rejects upgrade to non-existent WebSocket route', async () => {
    const cookie = await loginCookie();
    const res = await connect({ Cookie: cookie, Origin: origin() }, '/ws/unknown');
    expect(res.status).toBe(404);
  });

  it('rejects upgrade with Origin null (sandboxed iframe CSWSH attack)', async () => {
    const cookie = await loginCookie();
    const res = await connect({ Cookie: cookie, Origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('rejects upgrade when agent token is used instead of human session', async () => {
    const res = await connect({
      Cookie: `${SESSION_COOKIE}=${agentToken}`,
      Origin: origin(),
    });
    expect(res.status).toBe(403);
  });

  it('rejects upgrade with missing Origin header', async () => {
    const cookie = await loginCookie();
    const res = await connect({ Cookie: cookie });
    expect(res.status).toBe(403);
  });
});

describe('DaemonServer Probe: Body Limit & Request Handling', () => {
  it('accepts body at exact limit (512 bytes)', async () => {
    const body = 'a'.repeat(512);
    const r = await send('POST', '/echo', { Authorization: `Bearer ${agentToken}` }, body);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ echoed: body });
  });

  it('rejects body exceeding limit by 1 byte (513 bytes) with 413 and Connection: close', async () => {
    const body = 'a'.repeat(513);
    const r = await send('POST', '/echo', { Authorization: `Bearer ${agentToken}` }, body);
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe('close');
  });

  it('sets nosniff and no-store headers on responses', async () => {
    const r = await send('GET', '/unprotected');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
