// Cockpit data plane (P3.1; spec v1.1 §11–12): a snapshot endpoint for the Human and live
// board events pushed over the authenticated WebSocket, so the browser never polls.
import type { BoardService, MeshEvent } from '../board/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { type Dispatcher, usageSummary } from '../dispatch/index.js';
import type { LeaseArbiter } from '../leases/index.js';
import type { MissionService } from '../missions/index.js';
import type { DaemonServer } from '../server/index.js';

export interface CockpitOptions {
  server: DaemonServer;
  board: BoardService;
  db: SqliteDatabase;
  dispatcher?: Dispatcher;
  missions?: MissionService;
  /** File locks held right now, so the Human can see (and release) them. */
  leases?: LeaseArbiter;
  /** Extra state for the cockpit's setup panel (project check, platforms); see cockpit/setup.ts. */
  extra?: () => Record<string, unknown>;
}

/** Everything the cockpit renders, in one read. */
export function cockpitSnapshot({ board, db, dispatcher, missions, leases, extra }: Omit<CockpitOptions, 'server'>) {
  const hasDispatch = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_runs'").get());
  return {
    agents: board.agentsNow(),
    tasks: board.listTasks(),
    openQuestions: db.prepare('SELECT * FROM questions WHERE resolved = 0 ORDER BY created_at').all(),
    events: board.events(200),
    missions: missions ? missions.list() : [],
    leases: leases ? leases.activeLeases() : [],
    usage: hasDispatch ? usageSummary(db) : { byAgent: [], byMission: [] },
    ...(extra ? extra() : {}),
    dispatch: dispatcher
      ? {
          paused: dispatcher.isPaused(),
          backoffs: dispatcher.backoffs(),
          stuck: hasDispatch ? dispatcher.stuck() : [],
          recentRuns: hasDispatch ? db.prepare('SELECT * FROM dispatch_runs ORDER BY started_at DESC LIMIT 50').all() : [],
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
