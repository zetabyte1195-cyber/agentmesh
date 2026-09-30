// Commands that work with a running AgentMesh: login, stop, status, dispatch, and background mode.
// `start --background` launches a small supervisor in its own process; the supervisor runs AgentMesh
// and starts it again if it crashes (a limited number of times), so closing the terminal stops nothing.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandResult, openBrowser } from './setup.js';

/** A crash is restarted at most this many times in RESTART_WINDOW_MS; then the supervisor gives up. */
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** Exit code of `agentmesh start` when AgentMesh could not start at all (bad port, no config): not a crash. */
export const START_FAILED = 3;

export function shouldRestart(crashTimes: readonly number[], now: number): boolean {
  return crashTimes.filter((t) => now - t < RESTART_WINDOW_MS).length <= RESTART_LIMIT;
}

const daemon = () => import('@agentmesh/daemon');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rootOf(cwd: string): Promise<string | CommandResult> {
  try {
    return await (await daemon()).projectRoot(cwd);
  } catch {
    return { code: 1, output: `${cwd} is not an AgentMesh project (not a git repository). Run agentmesh init first.` };
  }
}

function failure(command: string, err: unknown): CommandResult {
  return { code: 1, output: `agentmesh ${command}: ${(err as Error).message}` };
}

export async function cmdLogin(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const root = await rootOf(cwd);
  if (typeof root !== 'string') return root;
  try {
    const { url } = await (await daemon()).callDaemon<{ url: string }>(root, 'POST', '/api/login-link');
    if (!argv.includes('--no-open')) openBrowser(url);
    return { code: 0, output: `Cockpit link (works once):\n${url}` };
  } catch (err) {
    return failure('login', err);
  }
}

export async function cmdStop(_argv: readonly string[], cwd: string): Promise<CommandResult> {
  const root = await rootOf(cwd);
  if (typeof root !== 'string') return root;
  const d = await daemon();
  const rec = d.readDaemonRecord(root);
  if (!rec || !d.isAlive(rec.pid)) return { code: 0, output: 'AgentMesh is not running here.' };
  try {
    await d.callDaemon(root, 'POST', '/api/stop');
  } catch (err) {
    return failure('stop', err);
  }
  for (let waited = 0; waited < 30_000; waited += 200) {
    if (!d.isAlive(rec.pid)) return { code: 0, output: 'AgentMesh stopped. Running agents were stopped with it; nothing is lost.' };
    await sleep(200);
  }
  return { code: 1, output: `AgentMesh was asked to stop but is still running after 30 seconds (process ${rec.pid}).` };
}

export async function cmdStatus(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const d = await daemon();
  try {
    const report = await d.projectStatus(cwd);
    return { code: 0, output: argv.includes('--json') ? JSON.stringify(report, null, 2) : d.formatStatus(report) };
  } catch (err) {
    return failure('status', err);
  }
}

export async function cmdDispatch(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const [action, agentId] = argv;
  if (action !== 'pause' && action !== 'resume') return { code: 1, output: 'Usage: agentmesh dispatch pause|resume [agent-id]\n  Without an agent id it applies to every agent.' };
  const root = await rootOf(cwd);
  if (typeof root !== 'string') return root;
  try {
    const r = await (await daemon()).callDaemon<{ paused: boolean }>(root, 'POST', '/api/dispatch', { paused: action === 'pause', ...(agentId ? { agentId } : {}) });
    const who = agentId ? ` for ${agentId}` : '';
    return { code: 0, output: action === 'pause' ? `Dispatching paused${who}. Runs already going finish normally.` : r.paused ? `Resumed${who}, but dispatching is still paused for everyone: agentmesh dispatch resume` : `Dispatching resumed${who}.` };
  } catch (err) {
    return failure('dispatch', err);
  }
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** `agentmesh start --background`: start the supervisor detached, wait until AgentMesh answers, hand out a link. */
export async function cmdStartBackground(argv: readonly string[], cwd: string, entry: string): Promise<CommandResult> {
  const root = await rootOf(cwd);
  if (typeof root !== 'string') return root;
  const d = await daemon();
  const running = d.readDaemonRecord(root);
  if (running && d.isAlive(running.pid)) return { code: 0, output: `AgentMesh is already running here: http://127.0.0.1:${running.port}\nFor a cockpit link: agentmesh login` };
  if (!existsSync(join(root, '.agentmesh', 'config.json'))) return { code: 1, output: 'AgentMesh is not set up here yet: run agentmesh init' };

  const log = join(root, '.agentmesh', 'daemon.log');
  const since = Date.now();
  const fd = openSync(log, 'a');
  const rest = argv.filter((a) => a !== '--background' && a !== '--no-open');
  const child = spawn(process.execPath, [entry, 'supervise', ...rest], { cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  closeSync(fd);
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));
  child.unref();

  for (let waited = 0; waited < 60_000 && exited === undefined; waited += 250) {
    const rec = d.readDaemonRecord(root);
    if (rec && d.isAlive(rec.pid) && Date.parse(rec.startedAt) >= since - 1000) {
      const lines = [`AgentMesh is running in the background: http://127.0.0.1:${rec.port}`];
      try {
        const { url } = await d.callDaemon<{ url: string }>(root, 'POST', '/api/login-link');
        if (!argv.includes('--no-open')) openBrowser(url);
        lines.push('Cockpit link (works once):', url);
      } catch {
        lines.push('For a cockpit link: agentmesh login');
      }
      lines.push('', 'It keeps running after you close this window, and restarts itself if it crashes.', 'Stop it with: agentmesh stop', `Log: ${log}`);
      return { code: 0, output: lines.join('\n') };
    }
    await sleep(250);
  }
  return { code: 1, output: `AgentMesh did not start${exited === undefined ? ' within a minute' : ''}. The end of its log (${log}):\n${tail(log, 15)}` };
}

/** `agentmesh supervise` (started by start --background): run AgentMesh, restart it after a crash. */
export async function cmdSupervise(argv: readonly string[], cwd: string, entry: string): Promise<CommandResult> {
  const crashes: number[] = [];
  let stopping = false;
  let current: ReturnType<typeof spawn> | null = null;
  const stop = () => {
    stopping = true;
    current?.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const say = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
  for (;;) {
    say('starting AgentMesh');
    const child = spawn(process.execPath, [entry, 'start', '--no-open', '--supervised', ...argv], { cwd, stdio: 'inherit', windowsHide: true });
    current = child;
    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (c) => resolve(c));
      child.on('error', () => resolve(1));
    });
    current = null;
    if (stopping || code === 0) {
      say('AgentMesh stopped');
      return { code: 0, output: '' };
    }
    if (code === START_FAILED) {
      say('AgentMesh could not start (see above); not trying again');
      return { code: 1, output: '' };
    }
    const now = Date.now();
    crashes.push(now);
    if (!shouldRestart(crashes, now)) {
      say(`AgentMesh stopped unexpectedly ${RESTART_LIMIT + 1} times in ${RESTART_WINDOW_MS / 60_000} minutes; not restarting. Start it again with: agentmesh start`);
      return { code: 1, output: '' };
    }
    say(`AgentMesh stopped unexpectedly (exit code ${code}); restarting in 3 seconds`);
    await sleep(3000);
    if (stopping) return { code: 0, output: '' };
  }
}
