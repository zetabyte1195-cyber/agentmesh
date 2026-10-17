// A spending limit per mission. The Human can say "stop around $5" or "stop around 2 million tokens" when a mission
// starts (or raise it later); once what the mission has used reaches it, the dispatcher starts no more runs for that
// mission (its planning steps, its tasks, their reviews and messages) and the Human is told, with a way to raise the
// limit. Other missions are not affected.
//
// What it can and cannot do, honestly:
//   • It counts only what the agent tools REPORT, and they report at the end of a run. A run that is going keeps going
//     (like pausing), so a mission can pass its limit by one run.
//   • Claude Code reports a cost in dollars and tokens; Antigravity reports tokens only; a tool in plain-text mode
//     reports nothing, so its runs count for nothing. A dollar limit therefore only sees the tools that report dollars.
//   • Tokens are input plus output. Cached input is not counted: it is read again on every step and is cheap, so it
//     would reach a limit quickly without costing much.
import type { Migration, SqliteDatabase } from '../db/index.js';
import { MISSION_PHASE_PREFIX } from '../missions/service.js';

export const BUDGET_MIGRATION: Migration = {
  version: 7,
  name: '0007_mission_budgets',
  up: `
    CREATE TABLE IF NOT EXISTS mission_budgets (
        mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
        -- NULL: no limit of that kind. A row with neither is never stored.
        max_cost_usd REAL,
        max_tokens INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (max_cost_usd IS NOT NULL OR max_tokens IS NOT NULL)
    );
    -- what a mission has used is summed over its runs and its tasks' runs, on every snapshot
    CREATE INDEX IF NOT EXISTS idx_dispatch_runs_task ON dispatch_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id);
  `,
};

export const MAX_COST_USD = 100_000;
export const MIN_TOKENS = 10_000;
export const MAX_TOKENS = 10_000_000_000;

export class BudgetError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

export interface BudgetLimits {
  maxCostUsd: number | null;
  maxTokens: number | null;
}

export interface BudgetStatus extends BudgetLimits {
  /** Sum of the costs the tools reported; null when none did. */
  usedCostUsd: number | null;
  /** Input plus output tokens the tools reported. */
  usedTokens: number;
  /** Why no more runs are started, in plain words; null while within the limit. */
  reached: string | null;
  /** Which limits are used up (and their values), so a notice can be told apart when only the other limit is edited. */
  reachedLimits: { costUsd?: number; tokens?: number };
}

const money = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString('en-US');

export class BudgetService {
  constructor(private readonly db: SqliteDatabase) {}

  private limitsRow(missionId: string): { max_cost_usd: number | null; max_tokens: number | null } | undefined {
    return this.db.prepare('SELECT max_cost_usd, max_tokens FROM mission_budgets WHERE mission_id = ?').get(missionId) as { max_cost_usd: number | null; max_tokens: number | null } | undefined;
  }

  /** Throws, in plain words, if a limit is not usable. Checked before a mission is created, so a bad limit never leaves one behind. */
  validate(limits: Partial<BudgetLimits>): BudgetLimits {
    const cost = limits.maxCostUsd ?? null;
    const tokens = limits.maxTokens ?? null;
    if (cost !== null && (!Number.isFinite(cost) || cost <= 0 || cost > MAX_COST_USD)) throw new BudgetError('INVALID', `The dollar limit must be more than 0 and at most ${count(MAX_COST_USD)}.`);
    if (tokens !== null && (!Number.isInteger(tokens) || tokens < MIN_TOKENS || tokens > MAX_TOKENS)) throw new BudgetError('INVALID', `The token limit must be a whole number from ${count(MIN_TOKENS)} to ${count(MAX_TOKENS)}.`);
    return { maxCostUsd: cost, maxTokens: tokens };
  }

  /** Set the limits, or remove them when both are null/absent. Raising a limit lets a stopped mission carry on. */
  set(missionId: string, limits: Partial<BudgetLimits>): BudgetStatus | null {
    if (!this.db.prepare('SELECT 1 FROM missions WHERE id = ?').get(missionId)) throw new BudgetError('NOT_FOUND', `Unknown mission ${missionId}`);
    const { maxCostUsd: cost, maxTokens: tokens } = this.validate(limits);
    if (cost === null && tokens === null) {
      this.db.prepare('DELETE FROM mission_budgets WHERE mission_id = ?').run(missionId);
      return null;
    }
    this.db
      .prepare(
        `INSERT INTO mission_budgets (mission_id, max_cost_usd, max_tokens) VALUES (?, ?, ?)
         ON CONFLICT(mission_id) DO UPDATE SET max_cost_usd = excluded.max_cost_usd, max_tokens = excluded.max_tokens, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(missionId, cost, tokens);
    return this.status(missionId);
  }

  /** What a mission has used so far: its planning runs plus every run on its tasks, finished runs only. */
  private used(missionId: string): { cost: number | null; tokens: number } {
    const r = this.db
      .prepare(
        `SELECT sum(u.cost_usd) AS cost, coalesce(sum(u.input_tokens), 0) + coalesce(sum(u.output_tokens), 0) AS tokens
           FROM dispatch_runs r JOIN run_usage u ON u.run_id = r.id
          WHERE r.status != 'RUNNING' AND (r.task_id = ? OR r.task_id IN (SELECT id FROM tasks WHERE phase_id = ?))`,
      )
      .get(`${MISSION_PHASE_PREFIX}${missionId}`, `${MISSION_PHASE_PREFIX}${missionId}`) as { cost: number | null; tokens: number };
    return { cost: r.cost, tokens: r.tokens };
  }

  /** The mission's limits and what it has used, or null when it has no limit. */
  status(missionId: string): BudgetStatus | null {
    const row = this.limitsRow(missionId);
    if (!row) return null;
    const used = this.used(missionId);
    const reasons: string[] = [];
    const reachedLimits: BudgetStatus['reachedLimits'] = {};
    // Costs are floating-point sums (0.1 + 0.7 is 0.7999999999999999), so "used up" allows a billionth of a dollar of rounding.
    if (row.max_cost_usd !== null && used.cost !== null && used.cost + 1e-9 >= row.max_cost_usd) {
      reasons.push(`it has used ${money(used.cost)} of its ${money(row.max_cost_usd)} limit`);
      reachedLimits.costUsd = row.max_cost_usd;
    }
    if (row.max_tokens !== null && used.tokens >= row.max_tokens) {
      reasons.push(`it has used ${count(used.tokens)} of its ${count(row.max_tokens)} token limit`);
      reachedLimits.tokens = row.max_tokens;
    }
    return {
      maxCostUsd: row.max_cost_usd,
      maxTokens: row.max_tokens,
      usedCostUsd: used.cost,
      usedTokens: used.tokens,
      reached: reasons.length ? `${reasons.join(' and ')}.`.replace(/^./, (c) => c.toUpperCase()) : null,
      reachedLimits,
    };
  }

  /** The missions still in progress that have reached their limit, with their status (so it is not worked out twice). */
  reached(): Map<string, BudgetStatus> {
    const out = new Map<string, BudgetStatus>();
    const rows = this.db
      .prepare("SELECT b.mission_id AS id FROM mission_budgets b JOIN missions m ON m.id = b.mission_id WHERE m.status NOT IN ('DONE', 'CANCELLED')")
      .all() as { id: string }[];
    for (const { id } of rows) {
      const status = this.status(id);
      if (status?.reached) out.set(id, status);
    }
    return out;
  }
}
