// `agentmesh doctor`: is this machine and this project ready, and if not, what exactly do I do?
// Every check names the fix as a command or a config line. Nothing is changed unless --fix is given,
// and --fix only ever does the one safe thing it names.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { git } from '../git/run-git.js';
import { detectProject } from '../init/detect.js';
import { InitError, type ProjectConfig, requireGitIdentity } from '../init/init.js';
import { dashboardDist } from '../paths.js';
import { AGY_MCP_RULE, type CheckLevel, type Diagnosis, type PlatformAdapter, type PlatformRegistry, createRegistry, ensureAgyMcpRule } from '../platforms/index.js';
import { type InstallStep, gitInstallHint, gitInstaller, landedOffPath, platformInstaller, runInstall } from './install.js';
import { type SandboxConfig, SandboxConfigError, parseSandbox, probeSandbox, sandboxApplies } from '../sandbox/index.js';
import { smokeTestPlatform } from './smoke.js';

export type DoctorCheck = Diagnosis;

export interface DoctorReport {
  checks: DoctorCheck[];
  /** No check failed (warnings are allowed). */
  ok: boolean;
}

export interface DoctorOptions {
  repoRoot: string;
  /** Apply the safe fixes doctor knows (currently: the Antigravity permission rule). */
  fix?: boolean;
  /** Also run every configured platform end to end (takes about a minute each and uses a little of your quota). */
  test?: boolean;
  port?: number;
  onProgress?: (line: string) => void;
  /** Offer to install what is missing (git, agent tools). Each install is confirmed first. */
  install?: boolean;
  /** Asks the person; answering no skips that install. Default: no (nothing is installed without consent). */
  confirm?: (question: string) => Promise<boolean>;
}

type PortState = 'free' | 'agentmesh' | 'busy' | 'denied';

async function portState(port: number): Promise<PortState> {
  const bind = await new Promise<'free' | 'in-use' | 'denied'>((done) => {
    const server = createServer();
    server.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'EADDRINUSE' ? 'in-use' : 'denied'));
    server.listen(port, '127.0.0.1', () => server.close(() => done('free')));
  });
  if (bind !== 'in-use') return bind;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return (await res.text()).includes('AgentMesh') ? 'agentmesh' : 'busy';
  } catch {
    return 'busy';
  }
}

const check = (level: CheckLevel, title: string, detail: string, fix?: string): DoctorCheck => ({ level, title, detail, ...(fix ? { fix } : {}) });

