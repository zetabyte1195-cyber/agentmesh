// The daemon's HTTP front door (P2.6; spec v1.1 §7). Loopback only. Every request passes a
// Host check (DNS rebinding), browser requests pass an Origin check (CSRF / cross-site
// WebSocket hijacking), and identity always comes from a token: an agent's Bearer token, or
// the Human's cockpit session cookie, which is itself a Human token issued through a
// single-use login link.
import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthError, type IdentityService, ImpersonationError, type Principal } from '../identity/index.js';
import { extractBearer } from '../identity/tokens.js';

export const BIND_HOST = '127.0.0.1';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
export const SESSION_COOKIE = 'agentmesh_session';
const LOGIN_CODE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_BODY = 64 * 1024;

/** Who may call a route. */
export type RouteAuth = 'agent' | 'human' | 'any' | 'none';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The authenticated caller. Null only on 'none' routes. */
  principal: Principal | null;
  /** The request body as text, size-limited. */
  body: () => Promise<string>;
}

export type RouteHandler = (ctx: RouteContext) => unknown | Promise<unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DaemonServerOptions {
  identity: IdentityService;
  /** The Human's agent id (registered with platform/paradigm HUMAN). */
  humanAgentId: string;
  port?: number;
  maxBodyBytes?: number;
  /** Built cockpit (packages/dashboard/dist). Served to anyone: it holds no data, and every API and WebSocket call it makes is authenticated. */
  staticDir?: string;
}

export class DaemonServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly routes = new Map<string, { auth: RouteAuth; handler: RouteHandler }>();
  private readonly loginCodes = new Map<string, number>(); // code → expiry
  private readonly maxBody: number;
  private port = 0;

  constructor(private readonly options: DaemonServerOptions) {
    this.maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
    this.http = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxBody });
    this.http.on('upgrade', (req, socket, head) => {
      const refusal = this.checkUpgrade(req);
      if (refusal) {
        socket.write(`HTTP/1.1 ${refusal} Forbidden\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  /** Register a route. Exact method + path match. */
  route(method: string, path: string, auth: RouteAuth, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, { auth, handler });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port ?? 0, BIND_HOST, () => resolve());
    });
    this.port = (this.http.address() as AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /**
   * A single-use cockpit login link (spec v1.1 §7.2), printed once in the terminal.
   * Opening it sets the session cookie and redirects to the cockpit.
   */
  issueCockpitUrl(): string {
    const code = randomBytes(24).toString('base64url');
    this.loginCodes.set(code, Date.now() + LOGIN_CODE_TTL_MS);
    return `http://${BIND_HOST}:${this.port}/login?code=${code}`;
  }

  /** Push an event to every authenticated cockpit WebSocket. */
  broadcast(message: unknown): number {
    const data = JSON.stringify(message);
    let sent = 0;
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        sent++;
      }
    }
    return sent;
  }

  private allowedHosts(): Set<string> {
    return new Set([`${BIND_HOST}:${this.port}`, `localhost:${this.port}`]);
  }

  private hostOk(req: IncomingMessage): boolean {
    return this.allowedHosts().has(req.headers.host ?? '');
  }

  /** Origin, when present, must be this daemon. `required` for browser-cookie actions and WebSockets. */
  private originOk(req: IncomingMessage, required: boolean): boolean {
    const origin = req.headers.origin;
    if (!origin) return !required;
    return [...this.allowedHosts()].some((h) => origin === `http://${h}`);
  }

  private sessionToken(req: IncomingMessage): string | null {
    const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
    const hit = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    return hit ? decodeURIComponent(hit.slice(SESSION_COOKIE.length + 1)) : null;
  }

  private checkUpgrade(req: IncomingMessage): number | null {
    if (!this.hostOk(req) || !this.originOk(req, true)) return 403;
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws/cockpit') return 404;
    try {
      const principal = this.options.identity.authenticate(this.sessionToken(req));
      return principal.isHuman ? null : 403;
    } catch {
      return 401;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!this.hostOk(req)) throw new HttpError(403, 'Forbidden host');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/login') return this.login(url, res);

      const route = this.routes.get(`${req.method} ${url.pathname}`);
      if (!route && req.method === 'GET' && this.options.staticDir && !/^\/(api|mcp|ws)(\/|$)/.test(url.pathname)) {
        return await this.serveStatic(url.pathname, res);
      }
      if (!route) throw new HttpError(404, 'Not found');
      const principal = this.authenticate(req, route.auth);
      // Always read (and size-cap) the body before the handler runs, so the limit holds for every
      // route and encoding, including chunked bodies to handlers that never read them (P2.4 hardening).
      const body = await this.readBody(req);
      const result = await route.handler({ req, res, url, principal, body: () => Promise.resolve(body) });
      if (!res.writableEnded) this.json(res, 200, result ?? { ok: true });
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        this.json(res, err.status, { error: err.message });
      }
      else if (err instanceof AuthError) this.json(res, 401, { error: err.reason });
      else if (err instanceof ImpersonationError) this.json(res, 403, { error: err.message });
      else this.json(res, 500, { error: 'Internal error' }); // never leak stacks
    }
  }

  /**
   * Bearer token (agents, CLI) or session cookie (the Human's browser). A cookie is ambient, so
   * cookie-authenticated requests must also carry this daemon's Origin (CSRF); Bearer tokens
   * are never sent automatically by browsers.
   */
  private authenticate(req: IncomingMessage, auth: RouteAuth): Principal | null {
    if (auth === 'none') return null;
    const bearer = extractBearer(req.headers.authorization);
    let principal: Principal;
    if (bearer) {
      if (!this.originOk(req, false)) throw new HttpError(403, 'Forbidden origin');
      principal = this.options.identity.authenticate(bearer);
    } else {
      const cookie = this.sessionToken(req);
      if (!cookie) throw new AuthError('MISSING_TOKEN');
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (!this.originOk(req, mutating)) throw new HttpError(403, 'Forbidden origin');
      principal = this.options.identity.authenticate(cookie);
    }
    if (auth === 'human' && !principal.isHuman) throw new HttpError(403, 'Human only');
    if (auth === 'agent' && principal.isHuman) throw new HttpError(403, 'Agent only');
    return principal;
  }

  private login(url: URL, res: ServerResponse): void {
    const code = url.searchParams.get('code') ?? '';
    const expiry = this.loginCodes.get(code);
    this.loginCodes.delete(code); // single use, even if expired
    if (!expiry || expiry < Date.now()) throw new HttpError(401, 'Login link invalid or already used');
    const token = this.options.identity.issueToken(this.options.humanAgentId, 'cockpit-session');
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end();
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBody && !tooLarge) {
          // Stop buffering but don't destroy the socket yet: the 413 must reach the client first.
          // The response carries Connection: close, so the socket ends after it is written.
          tooLarge = true;
          chunks.length = 0;
          reject(new HttpError(413, 'Request body too large'));
        }
        if (!tooLarge) chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** Static cockpit files with a strict CSP; unknown paths fall back to index.html (SPA). */
  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const root = resolve(this.options.staticDir!);
    let file = resolve(root, '.' + decodeURIComponent(pathname));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'Not found'); // path traversal
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    if (!isFile) file = join(root, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) throw new HttpError(404, 'Cockpit not built (run npm run build)');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}
