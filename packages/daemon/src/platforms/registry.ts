import { ZodError } from 'zod';
import { antigravityAdapter, claudeAdapter } from './builtin.js';
import { type CustomPlatformConfig, customAdapter } from './custom.js';
import type { AgentCommand } from '../runner/commands.js';
import type { PlatformAdapter, PlatformRunContext } from './types.js';

export const BUILTIN_PLATFORMS: readonly PlatformAdapter[] = [claudeAdapter, antigravityAdapter];

export interface PlatformRegistry {
  get(id: string): PlatformAdapter | undefined;
  has(id: string): boolean;
  list(): PlatformAdapter[];
  /** Define another platform while AgentMesh runs (adding a recipe from the cockpit). Throws on an invalid or duplicate one. */
  add(config: CustomPlatformConfig): PlatformAdapter;
  /** Replace a platform that was added (the choices of a recipe were changed). Agents already connected use it from their next run. */
  replace(config: CustomPlatformConfig): PlatformAdapter;
  /** Throws if `add` or `replace` would refuse this definition, and changes nothing. */
  check(config: CustomPlatformConfig): void;
}

/**
 * How an agent of this platform is started. The platform is looked up at every start, not once when the agent was connected,
 * so changing the platform's definition (the model of a recipe, say) reaches agents that are already connected.
 */
export function launcher(registry: PlatformRegistry, platform: string, allowedTools?: readonly string[], settings?: () => { model?: string; subAgents?: boolean }) {
  return (prompt: string, cwd: string, run: PlatformRunContext): AgentCommand => {
    const adapter = registry.get(platform);
    if (!adapter) throw new Error(`The platform ${platform} is no longer defined.`);
    // The model and sub-agent choices are read now, at the start of the run, so a change applies from the next one.
    return adapter.command({ prompt, cwd, run, ...(allowedTools ? { allowedTools } : {}), ...(settings?.() ?? {}) });
  };
}

/** The built-ins plus any platforms defined in config. Throws on an invalid or duplicate definition. */
export function createRegistry(custom: readonly CustomPlatformConfig[] = []): PlatformRegistry {
  const map = new Map<string, PlatformAdapter>(BUILTIN_PLATFORMS.map((p) => [p.id, p]));
  const added = new Set<string>();
  const make = (c: CustomPlatformConfig): PlatformAdapter => {
    let adapter: PlatformAdapter;
    try {
      adapter = customAdapter(c);
    } catch (err) {
      const id = (c as { id?: string }).id ?? '?';
      const why = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`).join('; ') : (err as Error).message;
      throw new Error(`Invalid custom platform "${id}" in .agentmesh/config.json: ${why}`, { cause: err });
    }
    return adapter;
  };
  const define = (c: CustomPlatformConfig): PlatformAdapter => {
    const adapter = make(c);
    if (map.has(adapter.id)) throw new Error(`Platform "${adapter.id}" is defined twice`);
    map.set(adapter.id, adapter);
    added.add(adapter.id);
    return adapter;
  };
  const replace = (c: CustomPlatformConfig): PlatformAdapter => {
    const adapter = make(c);
    if (!added.has(adapter.id)) throw new Error(`"${adapter.id}" is not a platform you added, so it cannot be changed.`);
    map.set(adapter.id, adapter);
    return adapter;
  };
  for (const c of custom) define(c);
  return { get: (id) => map.get(id), has: (id) => map.has(id), list: () => [...map.values()], add: define, replace, check: (c) => void make(c) };
}