/** Ask, then install with the output going to the terminal (installers may ask questions of their own). */
async function offerInstall(step: InstallStep, options: DoctorOptions): Promise<'declined' | Awaited<ReturnType<typeof runInstall>>> {
  const yes = await (options.confirm ?? (async () => false))(`Install ${step.what}? This runs:\n    ${step.display}\n`);
  if (!yes) return 'declined';
  options.onProgress?.(`Installing ${step.what}: ${step.display}`);
  return runInstall(step, { interactive: true });
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const progress = options.onProgress ?? (() => undefined);

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? check('ok', `Node ${process.versions.node}`, 'Node 22 or newer is required.') : check('fail', `Node ${process.versions.node} is too old`, 'AgentMesh needs Node 22 or newer.', 'Install a current Node from nodejs.org, then run this again.'));

  // git
  let gitVersion = '';
  try {
    gitVersion = (await git(options.repoRoot, ['--version'])).trim();
    add(check('ok', gitVersion, 'git is installed.'));
  } catch {
    const step = await gitInstaller();
    if (options.install && step) {
      const r = await offerInstall(step, options);
      if (r === 'declined') add(check('fail', 'git was not found', 'AgentMesh works on git branches, so it needs git.', `${step.display}\nthen: ${step.after}`));
      else if (r.ok) add(check('warn', 'Installed git', 'This terminal cannot see it yet.', step.after));
      else add(check('fail', 'Installing git did not work', r.output, gitInstallHint()));
    } else {
      add(check('fail', 'git was not found', 'AgentMesh works on git branches, so it needs git.', step ? `agentmesh doctor --install   (runs: ${step.display})\nor install it yourself: ${gitInstallHint()}` : gitInstallHint()));
    }
  }

  // The repository
  const dir = resolve(options.repoRoot);
  let root: string | null = null;
  if (gitVersion) {
    try {
      root = resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
    } catch {
      root = null;
    }
  }
  let config: ProjectConfig | null = null;
  let registry: PlatformRegistry = createRegistry();
  if (!root) {
    add(check('info', 'This folder is not a git repository yet', dir, 'agentmesh init   (in an empty folder it can start the repository for you)'));
  } else {
    const hasCommit = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
    add(hasCommit ? check('ok', 'The repository has commits', 'Agents branch from the latest commit.') : check('warn', 'The repository has no commits yet', 'Agents need a commit to branch from.', 'agentmesh init --commit   (or make a first commit yourself)'));
    try {
      await requireGitIdentity(root);
      add(check('ok', 'Git knows who you are', 'Agents commit with this name and email.'));
    } catch (err) {
      add(check('fail', 'Git has no name/email', 'Every commit an agent makes would fail.', err instanceof InitError ? err.message.split('\n').slice(1).join('\n').trim() : undefined));
    }
    const configPath = join(root, '.agentmesh', 'config.json');
    if (!existsSync(configPath)) {
      add(check('info', 'AgentMesh is not set up in this repository yet', configPath, 'agentmesh init'));
    } else {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig;
        registry = createRegistry(config.customPlatforms ?? []);
        add(check('ok', 'Configuration found', `${config.agents.length} agent(s): ${config.agents.map((a) => `${a.id} (${a.platform})`).join(', ')}`));
        for (const a of config.agents) {
          if (!registry.has(a.platform)) add(check('fail', `Agent ${a.id} uses an unknown platform "${a.platform}"`, `Known: ${registry.list().map((p) => p.id).join(', ')}.`, 'Define it under "customPlatforms" in .agentmesh/config.json, or change the agent.'));
        }
        if (config.verifyCommand) add(check('ok', `Project check: ${config.verifyCommand}`, 'Agents (and the merge step) run this before work lands.'));
        else if (config.landWithoutVerify) add(check('warn', 'New project: work lands after review, without a test run', 'Only the other agent\'s review protects your main branch until a test command is set.', 'Once the project has tests, set "verifyCommand" in .agentmesh/config.json (the cockpit will suggest it).'));
        else {
          const d = detectProject(root);
          add(check('warn', 'No project check is set, so nothing will land', d.notes[0] ?? 'AgentMesh does not know how to test this project.', d.verifyCommand ? `Set "verifyCommand": "${d.verifyCommand}" in .agentmesh/config.json` : 'Set "verifyCommand" in .agentmesh/config.json, or "landWithoutVerify": true for a brand-new project.'));
        }
      } catch (err) {
        add(check('fail', 'Could not read .agentmesh/config.json', (err as Error).message, 'Fix the file, or delete it and run agentmesh init.'));
      }
    }
  }

  // Port
  const port = options.port ?? config?.daemon.port ?? 8934;
  const ps = await portState(port);
  if (ps === 'free') add(check('ok', `Port ${port} is free`, 'The cockpit will use it.'));
  else if (ps === 'agentmesh') add(check('info', `An AgentMesh cockpit is already running on port ${port}`, 'Open it in your browser, or stop it before starting another.'));
  else if (ps === 'busy') add(check('fail', `Port ${port} is used by another program`, 'The cockpit cannot start there.', `agentmesh start --port ${port + 1}`));
  else add(check('fail', `Port ${port} cannot be used`, process.platform === 'win32' ? 'Windows reserves some port ranges (Hyper-V/WSL); this may be one of them.' : 'The system refused to open it.', process.platform === 'win32' ? 'netsh interface ipv4 show excludedportrange protocol=tcp   then pick a port outside those ranges: agentmesh start --port 8934' : `agentmesh start --port ${port + 1}`));

  // The cockpit itself
  const dash = dashboardDist();
  add(existsSync(join(dash, 'index.html')) ? check('ok', 'Cockpit files found', dash) : check('fail', 'The cockpit has not been built', dash, 'npm run build   (from the AgentMesh folder)'));

  // Container mode (experimental): checked for real, through the real wrapper.
  let sandbox: SandboxConfig | null = null;
  if (config?.sandbox !== undefined) {
    try {
      sandbox = parseSandbox(config.sandbox);
      if (!sandbox) add(check('info', 'Container mode is switched off', '"enabled": false in the "sandbox" section.'));
    } catch (err) {
      add(check('fail', 'The "sandbox" section is not valid', err instanceof SandboxConfigError ? err.message : (err as Error).message, 'Fix it in .agentmesh/config.json. AgentMesh will not start while it is wrong: it never falls back to running agents outside the container.'));
    }
  }
  if (sandbox && root && config) {
    const builtIn: Record<string, string> = { CLAUDE_CODE: 'claude', ANTIGRAVITY: 'agy' };
    const commands = [...new Set(config.agents.filter((a) => sandboxApplies(sandbox!, a.id)).map((a) => sandbox!.commands?.[a.platform] ?? builtIn[a.platform]).filter((c): c is string => Boolean(c)))];
    progress('Checking container mode (starts a few short containers)...');
    for (const d of await probeSandbox({ cfg: sandbox, repoRoot: root, commands })) add(d);
  }

  // Platforms: the ones this project uses, or all of them when there is no config yet.
  const used = config ? [...new Set(config.agents.map((a) => a.platform))].map((id) => registry.get(id)).filter((p): p is PlatformAdapter => Boolean(p)) : registry.list();
  for (const adapter of used) {
    // A tool that only runs in the container is checked there (above), not on this computer.
    if (sandbox && config && config.agents.filter((a) => a.platform === adapter.id).every((a) => sandboxApplies(sandbox!, a.id))) {
      add(check('info', `${adapter.label} runs in the container`, 'It is checked inside the image (above), not on this computer.'));
      continue;
    }
    let d = await adapter.detect();
    if (!d.installed) {
      const step = platformInstaller(adapter.id);
      const level = config ? 'fail' : 'info';
      if (options.install && step) {
        const r = await offerInstall(step, options);
        if (r === 'declined') {
          add(check(level, `${adapter.label} is not installed`, 'You chose not to install it now.', step.display));
          continue;
        }
        if (!r.ok) {
          add(check(level, `Installing ${adapter.label} did not work`, r.output, step.display));
          continue;
        }
        d = await adapter.detect();
        if (!d.installed) {
          add(landedOffPath(step) ? check('warn', `Installed ${step.what}`, `It is in ${step.lands}; this terminal cannot see it yet.`, step.after) : check(level, `Installed ${step.what}, but it cannot be found`, r.output, step.after));
          continue;
        }
        add(check('ok', `Installed ${step.what}`, 'Next, before AgentMesh can use it:', step.after));
      } else {
        const how = step ? `agentmesh doctor --install   (runs: ${step.display})` : 'Install it yourself and check that its command works in a terminal';
        add(check(level, `${adapter.label} is not installed`, `"${adapter.label}" was not found on PATH.${config ? '' : ' Only needed if you want to use it.'}`, config ? `${how}, or remove the ${adapter.id} agent from .agentmesh/config.json` : step ? how : undefined));
        continue;
      }
    }
    if (d.problem) {
      add(check('fail', `${adapter.label} is installed but did not answer correctly`, d.problem, `Run the tool by hand once and fix what it reports (${d.resolved ?? adapter.id}).`));
      continue;
    }
    add(check('ok', `${adapter.label} ${d.version ?? ''}`.trim(), `${d.resolved ?? ''}${adapter.verified ? '' : '  (defined in your config; not verified until you run: agentmesh doctor --test)'}`));
    let diagnoses = (await adapter.diagnose?.()) ?? [];
    if (options.fix && diagnoses.some((x) => x.fix === 'agentmesh doctor --fix') && adapter.id === 'ANTIGRAVITY') {
      try {
        const r = ensureAgyMcpRule();
        add(check('ok', 'Fixed: allowed AgentMesh tools for Antigravity', `Added ${AGY_MCP_RULE}${r.backup ? `; your previous settings are saved as ${r.backup}` : ''}.`));
        diagnoses = (await adapter.diagnose?.()) ?? [];
      } catch (err) {
        add(check('fail', 'Could not update the Antigravity settings', (err as Error).message));
      }
    }
    diagnoses.forEach(add);
  }

  // The end-to-end test
  if (options.test && config) {
    for (const adapter of used) {
      progress(`Testing ${adapter.label} end to end (this takes a minute)...`);
      const r = await smokeTestPlatform(adapter, { ...(config.customPlatforms?.length ? { customPlatforms: config.customPlatforms } : {}) });
      add(r.ok ? check('ok', `${adapter.label} works with AgentMesh (${r.seconds}s)`, r.detail) : check('fail', `${adapter.label} did not work with AgentMesh (${r.seconds}s)`, `${r.detail}${r.said ? `\nIt said: ${r.said}` : ''}`, adapter.id === 'ANTIGRAVITY' ? 'agentmesh doctor --fix' : undefined));
    }
  } else if (options.test) {
    add(check('info', 'Skipped the end-to-end test', 'It needs a configured project.', 'agentmesh init'));
  }

  return { checks, ok: checks.every((c) => c.level !== 'fail') };
}

const MARK: Record<CheckLevel, string> = { ok: '[ok]  ', warn: '[!!]  ', fail: '[FAIL]', info: '[i]   ' };

export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${MARK[c.level]} ${c.title}`);
    if (c.detail) for (const l of c.detail.split('\n')) lines.push(`       ${l}`);
    if (c.fix) for (const l of c.fix.split('\n')) lines.push(`       -> ${l}`);
  }
  const fails = report.checks.filter((c) => c.level === 'fail').length;
  const warns = report.checks.filter((c) => c.level === 'warn').length;
  lines.push('', fails ? `${fails} problem(s) to fix before AgentMesh can run.` : warns ? `Ready to run, with ${warns} thing(s) worth a look.` : 'Everything looks ready.');
  return lines.join('\n');
}
