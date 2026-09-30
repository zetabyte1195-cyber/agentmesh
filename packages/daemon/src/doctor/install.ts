// Installing what AgentMesh needs (G16), only ever with the person's consent: `agentmesh doctor --install`
// asks before each step (or --yes), and the cockpit's Install button is itself the consent. Every command
// here is the vendor's own documented install command, shown in full before it runs:
//   Claude Code   npm install -g @anthropic-ai/claude-code
//   Antigravity   https://antigravity.google/docs/cli/install (install.ps1 on Windows, install.sh elsewhere)
//   git           winget (Windows), Homebrew or the Xcode command line tools (macOS)
// Nothing is installed with administrator rights; where that would be needed, the person is told how.
import { type StdioOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface InstallStep {
  /** What gets installed, e.g. "Claude Code". */
  what: string;
  /** The command exactly as shown to the person. */
  display: string;
  executable: string;
  args: string[];
  /** Windows .cmd shims (npm) must go through the shell; the arguments are fixed, never user input. */
  shell?: boolean;
  /** What to do once it is installed (sign in, open a new terminal...). */
  after: string;
  /** The command the tool installs, e.g. "claude". */
  binary?: string;
  /** Where the tool lands, for when the running process cannot see it on PATH yet. */
  lands?: string;
}

export interface InstallResult {
  ok: boolean;
  exitCode: number | null;
  /** The last lines it printed (for the cockpit, which has no terminal). */
  output: string;
}

const onPath = (exe: string) =>
  new Promise<boolean>((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'where' : 'which', [exe], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });

/** How to install a platform's tool here, or null if AgentMesh has no verified way (the person installs it). */
export function platformInstaller(platformId: string, os: NodeJS.Platform = process.platform): InstallStep | null {
  if (platformId === 'CLAUDE_CODE') {
    return {
      what: 'Claude Code',
      binary: 'claude',
      display: 'npm install -g @anthropic-ai/claude-code',
      executable: os === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code'],
      shell: os === 'win32',
      after: 'Sign in once: run `claude` in a terminal and follow the prompts.',
    };
  }
  if (platformId === 'ANTIGRAVITY') {
    return os === 'win32'
      ? {
          what: 'Antigravity CLI (agy)',
          binary: 'agy',
          display: 'irm https://antigravity.google/cli/install.ps1 | iex   (in PowerShell)',
          executable: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'],
          after: 'Open a new terminal, run `agy` once to sign in (it opens your browser), then: agentmesh doctor --fix',
          lands: join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agy', 'bin'),
        }
      : {
          what: 'Antigravity CLI (agy)',
          binary: 'agy',
          display: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
          executable: 'bash',
          args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
          after: 'Open a new terminal, run `agy` once to sign in (it opens your browser), then: agentmesh doctor --fix',
          lands: join(homedir(), '.local', 'bin'),
        };
  }
  return null;
}

/** How to install git here, or null with a reason in `gitInstallHint` when it must be done by hand. */
export async function gitInstaller(os: NodeJS.Platform = process.platform): Promise<InstallStep | null> {
  const after = 'Open a new terminal, set your name and email in git (git config --global user.name "Your Name"; git config --global user.email "you@example.com"), then run this again.';
  if (os === 'win32' && (await onPath('winget'))) {
    return { what: 'git', display: 'winget install --id Git.Git -e --source winget', executable: 'winget', args: ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'], after };
  }
  if (os === 'darwin') {
    if (await onPath('brew')) return { what: 'git', display: 'brew install git', executable: 'brew', args: ['install', 'git'], after };
    return { what: 'git (Apple command line tools)', display: 'xcode-select --install', executable: 'xcode-select', args: ['--install'], after: `A window opens: choose Install and wait for it to finish. ${after}` };
  }
  return null;
}

export function gitInstallHint(os: NodeJS.Platform = process.platform): string {
  if (os === 'win32') return 'Download and install git from https://git-scm.com/download/win, then open a new terminal.';
  if (os === 'darwin') return 'Run: xcode-select --install   (or install Homebrew and run: brew install git)';
  return 'Install git with your package manager, e.g. sudo apt install git   or   sudo dnf install git';
}

/**
 * Run an install step. With `interactive` its output goes straight to the terminal (installers may ask
 * questions); otherwise it is captured and the end returned (the cockpit). Never throws.
 */
export function runInstall(step: InstallStep, options: { interactive?: boolean; timeoutMs?: number } = {}): Promise<InstallResult> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      const stdio: StdioOptions = options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'];
      // A shell step is passed as one fixed string (its arguments are constants), never as an array plus shell.
      child = step.shell ? spawn([step.executable, ...step.args].join(' '), { shell: true, windowsHide: true, stdio }) : spawn(step.executable, step.args, { windowsHide: true, stdio });
    } catch (err) {
      resolve({ ok: false, exitCode: null, output: (err as Error).message });
      return;
    }
    const keep = (b: Buffer) => (out = (out + b.toString()).slice(-8000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: `${out}\n${err.message}`.trim() });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let output = out.trim();
      if (code !== 0 && /EACCES|permission denied/i.test(out) && step.executable.startsWith('npm')) {
        output += '\n\nnpm is not allowed to install programs for all users here. Either install Node with a version manager (nvm, fnm, or the nodejs.org installer for your user), or run the command above yourself with the rights it needs.';
      }
      resolve({ ok: code === 0, exitCode: code, output: output.split('\n').slice(-40).join('\n') });
    });
  });
}

/** True if the tool is in the folder its installer uses, even though this process's PATH predates it. */
export function landedOffPath(step: InstallStep): boolean {
  const exe = step.binary;
  if (!step.lands || !exe) return false;
  return [exe, `${exe}.exe`, `${exe}.cmd`].some((n) => existsSync(join(step.lands!, n)));
}
