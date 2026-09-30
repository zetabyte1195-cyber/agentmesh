// Finding and launching agent CLIs portably. Node (>= 20.12) refuses to spawn .cmd/.bat files
// without a shell, and we never use a shell (prompts are arbitrary text: no re-parsing). npm installs
// most agent CLIs on Windows as a .cmd shim, so those are resolved to the node script the shim runs.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export interface ResolvedExecutable {
  /** What to spawn. */
  file: string;
  /** Arguments to put before the caller's (e.g. the node script behind an npm shim). */
  prefixArgs: string[];
}

const WIN_EXTS = ['.exe', '.com', '.cmd', '.bat'];

/** The node script an npm-generated .cmd shim runs, or null if the shim isn't the standard npm form. */
export function npmShimTarget(shimPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const m = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (!m?.[1]) return null;
  const target = resolve(dirname(shimPath), m[1].replace(/\\/g, '/')); // the shim uses Windows separators; Node accepts either on Windows
  return existsSync(target) ? target : null;
}

function candidates(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const hasDir = /[\\/]/.test(name);
  const dirs = hasDir ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...WIN_EXTS] : [''];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      // A bare "name" without extension is only a real file on non-Windows platforms.
      if (platform === 'win32' && ext === '' && !/\.[a-z0-9]+$/i.test(name)) continue;
      out.push(hasDir ? `${name}${ext}` : join(dir, `${name}${ext}`));
    }
  }
  return out;
}

/** Locate an executable on PATH (or at a given path). Returns null if it is not installed. */
export function resolveExecutable(
  name: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): ResolvedExecutable | { file: string; prefixArgs: string[]; unsupported: string } | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const base = isAbsolute(name) || /[\\/]/.test(name) ? name : name;
  for (const c of candidates(base, env, platform)) {
    if (!existsSync(c)) continue;
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(c)) {
      const target = npmShimTarget(c);
      if (target) return { file: process.execPath, prefixArgs: [target] };
      return { file: c, prefixArgs: [], unsupported: `${c} is a .cmd/.bat wrapper that AgentMesh can't launch safely; install the tool's native executable, or point "executable" at the node script it runs` };
    }
    return { file: c, prefixArgs: [] };
  }
  return null;
}

/** Run `<exe> <args>` (no shell), capturing the first line of output. Never throws. */
export function probeVersion(name: string, args: readonly string[], timeoutMs = 15_000): Promise<{ installed: boolean; version?: string; problem?: string; resolved?: string }> {
  const resolved = resolveExecutable(name);
  if (!resolved) return Promise.resolve({ installed: false });
  if ('unsupported' in resolved) return Promise.resolve({ installed: true, resolved: resolved.file, problem: resolved.unsupported });
  return new Promise((done) => {
    execFile(resolved.file, [...resolved.prefixArgs, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`.trim();
      const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
      if (err && !first) done({ installed: true, resolved: resolved.file, problem: (err as Error).message });
      else done({ installed: true, resolved: resolved.file, version: first.trim().slice(0, 200), ...(err ? { problem: first.trim().slice(0, 300) } : {}) });
    });
  });
}
