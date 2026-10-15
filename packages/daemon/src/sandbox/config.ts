// Container mode for agent runs (EXPERIMENTAL). The idea: each agent run is started inside a container, so the
// agent can only touch its own task workspace and not the rest of the computer.
//
// AgentMesh cannot put an agent tool into a container for you: the tool has to be installed and signed in INSIDE
// the image, and that is yours to prepare. So this is a generic wrapper: you write the command that starts a
// container, and AgentMesh puts the agent's own command after it. It is configured by hand in
// .agentmesh/config.json (never from the cockpit: it decides what gets executed).
//
//   "sandbox": {
//     "image": "my-agents:latest",
//     "wrapper": ["docker", "run", "--rm", "--name", "{name}", "--init", "-v", "{cwd}:{containerCwd}:{cwdAccess}",
//                 "-v", "{runDir}:{containerRunDir}:ro", "-w", "{containerCwd}", "{env}", "{image}"],
//     "commands": { "CLAUDE_CODE": "claude", "ANTIGRAVITY": "agy" }
//   }
//
// What it does NOT do (and the docs say so): it does not restrict the container's network, it does not contain the
// project's own check command (run on your computer by AgentMesh), and it is only as strong as the flags you write.
import { realpathSync } from 'node:fs';
import { z } from 'zod';

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxConfigError';
  }
}

const PLACEHOLDERS = ['name', 'cwd', 'runDir', 'containerCwd', 'containerRunDir', 'image', 'runId', 'projectId', 'cwdAccess', 'uid', 'gid', 'env'] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];

const ABSOLUTE_POSIX = /^\/[A-Za-z0-9._/-]*$/;

export const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** The image to run; also what the doctor checks exists. */
    image: z.string().min(1).max(300),
    /** The command that starts a container, ending just before the program to run. See the placeholders above. */
    wrapper: z.array(z.string().min(1).max(600)).min(2).max(80),
    /** Only these agents run in the container (default: all of them). */
    agents: z.array(z.string().min(1).max(64)).max(20).optional(),
    /** The command to run INSIDE the image for each platform, by platform id (a built-in tool's host path means nothing in a container). */
    commands: z.record(z.string(), z.string().min(1).max(200)).optional(),
    containerCwd: z.string().regex(ABSOLUTE_POSIX, 'an absolute path inside the container, e.g. /work').default('/work'),
    containerRunDir: z.string().regex(ABSOLUTE_POSIX, 'an absolute path inside the container, e.g. /agentmesh-run').default('/agentmesh-run'),
    /** How the container reaches this computer. */
    hostAlias: z.string().min(1).max(200).default('host.docker.internal'),
    /** Where the agent-only listener binds. Port 0 = any free port. */
    listen: z.object({ host: z.string().min(1).max(100).default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(0) }).strict().default({ host: '127.0.0.1', port: 0 }),
    /**
     * Where the project's check command (npm test, pytest...) runs. REQUIRED, with no default, because both choices cost something:
     *  "container": inside a container, so code an agent writes cannot run on this computer. The image needs your project's tools
     *     (node, python...), and dependencies installed on this computer may not work in a Linux container.
     *  "host": on this computer. Simple, but an agent in a container can write any file into its workspace, so code it plants
     *     (a test, a package.json script) runs here with your permissions when the check runs. This undoes the container.
     */
    checks: z.enum(['host', 'container'], { message: 'choose where the project check runs: "container" (the image needs your project\'s tools) or "host" (code an agent writes can then run on this computer)' }),
    /** Command that removes a container by name ({name}); derived for docker and podman. */
    stop: z.array(z.string().min(1).max(600)).min(1).max(20).optional(),
  })
  .strict();

export type SandboxConfig = z.output<typeof SandboxConfigSchema>;

const DOCKERLIKE = new Set(['docker', 'docker.exe', 'podman', 'podman.exe']);
const baseName = (s: string) => s.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
/** Whether container mode applies to this agent (all of them unless the section lists some). */
export const sandboxApplies = (cfg: SandboxConfig, agentId: string): boolean => !cfg.agents || cfg.agents.includes(agentId);

export const isDockerLike = (cfg: SandboxConfig) => DOCKERLIKE.has(baseName(cfg.wrapper[0]!));

