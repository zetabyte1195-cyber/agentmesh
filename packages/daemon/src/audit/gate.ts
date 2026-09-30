// Two-agent audit gate + diff pinning (P1.8; Spec v1.1 §9, R15)
import { randomUUID } from 'node:crypto';
import {
  type AgentIdentityLike,
  type TaskLike,
  type TaskStatus,
  resolveActorRole,
  validateTaskTransition,
} from '@agentmesh/core';
import type { SqliteDatabase } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import { diffHash } from '../git/diff.js';
import { git } from '../git/run-git.js';
import { type Principal, assertActingAs } from '../identity/index.js';
import { type LeaseArbiter, changedPathsBetween } from '../leases/index.js';
import { validateChecklist } from './checklist.js';
import {
  AuditGateError,
  type AuditRecord,
  type ChecklistResults,
  type ChecklistSchema,
  type ClaimAuditInput,
  type ClaimAuditResult,
  InvalidCommitRangeError,
  MissingTestRunSuccessError,
  SamePlatformAuditError,
  StaleAuditDiffError,
  type SubmitAuditInput,
  type SubmitForReviewInput,
  type SubmitForReviewResult,
  UnauthorizedAuditError,
} from './types.js';

export interface AuditGateOptions {
  db: SqliteDatabase;
  repoRoot: string;
  leases: LeaseArbiter;
  checklistSchema?: ChecklistSchema;
}

interface TaskDbRow {
  id: string;
  status: TaskStatus;
  assigned_agent_id: string | null;
  reviewing_agent_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  head_commit: string | null;
  diff_hash: string | null;
  author_platform?: string | null;
}

interface AuditDbRow {
  id: string;
  task_id: string;
  auditor_agent_id: string;
  verdict: 'PASSED' | 'REJECTED' | 'GAP_FOUND';
  diff_hash: string;
  test_run_success: number;
  checklist_results: string;
  notes: string;
  created_at: string;
}

export class AuditGate {
  private readonly db: SqliteDatabase;
  private readonly repoRoot: string;
  private readonly leases: LeaseArbiter;
  private checklistSchema: ChecklistSchema | undefined;

  constructor(options: AuditGateOptions) {
    this.db = options.db;
    this.repoRoot = options.repoRoot;
    this.leases = options.leases;
    this.checklistSchema = options.checklistSchema;
  }

  setChecklistSchema(schema: ChecklistSchema | undefined): void {
    this.checklistSchema = schema;
  }

  getChecklistSchema(): ChecklistSchema | undefined {
    return this.checklistSchema;
  }

