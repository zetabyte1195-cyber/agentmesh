// Cockpit data plane (P3.1; spec v1.1 §11–12): a snapshot endpoint for the Human and live
// board events pushed over the authenticated WebSocket, so the browser never polls.
import { existsSync } from 'node:fs';
import { type ActivityLog, changedFiles, editorSettingsIn, openInEditor, trustedWorkspace } from '../activity/index.js';
import type { BoardService, MeshEvent } from '../board/index.js';
import type { BudgetService } from '../budget/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { type Dispatcher, recentRuns, usageSummary } from '../dispatch/index.js';
import type { LeaseArbiter } from '../leases/index.js';
import type { MissionService } from '../missions/index.js';
import { MAX_BODY_BYTES, MAX_PLAYBOOKS, type PlaybookStore } from '../playbooks/index.js';
import { MAX_SCHEDULES, type ScheduleService } from '../schedules/index.js';
import { type SandboxRuntime, lintWrapper } from '../sandbox/index.js';
import { collectNotices } from '../notify/index.js';
import { isInside } from '../git/links.js';
import { type DaemonServer, HttpError } from '../server/index.js';

export interface CockpitOptions {
  server: DaemonServer;
  board: BoardService;
  db: SqliteDatabase;
  dispatcher?: Dispatcher;
  missions?: MissionService;
  /** File locks held right now, so the Human can see (and release) them. */
  leases?: LeaseArbiter;
  /** The Human's playbooks (names and descriptions only; bodies are fetched one at a time). */
  playbooks?: PlaybookStore;
  /** Timers that start missions. */
  schedules?: ScheduleService;
  /** Spending limits per mission. */
  budget?: BudgetService;
  /** Container mode, when configured. */
  sandbox?: SandboxRuntime;
  /** What each agent is doing right now (the live feed). */
  activity?: ActivityLog;
  /** The main branch, for the list of files a task changed. */
  trunk?: string;
  /** The project's folder: a task's workspace is only ever read from inside it. */
  root?: string;
  /** Extra state for the cockpit's setup panel (project check, platforms); see cockpit/setup.ts. */
  extra?: () => Record<string, unknown>;
}

/** Everything the cockpit renders, in one read. */
export function cockpitSnapshot({ board, db, dispatcher, missions, leases, playbooks, schedules, budget, sandbox, activity, extra }: Omit<CockpitOptions, 'server'>) {
  const hasDispatch = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_runs'").get());
  const missionList = missions ? missions.list() : [];
  return {
    agents: board.agentsNow(),
    tasks: board.listTasks(),
    openQuestions: db.prepare('SELECT * FROM questions WHERE resolved = 0 ORDER BY created_at').all(),
    events: board.events(200),
    missions: missionList.map((m) => ({ ...m, budget: budget?.status(m.id) ?? null })),
    leases: leases ? leases.activeLeases() : [],
    // For each agent that is working: its run and the latest few entries. Further entries arrive over the live connection.
    live: activity ? activity.live() : {},
    sandbox: sandbox ? { enabled: true, experimental: true, image: sandbox.cfg.image, checks: sandbox.cfg.checks, agents: sandbox.cfg.agents ?? null, listener: sandbox.address, blockedReason: sandbox.blockedReason(), warnings: lintWrapper(sandbox.cfg) } : null,
    schedules: schedules ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, max: MAX_SCHEDULES, items: schedules.list(), runs: schedules.runs(30) } : null,
    playbooks: playbooks ? { ...playbooks.list(), max: MAX_PLAYBOOKS, maxBytes: MAX_BODY_BYTES } : null,
    notices: collectNotices({ db, ...(missions ? { missions, missionList } : {}), ...(dispatcher ? { dispatcher } : {}), ...(budget ? { budget } : {}) }),
    usage: hasDispatch ? usageSummary(db) : { byAgent: [], byMission: [] },
    ...(extra ? extra() : {}),
    dispatch: dispatcher
      ? {
          paused: dispatcher.isPaused(),
          backoffs: dispatcher.backoffs(),
          stuck: hasDispatch ? dispatcher.stuck() : [],
          recentRuns: hasDispatch ? recentRuns(db, 60) : [],
        }
      : null,
  };
}

