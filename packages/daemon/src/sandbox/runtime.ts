// Container mode at run time: the agent-only listener, container lifecycle (start, stop by name, sweep after a
// crash), and a cached health check so a stopped container engine pauses the agents instead of burning their
// retries. EXPERIMENTAL.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckRunner } from '../review/check.js';
import { resolveExecutable } from '../platforms/resolve.js';
import type { IdentityService } from '../identity/index.js';
import type { PlatformRunContext } from '../platforms/types.js';
import type { AgentCommand } from '../runner/commands.js';
import { AgentListener, type AgentListenerOptions } from './agent-listener.js';
import { type SandboxConfig, expandWrapper, isDockerLike, sandboxApplies, stopCommand } from './config.js';
import { type WrapContext, containerNameOf, containerView, projectIdOf, wrapCommand } from './wrap.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** `env` is added to this computer's environment for the command (how a token reaches a container without appearing in the command line). */
export type Exec = (command: string[], timeoutMs?: number, env?: Record<string, string>) => Promise<ExecResult>;

/** Runs a command without a shell and never throws. */
export const realExec: Exec = (command, timeoutMs = 15_000, env) =>
  new Promise((resolve) => {
    const resolved = resolveExecutable(command[0]!);
    if (!resolved || 'unsupported' in resolved) {
      resolve({ code: 127, stdout: '', stderr: `${command[0]} was not found${resolved && 'unsupported' in resolved ? `: ${resolved.unsupported}` : ''}` });
      return;
    }
    execFile(resolved.file, [...resolved.prefixArgs, ...command.slice(1)], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface SandboxRuntimeOptions {
  cfg: SandboxConfig;
  repoRoot: string;
  identity: IdentityService;
  handler: AgentListenerOptions['handler'];
  log?: (line: string) => void;
  /** Test seam. */
  exec?: Exec;
  healthIntervalMs?: number;
}

export class SandboxRuntime {
  readonly projectId: string;
  private readonly exec: Exec;
  private listener: AgentListener | null = null;
  private listenError: string | null = null;
  private bound: { host: string; port: number } | null = null;
  private health: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly live = new Set<string>();

  constructor(private readonly o: SandboxRuntimeOptions) {
    this.projectId = projectIdOf(o.repoRoot);
    this.exec = o.exec ?? realExec;
  }

  get cfg(): SandboxConfig {
    return this.o.cfg;
  }

  appliesTo(agentId: string): boolean {
    return sandboxApplies(this.o.cfg, agentId);
  }

  /** The address the listener is bound to, or null if it could not start. */
  get address(): { host: string; port: number } | null {
    return this.bound;
  }

  private async resolveHost(): Promise<string> {
    const { host } = this.o.cfg.listen;
    if (host !== 'auto') return host;
    // On Linux the container's route to this computer is the engine's bridge gateway; binding there keeps the listener off the LAN.
    if (process.platform === 'linux' && isDockerLike(this.o.cfg)) {
      const r = await this.exec([this.o.cfg.wrapper[0]!, 'network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
      const ip = r.stdout.trim();
      if (r.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    }
    return '127.0.0.1';
  }

  async start(): Promise<void> {
    const host = await this.resolveHost();
    this.listener = new AgentListener({ identity: this.o.identity, host, port: this.o.cfg.listen.port, hostAlias: this.o.cfg.hostAlias, handler: this.o.handler });
    try {
      this.bound = await this.listener.listen();
    } catch (err) {
      this.listener = null;
      this.listenError = (err as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL' ? `${host} is not an address of this computer. Set "listen": { "host": ... } to one that is.` : (err as Error).message;
    }
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.healthIntervalMs ?? 20_000);
    this.timer.unref();
  }

  /** The address the container uses to call AgentMesh. */
  mcpUrl(): string {
    return `http://${this.o.cfg.hostAlias}:${this.bound?.port ?? 0}/mcp`;
  }

  /** Why sandboxed agents cannot be started right now, or null. They wait; the run is never started outside the container. */
  blockedReason(): string | null {
    if (!this.listener) return `The container listener could not start: ${this.listenError ?? 'unknown reason'}.`;
    return this.health;
  }

  async refresh(): Promise<void> {
    if (!isDockerLike(this.o.cfg)) {
      this.health = null;
      return;
    }
    const r = await this.exec([this.o.cfg.wrapper[0]!, 'info', '--format', '{{.ServerVersion}}'], 10_000);
    this.health = r.code === 0 ? null : `The container engine is not running (${this.o.cfg.wrapper[0]}: ${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 160) ?? 'no answer'}). Agents wait; nothing runs outside a container.`;
  }

  view(run: PlatformRunContext): { cwd: string; run: PlatformRunContext } {
    return containerView(this.o.cfg, run);
  }

  wrap(inner: AgentCommand, ctx: Omit<WrapContext, 'projectId'>): { command: AgentCommand; name: string } {
    return wrapCommand(inner, { ...ctx, projectId: this.projectId }, this.o.cfg);
  }

  /** Stop and cleanup hooks for one run's container. */
  hooks(name: string): { terminate: () => Promise<void>; cleanup: () => Promise<void> } {
    this.live.add(name);
    return {
      terminate: () => this.remove(name),
      cleanup: async () => {
        await this.remove(name);
        this.live.delete(name);
      },
    };
  }

  private async remove(name: string): Promise<void> {
    await this.exec(stopCommand(this.o.cfg, name), 20_000);
  }

  /**
   * Runs the project's check command inside a container (when "checks" is "container"). Same wrapper, the task's workspace mounted
   * read-write, an empty read-only folder where the agent's connection settings would be, and NO token: the check never needs one.
   * Fails the way child_process.exec does, so reviews and the merge step handle it unchanged.
   */
  checkRunner(): CheckRunner {
    return (command, o) =>
      new Promise((resolve, reject) => {
        const emptyRunDir = mkdtempSync(join(tmpdir(), 'agentmesh-check-'));
        const name = containerNameOf(this.projectId, `chk${randomBytes(3).toString('hex')}`);
        const wrapper = expandWrapper(this.o.cfg, { name, cwd: o.cwd, runDir: emptyRunDir, runId: 'check', projectId: this.projectId, cwdAccess: 'rw' }, []);
        const resolved = resolveExecutable(wrapper[0]!);
        const done = () => rmSync(emptyRunDir, { recursive: true, force: true, maxRetries: 2 });
        if (!resolved || 'unsupported' in resolved) {
          done();
          reject(Object.assign(new Error(`The container command "${wrapper[0]}" was not found`), { code: 127, killed: false, stdout: '', stderr: '' }));
          return;
        }
        this.live.add(name);
        const child = execFile(resolved.file, [...resolved.prefixArgs, ...wrapper.slice(1), 'sh', '-c', command], { timeout: o.timeoutMs, windowsHide: true, maxBuffer: o.maxBuffer }, (err, stdout, stderr) => {
          // A timeout kills the docker client but not the container: remove it by name.
          void this.remove(name).finally(() => {
            this.live.delete(name);
            done();
            if (err) reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
            else resolve({ stdout: String(stdout), stderr: String(stderr) });
          });
        });
        child.on('error', () => undefined);
      });
  }

  /** Removes containers a previous AgentMesh process left behind (found by the project label). Returns how many. */
  async sweep(): Promise<number> {
    if (!isDockerLike(this.o.cfg)) return 0;
    const bin = this.o.cfg.wrapper[0]!;
    const ps = await this.exec([bin, 'ps', '-aq', '--filter', `label=agentmesh.project=${this.projectId}`]);
    const ids = ps.stdout.split(/\s+/).filter((s) => /^[0-9a-f]{6,64}$/i.test(s));
    if (ps.code !== 0 || !ids.length) return 0;
    await this.exec([bin, 'rm', '-f', ...ids], 60_000);
    this.o.log?.(`Container mode: removed ${ids.length} container(s) left over from an earlier run.`);
    return ids.length;
  }

  /** Removes every container this process started (AgentMesh is stopping). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.live].map((n) => this.remove(n)));
    this.live.clear();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.listener?.close();
    this.listener = null;
  }
}
