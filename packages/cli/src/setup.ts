// The commands a new user runs first: init, doctor, start. Kept apart from index.ts so the
// command table there stays small. Every failure ends in something the person can do next.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export interface CommandResult {
  code: number;
  output: string;
}

interface Flags {
  yes: boolean;
  noCommit: boolean;
  noOpen: boolean;
  fix: boolean;
  test: boolean;
  background: boolean;
  install: boolean;
  supervised: boolean;
  port?: number;
  agents?: string[];
  rest: string[];
}

export function parseFlags(argv: readonly string[]): Flags | { error: string } {
  const f: Flags = { yes: false, noCommit: false, noOpen: false, fix: false, test: false, background: false, install: false, supervised: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--no-commit') f.noCommit = true;
    else if (a === '--no-open') f.noOpen = true;
    else if (a === '--fix') f.fix = true;
    else if (a === '--test') f.test = true;
    else if (a === '--background') f.background = true;
    else if (a === '--install') f.install = true;
    else if (a === '--supervised') f.supervised = true; // set by the background supervisor
    else if (a === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: '--port needs a number between 1 and 65535' };
      f.port = n;
    } else if (a === '--agents') {
      const v = argv[++i];
      if (!v) return { error: '--agents needs a comma-separated list, e.g. --agents claude,gemini' };
      f.agents = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('-')) return { error: `Unknown option ${a}` };
    else f.rest.push(a);
  }
  return f;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function readCustomPlatforms(cwd: string): unknown[] {
  const p = join(cwd, '.agentmesh', 'config.json');
  if (!existsSync(p)) return [];
  try {
    return ((JSON.parse(readFileSync(p, 'utf8')) as { customPlatforms?: unknown[] }).customPlatforms ?? []) as unknown[];
  } catch {
    return [];
  }
}

export async function cmdInit(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const flags = parseFlags(argv);
  if ('error' in flags) return { code: 1, output: `agentmesh init: ${flags.error}` };
  const d = await import('@agentmesh/daemon');
  try {
    const registry = d.createRegistry(readCustomPlatforms(cwd) as never);
    const hasConfig = existsSync(join(cwd, '.agentmesh', 'config.json'));
    let agents;
    let missing: string[] = [];
    if (!hasConfig) {
      if (flags.agents) {
        const wanted = flags.agents.map((name) => {
          const n = name.toLowerCase();
          return registry.list().find((p) => p.id.toLowerCase() === n || p.friendlyName.toLowerCase() === n || (n === 'claude' && p.id === 'CLAUDE_CODE') || (n === 'antigravity' && p.id === 'ANTIGRAVITY') || (n === 'gemini' && p.id === 'ANTIGRAVITY'));
        });
        const bad = flags.agents.filter((_n, i) => !wanted[i]);
        if (bad.length) return { code: 1, output: `agentmesh init: unknown platform ${bad.join(', ')}. Known: ${registry.list().map((p) => `${p.friendlyName.toLowerCase()} (${p.id})`).join(', ')}.` };
        const taken = new Set<string>();
        agents = wanted.map((p) => {
          const id = d.agentIdFor(p!, taken);
          taken.add(id);
          return { id, platform: p!.id, rulebook: p!.rulebook };
        });
      } else {
        const choice = await d.chooseAgents(registry);
        if (!choice.agents.length) {
          return { code: 1, output: `agentmesh init: no supported agent CLI was found on this machine.\n  Install at least one (${registry.list().map((p) => p.label).join(', ')}), sign in to it once, then run this again.\n  AgentMesh can install them for you (it asks first): agentmesh doctor --install` };
        }
        agents = choice.agents;
        missing = choice.missing.map((p) => p.label);
      }
    }
    const opts = { repoRoot: cwd, commit: !flags.noCommit, ...(flags.port ? { port: flags.port } : {}), ...(agents ? { agents } : {}) };
    let report;
    try {
      report = await d.initProject({ ...opts, createRepo: flags.yes });
    } catch (err) {
      if (err instanceof d.InitError && err.code === 'NOT_A_REPO' && !flags.yes) {
        if (await confirm(`${cwd} is empty and not a git repository. Start a new one here?`)) report = await d.initProject({ ...opts, createRepo: true });
        else return { code: 1, output: `${(err as Error).message}` };
      } else throw err;
    }
    const lines = [
      'AgentMesh is set up here.',
      '',
      ...(report.repoCreated ? ['  started a new git repository'] : []),
      ...report.created.map((f) => `  created    ${f}`),
      ...report.updated.map((f) => `  updated    ${f}`),
      ...report.unchanged.map((f) => `  unchanged  ${f}`),
      ...(report.committed ? [`  committed  ${report.committed}  (the files above, so every agent's workspace has them)`] : []),
      '',
      `Project: ${report.detected.kind}${report.config.verifyCommand ? `; checked with: ${report.config.verifyCommand}` : '; no check found yet'}`,
      `Agents:  ${report.config.agents.map((a) => `${a.id} (${a.platform})`).join(', ')}`,
      ...report.detected.notes.map((n) => `  note: ${n}`),
      ...report.warnings.map((w) => `  warning: ${w}`),
    ];
    if (missing.length) lines.push(`  (not found on this machine, so not added: ${missing.join(', ')})`);
    if (report.config.agents.length < 2) lines.push('', 'With one platform, another platform cannot review its work: you (the Human) review in the cockpit. Add a second platform for automatic cross-review.');
    lines.push('', 'Next:', '  1. agentmesh doctor --fix --test   checks each agent end to end (uses a little of your quota)', '  2. agentmesh start           opens the cockpit');
    return { code: 0, output: lines.join('\n') };
  } catch (err) {
    return { code: 1, output: `agentmesh init: ${(err as Error).message}` };
  }
}

