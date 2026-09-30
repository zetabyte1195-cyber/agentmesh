// The cockpit's setup panel: connect agents, see what is installed, test a platform end to end, and set
// the project's check command. Everything here is Human-only, and every change is written to
// .agentmesh/config.json (the one source of truth) and recorded in the timeline.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BoardService } from '../board/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import { smokeTestPlatform } from '../doctor/smoke.js';
import type { IdentityService, Principal } from '../identity/index.js';
import { agentIdFor } from '../init/agents.js';
import { detectProject } from '../init/detect.js';
import { type ProjectConfig, initProject } from '../init/init.js';
import { type PlatformRegistry, ensureAgyMcpRule } from '../platforms/index.js';
import { type DaemonServer, HttpError } from '../server/index.js';

export interface SetupOptions {
  server: DaemonServer;
  board: BoardService;
  identity: IdentityService;
  dispatcher: Dispatcher;
  registry: PlatformRegistry;
  root: string;
  /** Shared with the rest of the daemon: changing it here changes what the merge queue and reviews run. */
  config: ProjectConfig;
  allowedTools: readonly string[];
}

const AgentId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lower-case letters, digits and dashes, 2-31 characters');

/** Cheap state for the cockpit snapshot (no processes are started). */
export function setupState(o: Pick<SetupOptions, 'config' | 'registry' | 'root'>) {
  const suggested = o.config.verifyCommand ? null : detectProject(o.root).verifyCommand;
  return {
    setup: {
      project: {
        verifyCommand: o.config.verifyCommand,
        landWithoutVerify: Boolean(o.config.landWithoutVerify),
        suggestedVerifyCommand: suggested,
        landing: Boolean(o.config.verifyCommand || o.config.landWithoutVerify),
      },
      platforms: o.registry.list().map((p) => ({
        id: p.id,
        label: p.label,
        friendlyName: p.friendlyName,
        verified: p.verified,
        summary: p.summary,
        agents: o.config.agents.filter((a) => a.platform === p.id).map((a) => a.id),
      })),
    },
  };
}

function saveConfig(o: SetupOptions): void {
  writeFileSync(join(o.root, '.agentmesh', 'config.json'), `${JSON.stringify(o.config, null, 2)}\n`);
}

