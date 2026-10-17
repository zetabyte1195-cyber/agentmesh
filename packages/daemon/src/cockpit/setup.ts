// The cockpit's setup panel: connect agents, see what is installed, test a platform end to end, and set
// the project's check command. Everything here is Human-only, and every change is written to
// .agentmesh/config.json (the one source of truth) and recorded in the timeline.
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { BoardService } from '../board/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import { smokeTestPlatform } from '../doctor/smoke.js';
import { type Notifier, parseWebhookUrl } from '../notify/index.js';
import type { IdentityService, Principal } from '../identity/index.js';
import { agentIdFor } from '../init/agents.js';
import { detectProject } from '../init/detect.js';
import { type ProjectConfig, initProject } from '../init/init.js';
import { type PlatformRegistry, RECIPES, RecipeError, ensureAgyMcpRule, isThisComputer, launcher, recipeById, recipeConfig, usableAddress } from '../platforms/index.js';
import { type DaemonServer, HttpError } from '../server/index.js';
import type { UpdateChecker } from '../update/index.js';

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
  notifier?: Notifier;
  updates?: UpdateChecker;
}

/** The longest project note accepted: it is added to every agent prompt, so it is kept short enough to be read. */
export const MAX_PROJECT_CONTEXT = 3500;

const AgentId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lower-case letters, digits and dashes, 2-31 characters');

/** Cheap state for the cockpit snapshot (no processes are started). */
export function setupState(o: Pick<SetupOptions, 'config' | 'registry' | 'root' | 'notifier' | 'updates'>) {
  const suggested = o.config.verifyCommand ? null : detectProject(o.root).verifyCommand;
  return {
    setup: {
      project: {
        // The folder's name: shown in the cockpit's title block so several open cockpits can be told apart.
        name: basename(o.root),
        verifyCommand: o.config.verifyCommand,
        landWithoutVerify: Boolean(o.config.landWithoutVerify),
        suggestedVerifyCommand: suggested,
        landing: Boolean(o.config.verifyCommand || o.config.landWithoutVerify),
        context: o.config.projectContext ?? '',
        maxContext: MAX_PROJECT_CONTEXT,
      },
      // Ready-made definitions for other tools; every one is added as "not verified".
      recipes: RECIPES.map((r) => ({ id: r.id, title: r.title, summary: r.summary, caveats: r.caveats, install: r.install, signIn: r.signIn, docs: r.docs, fields: (r.fields ?? []).map((f) => ({ id: f.id, label: f.label, hint: f.hint, default: f.default, suggest: f.suggest ?? null })), added: o.registry.has(r.id), current: o.registry.has(r.id) && r.current ? r.current(o.config.customPlatforms?.find((c) => c.id === r.id) ?? r.config) : null })),
      // The secret is never sent back to the page: only whether one is set.
      notifications: { webhookUrl: o.config.notifications?.webhookUrl ?? null, hasSecret: Boolean(o.config.notifications?.webhookSecret), last: o.notifier?.last() ?? null },
      update: { enabled: Boolean(o.config.updateCheck), info: o.updates?.info() ?? null, error: o.updates?.error() ?? null },
      platforms: o.registry.list().map((p) => ({
        id: p.id,
        label: p.label,
        friendlyName: p.friendlyName,
        verified: p.verified,
        loopProtection: Boolean(p.loopProtection),
        summary: p.summary,
        agents: o.config.agents.filter((a) => a.platform === p.id).map((a) => a.id),
      })),
    },
  };
}

/** No list of models is anywhere near this long; a longer answer is not read to the end. */
const MAX_MODEL_LIST_BYTES = 1_048_576;