export async function cmdDoctor(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const flags = parseFlags(argv);
  if ('error' in flags) return { code: 1, output: `agentmesh doctor: ${flags.error}` };
  const d = await import('@agentmesh/daemon');
  const report = await d.runDoctor({ repoRoot: cwd, fix: flags.fix, test: flags.test, install: flags.install, confirm: flags.yes ? async () => true : confirm, ...(flags.port ? { port: flags.port } : {}), onProgress: (l) => console.log(l) });
  return { code: report.ok ? 0 : 1, output: d.formatDoctor(report) };
}

export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
  } catch {
    // the link is printed anyway
  }
}

export async function cmdStart(argv: readonly string[], cwd: string, entry: string, version?: string): Promise<CommandResult> {
  const flags = parseFlags(argv);
  if ('error' in flags) return { code: 1, output: `agentmesh start: ${flags.error}` };
  if (flags.background) {
    const { cmdStartBackground } = await import('./runtime-commands.js');
    return cmdStartBackground(argv, cwd, entry);
  }
  const d = await import('@agentmesh/daemon');
  try {
    const rec = d.readDaemonRecord(await d.projectRoot(cwd));
    if (rec && d.isAlive(rec.pid)) return { code: 1, output: `AgentMesh is already running here: http://127.0.0.1:${rec.port}\n  For a cockpit link: agentmesh login    To stop it: agentmesh stop` };
  } catch {
    // not a repository: startDaemon explains
  }
  let daemon;
  try {
    daemon = await d.startDaemon({ repoRoot: cwd, record: true, ...(version ? { version } : {}), ...(flags.port ? { port: flags.port } : {}) });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const hint = e.code === 'EADDRINUSE' ? '\n  That port is in use (is AgentMesh already running?). Try: agentmesh start --port 8944' : e.code === 'EACCES' ? '\n  That port cannot be used (Windows reserves some ranges). Try: agentmesh start --port 8944' : /agentmesh init/.test(e.message) ? '' : '\n  Run "agentmesh doctor" to see what is wrong.';
    return { code: 3, output: `agentmesh start failed: ${e.message}${hint}` }; // 3: the supervisor must not retry this
  }
  console.log(`AgentMesh is running: http://127.0.0.1:${daemon.port}`);
  // A supervised daemon writes to a log file: a login link there would be a credential lying on disk.
  if (flags.supervised) console.log('For a cockpit link: agentmesh login');
  else if (flags.noOpen) console.log(`Open the cockpit (this link works once): ${daemon.loginUrl}`);
  else {
    openBrowser(daemon.loginUrl);
    console.log('Opening the cockpit in your browser. If it did not open, use this link (it works once):');
    console.log(daemon.loginUrl);
  }
  if (!flags.supervised) console.log('Press Ctrl+C to stop (or run agentmesh stop in another window). Agents stop with it; nothing is lost.\nLost the link? agentmesh login');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    void daemon.stopRequested.then(resolve);
  });
  await daemon.stop();
  return { code: 0, output: 'AgentMesh stopped.' };
}
