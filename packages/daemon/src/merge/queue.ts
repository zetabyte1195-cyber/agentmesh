// Serial merge queue (P1.7; spec v1.1 §8.3; docs/design/merge-queue.md §4). Lands PASSED tasks
// on trunk one at a time: rebase onto local trunk → landed patch must equal the audited patch →
// project verification → fast-forward trunk FROM THE PRIMARY TREE → link-safe cleanup.
// Never checks out trunk in a worktree, never update-refs a checked-out branch, never stashes,
// resets or touches the Human's uncommitted work, never pushes.
import { DAEMON_PRINCIPAL, type TaskStatus, resolveActorRole, validateTaskTransition } from '@agentmesh/core';
import { type SqliteDatabase, withImmediateTransaction } from '../db/index.js';
import { diffHash, patchId } from '../git/diff.js';
import { GitError, git } from '../git/run-git.js';
import type { WorktreeController } from '../git/worktrees.js';
import type { LeaseArbiter } from '../leases/index.js';
import { type CheckRunner, hostCheck } from '../review/check.js';


export type LandingOutcome =
  | 'LANDED' // on trunk, task COMMITTED, worktree and branch removed
  | 'REBASE_CONFLICT' // rebase aborted; task back to IN_PROGRESS for its author
  | 'PATCH_CHANGED' // landed patch would differ from the audited one; task back to READY_FOR_REVIEW
  | 'VERIFY_FAILED' // verification failed after rebase; task back to IN_PROGRESS
  | 'PAUSED' // primary tree not on trunk, or Human's uncommitted changes overlap; task stays PASSED
  | 'IDLE' // nothing to land
  | 'BUSY'; // another landing is in progress

export interface LandingReport {
  taskId: string | null;
  outcome: LandingOutcome;
  detail: string;
}

export interface MergeQueueOptions {
  db: SqliteDatabase;
  /** The primary tree (the Human's checkout, where trunk is checked out). */
  repoRoot: string;
  trunk?: string;
  worktrees: WorktreeController;
  leases?: LeaseArbiter;
  /**
   * Project verification command from config, e.g. "npm test && npm run build". Never agent-supplied.
   * null lands audited work without running checks: only for projects that cannot be tested yet, and
   * only when the Human opted in (landWithoutVerify).
   */
  verifyCommand: string | null | (() => string | null);
  /** Runs the check. Default: on this computer. Container mode can supply one that runs it in the container. */
  runCheck?: CheckRunner;
  verifyTimeoutMs?: number;
  /**
   * True while an agent process still runs for the task (e.g. the auditor exiting after its verdict).
   * The queue waits for such a task at its head: landing rebases and removes the worktree the process
   * may have open (live AC-8 run #3).
   */
  isTaskBusy?: (taskId: string) => boolean;
}

type TaskRow = {
  id: string;
  status: TaskStatus;
  assigned_agent_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  head_commit: string | null;
  diff_hash: string | null;
};

export class MergeQueue {
  private landing = false;
  private readonly trunk: string;

  constructor(private readonly options: MergeQueueOptions) {
    this.trunk = options.trunk ?? 'main';
  }

