// Migration 6: schedules (start a mission on a timer, or when another mission finishes) and a record of every
// firing, including the ones that were skipped and why.
import type { Migration } from '../db/index.js';

export const SCHEDULE_MIGRATION: Migration = {
  version: 6,
  name: '0006_schedules',
  up: `
    CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron', 'interval', 'mission_done')),
        -- cron schedules (presets such as "daily at 02:00" are stored compiled to cron, with a label for display)
        cron TEXT,
        preset_label TEXT,
        interval_hours INTEGER CHECK(interval_hours IS NULL OR interval_hours BETWEEN 1 AND 168),
        -- mission_done: 'any', or the id of the schedule whose missions are watched
        watch TEXT,
        brief TEXT NOT NULL,
        planner_agent_id TEXT NOT NULL REFERENCES agents(id),
        reviewer_agent_ids TEXT NOT NULL DEFAULT '[]',
        max_rounds INTEGER NOT NULL DEFAULT 3,
        -- ISO-8601 UTC. The interval's start, and the floor of the cursor.
        anchor_at TEXT NOT NULL,
        -- ISO-8601 UTC: the last slot handled (fired OR skipped). A slot at or before it is never handled again.
        cursor_at TEXT NOT NULL,
        -- the mission the schedule started last: the overlap rule looks at this one, not at prunable history
        last_mission_id TEXT,
        last_run_at TEXT,
        last_outcome TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        -- slot: on time; late: the machine or AgentMesh was off at the slot; manual: Run now; event: another mission finished
        trigger TEXT NOT NULL CHECK(trigger IN ('slot', 'late', 'manual', 'event')),
        slot_at TEXT,
        source_mission_id TEXT,
        mission_id TEXT,
        detail TEXT,
        outcome TEXT NOT NULL CHECK(outcome = 'started' OR outcome LIKE 'skipped:%' OR outcome LIKE 'failed:%'),
        -- identical consecutive skips are folded into one row that counts them
        repeat INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_runs ON schedule_runs(schedule_id, created_at);
    -- a finished mission triggers a given schedule at most once, even across restarts
    CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_event ON schedule_runs(schedule_id, source_mission_id) WHERE source_mission_id IS NOT NULL;
  `,
};