/** The body as text, or null if it is longer than `limit` (the rest is not read). */
async function readTextUpTo(res: Response, limit: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
        projectContext: z.string().max(MAX_PROJECT_CONTEXT, `Keep it under ${MAX_PROJECT_CONTEXT} characters: it is added to every agent prompt.`).nullable().optional(),
        updateCheck: z.boolean().optional(),
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
    if (r.data.projectContext !== undefined) {
      const text = (r.data.projectContext ?? '').trim();
      if (text) o.config.projectContext = text;
      else delete o.config.projectContext;
      changes.push(text ? `updated the project context (${text.length} characters)` : 'removed the project context');
    }
    if (r.data.updateCheck !== undefined) {
      if (r.data.updateCheck) o.config.updateCheck = true;
      else delete o.config.updateCheck;
      changes.push(r.data.updateCheck ? 'turned on the daily check for a newer AgentMesh' : 'turned off the check for a newer AgentMesh');
    }
    if (!changes.length) throw new HttpError(400, 'Nothing to change');
    saveConfig(o);
    o.board.recordControl(human(principal), changes.join('; '));
    return setupState(o).setup.project;
  });

  // Where to tell the Human that something needs them. The secret signs every message; it is stored in
  // .agentmesh/config.json (local, git-ignored) and never returned by the API.
  o.server.route('POST', '/api/notifications', 'human', async ({ principal, body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await body()) || '{}');
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const r = z.object({ webhookUrl: z.string().max(2000).nullable(), webhookSecret: z.string().max(200).nullable().optional() }).strict().safeParse(raw);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const url = (r.data.webhookUrl ?? '').trim();
    if (!url) {
      delete o.config.notifications;
      saveConfig(o);
      o.board.recordControl(human(principal), 'removed the notification webhook');
      return setupState(o).setup.notifications;
    }
    let host: string;
    try {
      host = parseWebhookUrl(url).host;
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const next: NonNullable<ProjectConfig['notifications']> = { webhookUrl: url };
    const secret = r.data.webhookSecret === undefined ? o.config.notifications?.webhookSecret : (r.data.webhookSecret ?? '').trim();
    if (secret) next.webhookSecret = secret;
    o.config.notifications = next;
    saveConfig(o);
    o.board.recordControl(human(principal), `set the notification webhook (${host})`);
    return setupState(o).setup.notifications;
  });

  o.server.route('POST', '/api/notifications/test', 'human', async () => {
    if (!o.notifier) throw new HttpError(503, 'Notifications are not running');
    return o.notifier.sendTest();
  });

  o.server.route('POST', '/api/update/check', 'human', async () => {
    if (!o.updates) throw new HttpError(503, 'Update checking is not available');
    try {
      return await o.updates.check();
    } catch (err) {
      throw new HttpError(502, `Could not check: ${(err as Error).message}`);
    }
  });

  // Add another tool from a ready-made recipe. It appears as "not verified" until the Human has tested it.
  o.server.route('POST', '/api/platforms/recipe', 'human', async ({ principal, body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await body()) || '{}');
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const r = z.object({ id: z.string().min(1).max(40), values: z.record(z.string(), z.string().max(300)).optional() }).strict().safeParse(raw);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const recipe = recipeById(r.data.id);
    if (!recipe) throw new HttpError(404, `There is no recipe "${r.data.id}". Known: ${RECIPES.map((x) => x.id).join(', ')}`);
    // A recipe with choices that is already added is changed (a typo in the model, another model to try); one without has nothing to change.
    const existing = o.registry.has(recipe.id);
    if (existing && !recipe.fields?.length) throw new HttpError(409, `${recipe.title} is already added.`);
    let definition;
    try {
      definition = recipeConfig(recipe, r.data.values ?? {});
    } catch (err) {
      if (err instanceof RecipeError) throw new HttpError(400, err.message);
      throw err;
    }
    try {
      o.registry.check(definition);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    // The file first: if it cannot be written, nothing was changed in memory and trying again is possible.
    const had = o.config.customPlatforms;
    const list = had ?? [];
    o.config.customPlatforms = list.some((c) => c.id === recipe.id) ? list.map((c) => (c.id === recipe.id ? definition : c)) : [...list, definition];
    try {
      saveConfig(o);
    } catch (err) {
      if (had === undefined) delete o.config.customPlatforms;
      else o.config.customPlatforms = had;
      throw err;
    }
    if (existing) o.registry.replace(definition);
    else o.registry.add(definition);
    const choices = recipe.current ? recipe.current(definition) : {};
    const set = Object.entries(choices).map(([k, v]) => `${k} ${v}`).join(', ');
    const address = choices['address'];
    const away = address && !isThisComputer(address) ? `. The address ${address} is not this computer: what the agent reads in the project is sent there` : '';
    o.board.recordControl(human(principal), existing ? `changed ${recipe.title}: ${set} (not verified yet)${away}` : `added ${recipe.title} from a recipe (not verified yet)${set ? `: ${set}` : ''}${away}`);
    return { id: recipe.id, label: recipe.title, verified: false, changed: existing };
  });

  // The models Ollama has pulled, so the cockpit can offer them. Only an address on this computer is ever asked: this must not
  // become a way to look at other machines from here.
  o.server.route('POST', '/api/platforms/ollama-models', 'human', async ({ body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await body()) || '{}');
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const r = z.object({ address: z.string().max(200).optional() }).strict().safeParse(raw);
    if (!r.success) throw new HttpError(400, 'address: expected text');
    // Blank means the usual address here, as it does when the recipe is added.
    const address = (r.data.address ?? '').trim() || 'http://127.0.0.1:11434';
    if (!/^https?:\/\/[A-Za-z0-9._-]+(:[0-9]{1,5})?$/.test(address)) throw new HttpError(400, 'The address should look like http://127.0.0.1:11434 (no path at the end).');
    if (!usableAddress(address)) throw new HttpError(400, `"${address}" does not look like an address: check the numbers and the port.`);
    if (!isThisComputer(address)) return { checked: false, reachable: null, models: [], note: 'Models are only listed for Ollama on this computer. Type the model name yourself.' };
    const silent = { checked: true, reachable: false, models: [], note: `Ollama did not answer at ${address}. Start it, then look again.` };
    let res: Response;
    try {
      // A redirect is never followed: it could lead off this computer, and this must not become a way to look at other machines.
      res = await fetch(`${address}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    } catch (err) {
      const why = `${(err as Error).message} ${((err as { cause?: Error }).cause?.message) ?? ''}`;
      if (/redirect/i.test(why)) return { checked: true, reachable: false, models: [], note: 'Something at that address tried to send AgentMesh somewhere else. That is not followed. Check the address.' };
      return silent;
    }
    if (!res.ok) return { checked: true, reachable: false, models: [], note: `Ollama answered ${res.status}.` };
    let text: string | null;
    try {
      text = await readTextUpTo(res, MAX_MODEL_LIST_BYTES);
    } catch {
      return silent;
    }
    if (text === null) return { checked: true, reachable: false, models: [], note: 'The answer is too long to be a list of models, so it was not read. Check the address.' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { checked: true, reachable: false, models: [], note: `Something answered at ${address}, but it is not Ollama (it did not send a list of models).` };
    }
    const listed = parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown }).models) ? ((parsed as { models: unknown[] }).models) : [];
    const models = listed.flatMap((m) => {
      if (m === null || typeof m !== 'object') return [];
      const { name, size, remote_host: remote } = m as { name?: unknown; size?: unknown; remote_host?: unknown };
      if (typeof name !== 'string') return [];
      return [{ name, sizeGb: typeof size === 'number' && Number.isFinite(size) ? Math.round(size / 1e8) / 10 : null, cloud: Boolean(remote) || /[:-]cloud$/i.test(name) }];
    });
    return { checked: true, reachable: true, models };
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
    if (!detection.installed) throw new HttpError(409, `${adapter.label} is not installed on this machine. Install it and sign in once, then connect it.`);
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
      command: launcher(o.registry, adapter.id, o.allowedTools),
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