  /** PASSED tasks in the order they passed (FIFO by their latest PASSED audit). */
  pending(): string[] {
    const rows = this.options.db
      .prepare(
        `SELECT t.id FROM tasks t
           JOIN audits a ON a.task_id = t.id AND a.verdict = 'PASSED' AND a.diff_hash = t.diff_hash
          WHERE t.status = 'PASSED'
          GROUP BY t.id
          ORDER BY MAX(a.created_at), t.id`,
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Land the oldest PASSED task. Serial: a second concurrent call returns BUSY. */
  async processNext(): Promise<LandingReport> {
    if (this.landing) return { taskId: null, outcome: 'BUSY', detail: 'A landing is already in progress' };
    this.landing = true;
    try {
      const taskId = this.pending()[0];
      if (!taskId) return { taskId: null, outcome: 'IDLE', detail: 'No PASSED tasks' };
      // Strict FIFO: never skip ahead of a busy head, or a later task could land before its
      // prerequisite, or push the earlier task into a rebase conflict (Gemini, P2.7 audit).
      if (this.options.isTaskBusy?.(taskId)) return { taskId, outcome: 'BUSY', detail: 'Waiting for the agent run on this task to exit' };
      return await this.land(taskId);
    } finally {
      this.landing = false;
    }
  }

  private async land(taskId: string): Promise<LandingReport> {
    const { repoRoot } = this.options;
    const task = this.task(taskId);
    if (!task.branch_name || !task.worktree_path || !task.base_commit || !task.head_commit) {
      return this.pause(taskId, 'Task is missing branch/worktree/base/head; cannot land');
    }
    const wt = task.worktree_path;

    // The branch must still be exactly what was audited.
    const branchHead = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    if (branchHead !== task.head_commit) {
      return this.backToReview(task, branchHead, `Branch moved after the audit (${task.head_commit.slice(0, 8)} → ${branchHead.slice(0, 8)})`);
    }
    const auditedPatch = await patchId(wt, task.base_commit, task.head_commit);

    // Cheap precondition first: pausing before any rebase leaves the worktree exactly as audited.
    const current = await this.primaryBranch();
    if (current !== this.trunk) return this.pause(taskId, `Primary tree is on "${current || 'detached HEAD'}", not ${this.trunk}; switch back to land`);

    // 1. Rebase onto local trunk (worktrees share refs; no fetch, no remote needed).
    try {
      await git(wt, ['rebase', this.trunk]);
    } catch (err) {
      await git(wt, ['rebase', '--abort']).catch(() => undefined);
      return this.setStatus(taskId, 'IN_PROGRESS', 'REBASE_CONFLICT', `Rebase onto ${this.trunk} failed; author must resolve. ${errText(err)}`);
    }
    const trunkHead = (await git(repoRoot, ['rev-parse', this.trunk])).trim();
    const rebasedHead = (await git(wt, ['rev-parse', 'HEAD'])).trim();

    // 2. The landed patch must equal the audited patch; otherwise a quick range-diff re-review.
    const landedPatch = await patchId(wt, trunkHead, rebasedHead);
    if (landedPatch !== auditedPatch) {
      return this.backToReview({ ...task, base_commit: trunkHead }, rebasedHead, 'Patch changed during rebase (patch-id mismatch); range-diff re-review needed');
    }

    // 3. Project verification in the worktree (skipped only when the Human opted in to landing without one).
    const configured = this.options.verifyCommand;
    const verifyCommand = typeof configured === 'function' ? configured() : configured;
    if (verifyCommand) {
      try {
        await (this.options.runCheck ?? hostCheck)(verifyCommand, { cwd: wt, timeoutMs: this.options.verifyTimeoutMs ?? 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        await this.restoreAudited(wt, task.head_commit);
        return this.setStatus(taskId, 'IN_PROGRESS', 'VERIFY_FAILED', `Verification failed after rebase: ${errText(err).slice(0, 2000)}`);
      }
    }

    // 4. Fast-forward trunk from the primary tree.
    try {
      await git(repoRoot, ['merge', '--ff-only', task.branch_name]);
    } catch (err) {
      await this.restoreAudited(wt, task.head_commit);
      return this.pause(taskId, `Fast-forward refused (your uncommitted changes overlap, or trunk moved): ${errText(err)}`);
    }

    // 5. Record, release, clean up (link-safe removal; branch deleted only because it is merged).
    this.atomically(() => {
      this.options.db.prepare('UPDATE tasks SET head_commit = ?, base_commit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(rebasedHead, trunkHead, taskId);
      this.transition(taskId, 'COMMITTED');
    });
    this.options.leases?.releaseAllForTask(taskId);
    const cleanup = await this.options.worktrees.remove(taskId, { deleteBranch: 'if-merged' }).then(
      () => '',
      (err: unknown) => ` (cleanup needs attention: ${errText(err)})`,
    );
    return { taskId, outcome: 'LANDED', detail: `Landed ${rebasedHead.slice(0, 8)} on ${this.trunk}${cleanup}` };
  }

  /** PASSED → READY_FOR_REVIEW with the new diff pinned, so the old audit can't pass it again. */
  private async backToReview(task: TaskRow, newHead: string, detail: string): Promise<LandingReport> {
    const wt = task.worktree_path ?? this.options.repoRoot;
    const base = task.base_commit ?? this.trunk;
    const newHash = await diffHash(wt, base, newHead);
    // One transaction: a crash between these would leave a PASSED task whose diff_hash no audit matches.
    this.atomically(() => {
      this.options.db.prepare('UPDATE tasks SET head_commit = ?, base_commit = ?, diff_hash = ? WHERE id = ?').run(newHead, base, newHash, task.id);
      this.transition(task.id, 'READY_FOR_REVIEW');
    });
    return { taskId: task.id, outcome: 'PATCH_CHANGED', detail };
  }

  /**
   * Leave the task PASSED and report. Deliberately NOT PASSED → BLOCKED: the state machine only
   * lets BLOCKED return to TODO/DRAFT, which would discard a finished, audited task.
   */
  private pause(taskId: string, detail: string): LandingReport {
    return { taskId, outcome: 'PAUSED', detail };
  }

  private setStatus(taskId: string, to: TaskStatus, outcome: LandingOutcome, detail: string): LandingReport {
    this.transition(taskId, to);
    return { taskId, outcome, detail };
  }

  /** Every queue transition is checked as the daemon against the P1.3 state machine, then the DB triggers. */
  private transition(taskId: string, to: TaskStatus): void {
    const task = this.task(taskId);
    const decision = validateTaskTransition(task, task.status, to, resolveActorRole(task, DAEMON_PRINCIPAL));
    if (!decision.allowed) throw new Error(`Merge queue transition refused: ${decision.reason}`);
    this.options.db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(to, taskId);
  }

  /**
   * Put the TASK WORKTREE (never the primary tree) back on the exact audited commit, so a retry or the
   * author's next submission starts from what was reviewed and leased (Gemini, P1.7 audit findings 1-2).
   * Safe: a PASSED task's worktree holds only its committed, audited work (a dirty tree fails the rebase).
   */
  private async restoreAudited(wt: string, auditedHead: string): Promise<void> {
    await git(wt, ['reset', '--hard', auditedHead]);
  }

  private async primaryBranch(): Promise<string> {
    return (await git(this.options.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  }

  private atomically(fn: () => void): void {
    withImmediateTransaction(this.options.db, fn);
  }

  private task(taskId: string): TaskRow {
    const row = this.options.db
      .prepare('SELECT id, status, assigned_agent_id, branch_name, worktree_path, base_commit, head_commit, diff_hash FROM tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined;
    if (!row) throw new Error(`Unknown task ${taskId}`);
    return row;
  }
}

function errText(err: unknown): string {
  if (err instanceof GitError) return err.stderr.trim();
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(err)).trim();
}
