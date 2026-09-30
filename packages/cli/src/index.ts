#!/usr/bin/env node
// The agentmesh CLI (spec v1.1 §14). Commands are listed now so the surface is
// visible; each one names the task that implements it until it exists.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cmdDispatch, cmdLogin, cmdStatus, cmdStop, cmdSupervise } from './runtime-commands.js';
import { cmdDoctor, cmdInit, cmdStart } from './setup.js';

export const VERSION = '0.1.0';
/** This program's own file (the bundle, once packed): background mode starts it again as a supervisor. */
const ENTRY = fileURLToPath(import.meta.url);

const COMMANDS: Record<string, { summary: string; task: string }> = {
  init: { summary: 'Set up AgentMesh in this folder (detects your agents; can start a new project)', task: 'P2.3' },
  doctor: { summary: 'Check this machine and project; --test runs each agent end to end, --fix applies safe fixes', task: 'P3.6' },
  start: { summary: 'Start AgentMesh and open the cockpit; --background keeps it running after you close the window', task: 'P2.1/P3.1' },
  login: { summary: 'Open the cockpit again with a fresh link (while AgentMesh is running)', task: 'G1' },
  stop: { summary: 'Stop AgentMesh (running agents stop with it)', task: 'G6' },
  status: { summary: 'Show agents, missions, tasks, file locks and questions waiting for you', task: 'G14' },
  dispatch: { summary: 'dispatch pause|resume [agent]: stop or restart handing out work', task: 'G14' },
  export: { summary: 'Write a Markdown snapshot of the board and timeline', task: 'P3.2' },
  repair: { summary: "Fix AgentMesh's database engine after a Node upgrade (installed copy only)", task: 'G16' },
};

export interface RunResult {
  code: number;
  output: string;
}

export function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return [`agentmesh ${VERSION}`, '', 'Usage: agentmesh <command>', '', 'Commands:', ...lines].join('\n');
}

export function run(argv: readonly string[]): RunResult {
  const [command] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return { code: 0, output: usage() };
  if (command === '--version' || command === '-v') return { code: 0, output: VERSION };
  const known = COMMANDS[command];
  if (!known) return { code: 1, output: `Unknown command "${command}".\n\n${usage()}` };
  return { code: 2, output: `agentmesh ${command}: not available in this version.` };
}

/** Commands that are implemented; everything else falls through to run(). */
export async function runAsync(argv: readonly string[], cwd = process.cwd()): Promise<RunResult> {
  if (argv[0] === 'init') return cmdInit(argv.slice(1), cwd);
  if (argv[0] === 'start') return cmdStart(argv.slice(1), cwd, ENTRY);
  if (argv[0] === 'supervise') return cmdSupervise(argv.slice(1), cwd, ENTRY);
  // The installed program's launcher handles `repair` before this code loads; reaching here means a source checkout.
  if (argv[0] === 'repair') return { code: 0, output: 'This copy runs from the source folder, so there is nothing to repair here. If its database engine fails, run: npm rebuild better-sqlite3   (in the AgentMesh folder)' };
  if (argv[0] === 'login') return cmdLogin(argv.slice(1), cwd);
  if (argv[0] === 'stop') return cmdStop(argv.slice(1), cwd);
  if (argv[0] === 'status') return cmdStatus(argv.slice(1), cwd);
  if (argv[0] === 'dispatch') return cmdDispatch(argv.slice(1), cwd);
  if (argv[0] === 'doctor') return cmdDoctor(argv.slice(1), cwd);
  if (argv[0] === 'export') {
    const { exportBoard } = await import('@agentmesh/daemon');
    try {
      const r = await exportBoard(argv[1] ? { repoRoot: cwd, outputPath: argv[1] } : { repoRoot: cwd });
      return { code: 0, output: `Wrote ${r.path} (${r.taskCount} tasks, ${r.eventCount} events).` };
    } catch (err) {
      return { code: 1, output: `agentmesh export failed: ${(err as Error).message}` };
    }
  }
  return run(argv);
}

/**
 * True when this file is the program being run (not imported by a test). npm installs the command as a
 * symlink on macOS and Linux: Node reports argv[1] as the symlink but import.meta.url as the real file,
 * so both are compared by real path.
 */
function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href;
  } catch {
    return false;
  }
}

/** Run one command line and exit with its code. The packed release's launcher calls this. */
export async function main(argv: readonly string[]): Promise<void> {
  const { code, output } = await runAsync(argv);
  if (output) (code === 0 ? console.log : console.error)(output);
  process.exitCode = code;
  // A stopped daemon may leave a handle open (a socket closing, a timer); the command is over either way.
  setTimeout(() => process.exit(code), 2000).unref();
}

if (isMain()) await main(process.argv.slice(2));