export function registerCockpit(options: CockpitOptions): void {
  options.server.route('GET', '/api/state', 'human', () => cockpitSnapshot(options));

  // What a run did (as far as it is kept: a bounded number of runs, in memory, until AgentMesh stops).
  options.server.route('GET', '/api/activity', 'human', ({ url }) => {
    const runId = url.searchParams.get('runId');
    if (!runId) throw new HttpError(400, 'runId is required');
    const after = Number(url.searchParams.get('after') ?? 0);
    const entries = options.activity?.entries(runId, Number.isFinite(after) ? after : 0) ?? null;
    const info = options.activity?.info(runId) ?? null;
    return { runId, kept: entries !== null, running: info?.running ?? false, ...(info ? { agentId: info.agentId, taskId: info.taskId } : {}), entries: entries ?? [] };
  });

  // Open a task's folder in the Human's editor. Only a folder inside this project, taken from the task and never from the request.
  options.server.route('POST', '/api/workspace/open', 'human', async ({ principal, body }) => {
    let raw: { taskId?: unknown; confirm?: unknown };
    try {
      raw = JSON.parse((await body()) || '{}') as { taskId?: unknown; confirm?: unknown };
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    if (typeof raw.taskId !== 'string' || !raw.taskId) throw new HttpError(400, 'taskId is required');
    const row = options.db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(raw.taskId) as { worktree_path: string | null } | undefined;
    if (!row) throw new HttpError(404, `Unknown task ${raw.taskId}`);
    const wt = row.worktree_path;
    if (!wt || !existsSync(wt)) throw new HttpError(409, 'This task has no workspace yet: the agent has not started on it.');
    if (options.root && !isInside(options.root, wt)) throw new HttpError(409, 'This task\'s workspace is not inside the project, so it is not opened.');
    // The same test as before git is run in it: a folder whose link back to the project was rewritten is not one AgentMesh made.
    if (!trustedWorkspace(wt, options.root)) throw new HttpError(409, 'This task\'s workspace is no longer linked to this project (its .git was changed), so it is not opened.');
    // What is in the folder was written by an agent and nobody has read it. An editor runs things from its own settings once the
    // folder is trusted, so if the agent left such settings, the person is asked first.
    const found = editorSettingsIn(wt);
    if (found.length && raw.confirm !== true) {
      return { ok: false, needsConfirm: true, found, message: `This folder has editor settings the agent wrote (${found.join(', ')}). An editor can run programs from them once you trust the folder. Open it anyway?` };
    }
    const r = await openInEditor(wt);
    if (!r.ok) throw new HttpError(409, r.error);
    options.board.recordControl(principal!, `opened the workspace of ${raw.taskId} in ${r.editor}`, raw.taskId);
    return { ok: true, editor: r.editor };
  });

  // The files a task's workspace differs from the main branch by, from git.
  options.server.route('GET', '/api/changes', 'human', async ({ url }) => {
    const taskId = url.searchParams.get('taskId');
    if (!taskId) throw new HttpError(400, 'taskId is required');
    const row = options.db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(taskId) as { worktree_path: string | null } | undefined;
    if (!row) throw new HttpError(404, `Unknown task ${taskId}`);
    const none = { taskId, workspace: false, files: [], truncated: false };
    const wt = row.worktree_path;
    if (!wt || !existsSync(wt) || (options.root && !isInside(options.root, wt))) return none;
    return { taskId, workspace: true, ...(await changedFiles(wt, options.trunk ?? 'main', options.root ? { projectRoot: options.root } : {})) };
  });
}

/** Plug into BoardService({ onEvent }) so every board event reaches open cockpits immediately. */
export function cockpitEventPusher(server: DaemonServer): (event: MeshEvent) => void {
  return (event) => {
    server.broadcast({ type: 'EVENT', payload: event });
  };
}
