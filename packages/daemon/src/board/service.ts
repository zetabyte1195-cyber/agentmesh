// Board operations behind the MCP tools and the cockpit (P2.1; spec v1.1 §10.1). Every method
// takes the caller's Principal (from a token), never an agent id argument. Status changes go
// through the P1.3 state machine (who may) and the DB triggers (what is legal).
import { randomUUID } from 'node:crypto';
import { type TaskStatus, resolveActorRole, validateTaskTransition } from '@agentmesh/core';
import type { SqliteDatabase } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import type { BootstrapOptions, WorktreeController } from '../git/worktrees.js';
import type { Principal } from '../identity/index.js';

export type EventKind = 'status' | 'claim' | 'status-change' | 'finding' | 'handoff' | 'audit' | 'question' | 'answer' | 'decision' | 'task-added';
export type Severity = 'INFO' | 'SPEC_CORRECTION' | 'SECURITY' | 'BUG';

export interface MeshEvent {
  id: string;
  taskId: string | null;
  agentId: string | null;
  kind: EventKind;
  text: string;
  createdAt: string;
}

export class BoardError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}

/** Status changes an author may request directly; review/audit/landing moves have dedicated flows. */
const AUTHOR_TARGETS: ReadonlySet<TaskStatus> = new Set(['IN_PROGRESS', 'TESTING', 'BLOCKED', 'TODO']);

export interface BoardServiceOptions {
  db: SqliteDatabase;
  worktrees: WorktreeController;
  bootstrap?: BootstrapOptions;
  /** Called after every recorded event (the cockpit WebSocket subscribes here). */
  onEvent?: (event: MeshEvent) => void;
  /**
   * Called before a task is created; throw to refuse. May correct the input in place (missions use it
   * to check who may create a mission's tasks and to canonicalise owner names).
   */
  taskGuard?: (principal: Principal, input: { id: string; phase: string; suggestedOwner?: string }) => void;
}

export class BoardService {
  constructor(private readonly options: BoardServiceOptions) {}

  private get db(): SqliteDatabase {
    return this.options.db;
  }

  /** Session-start summary for an agent. */
  getBoard(principal: Principal) {
    const tasks = this.db
      .prepare('SELECT id, title, status, assigned_agent_id AS owner, suggested_owner AS suggestedOwner, prerequisites FROM tasks ORDER BY id')
      .all()
      .map((t) => ({ ...(t as Record<string, unknown>), prerequisites: JSON.parse((t as { prerequisites: string }).prerequisites) as string[] }));
    return {
      you: { agentId: principal.agentId, platform: principal.platform },
      agents: this.agentsNow(),
      tasks,
      openQuestions: this.db.prepare('SELECT * FROM questions WHERE resolved = 0 ORDER BY created_at').all(),
      handoffsToYou: this.db.prepare('SELECT * FROM handoffs WHERE to_agent_id = ? ORDER BY created_at DESC LIMIT 10').all(principal.agentId),
      answersToYou: this.db.prepare('SELECT id, task_id AS taskId, text, answer, answered_by_agent_id AS answeredBy FROM questions WHERE from_agent_id = ? AND resolved = 1 ORDER BY resolved_at DESC LIMIT 5').all(principal.agentId),
      recentEvents: this.db.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT 20').all(),
    };
  }

  /** Each agent with its most recent "status" event (what it is doing now). */
  agentsNow() {
    return this.db
      .prepare(
        `SELECT a.id, a.name, a.platform, a.status, a.current_task_id AS currentTaskId,
                (SELECT text FROM events e WHERE e.agent_id = a.id AND e.kind = 'status' ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS doing
           FROM agents a ORDER BY a.id`,
      )
      .all();
  }

  setStatus(principal: Principal, doing: string, taskId?: string): void {
    const text = doing.trim();
    if (!text) throw new BoardError('INVALID', 'doing must not be empty');
    withImmediateTransaction(this.db, () => {
      this.db.prepare("UPDATE agents SET status = ?, current_task_id = ?, last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?").run(
        text.toLowerCase() === 'idle' ? 'IDLE' : 'BUSY',
        taskId ?? null,
        principal.agentId,
      );
      this.event(principal, 'status', text, taskId ?? null);
    });
  }

  listTasks(filter: { status?: string; owner?: string } = {}) {
    return this.db
      .prepare('SELECT * FROM tasks WHERE (? IS NULL OR status = ?) AND (? IS NULL OR assigned_agent_id = ?) ORDER BY id')
      .all(filter.status ?? null, filter.status ?? null, filter.owner ?? null, filter.owner ?? null);
  }

