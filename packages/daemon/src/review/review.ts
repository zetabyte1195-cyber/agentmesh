// Review tools executed BY THE DAEMON (P2.7, from live AC-8 run #2): an auditor on any platform can
// read the exact pinned diff and run the project's configured verification without shell access.
// Headless agy refuses commands without exact allow rules (e.g. `git show`), which ended a live audit.
import type { SqliteDatabase } from '../db/index.js';
import { taskDiff } from '../git/diff.js';
import type { Principal } from '../identity/index.js';
import { changedPathsBetween } from '../leases/index.js';
import { type CheckRunner, hostCheck } from './check.js';

export const MAX_DIFF_CHARS = 200_000;
const OUTPUT_TAIL_CHARS = 6_000;
const REVIEWABLE = new Set(['READY_FOR_REVIEW', 'AUDITING']);
const WORKING = new Set(['CLAIMED', 'IN_PROGRESS', 'TESTING']);

export class ReviewError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'NOT_REVIEWABLE' | 'NO_VERIFY_COMMAND' | 'BUSY',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

interface TaskRow {
  id: string;
  status: string;
  worktree_path: string | null;
  base_commit: string | null;
  head_commit: string | null;
  diff_hash: string | null;
}

export interface ReviewServiceOptions {
  db: SqliteDatabase;
  /** From .agentmesh/config.json, set by the Human. Never agent-supplied. A function so the Human can change it while running. */
  verifyCommand: string | null | (() => string | null);
  /** Runs the check. Default: on this computer. Container mode can supply one that runs it in the container. */
  runCheck?: CheckRunner;
  verifyTimeoutMs?: number;
}

export class ReviewService {
  private readonly verifying = new Set<string>();

  constructor(private readonly options: ReviewServiceOptions) {}

  /** The exact diff pinned at submission: what mesh_submit_audit's diffHash refers to. */
  async getDiff(_principal: Principal, taskId: string) {
    const t = this.reviewable(taskId);
    const [diff, paths] = await Promise.all([taskDiff(t.worktree_path!, t.base_commit!, t.head_commit!), changedPathsBetween(t.worktree_path!, t.base_commit!, t.head_commit!)]);
    return {
      taskId,
      diffHash: t.diff_hash,
      baseCommit: t.base_commit,
      headCommit: t.head_commit,
      changedPaths: paths,
      truncated: diff.length > MAX_DIFF_CHARS,
      diff: diff.slice(0, MAX_DIFF_CHARS),
    };
  }

  /** Run the project's configured verification in the task worktree (one run per task at a time). */
  async runVerification(principal: Principal, taskId: string) {
    const t = this.verifiable(principal, taskId);
    const command = typeof this.options.verifyCommand === 'function' ? this.options.verifyCommand() : this.options.verifyCommand;
    if (!command) throw new ReviewError('NO_VERIFY_COMMAND', 'No verifyCommand is configured in .agentmesh/config.json; ask the Human.');
    if (this.verifying.has(taskId)) throw new ReviewError('BUSY', `Verification for ${taskId} is already running`);
    this.verifying.add(taskId);
    const started = Date.now();
    try {
      const { stdout, stderr } = await (this.options.runCheck ?? hostCheck)(command, { cwd: t.worktree_path!, timeoutMs: this.options.verifyTimeoutMs ?? 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      return { taskId, command, ok: true, exitCode: 0, durationMs: Date.now() - started, output: tail(`${stdout}${stderr}`) };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message: string };
      return {
        taskId,
        command,
        ok: false,
        exitCode: typeof e.code === 'number' ? e.code : null,
        timedOut: Boolean(e.killed),
        durationMs: Date.now() - started,
        output: tail(`${e.stdout ?? ''}${e.stderr ?? ''}` || e.message),
      };
    } finally {
      this.verifying.delete(taskId);
    }
  }

  /**
   * Reviewers check submitted tasks; the AUTHOR may also run the same checks on its own task while it works, so
   * an agent with no shell access (headless Antigravity) can still test before submitting.
   */
  private verifiable(principal: Principal, taskId: string): TaskRow {
    const t = this.options.db
      .prepare('SELECT id, status, assigned_agent_id, worktree_path, base_commit, head_commit, diff_hash FROM tasks WHERE id = ?')
      .get(taskId) as (TaskRow & { assigned_agent_id: string | null }) | undefined;
    if (!t) throw new ReviewError('NOT_FOUND', `Unknown task ${taskId}`);
    if (t.assigned_agent_id === principal.agentId && WORKING.has(t.status) && t.worktree_path) return t;
    return this.reviewable(taskId);
  }

  private reviewable(taskId: string): TaskRow {
    const t = this.options.db
      .prepare('SELECT id, status, worktree_path, base_commit, head_commit, diff_hash FROM tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined;
    if (!t) throw new ReviewError('NOT_FOUND', `Unknown task ${taskId}`);
    if (!REVIEWABLE.has(t.status) || !t.worktree_path || !t.base_commit || !t.head_commit) {
      throw new ReviewError('NOT_REVIEWABLE', `Task ${taskId} is ${t.status}; only a submitted task (READY_FOR_REVIEW/AUDITING) can be reviewed`);
    }
    return t;
  }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}
