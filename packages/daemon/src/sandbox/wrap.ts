// Turns an agent's own command into "the container wrapper, then that command".
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { PlatformRunContext } from '../platforms/types.js';
import { resolveExecutable } from '../platforms/resolve.js';
import type { AgentCommand } from '../runner/commands.js';
import { type SandboxConfig, expandWrapper } from './config.js';

/** A short stable id for this project, so containers can be found again (and removed) after a crash. */
export const projectIdOf = (repoRoot: string): string => createHash('sha1').update(repoRoot.toLowerCase()).digest('hex').slice(0, 12);

export const containerNameOf = (projectId: string, runId: string): string => `am-${projectId.slice(0, 6)}-${runId.replace(/-/g, '').slice(0, 8)}`;

/** The run's folder and working directory as the container sees them. The paths the platform adapters build commands from. */
export function containerView(cfg: SandboxConfig, run: PlatformRunContext): { cwd: string; run: PlatformRunContext } {
  const inRun = (host: string) => posix.join(cfg.containerRunDir, host.slice(run.dir.length).replace(/\\/g, '/').replace(/^\/+/, ''));
  return {
    cwd: cfg.containerCwd,
    run: {
      ...run,
      dir: cfg.containerRunDir,
      claudeMcpConfig: inRun(run.claudeMcpConfig),
      ...(run.toolConfigs ? { toolConfigs: { opencode: inRun(run.toolConfigs.opencode), gemini: inRun(run.toolConfigs.gemini) } } : {}),
      inContainer: true,
    },
  };
}

export interface WrapContext {
  runId: string;
  projectId: string;
  /** Host paths. */
  cwd: string;
  runDir: string;
  /** True when the agent's working directory is the Human's own checkout (a run with no task workspace): mounted read-only. */
  cwdIsRepoRoot: boolean;
}

/**
 * `inner` is the agent's command as built for the container's view. The result starts the container and
 * runs it there. The token and the other variables stay in the process environment and are passed by name
 * (-e NAME), so they never appear in a command line.
 */
export function wrapCommand(inner: AgentCommand, ctx: WrapContext, cfg: SandboxConfig): { command: AgentCommand; name: string } {
  const name = containerNameOf(ctx.projectId, ctx.runId);
  const envNames = ['AGENTMESH_TOKEN', ...Object.keys(inner.env ?? {}).filter((k) => k !== 'AGENTMESH_TOKEN')];
  const wrapper = expandWrapper(cfg, { name, cwd: ctx.cwd, runDir: ctx.runDir, runId: ctx.runId, projectId: ctx.projectId, cwdAccess: ctx.cwdIsRepoRoot ? 'ro' : 'rw' }, envNames);
  const resolved = resolveExecutable(wrapper[0]!);
  if (!resolved) throw new Error(`The container command "${wrapper[0]}" was not found. Is it installed and on your PATH?`);
  if ('unsupported' in resolved) throw new Error(`The container command: ${resolved.unsupported}`);
  const inContainerExecutable = cfg.commands?.[inner.platform] ?? inner.executable;
  return {
    name,
    command: { ...inner, executable: resolved.file, args: [...resolved.prefixArgs, ...wrapper.slice(1), inContainerExecutable, ...inner.args] },
  };
}
