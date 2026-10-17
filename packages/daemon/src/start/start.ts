// `agentmesh start` (P2.7): assemble every piece into one long-running daemon for a repository
// that has run `agentmesh init`. Schedules (dispatch, landing) live here, in the daemon process,
// never in an agent session (lesson recorded on P2.5).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditGate } from '../audit/index.js';
import { BoardService } from '../board/index.js';
import { BUDGET_MIGRATION, BudgetService } from '../budget/index.js';
import { cockpitEventPusher, registerCockpit, registerControls, registerSetup, setupState } from '../cockpit/index.js';
import { MIGRATIONS, type SqliteDatabase, closeDatabase, migrate, openDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, USAGE_MIGRATION } from '../dispatch/index.js';
import { git } from '../git/run-git.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import type { ProjectConfig } from '../init/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { dashboardDist } from '../paths.js';
import { removeDaemonRecord, writeDaemonRecord } from './runtime.js';
import { handleMcpHttp } from '../mcp/index.js';
import { MergeQueue } from '../merge/index.js';
import { MISSION_MIGRATION, MissionService, TemplateStore } from '../missions/index.js';
import { Notifier } from '../notify/index.js';
import { PlaybookStore } from '../playbooks/index.js';
import type { CheckRunner } from '../review/check.js';
import { SandboxRuntime, lintWrapper, parseSandbox } from '../sandbox/index.js';
import { SCHEDULE_MIGRATION, ScheduleService } from '../schedules/index.js';
import { UpdateChecker } from '../update/index.js';
import { ReviewService } from '../review/index.js';
import { CommitService } from '../work/index.js';
import { DEFAULT_CLAUDE_ALLOWED_TOOLS, type PlatformRegistry, createRegistry, launcher } from '../platforms/index.js';
import { DaemonServer } from '../server/index.js';

export const HUMAN_AGENT_ID = 'human';

export { DEFAULT_CLAUDE_ALLOWED_TOOLS };

export interface StartOptions {
  repoRoot: string;
  /** Start dispatching agents automatically. Default true. */
  autoDispatch?: boolean;
  dispatchIntervalMs?: number;
  landingIntervalMs?: number;
  scheduleIntervalMs?: number;
  /** Override the port from config (tests use 0). */
  port?: number;
  claudeAllowedTools?: readonly string[];
  /** Test seam: replace how agents are launched. */
  agentsOverride?: DispatchableAgent[];
  log?: (line: string) => void;
  /**
   * Record this daemon (port, pid, a Human token) under the user's profile so `agentmesh login / stop /
   * status / dispatch` can reach it. The CLI turns this on; tests leave it off.
   */
  record?: boolean;
  /** The running AgentMesh version (shown in Setup, compared by the update check). */
  version?: string;
  /** Where the record goes (tests). Default ~/.agentmesh/daemons. */
  runtimeDir?: string;
}

export interface RunningDaemon {
  port: number;
  loginUrl: string;
  db: SqliteDatabase;
  identity: IdentityService;
  board: BoardService;
  gate: AuditGate;
  leases: LeaseArbiter;
  dispatcher: Dispatcher;
  missions: MissionService;
  notifier: Notifier;
  updates: UpdateChecker;
  schedules: ScheduleService;
  mergeQueue: MergeQueue | null;
  /** The platforms known to this daemon (the built-in ones and those added). */
  registry: PlatformRegistry;
  /** Resolves when the Human asked the daemon to stop (agentmesh stop). */
  stopRequested: Promise<void>;
  stop: () => Promise<void>;
}

