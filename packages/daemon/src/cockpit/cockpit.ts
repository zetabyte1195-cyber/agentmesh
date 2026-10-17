// Cockpit data plane (P3.1; spec v1.1 §11–12): a snapshot endpoint for the Human and live
// board events pushed over the authenticated WebSocket, so the browser never polls.
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
import type { DaemonServer } from '../server/index.js';

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
  /** Extra state for the cockpit's setup panel (project check, platforms); see cockpit/setup.ts. */
  extra?: () => Record<string, unknown>;
}

/** Everything the cockpit renders, in one read. */
export function cockpitSnapshot({ board, db, dispatcher, missions, leases, playbooks, schedules, budget, sandbox, extra }: Omit<CockpitOptions, 'server'>) {
  const hasDispatch = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_runs'").get());
  const missionList = missions ? missions.list() : [];
  return {
    agents: board.agentsNow(),
    tasks: board.listTasks(),
    openQuestions: db.prepare('SELECT * FROM questions WHERE resolved = 0 ORDER BY created_at').all(),
    events: board.events(200),
    missions: missionList.map((m) => ({ ...m, budget: budget?.status(m.id) ?? null })),
    leases: leases ? leases.activeLeases() : [],
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
}

/** Plug into BoardService({ onEvent }) so every board event reaches open cockpits immediately. */
export function cockpitEventPusher(server: DaemonServer): (event: MeshEvent) => void {
  return (event) => {
    server.broadcast({ type: 'EVENT', payload: event });
  };
}
