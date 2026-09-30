// mesh_commit (P3.5): the daemon commits in the task worktree FOR the author. Headless agy only runs
// commands matching an allow rule exactly, so `git commit -m <any message>` can never be allowed:
// without this tool a Gemini run could not author a task at all (found while dogfooding, P3.4).
// Same idea as the P2.7 review tools: agents never need shell git.
import type { SqliteDatabase } from '../db/index.js';
import { git } from '../git/run-git.js';
import type { Principal } from '../identity/index.js';
import type { LeaseArbiter } from '../leases/index.js';

/** Same states the lease arbiter lets an author work in. */
const WORKING_STATES = new Set(['CLAIMED', 'IN_PROGRESS', 'TESTING']);
export const MAX_COMMIT_MESSAGE = 5_000;

export class CommitError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'NOT_WORKING' | 'NOTHING_TO_COMMIT' | 'UNCOVERED_PATHS' | 'INVALID' | 'BUSY',
    message: string,
  ) {
    super(message);
    this.name = 'CommitError';
  }
}

export interface CommitServiceOptions {
  db: SqliteDatabase;
  leases: LeaseArbiter;
}

export class CommitService {
  private readonly committing = new Set<string>();

  constructor(private readonly options: CommitServiceOptions) {}

  /**
   * Stage every change in the author's worktree and commit it. Refuses (leaving the files exactly as
   * they were, only unstaged) if any staged path is outside the author's active leases, the same
   * rule submission enforces, so problems surface at commit time rather than at submission.
   */
  async commit(principal: Principal, taskId: string, message: string): Promise<{ taskId: string; headCommit: string; changedPaths: string[] }> {
    const text = message.trim();
    if (!text) throw new CommitError('INVALID', 'Commit message must not be empty');
    if (text.length > MAX_COMMIT_MESSAGE) throw new CommitError('INVALID', `Commit message is longer than ${MAX_COMMIT_MESSAGE} characters`);

    const task = this.options.db.prepare('SELECT status, assigned_agent_id, worktree_path FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; assigned_agent_id: string | null; worktree_path: string | null }
      | undefined;
    if (!task) throw new CommitError('NOT_FOUND', `Unknown task ${taskId}`);
    if (principal.isHuman || task.assigned_agent_id !== principal.agentId) throw new CommitError('FORBIDDEN', `Only ${taskId}'s assigned author can commit to it`);
    if (!WORKING_STATES.has(task.status)) throw new CommitError('NOT_WORKING', `Task ${taskId} is ${task.status}; commits are only possible while it is being worked on`);
    if (!task.worktree_path) throw new CommitError('NOT_FOUND', `Task ${taskId} has no worktree`);
    if (this.committing.has(taskId)) throw new CommitError('BUSY', `A commit for ${taskId} is already in progress`);

    const wt = task.worktree_path;
    this.committing.add(taskId);
    try {
      await git(wt, ['add', '-A']);
      const staged = (await git(wt, ['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean);
      if (!staged.length) throw new CommitError('NOTHING_TO_COMMIT', 'Nothing to commit: the worktree has no changes');
      try {
        this.options.leases.assertSubmissionCovered(principal, taskId, staged);
      } catch (err) {
        await git(wt, ['reset', '-q']); // unstage only; the working files are untouched
        throw new CommitError('UNCOVERED_PATHS', `${(err as Error).message}. Lease these paths with mesh_acquire_lease, or undo those changes, then commit again.`);
      }
      // No shell: the message is one argv entry, never parsed. The trailer records which agent committed.
      await git(wt, ['commit', '-q', '-m', `${text}\n\nAgentMesh-Agent: ${principal.agentId}`]);
      return { taskId, headCommit: (await git(wt, ['rev-parse', 'HEAD'])).trim(), changedPaths: staged };
    } finally {
      this.committing.delete(taskId);
    }
  }
}