  getTask(taskId: string) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new BoardError('NOT_FOUND', `Unknown task ${taskId}`);
    const rel = (table: string) => this.db.prepare(`SELECT * FROM ${table} WHERE task_id = ? ORDER BY created_at`).all(taskId);
    return { task, findings: rel('findings'), handoffs: rel('handoffs'), audits: rel('audits'), questions: rel('questions'), decisions: rel('decisions') };
  }

  createTask(
    principal: Principal,
    input: { id: string; phase: string; title: string; description?: string; acceptanceCriteria: string; suggestedOwner?: string; prerequisites?: string[]; priority?: number },
  ) {
    this.options.taskGuard?.(principal, input);
    // Same rule as worktree allocation (git/worktrees.ts assertTaskId): refuse at creation, not at claim time.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.id) || input.id.includes('..') || input.id.endsWith('.')) {
      throw new BoardError('INVALID', `Invalid task id "${input.id}"`);
    }
    return withImmediateTransaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(input.id)) throw new BoardError('CONFLICT', `Task ${input.id} already exists`);
      for (const p of input.prerequisites ?? []) {
        if (!this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(p)) throw new BoardError('INVALID', `Unknown prerequisite ${p}`);
      }
      this.db
        .prepare(
          `INSERT INTO tasks (id, phase_id, title, description, acceptance_criteria, suggested_owner, prerequisites, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.phase, input.title, input.description ?? '', input.acceptanceCriteria, input.suggestedOwner ?? null, JSON.stringify(input.prerequisites ?? []), input.priority ?? 2);
      this.event(principal, 'task-added', `added ${input.id}: ${input.title}`, input.id);
      return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.id);
    });
  }

  /**
   * Claim a TODO task: the state machine checks the actor, the DB checks prerequisites, then a
   * worktree is allocated and returned. If allocation fails the claim is rolled back.
   */
  async claimTask(principal: Principal, taskId: string) {
    if (principal.isHuman) throw new BoardError('FORBIDDEN', 'The Human assigns tasks; agents claim them');
    const task = this.taskRow(taskId);
    const decision = validateTaskTransition(
      { ...task, prerequisites: task.prerequisites },
      task.status,
      'IN_PROGRESS',
      resolveActorRole(task, { id: principal.agentId, platform: principal.platform, paradigm: principal.paradigm }),
      { satisfiedPrerequisiteIds: this.satisfiedPrereqs(task.prerequisites) },
    );
    if (!decision.allowed) throw new BoardError('FORBIDDEN', decision.reason);
    const wt = await this.options.worktrees.allocate(taskId, task.title, this.options.bootstrap);
    try {
      withImmediateTransaction(this.db, () => {
        const claimed = this.db
          .prepare(
            `UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ?, branch_name = ?, worktree_path = ?,
                    base_commit = ?, head_commit = NULL, diff_hash = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = ?`,
          )
          .run(principal.agentId, wt.branch, wt.path, wt.baseCommit, taskId, task.status);
        // Someone else claimed it while the worktree was being created (Gemini, P2.1 audit):
        // refuse, which rolls back this transaction and (below) removes the orphan worktree.
        if (claimed.changes === 0) throw new BoardError('CONFLICT', `Task ${taskId} was claimed by another agent first`);
        this.event(principal, 'claim', `claimed ${taskId}: ${task.title}`, taskId);
      });
    } catch (err) {
      await this.options.worktrees.remove(taskId, { deleteBranch: 'force' }).catch(() => undefined);
      throw err;
    }
    return { taskId, worktree: wt.path, branch: wt.branch, baseCommit: wt.baseCommit };
  }

  /** Author-side moves only (IN_PROGRESS/TESTING/BLOCKED/TODO). Review, audit and landing have their own flows. */
  updateStatus(principal: Principal, taskId: string, status: TaskStatus, note?: string) {
    if (!AUTHOR_TARGETS.has(status)) {
      throw new BoardError('INVALID', `Use mesh_submit_for_review / mesh_submit_audit for ${status}`);
    }
    const task = this.taskRow(taskId);
    const role = resolveActorRole(task, { id: principal.agentId, platform: principal.platform, paradigm: principal.paradigm });
    const decision = validateTaskTransition(task, task.status, status, role, { satisfiedPrerequisiteIds: this.satisfiedPrereqs(task.prerequisites) });
    if (!decision.allowed) throw new BoardError('FORBIDDEN', decision.reason);
    withImmediateTransaction(this.db, () => {
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, taskId);
      this.event(principal, 'status-change', `${taskId} → ${status}${note ? ` — ${note}` : ''}`, taskId);
    });
  }

  logFinding(principal: Principal, input: { taskId?: string; text: string; severity: Severity; file?: string; line?: number; groundTruthRef?: string }) {
    const id = randomUUID();
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO findings (id, task_id, agent_id, text, file_path, line_number, severity, ground_truth_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.taskId ?? null, principal.agentId, input.text, input.file ?? null, input.line ?? null, input.severity, input.groundTruthRef ?? null);
      this.event(principal, 'finding', `[${input.severity}] ${input.text}`, input.taskId ?? null);
    });
    return { id };
  }

  sendHandoff(principal: Principal, input: { taskId: string; toAgentId: string; message: string; actionItems?: string[] }) {
    this.taskRow(input.taskId);
    if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(input.toAgentId)) throw new BoardError('NOT_FOUND', `Unknown agent ${input.toAgentId}`);
    const id = randomUUID();
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message, action_items) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.taskId, principal.agentId, input.toAgentId, input.message, JSON.stringify(input.actionItems ?? []));
      this.event(principal, 'handoff', `→ ${input.toAgentId}: ${input.message}`, input.taskId);
    });
    return { id };
  }

  askQuestion(principal: Principal, input: { taskId?: string; text: string; toRole?: 'Human' | 'Agent' | 'All'; toAgentId?: string }) {
    const id = randomUUID();
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO questions (id, task_id, from_agent_id, to_agent_id, to_role, text) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.taskId ?? null, principal.agentId, input.toAgentId ?? null, input.toRole ?? 'Human', input.text);
      this.event(principal, 'question', `asks ${input.toAgentId ?? input.toRole ?? 'Human'}: ${input.text}`, input.taskId ?? null);
    });
    return { id };
  }

  /** The DB refuses agents answering Human-directed questions (trg_questions_resolve_check). */
  answerQuestion(principal: Principal, questionId: string, answer: string) {
    const q = this.db.prepare('SELECT task_id, from_agent_id, text FROM questions WHERE id = ?').get(questionId) as { task_id: string | null; from_agent_id: string; text: string } | undefined;
    if (!q) throw new BoardError('NOT_FOUND', `Unknown question ${questionId}`);
    withImmediateTransaction(this.db, () => {
      const result = this.db
        .prepare('UPDATE questions SET resolved = 1, answer = ?, answered_by_agent_id = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND resolved = 0')
        .run(answer, principal.agentId, questionId);
      if (result.changes === 0) throw new BoardError('CONFLICT', `Question ${questionId} is already answered`);
      this.event(principal, 'answer', `answered: ${answer}`, q.task_id);
      // The asker usually stopped to wait. A handoff is what starts its next run, and its board will show it.
      if (q.task_id && q.from_agent_id !== principal.agentId) {
        this.db
          .prepare('INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, message, action_items) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), q.task_id, principal.agentId, q.from_agent_id, `Answer to your question ("${q.text.replace(/\s+/g, ' ').slice(0, 160)}"): ${answer}`, '[]');
      }
    });
  }

  recordDecision(principal: Principal, input: { taskId?: string; decision: string; rationale?: string }) {
    const id = randomUUID();
    withImmediateTransaction(this.db, () => {
      this.db.prepare('INSERT INTO decisions (id, task_id, agent_id, decision, rationale) VALUES (?, ?, ?, ?, ?)').run(id, input.taskId ?? null, principal.agentId, input.decision, input.rationale ?? null);
      this.event(principal, 'decision', input.decision, input.taskId ?? null);
    });
    return { id };
  }

  /** A note in the timeline by any principal (kind 'decision'): mission steps, and the like. */
  announce(principal: Principal, text: string, taskId: string | null = null): void {
    this.event(principal, 'decision', text, taskId);
  }

  /**
   * A Human control with no board row of its own (pause dispatch, stop a run) still reaches the
   * timeline, as a 'decision' by the Human (P3.3 AC; the events kind CHECK has no 'control').
   */
  recordControl(principal: Principal, text: string, taskId: string | null = null): void {
    if (!principal.isHuman) throw new BoardError('FORBIDDEN', 'Only the Human records controls');
    this.event(principal, 'decision', text, taskId);
  }

  /** Recent events, newest first (the cockpit timeline). */
  events(limit = 200): MeshEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Record<string, string | null>[]).map(toEvent);
  }

  private event(principal: Principal, kind: EventKind, text: string, taskId: string | null): void {
    const id = randomUUID();
    this.db.prepare('INSERT INTO events (id, task_id, agent_id, kind, text) VALUES (?, ?, ?, ?, ?)').run(id, taskId, principal.agentId, kind, text);
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, string | null>;
    this.options.onEvent?.(toEvent(row));
  }

  private taskRow(taskId: string) {
    const row = this.db
      .prepare(
        `SELECT t.id, t.title, t.status, t.assigned_agent_id, t.reviewing_agent_id, t.diff_hash, t.prerequisites, a.platform AS author_platform
           FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id WHERE t.id = ?`,
      )
      .get(taskId) as
      | { id: string; title: string; status: TaskStatus; assigned_agent_id: string | null; reviewing_agent_id: string | null; diff_hash: string | null; prerequisites: string; author_platform: string | null }
      | undefined;
    if (!row) throw new BoardError('NOT_FOUND', `Unknown task ${taskId}`);
    return row;
  }

  private satisfiedPrereqs(prerequisitesJson: string): string[] {
    const ids = JSON.parse(prerequisitesJson) as string[];
    return ids.filter((id) => {
      const r = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string } | undefined;
      return r?.status === 'PASSED' || r?.status === 'COMMITTED';
    });
  }
}

function toEvent(row: Record<string, string | null>): MeshEvent {
  return {
    id: String(row.id),
    taskId: row.task_id ?? null,
    agentId: row.agent_id ?? null,
    kind: row.kind as EventKind,
    text: String(row.text),
    createdAt: String(row.created_at),
  };
}