export async function startDaemon(options: StartOptions): Promise<RunningDaemon> {
  const log = options.log ?? ((line: string) => console.log(line));
  const root = resolve((await git(options.repoRoot, ['rev-parse', '--show-toplevel'])).trim());
  const configPath = join(root, '.agentmesh', 'config.json');
  if (!existsSync(configPath)) throw new Error('No .agentmesh/config.json: run `agentmesh init` first.');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig;
  // Every agent's platform must be built in or defined in customPlatforms. Anything else used to be launched silently as agy.
  const registry = createRegistry(config.customPlatforms ?? []);
  const unsupported = config.agents.filter((a) => !registry.has(a.platform));
  if (!options.agentsOverride && unsupported.length) {
    throw new Error(`Unsupported platform in .agentmesh/config.json: ${unsupported.map((a) => `${a.id} (${a.platform})`).join(', ')}. Known: ${registry.list().map((p) => p.id).join(', ')}. Define others under "customPlatforms".`);
  }

  // Container mode: an invalid section stops AgentMesh from starting. It must never fall back to running agents outside a container.
  const sandboxConfig = parseSandbox(config.sandbox);

  // 1. State: migrations 1 (schema), 2 (credentials), 3 (dispatch), 4 (missions), 5 (usage), 6 (schedules), 7 (spending limits).
  const db = openDatabase(join(root, '.agentmesh', 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, USAGE_MIGRATION, SCHEDULE_MIGRATION, BUDGET_MIGRATION]);
  const identity = new IdentityService(db);
  const exists = (id: string) => Boolean(db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id));
  if (!exists(HUMAN_AGENT_ID)) identity.registerAgent({ id: HUMAN_AGENT_ID, name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  // A cockpit session ends when AgentMesh stops: a cookie copied from a browser is no use after a restart (the login link printed at
  // start makes a new one). The agents' own tokens are handled by the dispatcher.
  db.prepare("UPDATE agent_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE label = 'cockpit-session' AND revoked_at IS NULL").run();
  for (const a of config.agents) {
    if (!exists(a.id)) identity.registerAgent({ id: a.id, name: registry.get(a.platform)?.friendlyName ?? a.id, platform: a.platform, paradigm: 'CLI' });
  }

  // 2. Services.
  const worktrees = new WorktreeController({ repoRoot: root, trunk: config.trunk });
  const server = new DaemonServer({ identity, humanAgentId: HUMAN_AGENT_ID, port: options.port ?? config.daemon.port, staticDir: dashboardDist() });
  // Missions need the board (for timeline entries) and the board needs missions (to guard who may create a
  // mission's tasks), so the guard looks the service up when it is called.
  const late: { missions?: MissionService } = {};
  const board = new BoardService({ db, worktrees, bootstrap: config.bootstrap, onEvent: cockpitEventPusher(server), taskGuard: (p, input) => late.missions?.guardTask(p, input) });
  const missions = new MissionService({ db, board });
  late.missions = missions;
  const leases = new LeaseArbiter(db);
  const gate = new AuditGate({ db, repoRoot: root, leases });
  // Read the project check each time: the Human can change it in the cockpit while the daemon runs.
  // With container mode's "checks": "container" the check runs in a container, not on this computer (code an agent writes must not
  // run here). The runner is set once the container runtime exists; until then, and if it is ever missing, the check FAILS rather
  // than quietly running on the host.
  let containerCheck: CheckRunner | null = null;
  const runCheck: CheckRunner | undefined =
    sandboxConfig?.checks === 'container' ? (c, o) => (containerCheck ? containerCheck(c, o) : Promise.reject(Object.assign(new Error('Container mode is not ready, so the project check was not run.'), { code: 1, killed: false, stdout: '', stderr: '' }))) : undefined;
  const review = new ReviewService({ db, verifyCommand: () => config.verifyCommand, ...(runCheck ? { runCheck } : {}) });
  const commits = new CommitService({ db, leases });
  const playbooks = new PlaybookStore(join(root, '.agentmesh', 'playbooks'));
  const services = { board, leases, gate, review, commits, missions, playbooks };
  server.route('POST', '/mcp', 'agent', async ({ req, res, principal, body }) => handleMcpHttp(req, res, principal!, await body(), services));
  const port = await server.listen();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  // Containers cannot reach the loopback-only server, so container mode serves the MCP endpoint (and nothing else) on its own listener.
  const sandbox = sandboxConfig
    ? new SandboxRuntime({ cfg: sandboxConfig, repoRoot: root, identity, handler: (req, res, principal, body) => handleMcpHttp(req, res, principal, body, services), log })
    : null;
  if (sandbox) {
    containerCheck = sandbox.checkRunner();
    await sandbox.start();
    const blocked = sandbox.blockedReason();
    log(`Container mode (experimental): agents${sandboxConfig!.agents ? ` ${sandboxConfig!.agents.join(', ')}` : ''} run in containers; they reach AgentMesh at ${sandbox.mcpUrl()}.${blocked ? ` BLOCKED: ${blocked}` : ''}`);
    for (const w of lintWrapper(sandboxConfig!)) log(`Container mode warning: ${w}`);
  }

  // 3. Headless agents: each run gets its own MCP config (token inside) outside the repo.
  const allowed = options.claudeAllowedTools ?? DEFAULT_CLAUDE_ALLOWED_TOOLS;
  const agents: DispatchableAgent[] =
    options.agentsOverride ??
    config.agents.map((a) => {
      const adapter = registry.get(a.platform)!;
      return {
        agentId: a.id,
        platform: a.platform,
        rulebook: a.rulebook || adapter.rulebook,
        ownerNames: [adapter.friendlyName],
        command: launcher(registry, a.platform, allowed),
      };
    });
  // The daemon claims TASK work itself and starts the agent inside the new worktree (live AC-8 run #1).
  const claim = async (principal: Parameters<BoardService['claimTask']>[0], taskId: string) => ({ worktree: (await board.claimTask(principal, taskId)).worktree });
  const scratch = { create: (name: string) => worktrees.createScratch(name), remove: (path: string) => worktrees.removeScratch(path) };
  const budget = new BudgetService(db);
  const dispatcher = new Dispatcher({ db, identity, leases, agents, repoRoot: root, mcpUrl, claim, missions, budget, landing: () => Boolean(config.verifyCommand || config.landWithoutVerify), scratch, runTimeoutMs: 45 * 60_000, context: () => config.projectContext, playbooks: (n) => playbooks.catalogue(n), ...(sandbox ? { sandbox } : {}) });
  // Both read the config each time they run, so changing them in the cockpit needs no restart.
  const notifier = new Notifier({ db, missions, dispatcher, budget, config: () => config.notifications, cockpitUrl: () => `http://127.0.0.1:${port}` });
  const schedules = new ScheduleService({ db, missions, board, connectedAgents: () => dispatcher.agentIds(), isPaused: () => dispatcher.isPaused() });
  const updates = new UpdateChecker({ current: options.version ?? '0.0.0', enabled: () => Boolean(config.updateCheck) });
  registerCockpit({ server, board, db, dispatcher, missions, leases, playbooks, schedules, budget, ...(sandbox ? { sandbox } : {}), extra: () => ({ ...setupState({ config, registry, root, notifier, updates }), version: options.version ?? null }) });
  registerControls({ server, board, gate, review, dispatcher, missions, leases, templates: new TemplateStore(join(root, '.agentmesh')), playbooks, schedules, budget });
  registerSetup({ server, board, identity, dispatcher, registry, root, config, allowedTools: allowed, notifier, updates });

  // 4. The merge queue always exists; it lands only while the Human has set a check (or opted in to landing
  //    without one), and the Human can change that in the cockpit without restarting.
  const mergeQueue = new MergeQueue({ db, repoRoot: root, trunk: config.trunk, worktrees, leases, verifyCommand: () => config.verifyCommand || null, ...(runCheck ? { runCheck } : {}), isTaskBusy: (id) => dispatcher.isTaskBusy(id) });
  const landingEnabled = () => Boolean(config.verifyCommand || config.landWithoutVerify);

  // 5. Crash recovery, then the schedules.
  const live = (db.prepare("SELECT id FROM tasks WHERE worktree_path IS NOT NULL AND status NOT IN ('COMMITTED', 'TODO')").all() as { id: string }[]).map((r) => r.id);
  const { orphaned, missing } = await worktrees.reconcile(live);
  if (orphaned.length || missing.length) log(`Worktree reconcile: ${orphaned.length} orphaned, ${missing.length} missing (see the cockpit).`);
  await worktrees.cleanScratch(); // planning checkouts left by a crash or a stop
  await sandbox?.sweep(); // containers a crashed AgentMesh left behind
  if (options.autoDispatch ?? true) {
    dispatcher.start(options.dispatchIntervalMs ?? 15_000);
    notifier.start();
    updates.start();
  }
  // Schedules are checked every 30 seconds (and once now, so a slot missed while AgentMesh was off fires on start).
  const runSchedules = () => {
    try {
      schedules.tick();
    } catch (err) {
      log(`Schedules: ${(err as Error).message}`);
    }
  };
  const scheduleTimer = (options.autoDispatch ?? true) ? setInterval(runSchedules, options.scheduleIntervalMs ?? 30_000) : null;
  if (scheduleTimer) runSchedules();
  const landing = setInterval(() => {
    if (!landingEnabled()) return;
    void mergeQueue.processNext().then((r) => {
      if (r.outcome !== 'IDLE' && r.outcome !== 'BUSY') log(`Merge queue: ${r.outcome} ${r.taskId ?? ''} ${r.detail}`);
    });
  }, options.landingIntervalMs ?? 20_000);
  if (!landingEnabled()) log('Merge queue OFF: set a project check in the cockpit (or "verifyCommand" in .agentmesh/config.json) to enable landing.');
  else if (!config.verifyCommand) log('Merge queue ON WITHOUT VERIFICATION (landWithoutVerify): audited work lands without running project checks.');

  const loginUrl = server.issueCockpitUrl();

  // The command line reaches a running daemon through these Human routes (see runtime.ts).
  let requestStop: () => void = () => undefined;
  const stopRequested = new Promise<void>((r) => (requestStop = r));
  server.route('POST', '/api/login-link', 'human', () => ({ url: server.issueCockpitUrl() }));
  server.route('POST', '/api/stop', 'human', ({ principal }) => {
    board.recordControl(principal!, 'stopped AgentMesh');
    setTimeout(requestStop, 50); // answer first, then stop
    return { stopping: true };
  });
  let cliToken: string | null = null;
  if (options.record) {
    cliToken = identity.issueToken(HUMAN_AGENT_ID, 'cli');
    writeDaemonRecord({ root, port, pid: process.pid, token: cliToken, startedAt: new Date().toISOString() }, options.runtimeDir);
  }

  return {
    port,
    loginUrl,
    db,
    identity,
    board,
    gate,
    leases,
    dispatcher,
    missions,
    notifier,
    updates,
    schedules,
    mergeQueue,
    registry,
    stopRequested,
    stop: async () => {
      dispatcher.stop();
      notifier.stop();
      updates.stop();
      await sandbox?.stopAll();
      await sandbox?.close();
      if (scheduleTimer) clearInterval(scheduleTimer);
      clearInterval(landing);
      if (cliToken) {
        identity.revokeToken(cliToken);
        removeDaemonRecord(root, process.pid, options.runtimeDir);
      }
      await server.close();
      closeDatabase(db);
    },
  };
}