  /**
   * Author submits a completed task for review (spec v1.1 §9.1).
   * Verifies leases over all changed paths, pins diff_hash = SHA-256(diff <base> <head>),
   * and transitions task to READY_FOR_REVIEW.
   */
  async submitForReview(principal: Principal, input: SubmitForReviewInput): Promise<SubmitForReviewResult> {
    assertActingAs(principal, input.authorAgentId);

    const task = this.getTask(input.taskId);
    if (!task) {
      throw new AuditGateError(`Unknown task ${input.taskId}`, 'TASK_NOT_FOUND');
    }

    const role = resolveActorRole(
      { id: task.id, status: task.status, assigned_agent_id: task.assigned_agent_id, author_platform: task.author_platform },
      toAgentIdentity(principal),
    );
    if (role !== 'author' && role !== 'human') {
      throw new UnauthorizedAuditError(`Only the assigned author or Human may submit task ${task.id} for review`);
    }

    if (!task.worktree_path) {
      throw new AuditGateError(
        `Task ${task.id} has no allocated worktree_path; cannot submit for review`,
        'MISSING_WORKTREE',
      );
    }
    if (!task.base_commit) {
      throw new AuditGateError(
        `Task ${task.id} has no recorded base_commit; cannot submit for review`,
        'MISSING_BASE_COMMIT',
      );
    }

    const wtPath = task.worktree_path;
    const actualHead = (await git(wtPath, ['rev-parse', 'HEAD'])).trim();

    // Security check (Finding 1): Range cannot be narrowed by caller-supplied commits.
    // Base must be task.base_commit, head must be worktree HEAD. Reject differing inputs.
    if (input.baseCommit && input.baseCommit !== task.base_commit) {
      throw new InvalidCommitRangeError(
        `Caller-supplied baseCommit (${input.baseCommit}) does not match task.base_commit (${task.base_commit})`,
      );
    }
    if (input.headCommit && input.headCommit !== actualHead) {
      throw new InvalidCommitRangeError(
        `Caller-supplied headCommit (${input.headCommit}) does not match worktree HEAD (${actualHead})`,
      );
    }

    const baseCommit = task.base_commit;
    const headCommit = actualHead;

    // 1. Check lease coverage over all changed files between base and head
    const changedPaths = await changedPathsBetween(wtPath, baseCommit, headCommit);
    this.leases.assertSubmissionCovered(principal, task.id, changedPaths);

    // 2. Compute canonical diff_hash
    const hash = await diffHash(wtPath, baseCommit, headCommit);

    const taskLike: TaskLike = {
      id: task.id,
      status: task.status,
      assigned_agent_id: task.assigned_agent_id,
      author_platform: task.author_platform,
      diff_hash: hash,
    };

    const decision = validateTaskTransition(taskLike, task.status, 'READY_FOR_REVIEW', role);
    if (!decision.allowed) {
      throw new AuditGateError(`Cannot submit task for review: ${decision.reason}`, 'INVALID_TRANSITION');
    }

    // 3. Atomically transition task to READY_FOR_REVIEW and record activity
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE tasks SET status = ?, base_commit = ?, head_commit = ?, diff_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        )
        .run('READY_FOR_REVIEW', baseCommit, headCommit, hash, task.id);

