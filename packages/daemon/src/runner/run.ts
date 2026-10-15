// Supervises one headless agent process (spec v1.1 §10.2): no shell, no PTY, stream-json
// parsed line by line, lease heartbeat while it runs, timeout, and a stop that ends the whole
// process tree (agents start their own children, e.g. MCP servers). Windows has no SIGSTOP,
// so there is no pause here: "pause" means the daemon stops dispatching new runs.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AgentCommand } from './commands.js';
import { LineSplitter, type RunnerEvent } from './events.js';
import { DEFAULT_LOOP_THRESHOLD, LoopDetector } from './loop.js';

export type ResultEvent = Extract<RunnerEvent, { kind: 'result' }>;

export interface RunOptions {
  command: AgentCommand;
  cwd: string;
  /** Added to the inherited environment, e.g. { AGENTMESH_TOKEN }. */
  env?: Record<string, string>;
  onEvent?: (event: RunnerEvent) => void;
  /** Every raw output line, for the cockpit's read-only runner view. */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Called every intervalMs while the process runs (lease renewal). */
  heartbeat?: { intervalMs: number; beat: () => void };
  timeoutMs?: number;
  /** Stop the run when the agent makes the same tool call with the same result this many times in a row. 0 turns it off. Default 3. */
  loopThreshold?: number;
  /** Called first when the run is stopped or times out, before the process is killed (container mode: remove the container by name). */
  terminate?: () => Promise<void>;
  /** Called once when the run has ended, however it ended. Never throws. */
  cleanup?: () => Promise<void>;
}

export interface RunResult {
  /** True only if the process exited 0 AND reported a successful result event AND wasn't stopped. */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  result: ResultEvent | null;
  /** Why ok is false, in one line. */
  failure: string | null;
  stderrTail: string[];
  heartbeatErrors: number;
  /** Set when the run was stopped for repeating itself: "no_progress: ..." (the reason is also `failure`). */
  noProgress: string | null;
}

export interface RunningAgent {
  pid: number | undefined;
  done: Promise<RunResult>;
  stop: () => Promise<void>;
}

const STDERR_TAIL = 20;
const MAX_TEXT_CHARS = 200_000;

/**
 * Every descendant of a process on macOS/Linux, deepest first. A process group is not enough: a child
 * that starts its own group or session (agents' helpers sometimes do) survives a group kill.
 */
async function descendantsOf(rootPid: number): Promise<number[]> {
  const listing = await new Promise<string>((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  const children = new Map<number, number[]>();
  for (const line of listing.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const walk = (pid: number, depth: number) => {
    if (depth > 64) return;
    for (const kid of children.get(pid) ?? []) {
      walk(kid, depth + 1);
      out.push(kid);
    }
  };
  walk(rootPid, 0);
  return out;
}

const tryKill = (pid: number, signal: NodeJS.Signals = 'SIGKILL') => {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
};

/** End the process and all its descendants. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('close', () => resolve());
      killer.on('error', () => {
        child.kill();
        resolve();
      });
    } else {
      const pid = child.pid;
      // Find the descendants BEFORE killing anything: once their parent is gone they are re-parented and untraceable.
      void descendantsOf(pid).then((descendants) => {
        tryKill(-pid); // the child leads its own process group (detached)
        child.kill('SIGKILL');
        for (const d of descendants) tryKill(d);
        resolve();
      });
    }
  });
}

export function startAgent(options: RunOptions): RunningAgent {
  const { command } = options;
  const splitter = new LineSplitter();
  const stderrSplitter = new LineSplitter();
  const stderrTail: string[] = [];
  let result: ResultEvent | null = null;
  let stopped = false;
  let timedOut = false;
  let heartbeatErrors = 0;
  let noProgress: string | null = null;
  const loop = new LoopDetector(options.loopThreshold ?? DEFAULT_LOOP_THRESHOLD);

  const child = spawn(command.executable, command.args, {
    cwd: options.cwd,
    env: { ...process.env, ...command.env, ...options.env },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const textLines: string[] = [];
  let textChars = 0;
  const handleStdoutLine = (line: string) => {
    options.onOutput?.('stdout', line);
    if (command.textOutput) {
      if (textChars < MAX_TEXT_CHARS) {
        textLines.push(line);
        textChars += line.length + 1;
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // not an event (banner, warning): output only
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const event of command.parse(parsed as Record<string, unknown>)) {
      if (event.kind === 'result') result = event;
      options.onEvent?.(event);
      if (!noProgress) {
        const looping = loop.observe(event);
        if (looping) {
          noProgress = looping;
          void stop(); // a function declaration below: safe to call from here
        }
      }
    }
  };
  const handleStderrLine = (line: string) => {
    options.onOutput?.('stderr', line);
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
  };

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => splitter.push(chunk).forEach(handleStdoutLine));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderrSplitter.push(chunk).forEach(handleStderrLine));

  const beat = options.heartbeat
    ? setInterval(() => {
        try {
          options.heartbeat?.beat();
        } catch {
          heartbeatErrors++;
        }
      }, options.heartbeat.intervalMs)
    : null;

  async function stop(): Promise<void> {
    stopped = true;
    // Killing a `docker run` client does not stop its container, so the container goes first.
    await options.terminate?.().catch(() => undefined);
    await killTree(child);
  }
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        void stop();
      }, options.timeoutMs)
    : null;

  const done = new Promise<RunResult>((resolve) => {
    let finished = false;
    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (finished) return; // 'error' and 'close' can both fire for one failed spawn
      finished = true;
      if (beat) clearInterval(beat);
      if (timer) clearTimeout(timer);
      void options.cleanup?.().catch(() => undefined);
      splitter.flush().forEach(handleStdoutLine);
      stderrSplitter.flush().forEach(handleStderrLine);
      // Plain-text tools have no result event: a clean exit is the result, and stdout is its text.
      if (command.textOutput && !spawnError && exitCode === 0 && !stopped && !timedOut) {
        result = { kind: 'result', ok: true, turns: null, costUsd: null, usage: null, text: textLines.join('\n'), denied: [] };
        options.onEvent?.(result);
      }
      const final = result as ResultEvent | null;
      let failure: string | null = null;
      if (spawnError) {
        // Node reports a missing working folder as ENOENT for the program; say which one is really missing.
        failure = !existsSync(options.cwd) ? `could not start ${command.executable}: its working folder does not exist (${options.cwd})` : `could not start ${command.executable}: ${spawnError.message}`;
      }
      else if (noProgress) failure = noProgress;
      else if (timedOut) failure = `timed out after ${options.timeoutMs} ms`;
      else if (stopped) failure = 'stopped';
      else if (exitCode !== 0) failure = `exited with code ${exitCode}`;
      else if (!final) failure = 'exited without a result event';
      else if (!final.ok) failure = 'agent reported failure';
      else if (final.denied?.length) failure = `refused by the agent's permission rules: ${final.denied.join(', ')} (the run ended there)`;
      resolve({ ok: failure === null, exitCode, timedOut, stopped, result: final, failure, stderrTail, heartbeatErrors, noProgress });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });

  return { pid: child.pid, done, stop };
}
