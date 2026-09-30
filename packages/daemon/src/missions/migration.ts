// Migration 4: missions (brief → plan → cross-review → Human approval → task split → build).
// dispatch_runs is rebuilt because SQLite cannot alter a CHECK, and its `kind` must now allow the
// planning kinds. Existing rows are copied unchanged.
import type { Migration } from '../db/index.js';

export const MISSION_MIGRATION: Migration = {
  version: 4,
  name: '0004_missions',
  up: `
    CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PLANNING', 'REVIEWING', 'REVISING', 'PLAN_READY', 'SPLITTING', 'IMPLEMENTING', 'DONE', 'CANCELLED')),
        planner_agent_id TEXT NOT NULL REFERENCES agents(id),
        -- JSON array of agent ids that review the plan (never includes the planner)
        reviewer_agent_ids TEXT NOT NULL DEFAULT '[]',
        round INTEGER NOT NULL DEFAULT 1,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mission_plans (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        author_agent_id TEXT NOT NULL REFERENCES agents(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mission_id, version)
    );
    CREATE TABLE IF NOT EXISTS mission_reviews (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        round INTEGER NOT NULL,
        plan_version INTEGER NOT NULL,
        -- an agent, or 'human' for the Human's own notes ("request changes")
        reviewer_agent_id TEXT NOT NULL REFERENCES agents(id),
        verdict TEXT NOT NULL CHECK(verdict IN ('OK', 'GAPS')),
        gaps TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mission_reviews_mission ON mission_reviews(mission_id, round);

    CREATE TABLE dispatch_runs_v4 (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        task_id TEXT,
        task_version TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('AUDIT', 'HANDOFF', 'TASK', 'PLAN', 'PLAN_REVIEW', 'PLAN_REVISE', 'SPLIT')),
        status TEXT NOT NULL CHECK(status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'QUOTA', 'STOPPED', 'ABANDONED')),
        detail TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
    );
    INSERT INTO dispatch_runs_v4 (id, agent_id, task_id, task_version, kind, status, detail, started_at, ended_at)
        SELECT id, agent_id, task_id, task_version, kind, status, detail, started_at, ended_at FROM dispatch_runs;
    DROP TABLE dispatch_runs;
    ALTER TABLE dispatch_runs_v4 RENAME TO dispatch_runs;
    CREATE INDEX IF NOT EXISTS idx_dispatch_runs_agent ON dispatch_runs(agent_id, status);
  `,
};
