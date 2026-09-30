// Which agents should a new project start with? The ones whose CLI is actually installed, so a friend
// with only Claude Code isn't set up with an agent that can never run.
import type { Detection, PlatformAdapter, PlatformRegistry } from '../platforms/index.js';
import type { InitAgent } from './init.js';

export interface AgentChoice {
  agents: InitAgent[];
  found: { adapter: PlatformAdapter; detection: Detection }[];
  missing: PlatformAdapter[];
}

/** `codex-1` for a platform whose friendly name is Codex. */
export function agentIdFor(adapter: PlatformAdapter, taken: ReadonlySet<string> = new Set()): string {
  const base = adapter.friendlyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || adapter.id.toLowerCase();
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** One agent per installed platform (built-ins and any defined in config), in registry order. */
export async function chooseAgents(registry: PlatformRegistry): Promise<AgentChoice> {
  const found: AgentChoice['found'] = [];
  const missing: PlatformAdapter[] = [];
  const results = await Promise.all(registry.list().map(async (adapter) => ({ adapter, detection: await adapter.detect() })));
  for (const r of results) {
    if (r.detection.installed && !r.detection.problem) found.push(r);
    else missing.push(r.adapter);
  }
  const taken = new Set<string>();
  const agents = found.map(({ adapter }) => {
    const id = agentIdFor(adapter, taken);
    taken.add(id);
    return { id, platform: adapter.id, rulebook: adapter.rulebook };
  });
  return { agents, found, missing };
}