export function registerSetup(o: SetupOptions): void {
  const human = (p: Principal | null): Principal => p!;
  let testing = false;

  // What is installed, and what each platform still needs. Starts a process per platform, so on request only.
  o.server.route('GET', '/api/platforms', 'human', async () => {
    return Promise.all(
      o.registry.list().map(async (p) => {
        const detection = await p.detect();
        const diagnoses = detection.installed && !detection.problem ? ((await p.diagnose?.()) ?? []) : [];
        return {
          id: p.id,
          label: p.label,
          verified: p.verified,
          installed: detection.installed,
          version: detection.version ?? null,
          problem: detection.problem ?? null,
          needsFix: diagnoses.some((d) => d.level === 'fail'),
          diagnoses,
        };
      }),
    );
  });

  o.server.route('POST', '/api/settings', 'human', async ({ principal, body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await body()) || '{}');
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const r = z
      .object({
        verifyCommand: z.string().trim().min(1).max(500).refine((s) => !/[\r\n]/.test(s), 'one line only').nullable().optional(),
        landWithoutVerify: z.boolean().optional(),
      })
      .strict()
      .safeParse(raw);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const changes: string[] = [];
    if (r.data.verifyCommand !== undefined) {
      o.config.verifyCommand = r.data.verifyCommand;
      changes.push(r.data.verifyCommand ? `project check is now "${r.data.verifyCommand}"` : 'project check removed');
      if (r.data.verifyCommand) delete o.config.landWithoutVerify; // a real check replaces the new-project shortcut
    }
    if (r.data.landWithoutVerify !== undefined) {
      if (r.data.landWithoutVerify) o.config.landWithoutVerify = true;
      else delete o.config.landWithoutVerify;
      changes.push(r.data.landWithoutVerify ? 'work now lands after review WITHOUT a test run' : 'work no longer lands without a check');
    }
    if (!changes.length) throw new HttpError(400, 'Nothing to change');
    saveConfig(o);
    o.board.recordControl(human(principal), changes.join('; '));
    return setupState(o).setup.project;
  });

  o.server.route('POST', '/api/agents', 'human', async ({ principal, body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await body()) || '{}');
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const r = z.object({ platform: z.string().min(1).max(40), id: AgentId.optional() }).strict().safeParse(raw);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const adapter = o.registry.get(r.data.platform);
    if (!adapter) throw new HttpError(400, `Unknown platform "${r.data.platform}". Known: ${o.registry.list().map((p) => p.id).join(', ')}`);
    const detection = await adapter.detect();
    if (!detection.installed) throw new HttpError(409, `${adapter.label} is not installed on this machine (no "${adapter.id}" command found). Install it and sign in once, then connect it.`);
    if (detection.problem) throw new HttpError(409, `${adapter.label} is installed but did not answer correctly: ${detection.problem}`);
    const taken = new Set(o.config.agents.map((a) => a.id));
    const id = r.data.id ?? agentIdFor(adapter, taken);
    if (taken.has(id)) throw new HttpError(409, `An agent called ${id} already exists`);
    const agent = { id, platform: adapter.id, rulebook: adapter.rulebook };
    o.config.agents.push(agent);
    saveConfig(o);
    o.identity.registerAgent({ id, name: adapter.friendlyName, platform: adapter.id, paradigm: 'CLI' });
    o.dispatcher.addAgent({
      agentId: id,
      platform: adapter.id,
      rulebook: adapter.rulebook,
      ownerNames: [adapter.friendlyName],
      command: (prompt, cwd, run) => adapter.command({ prompt, cwd, run, allowedTools: o.allowedTools }),
    });
    // Every agent's rulebook mentions the others; rewrite them and commit so new workspaces have them.
    const warnings: string[] = [];
    let committed: string | null = null;
    try {
      const rep = await initProject({ repoRoot: o.root, commit: true });
      committed = rep.committed;
      warnings.push(...rep.warnings);
    } catch (err) {
      warnings.push(`The agent is connected, but its rulebook could not be written: ${(err as Error).message}`);
    }
    o.board.recordControl(human(principal), `connected ${id} (${adapter.label})`);
    return { agent, committed, warnings, verified: adapter.verified };
  });

  // The real proof: run the platform against a throwaway daemon and check it used AgentMesh's tools.
  o.server.route('POST', '/api/platforms/test', 'human', async ({ principal, body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await body()) || '{}');
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const r = z.object({ platform: z.string().min(1).max(40) }).strict().safeParse(raw);
    if (!r.success) throw new HttpError(400, 'platform is required');
    const adapter = o.registry.get(r.data.platform);
    if (!adapter) throw new HttpError(400, `Unknown platform "${r.data.platform}"`);
    if (testing) throw new HttpError(409, 'A platform test is already running; wait for it to finish.');
    testing = true;
    try {
      const result = await smokeTestPlatform(adapter, { ...(o.config.customPlatforms?.length ? { customPlatforms: o.config.customPlatforms } : {}) });
      o.board.recordControl(human(principal), `tested ${adapter.label}: ${result.ok ? 'works' : 'FAILED'} (${result.seconds}s)`);
      return result;
    } finally {
      testing = false;
    }
  });

  // Antigravity's one required permission rule, added only when the Human presses the button.
  o.server.route('POST', '/api/platforms/fix', 'human', async ({ principal, body }) => {
    const b = JSON.parse((await body()) || '{}') as { platform?: string };
    if (b.platform !== 'ANTIGRAVITY') throw new HttpError(400, 'Only Antigravity has a fix here');
    try {
      const r = ensureAgyMcpRule();
      o.board.recordControl(human(principal), r.changed ? 'allowed AgentMesh tools in the Antigravity settings' : 'Antigravity already allows AgentMesh tools');
      return r;
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });
}