/** Reads the `sandbox` section of the config. Returns null when it is absent or switched off; throws SandboxConfigError otherwise if it is wrong. */
export function parseSandbox(raw: unknown): SandboxConfig | null {
  if (raw === undefined || raw === null) return null;
  const r = SandboxConfigSchema.safeParse(raw);
  if (!r.success) throw new SandboxConfigError(`The "sandbox" section of .agentmesh/config.json is not valid: ${r.error.issues.map((i) => `${i.path.join('.') || 'sandbox'}: ${i.message}`).join('; ')}`);
  const cfg = r.data;
  if (!cfg.enabled) return null;

  const used = new Set<string>();
  for (const [i, element] of cfg.wrapper.entries()) {
    for (const m of element.matchAll(/\{([^{}]*)\}/g)) {
      const name = m[1]!;
      if (!(PLACEHOLDERS as readonly string[]).includes(name)) throw new SandboxConfigError(`wrapper item ${i + 1} uses {${name}}, which is not a placeholder. Known: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`);
      used.add(name);
    }
    if (element.includes('{env}') && element !== '{env}') throw new SandboxConfigError('{env} must be an item of its own in the wrapper (it becomes several -e options).');
  }
  if (!used.has('name')) throw new SandboxConfigError('The wrapper must give the container the name {name} (for example "--name", "{name}"): that is how AgentMesh stops it.');
  if (!used.has('env')) throw new SandboxConfigError('The wrapper must contain {env}, which passes the run\'s token into the container. Without it the agent could not call AgentMesh.');
  const tty = cfg.wrapper.find((w) => ['-t', '-i', '-it', '-ti', '--tty', '--interactive'].includes(w));
  if (tty) throw new SandboxConfigError(`The wrapper must not contain ${tty}: a terminal would corrupt the agent's output.`);
  if (!isDockerLike(cfg) && !cfg.stop) throw new SandboxConfigError('For a wrapper that is not docker or podman, give "stop": the command that removes a container by {name}.');
  return cfg;
}

/** Things in the wrapper that undo the point of a container. Shown as warnings, not refused: it is your configuration. */
export function lintWrapper(cfg: SandboxConfig): string[] {
  const joined = cfg.wrapper.join(' ');
  const warnings: string[] = [];
  if (cfg.checks === 'host') warnings.push('The project check runs on THIS computer: code an agent writes into its workspace (a test, a package.json script) runs here, with your permissions, when the check runs. That undoes the container. Set "checks": "container" to run it in the container instead.');
  if (/--privileged/.test(joined)) warnings.push('--privileged gives the container almost everything on this computer; it defeats the purpose.');
  if (/(docker|podman)\.sock/.test(joined)) warnings.push('Mounting the container engine\'s socket lets the agent start other containers with any access: it defeats the purpose.');
  if (/--(pid|ipc|uts|userns)[ =]host|--network[ =]host|--net[ =]host/.test(joined)) warnings.push('Sharing the host\'s namespaces or network removes the isolation you are asking for.');
  if (/-v\s+(\/|[A-Za-z]:[\\/]?)(:|\s|$)/.test(joined)) warnings.push('Mounting a whole drive or the root folder gives the agent your whole computer.');
  if (!/--(memory|cpus|pids-limit)/.test(joined)) warnings.push('No --memory, --cpus or --pids-limit: a runaway agent could use all of this computer\'s resources.');
  if (!/--cap-drop/.test(joined)) warnings.push('No --cap-drop ALL: the container keeps more privileges than an agent needs.');
  return warnings;
}

export interface ExpandVars {
  name: string;
  /** Host paths. */
  cwd: string;
  runDir: string;
  runId: string;
  projectId: string;
  cwdAccess: 'ro' | 'rw';
}

const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // not there (yet): used as written
  }
};

/** The wrapper with every placeholder filled. `envNames` are the variables to pass through (values never appear in the command line). */
export function expandWrapper(cfg: SandboxConfig, vars: ExpandVars, envNames: readonly string[]): string[] {
  const values: Record<Exclude<Placeholder, 'env'>, string | undefined> = {
    name: vars.name,
    cwd: real(vars.cwd),
    runDir: real(vars.runDir),
    containerCwd: cfg.containerCwd,
    containerRunDir: cfg.containerRunDir,
    image: cfg.image,
    runId: vars.runId,
    projectId: vars.projectId,
    cwdAccess: vars.cwdAccess,
    uid: typeof process.getuid === 'function' ? String(process.getuid()) : undefined,
    gid: typeof process.getgid === 'function' ? String(process.getgid()) : undefined,
  };
  const out: string[] = [];
  for (const item of cfg.wrapper) {
    if (item === '{env}') {
      for (const n of envNames) out.push('-e', n);
      continue;
    }
    out.push(
      item.replace(/\{([^{}]*)\}/g, (_m, key: string) => {
        const v = values[key as keyof typeof values];
        if (v === undefined) throw new SandboxConfigError(`{${key}} is not available on this operating system. Remove it from the wrapper (on Windows there is no user id to pass).`);
        return v;
      }),
    );
  }
  return out;
}

/** The command that removes a container by name. */
export function stopCommand(cfg: SandboxConfig, name: string): string[] {
  if (cfg.stop) return cfg.stop.map((s) => s.replaceAll('{name}', name));
  return [cfg.wrapper[0]!, 'rm', '-f', name];
}
