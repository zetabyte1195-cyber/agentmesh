
/**
 * Audited SQLite Schema v1.1 from docs/design/schema.sql (Task S0.3).
 * Contains tables, indexes, triggers, and views for AgentMesh multi-agent coordination.
 */
export const INITIAL_SCHEMA_SQL = `-- AgentMesh SQLite Schema v1.1
-- Unified Multi-Agent Coordination, Verification & State Management
-- Conforms to Spec v1.1 and Architecture Decisions from S0.1, S0.3, S0.4

PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. Registered Agent Instances
-- ============================================================================
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,                       -- e.g. "claude-code-cli-01", "antigravity-gemini-01", "human-user"
    name TEXT NOT NULL,                         -- Display name
    platform TEXT NOT NULL,                     -- e.g. "CLAUDE_CODE", "ANTIGRAVITY", "CURSOR", "WINDSURF", "AIDER", "HUMAN"
    paradigm TEXT NOT NULL CHECK(paradigm IN ('CLI', 'IDE', 'DAEMON', 'HUMAN')),
    capabilities TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities)), -- JSON array of capability tags
    status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('ONLINE', 'BUSY', 'IDLE', 'PAUSED', 'OFFLINE')),
    current_task_id TEXT,                      -- Current task agent is executing (soft ref to avoid cycle)
    worktree_path TEXT,                        -- Active git worktree filesystem path
    last_heartbeat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 2. Tasks Master
-- ============================================================================
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,                       -- e.g. "S0.1", "P1.1", "P2.3"
    phase_id TEXT NOT NULL,                    -- e.g. "Phase 0 — Spec Reconciliation"
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 5), -- 1=Critical, 2=High, 3=Normal, 4=Low, 5=Backlog
    status TEXT NOT NULL DEFAULT 'TODO' CHECK(status IN (
        'DRAFT', 'TODO', 'BLOCKED', 'CLAIMED', 'IN_PROGRESS',
        'TESTING', 'READY_FOR_REVIEW', 'AUDITING',
        'PASSED', 'REJECTED', 'COMMITTED'
    )),
    suggested_owner TEXT,                      -- "Claude", "Gemini", "Pair", "Human"
    assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    reviewing_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    branch_name TEXT,                          -- e.g. "mesh/p1-1-scaffold"
    worktree_path TEXT,                        -- e.g. ".agentmesh/worktrees/wt-P1.1"
    base_commit TEXT,                          -- Commit SHA branched from trunk
    head_commit TEXT,                          -- Latest commit SHA on task branch
    diff_hash TEXT,                            -- SHA-256 hash of git diff pinned at submission
    acceptance_criteria TEXT NOT NULL,
    prerequisites TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(prerequisites)), -- JSON array of task IDs
    notes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(notes)),                 -- JSON array of structured log notes
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 3. Path & AST Resource Leases (Collision Prevention)
-- ============================================================================
CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,                       -- UUID v4 or ULID
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('FILE', 'DIR')),
    resource_path TEXT NOT NULL,               -- e.g. "src/math/bt709.ts" or "src/video/*"
    acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,             -- Enforced by TTL heartbeat watchdog
    released_at TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'EXPIRED', 'RELEASED'))
);

-- ============================================================================
-- 4. Two-Agent Verification Audits
-- ============================================================================
-- Note: Subqueries are prohibited in SQLite CHECK constraints.
-- Cross-platform verification and state constraints are strictly enforced
-- via BEFORE INSERT/UPDATE triggers below.
CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,                       -- UUID v4 or ULID
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    auditor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    verdict TEXT NOT NULL CHECK(verdict IN ('PASSED', 'REJECTED', 'GAP_FOUND')),
    diff_hash TEXT NOT NULL,                   -- SHA-256 of git diff reviewed
    test_run_success INTEGER NOT NULL CHECK(test_run_success IN (0, 1)), -- 1 = TRUE, 0 = FALSE
    checklist_results TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checklist_results)),
    notes TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 5. Verified Ground-Truth Findings
-- ============================================================================
CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,                       -- e.g. "f1-mue0pc2e"
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    text TEXT NOT NULL,
    file_path TEXT,
    line_number INTEGER,
    severity TEXT NOT NULL CHECK(severity IN ('INFO', 'SPEC_CORRECTION', 'SECURITY', 'BUG')),
    ground_truth_ref TEXT,                     -- Citation to documentation, code line, or real command output
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 6. Structured Agent Handoffs
-- ============================================================================
CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,                       -- e.g. "h1-mue0l3gt"
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    to_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    action_items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(action_items)), -- JSON array of action item strings
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 7. Questions (HITL and Agent Consultation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,                       -- e.g. "q1-mue0l3gr"
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    to_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    to_platform TEXT,                          -- e.g. "CLAUDE_CODE", "ANTIGRAVITY", or NULL for any
    to_role TEXT NOT NULL DEFAULT 'Human' CHECK(to_role IN ('Human', 'Agent', 'All')),
    text TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0, 1)),
    answer TEXT,
    answered_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

-- ============================================================================
-- 8. Architecture Decisions Log
-- ============================================================================
CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,                       -- e.g. "d1-mue0ztrb"
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL,
    rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 9. Real-Time Telemetry & Token Tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS telemetry_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    token_velocity REAL NOT NULL,              -- Tokens per second
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL,
    cpu_percent REAL NOT NULL,
    rss_memory_mb REAL NOT NULL,
    active_tool_name TEXT,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 10. Unified Activity Stream
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,                       -- e.g. "e1-mue0l3gt"
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK(kind IN (
        'status', 'claim', 'status-change', 'finding', 'handoff',
        'audit', 'question', 'answer', 'decision', 'task-added'
    )),
    text TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Performance & Lookup Indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_leases_active ON leases(resource_path, status) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(status, last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_audits_task ON audits(task_id);
CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_task ON handoffs(task_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_to_agent ON handoffs(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_questions_open ON questions(resolved) WHERE resolved = 0;
CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);

-- ============================================================================
-- DATABASE TRIGGERS: INTEGRITY & STATE MACHINE ENFORCEMENT
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Trigger: Human Agent Identity & Paradigm Integrity (H2)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_agents_validate_human_insert
BEFORE INSERT ON agents
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Human agent must have platform = ''HUMAN'' and paradigm = ''HUMAN''')
    WHERE (NEW.platform = 'HUMAN' AND NEW.paradigm != 'HUMAN')
       OR (NEW.paradigm = 'HUMAN' AND NEW.platform != 'HUMAN');

    SELECT RAISE(ABORT, 'Only one Human agent record is permitted')
    WHERE (NEW.platform = 'HUMAN' OR NEW.paradigm = 'HUMAN')
      AND EXISTS (
          SELECT 1 FROM agents WHERE platform = 'HUMAN' OR paradigm = 'HUMAN'
      );
END;

CREATE TRIGGER IF NOT EXISTS trg_agents_validate_human_update
BEFORE UPDATE ON agents
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Human agent must have platform = ''HUMAN'' and paradigm = ''HUMAN''')
    WHERE (NEW.platform = 'HUMAN' AND NEW.paradigm != 'HUMAN')
       OR (NEW.paradigm = 'HUMAN' AND NEW.platform != 'HUMAN');

    SELECT RAISE(ABORT, 'Only one Human agent record is permitted')
    WHERE (NEW.platform = 'HUMAN' OR NEW.paradigm = 'HUMAN')
      AND EXISTS (
          SELECT 1 FROM agents WHERE (platform = 'HUMAN' OR paradigm = 'HUMAN') AND id != OLD.id
      );
END;

-- ----------------------------------------------------------------------------
-- Trigger: Agent Identity Immutability (H7)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_agents_immutable_identity
BEFORE UPDATE OF platform, paradigm ON agents
FOR EACH ROW
WHEN NEW.platform IS NOT OLD.platform OR NEW.paradigm IS NOT OLD.paradigm
BEGIN
    SELECT RAISE(ABORT, 'Agent platform and paradigm are immutable after registration');
END;

-- ----------------------------------------------------------------------------
-- Trigger: Author & diff_hash Required for READY_FOR_REVIEW (H4, H5)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_tasks_ready_for_review_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.status = 'READY_FOR_REVIEW'
BEGIN
    SELECT RAISE(ABORT, 'Task cannot be READY_FOR_REVIEW without an assigned author')
    WHERE NEW.assigned_agent_id IS NULL;

    SELECT RAISE(ABORT, 'Task cannot be READY_FOR_REVIEW without diff_hash')
    WHERE NEW.diff_hash IS NULL OR trim(NEW.diff_hash) = '';
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_ready_for_review_update
BEFORE UPDATE ON tasks
FOR EACH ROW
WHEN NEW.status = 'READY_FOR_REVIEW'
BEGIN
    SELECT RAISE(ABORT, 'Task cannot be READY_FOR_REVIEW without an assigned author')
    WHERE NEW.assigned_agent_id IS NULL;

    SELECT RAISE(ABORT, 'Task cannot be READY_FOR_REVIEW without diff_hash')
    WHERE NEW.diff_hash IS NULL OR trim(NEW.diff_hash) = '';
END;

-- ----------------------------------------------------------------------------
-- Trigger: Prevent Self-Referencing Prerequisites on Insert & Update
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_tasks_no_self_prerequisite_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN json_valid(NEW.prerequisites) = 1
BEGIN
    SELECT RAISE(ABORT, 'Task cannot have itself as a prerequisite')
    FROM json_each(NEW.prerequisites)
    WHERE value = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_no_self_prerequisite_update
BEFORE UPDATE OF prerequisites ON tasks
FOR EACH ROW
WHEN json_valid(NEW.prerequisites) = 1
BEGIN
    SELECT RAISE(ABORT, 'Task cannot have itself as a prerequisite')
    FROM json_each(NEW.prerequisites)
    WHERE value = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Task State Machine Transition Rules
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_task_status_transition
BEFORE UPDATE OF status ON tasks
FOR EACH ROW
WHEN OLD.status != NEW.status
BEGIN
    SELECT RAISE(ABORT, 'Illegal task status transition')
    WHERE NOT (
        -- DRAFT can move to TODO (published) or BLOCKED
        (OLD.status = 'DRAFT' AND NEW.status IN ('TODO', 'BLOCKED')) OR

        -- BLOCKED can move to TODO (when unblocked) or DRAFT
        (OLD.status = 'BLOCKED' AND NEW.status IN ('TODO', 'DRAFT')) OR

        -- TODO can move to CLAIMED, IN_PROGRESS, or BLOCKED
        (OLD.status = 'TODO' AND NEW.status IN ('CLAIMED', 'IN_PROGRESS', 'BLOCKED')) OR

        -- CLAIMED can move to IN_PROGRESS, TODO (unclaimed), or BLOCKED
        (OLD.status = 'CLAIMED' AND NEW.status IN ('IN_PROGRESS', 'TODO', 'BLOCKED')) OR

        -- IN_PROGRESS can move to TESTING, READY_FOR_REVIEW, BLOCKED, or TODO (abandoned/reset)
        (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('TESTING', 'READY_FOR_REVIEW', 'BLOCKED', 'TODO')) OR

        -- TESTING can move to IN_PROGRESS (tests failed), READY_FOR_REVIEW (tests passed), or BLOCKED
        (OLD.status = 'TESTING' AND NEW.status IN ('IN_PROGRESS', 'READY_FOR_REVIEW', 'BLOCKED')) OR

        -- READY_FOR_REVIEW can move to AUDITING, PASSED, REJECTED, or IN_PROGRESS (withdrawn or queue rebase failure)
        (OLD.status = 'READY_FOR_REVIEW' AND NEW.status IN ('AUDITING', 'PASSED', 'REJECTED', 'IN_PROGRESS')) OR

        -- AUDITING can move to PASSED, REJECTED, READY_FOR_REVIEW (auditor unclaims), or IN_PROGRESS
        (OLD.status = 'AUDITING' AND NEW.status IN ('PASSED', 'REJECTED', 'READY_FOR_REVIEW', 'IN_PROGRESS')) OR

        -- REJECTED can move to IN_PROGRESS (author resumes to fix gaps), BLOCKED, or TODO
        (OLD.status = 'REJECTED' AND NEW.status IN ('IN_PROGRESS', 'BLOCKED', 'TODO')) OR

        -- PASSED can move to COMMITTED (landed), IN_PROGRESS (queue conflict/failure), READY_FOR_REVIEW (patch-id mismatch), or BLOCKED (queue pause)
        (OLD.status = 'PASSED' AND NEW.status IN ('COMMITTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'BLOCKED'))
    );
END;

-- ----------------------------------------------------------------------------
-- Trigger: Enforce Prerequisites Integrity on Claim / Work Start
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_task_claim_prerequisites_check
BEFORE UPDATE OF status ON tasks
FOR EACH ROW
WHEN OLD.status IN ('TODO', 'BLOCKED') AND NEW.status IN ('CLAIMED', 'IN_PROGRESS')
BEGIN
    SELECT RAISE(ABORT, 'Cannot claim task: prerequisite ' || p.value || ' is not PASSED or COMMITTED')
    FROM json_each(NEW.prerequisites) p
    WHERE NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = p.value
          AND t.status IN ('PASSED', 'COMMITTED')
    );
END;

-- ----------------------------------------------------------------------------
-- Trigger: Two-Agent Rule & Audit Precondition Validation (H2, H4, H5)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_audit_insert_validation
BEFORE INSERT ON audits
FOR EACH ROW
BEGIN
    -- 1. Target task must be in READY_FOR_REVIEW or AUDITING
    SELECT RAISE(ABORT, 'Task must be in READY_FOR_REVIEW or AUDITING status to be audited')
    FROM tasks t
    WHERE t.id = NEW.task_id
      AND t.status NOT IN ('READY_FOR_REVIEW', 'AUDITING');

    -- 2. Reject audits of tasks with no author (H4)
    SELECT RAISE(ABORT, 'Cannot audit task without an assigned author')
    FROM tasks t
    WHERE t.id = NEW.task_id
      AND t.assigned_agent_id IS NULL;

    -- 3. Audit diff_hash must match task pinned diff_hash (H5: spec §5.2 STALE_AUDIT_DIFF)
    SELECT RAISE(ABORT, 'Audit diff_hash does not match task pinned diff_hash (STALE_AUDIT_DIFF)')
    FROM tasks t
    WHERE t.id = NEW.task_id
      AND (t.diff_hash IS NULL OR t.diff_hash != NEW.diff_hash);

    -- 4. Two-agent rule: cross-platform validation (H2)
    -- Non-human auditors cannot audit tasks authored by agents on the same platform.
    -- To be exempt, auditor must have BOTH paradigm = 'HUMAN' and platform = 'HUMAN'.
    SELECT RAISE(ABORT, 'Two-agent rule violation: auditor platform must differ from author platform')
    FROM tasks t
    JOIN agents author ON author.id = t.assigned_agent_id
    JOIN agents auditor ON auditor.id = NEW.auditor_agent_id
    WHERE t.id = NEW.task_id
      AND NOT (auditor.paradigm = 'HUMAN' AND auditor.platform = 'HUMAN')
      AND (
          auditor.id = author.id
          OR auditor.platform = author.platform
      );

    -- 5. If verdict is PASSED, test_run_success must be 1
    SELECT RAISE(ABORT, 'Audit verdict PASSED requires test_run_success = 1')
    WHERE NEW.verdict = 'PASSED' AND (NEW.test_run_success IS NULL OR NEW.test_run_success != 1);
END;

-- ----------------------------------------------------------------------------
-- Trigger: Apply Audit Outcome to Task Status
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_audit_apply_verdict
AFTER INSERT ON audits
FOR EACH ROW
BEGIN
    UPDATE tasks
    SET status = CASE WHEN NEW.verdict = 'PASSED' THEN 'PASSED' ELSE 'REJECTED' END,
        reviewing_agent_id = NEW.auditor_agent_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.task_id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Prevent Direct Status Change to PASSED Without an Audit (H3)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_task_prevent_unauthorized_pass
BEFORE UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status = 'PASSED' AND OLD.status != 'PASSED'
BEGIN
    SELECT RAISE(ABORT, 'Cannot transition task to PASSED without a corresponding PASSED audit record')
    WHERE NEW.diff_hash IS NULL
       OR NOT EXISTS (
        SELECT 1 FROM audits a
        WHERE a.task_id = NEW.id
          AND a.verdict = 'PASSED'
          AND a.diff_hash = NEW.diff_hash
    );
END;

-- ----------------------------------------------------------------------------
-- Trigger: Immutability of Audits (Audit Log Integrity)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_audits_prevent_update
BEFORE UPDATE ON audits
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Audit records are immutable and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_audits_prevent_delete
BEFORE DELETE ON audits
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Audit records are immutable and cannot be deleted');
END;

-- ----------------------------------------------------------------------------
-- Trigger: Question Resolution Permissions (H1)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_questions_resolve_check
BEFORE UPDATE OF resolved ON questions
FOR EACH ROW
WHEN OLD.resolved = 0 AND NEW.resolved = 1
BEGIN
    SELECT RAISE(ABORT, 'Cannot resolve question without an answer')
    WHERE NEW.answer IS NULL OR trim(NEW.answer) = '';

    SELECT RAISE(ABORT, 'Cannot resolve question without specifying answered_by_agent_id')
    WHERE NEW.answered_by_agent_id IS NULL;

    SELECT RAISE(ABORT, 'Questions directed to Human can only be answered by a Human agent')
    WHERE OLD.to_role = 'Human'
      AND NOT EXISTS (
          SELECT 1 FROM agents a
          WHERE a.id = NEW.answered_by_agent_id
            AND a.paradigm = 'HUMAN'
            AND a.platform = 'HUMAN'
      );
END;

CREATE TRIGGER IF NOT EXISTS trg_questions_resolve_insert_check
BEFORE INSERT ON questions
FOR EACH ROW
WHEN NEW.resolved = 1
BEGIN
    SELECT RAISE(ABORT, 'Cannot resolve question without an answer')
    WHERE NEW.answer IS NULL OR trim(NEW.answer) = '';

    SELECT RAISE(ABORT, 'Cannot resolve question without specifying answered_by_agent_id')
    WHERE NEW.answered_by_agent_id IS NULL;

    SELECT RAISE(ABORT, 'Questions directed to Human can only be answered by a Human agent')
    WHERE NEW.to_role = 'Human'
      AND NOT EXISTS (
          SELECT 1 FROM agents a
          WHERE a.id = NEW.answered_by_agent_id
            AND a.paradigm = 'HUMAN'
            AND a.platform = 'HUMAN'
      );
END;

-- ============================================================================
-- Convenience Views
-- ============================================================================
CREATE VIEW IF NOT EXISTS v_task_dependencies AS
SELECT
    t.id AS task_id,
    t.title AS task_title,
    t.status AS task_status,
    p.value AS prerequisite_task_id,
    pt.status AS prerequisite_status,
    CASE WHEN pt.status IN ('PASSED', 'COMMITTED') THEN 1 ELSE 0 END AS is_satisfied
FROM tasks t,
json_each(t.prerequisites) p
LEFT JOIN tasks pt ON pt.id = p.value;
`;

/**
 * Loads the initial schema SQL from the bundled INITIAL_SCHEMA_SQL string.
 * Drift testing guarantees INITIAL_SCHEMA_SQL matches docs/design/schema.sql at build time.
 */
export function loadInitialSchemaSql(): string {
  return INITIAL_SCHEMA_SQL;
}
