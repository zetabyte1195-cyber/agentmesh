// A second, much smaller front door for agents running in containers.
//
// The main server listens only on this computer's loopback address, so a container cannot reach it. Opening
// that server to the network would expose the cockpit, the login link and every Human control. Instead,
// container mode starts THIS listener, which serves exactly one thing: POST /mcp, with an agent's Bearer token.
//   • everything else is 404: no cockpit, no /login, no static files, no WebSocket upgrades
//   • cookies are never read, so a Human session can never be used here; a Human token is refused (403)
//   • the Host header must be one of this listener's own addresses (a guard against DNS rebinding, not a login:
//     the token is the credential)
//   • tokens are per-run, 256-bit, revoked when the run ends and again when AgentMesh restarts
// A container that has its own run's token can use that agent's tools, as intended, and nothing more.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { AuthError, type IdentityService, ImpersonationError, type Principal } from '../identity/index.js';
import { extractBearer } from '../identity/tokens.js';
import { listenFree } from '../server/ports.js';

export interface AgentListenerOptions {
  identity: IdentityService;
  host: string;
  port: number;
  /** The name containers use for this computer, e.g. host.docker.internal. */
  hostAlias: string;
  handler: (req: IncomingMessage, res: ServerResponse, principal: Principal, body: string) => unknown | Promise<unknown>;
  maxBodyBytes?: number;
}

export class AgentListener {
  private readonly http: Server;
  private boundPort = 0;
  private readonly maxBody: number;

  constructor(private readonly o: AgentListenerOptions) {
    this.maxBody = o.maxBodyBytes ?? 64 * 1024;
    this.http = createServer((req, res) => void this.handle(req, res));
    this.http.on('upgrade', (_req, socket) => socket.destroy());
  }

  async listen(): Promise<{ host: string; port: number }> {
    // A container's client refuses the same ports a browser does, so a port chosen by the system is never one of them.
    this.boundPort = await listenFree(this.http, this.o.host, this.o.port);
    return { host: this.o.host, port: this.boundPort };
  }

  get port(): number {
    return this.boundPort;
  }

  async close(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private hostOk(req: IncomingMessage): boolean {
    const p = this.boundPort;
    return new Set([`${this.o.hostAlias}:${p}`, `${this.o.host}:${p}`, `127.0.0.1:${p}`, `localhost:${p}`]).has(req.headers.host ?? '');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status: number, error: string) => {
      if (res.writableEnded) return;
      req.resume(); // a refused request's body is read and thrown away, or the client sees the connection reset instead of the answer
      if (status === 413) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error }));
    };
    try {
      if (!this.hostOk(req)) return fail(403, 'Forbidden host');
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method !== 'POST' || path !== '/mcp') return fail(404, 'Not found');
      const bearer = extractBearer(req.headers.authorization);
      if (!bearer) return fail(401, 'MISSING_TOKEN');
      const principal = this.o.identity.authenticate(bearer);
      if (principal.isHuman) return fail(403, 'Agent only');
      const body = await new Promise<string>((resolve, reject) => {
        let size = 0;
        let tooLarge = false;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > this.maxBody && !tooLarge) {
            tooLarge = true;
            chunks.length = 0;
            reject(new Error('TOO_LARGE'));
          }
          if (!tooLarge) chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
      await this.o.handler(req, res, principal, body);
    } catch (err) {
      if (err instanceof AuthError) return fail(401, err.reason);
      if (err instanceof ImpersonationError) return fail(403, err.message);
      if ((err as Error).message === 'TOO_LARGE') return fail(413, 'Request body too large');
      fail(500, 'Internal error'); // never leak stacks
    }
  }
}