      this.db
        .prepare('INSERT INTO events (id, task_id, agent_id, kind, text) VALUES (?, ?, ?, ?, ?)')
        .run(
          randomUUID(),
          task.id,
          principal.agentId,
          'status-change',
          `${task.id} → READY_FOR_REVIEW (pinned diff ${hash.slice(0, 12)})`,
        );
    });

    return {
      taskId: task.id,
      status: 'READY_FOR_REVIEW',
      diffHash: hash,
      baseCommit,
      headCommit,
    };
  }

  /**
   * Eligible peer auditor claims review of a task in READY_FOR_REVIEW.
   * Transitions task status to AUDITING.
   */
  async claimAudit(principal: Principal, input: ClaimAuditInput): Promise<ClaimAuditResult> {
    assertActingAs(principal, input.auditorAgentId);

    const task = this.getTask(input.taskId);
    if (!task) {
      throw new AuditGateError(`Unknown task ${input.taskId}`, 'TASK_NOT_FOUND');
    }

    if (task.status !== 'READY_FOR_REVIEW') {
      throw new AuditGateError(`Task ${task.id} is in status ${task.status}; only READY_FOR_REVIEW tasks can be claimed for audit`, 'INVALID_STATUS');
    }

    this.assertAuditorEligibility(task, principal);

    const taskLike: TaskLike = {
      id: task.id,
      status: task.status,
      assigned_agent_id: task.assigned_agent_id,
      author_platform: task.author_platform,
      diff_hash: task.diff_hash,
    };

    const role = resolveActorRole(taskLike, toAgentIdentity(principal));
    const decision = validateTaskTransition(taskLike, task.status, 'AUDITING', role);
    if (!decision.allowed) {
      throw new AuditGateError(`Cannot claim audit: ${decision.reason}`, 'INVALID_TRANSITION');
    }

    withImmediateTransaction(this.db, () => {
      this.db
        .prepare('UPDATE tasks SET status = ?, reviewing_agent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('AUDITING', principal.agentId, task.id);

      this.db
        .prepare('INSERT INTO events (id, task_id, agent_id, kind, text) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), task.id, principal.agentId, 'claim', `${task.id} audit claimed by ${principal.agentId}`);
    });

    return {
      taskId: task.id,
      status: 'AUDITING',
      auditorAgentId: principal.agentId,
    };
  }

  /**
   * Submit an independent verification audit (spec v1.1 §9).
   * Enforces:
   * 1. Two-agent rule: same-platform refused, author cannot audit own task.
   * 2. Human override: Human can audit any task across any platform.
   * 3. Diff pinning: diff_hash must match the pinned diff_hash (STALE_AUDIT_DIFF).
   * 4. Explicit testRunSuccess: never defaulted, required true for PASSED.
   * 5. Checklist schema validation: all required items in project schema must pass for PASSED.
   */
  async submitAudit(principal: Principal, input: SubmitAuditInput): Promise<AuditRecord> {
    assertActingAs(principal, input.auditorAgentId);

    // Decision d4: testRunSuccess must be explicitly supplied as boolean; never defaulted
    if (typeof input.testRunSuccess !== 'boolean') {
      throw new MissingTestRunSuccessError();
    }

    const task = this.getTask(input.taskId);
    if (!task) {
      throw new AuditGateError(`Unknown task ${input.taskId}`, 'TASK_NOT_FOUND');
    }

    if (task.status !== 'READY_FOR_REVIEW' && task.status !== 'AUDITING') {
      throw new AuditGateError(
        `Task ${task.id} must be in READY_FOR_REVIEW or AUDITING status to be audited (currently ${task.status})`,
        'INVALID_STATUS',
      );
    }

    if (!task.assigned_agent_id) {
      throw new UnauthorizedAuditError('Cannot audit task without an assigned author');
    }

    // Finding 4: In AUDITING status, require principal to be the claiming auditor (or Human)
    if (
      task.status === 'AUDITING' &&
      task.reviewing_agent_id &&
      principal.agentId !== task.reviewing_agent_id &&
      !principal.isHuman
    ) {
      throw new UnauthorizedAuditError(
        `Task ${task.id} audit was claimed by ${task.reviewing_agent_id}; only that agent or Human may submit the verdict`,
      );
    }

    // Two-agent rule enforcement & Human override
    this.assertAuditorEligibility(task, principal);

    // Finding 3: Worktree HEAD must still equal task.head_commit (prevent unreviewed changes post-submission)
    if (!task.worktree_path) {
      throw new AuditGateError(
        `Task ${task.id} has no allocated worktree_path; cannot audit`,
        'MISSING_WORKTREE',
      );
    }
    const currentHead = (await git(task.worktree_path, ['rev-parse', 'HEAD'])).trim();
    if (!task.head_commit || currentHead !== task.head_commit) {
      throw new StaleAuditDiffError(
        task.id,
        task.diff_hash ?? '',
        input.diffHash,
        `Worktree HEAD (${currentHead.slice(0, 12)}) has diverged from pinned head_commit (${task.head_commit?.slice(0, 12) ?? 'none'}) (STALE_AUDIT_DIFF)`,
      );
    }

    // Diff pinning check (spec v1.1 §9.3)
    if (!task.diff_hash || task.diff_hash !== input.diffHash) {
      throw new StaleAuditDiffError(task.id, task.diff_hash ?? '', input.diffHash);
    }

    // PASSED verdict requires test_run_success = true
    if (input.verdict === 'PASSED' && !input.testRunSuccess) {
      throw new AuditGateError('Audit verdict PASSED strictly requires testRunSuccess = true', 'TEST_RUN_REQUIRED');
    }

    // Validate against configured per-project checklist schema
    validateChecklist(this.checklistSchema, input.checklistResults, input.verdict);

    const taskLike: TaskLike = {
      id: task.id,
      status: task.status,
      assigned_agent_id: task.assigned_agent_id,
      author_platform: task.author_platform,
      reviewing_agent_id: task.reviewing_agent_id,
      diff_hash: task.diff_hash,
    };

    const role = resolveActorRole(taskLike, toAgentIdentity(principal));
    const targetStatus: TaskStatus = input.verdict === 'PASSED' ? 'PASSED' : 'REJECTED';
    const decision = validateTaskTransition(taskLike, task.status, targetStatus, role);
    if (!decision.allowed) {
      throw new AuditGateError(`Audit transition refused: ${decision.reason}`, 'INVALID_TRANSITION');
    }

    const auditId = randomUUID();
    const checklistJson = JSON.stringify(input.checklistResults ?? {});

    withImmediateTransaction(this.db, () => {
      // Inserting into audits fires DB triggers:
      // 1. trg_audit_insert_validation: verifies preconditions at SQL layer
      // 2. trg_audit_apply_verdict: updates tasks.status to PASSED/REJECTED and reviewing_agent_id
      this.db
        .prepare(
          `INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, checklist_results, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          auditId,
          task.id,
          principal.agentId,
          input.verdict,
          input.diffHash,
          input.testRunSuccess ? 1 : 0,
          checklistJson,
          input.notes,
        );

      this.db
        .prepare('INSERT INTO events (id, task_id, agent_id, kind, text) VALUES (?, ?, ?, ?, ?)')
        .run(
          randomUUID(),
          task.id,
          principal.agentId,
          'audit',
          `${task.id} audit verdict ${input.verdict} by ${principal.agentId}: ${input.notes}`,
        );
    });

    const record = this.getAudit(auditId);
    if (!record) {
      throw new AuditGateError(`Failed to retrieve recorded audit ${auditId}`, 'INTERNAL_ERROR');
    }
    return record;
  }

  getAuditsForTask(taskId: string): AuditRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM audits WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as AuditDbRow[];
    return rows.map(toAuditRecord);
  }

  getAudit(auditId: string): AuditRecord | null {
    const row = this.db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId) as AuditDbRow | undefined;
    return row ? toAuditRecord(row) : null;
  }

  private getTask(taskId: string): TaskDbRow | null {
    const row = this.db
      .prepare(
        `SELECT t.id, t.status, t.assigned_agent_id, t.reviewing_agent_id,
                t.branch_name, t.worktree_path, t.base_commit, t.head_commit, t.diff_hash,
                a.platform as author_platform
           FROM tasks t
           LEFT JOIN agents a ON a.id = t.assigned_agent_id
          WHERE t.id = ?`,
      )
      .get(taskId) as TaskDbRow | undefined;
    return row ?? null;
  }

  private assertAuditorEligibility(task: TaskDbRow, principal: Principal): void {
    // Author cannot audit own task
    if (task.assigned_agent_id === principal.agentId) {
      throw new UnauthorizedAuditError('Author cannot audit their own task');
    }

    // Human override: verified human (platform === 'HUMAN' && paradigm === 'HUMAN') can audit anything
    if (principal.isHuman) {
      return;
    }

    // Non-human auditor: same-platform audits are strictly refused
    if (task.author_platform && principal.platform === task.author_platform) {
      throw new SamePlatformAuditError(task.author_platform, principal.platform, principal.agentId);
    }
  }
}

function toAuditRecord(row: AuditDbRow): AuditRecord {
  let parsedChecklist: ChecklistResults;
  try {
    parsedChecklist = JSON.parse(row.checklist_results) as ChecklistResults;
  } catch {
    parsedChecklist = {};
  }
  return {
    id: row.id,
    taskId: row.task_id,
    auditorAgentId: row.auditor_agent_id,
    verdict: row.verdict,
    diffHash: row.diff_hash,
    testRunSuccess: row.test_run_success === 1,
    checklistResults: parsedChecklist,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function toAgentIdentity(principal: Principal): AgentIdentityLike {
  return {
    id: principal.agentId,
    agentId: principal.agentId,
    platform: principal.platform,
    paradigm: principal.paradigm,
  };
}

