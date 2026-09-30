import { ZodError } from 'zod';
import { antigravityAdapter, claudeAdapter } from './builtin.js';
import { type CustomPlatformConfig, customAdapter } from './custom.js';
import type { PlatformAdapter } from './types.js';

export const BUILTIN_PLATFORMS: readonly PlatformAdapter[] = [claudeAdapter, antigravityAdapter];

export interface PlatformRegistry {
  get(id: string): PlatformAdapter | undefined;
  has(id: string): boolean;
  list(): PlatformAdapter[];
}

/** The built-ins plus any platforms defined in config. Throws on an invalid or duplicate definition. */
export function createRegistry(custom: readonly CustomPlatformConfig[] = []): PlatformRegistry {
  const map = new Map<string, PlatformAdapter>(BUILTIN_PLATFORMS.map((p) => [p.id, p]));
  for (const c of custom) {
    let adapter: PlatformAdapter;
    try {
      adapter = customAdapter(c);
    } catch (err) {
      const id = (c as { id?: string }).id ?? '?';
      const why = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`).join('; ') : (err as Error).message;
      throw new Error(`Invalid custom platform "${id}" in .agentmesh/config.json: ${why}`, { cause: err });
    }
    if (map.has(adapter.id)) throw new Error(`Platform "${adapter.id}" is defined twice`);
    map.set(adapter.id, adapter);
  }
  return { get: (id) => map.get(id), has: (id) => map.has(id), list: () => [...map.values()] };
}
