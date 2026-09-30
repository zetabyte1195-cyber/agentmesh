// How much each run used (G4). The agent tools report it at the end of a run: Claude Code gives tokens
// and a cost in US dollars; Antigravity gives tokens only; a tool in plain-text mode gives nothing. Kept
// in its own table so runs recorded before this existed simply have no row.
import type { Migration, SqliteDatabase } from '../db/index.js';
import type { RunUsage } from '../runner/events.js';
import { MISSION_PHASE_PREFIX } from '../missions/service.js';

export const USAGE_MIGRATION: Migration = {
  version: 5,
  name: '0005_run_usage',
  up: `
    CREATE TABLE IF NOT EXISTS run_usage (
        run_id TEXT PRIMARY KEY REFERENCES dispatch_runs(id) ON DELETE CASCADE,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        -- NULL when the tool reports no cost (Antigravity)
        cost_usd REAL
    );
  `,
};

export function hasUsageTable(db: SqliteDatabase): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_usage'").get());
}

export function recordUsage(db: SqliteDatabase, runId: string, usage: RunUsage | null, costUsd: number | null): void {
  if (!usage && costUsd === null) return;
  db.prepare('INSERT OR REPLACE INTO run_usage (run_id, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)').run(
    runId,
    usage?.inputTokens ?? 0,
    usage?.outputTokens ?? 0,
    usage?.cacheReadTokens ?? 0,
    costUsd,
  );
}

export interface UsageTotals {
  runs: number;
  /** Runs whose tool reported nothing (plain-text tools, runs that crashed before the end). */
  unreported: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Sum of the reported costs; null if no run reported one. */
  costUsd: number | null;
}

export interface UsageSummary {
  byAgent: ({ agentId: string } & UsageTotals)[];
  byMission: ({ missionId: string } & UsageTotals)[];
}

const TOTALS = `count(*) AS runs, sum(u.run_id IS NULL) AS unreported, coalesce(sum(u.input_tokens), 0) AS inputTokens,
  coalesce(sum(u.output_tokens), 0) AS outputTokens, coalesce(sum(u.cache_read_tokens), 0) AS cacheReadTokens, sum(u.cost_usd) AS costUsd`;

/** Totals per agent and per mission (its planning runs plus every run on its tasks). Finished runs only. */
export function usageSummary(db: SqliteDatabase): UsageSummary {
  if (!hasUsageTable(db)) return { byAgent: [], byMission: [] };
  const byAgent = db
    .prepare(`SELECT r.agent_id AS agentId, ${TOTALS} FROM dispatch_runs r LEFT JOIN run_usage u ON u.run_id = r.id WHERE r.status != 'RUNNING' GROUP BY r.agent_id ORDER BY r.agent_id`)
    .all() as UsageSummary['byAgent'];
  const byMission = db
    .prepare(
      `SELECT m.id AS missionId, ${TOTALS} FROM missions m
         JOIN dispatch_runs r ON r.status != 'RUNNING' AND (r.task_id = 'mission:' || m.id OR r.task_id IN (SELECT id FROM tasks WHERE phase_id = ? || m.id))
         LEFT JOIN run_usage u ON u.run_id = r.id
        GROUP BY m.id ORDER BY m.created_at`,
    )
    .all(MISSION_PHASE_PREFIX) as UsageSummary['byMission'];
  return { byAgent, byMission };
}
