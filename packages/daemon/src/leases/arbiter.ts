// Path lease arbiter (P1.5, spec v1.1 §8.2). Leases stop two tasks from editing the same
// files, expire on their own if an agent dies (TTL), and are checked again when work is
// submitted, because an agent can always write files it never leased.
import { randomUUID } from 'node:crypto';
import type { LeaseResourceType } from '@agentmesh/core';
import type { SqliteDatabase } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import type { Principal } from '../identity/index.js';
import { type LeaseTarget, comparisonKey, covers, normalizeLeasePath, overlaps } from './paths.js';

export const DEFAULT_LEASE_TTL_SECONDS = 120;
/** Runners renew at this interval, well inside the TTL (spec v1.1 §8.2). */
export const LEASE_HEARTBEAT_SECONDS = 30;

/** Task states in which the author may hold and take leases. */
const WORKING_STATES = new Set(['CLAIMED', 'IN_PROGRESS', 'TESTING']);

export interface Lease {
  id: string;
  taskId: string;
  agentId: string;
  type: LeaseResourceType;
  path: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface LeaseConflict {
  requested: LeaseTarget;
  heldBy: { agentId: string; taskId: string; type: LeaseResourceType; path: string; expiresAt: string };
}

export class LeaseConflictError extends Error {
  constructor(readonly conflicts: LeaseConflict[]) {
    const first = conflicts[0];
    super(
      `Lease conflict: ${first?.requested.type} ${first?.requested.path} overlaps ${first?.heldBy.type} ${first?.heldBy.path} ` +
        `held by ${first?.heldBy.agentId} for task ${first?.heldBy.taskId}` +
        (conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : ''),
    );
    this.name = 'LeaseConflictError';
  }
}

export class UncoveredPathsError extends Error {
  constructor(
    readonly taskId: string,
    readonly paths: string[],
  ) {
    super(`Task ${taskId} changed ${paths.length} path(s) without an active lease: ${paths.slice(0, 5).join(', ')}`);
    this.name = 'UncoveredPathsError';
  }
}

interface LeaseRow {
  id: string;
  task_id: string;
  agent_id: string;
  resource_type: LeaseResourceType;
  resource_path: string;
  acquired_at: string;
  expires_at: string;
}

export interface LeaseArbiterOptions {
  ttlSeconds?: number;
  /** Compare paths case-insensitively. Default: true on Windows. */
  caseInsensitive?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** SQLite's CURRENT_TIMESTAMP format (UTC), so stored values sort and compare as strings. */
function sqlTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export class LeaseArbiter {
  private readonly ttlSeconds: number;
  private readonly caseInsensitive: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly db: SqliteDatabase,
    options: LeaseArbiterOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    this.caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Acquire leases for a task, all or nothing. Only the task's assigned author may do this,
   * and only while the task is being worked on. Overlaps with another task's active lease
   * fail with LeaseConflictError naming the holder; the task's own leases never conflict.
   */
  acquire(principal: Principal, taskId: string, targets: readonly LeaseTarget[], ttlSeconds = this.ttlSeconds): Lease[] {
    const requested = targets.map((t) => ({ type: t.type, path: normalizeLeasePath(t.path) }));
    if (!requested.length) throw new Error('No lease targets given');
    return withImmediateTransaction(this.db, () => {
      this.assertAuthorWorking(principal, taskId);
      const nowSql = sqlTime(this.now());
      this.expireStale(nowSql);
      const others = (this.db
        .prepare("SELECT * FROM leases WHERE status = 'ACTIVE' AND task_id != ?")
        .all(taskId) as LeaseRow[]);
      const conflicts: LeaseConflict[] = [];
      for (const req of requested) {
        for (const held of others) {
          if (overlaps(this.key(req), this.key({ type: held.resource_type, path: held.resource_path }))) {
            conflicts.push({
              requested: req,
              heldBy: { agentId: held.agent_id, taskId: held.task_id, type: held.resource_type, path: held.resource_path, expiresAt: held.expires_at },
            });
          }
        }
      }
      if (conflicts.length) throw new LeaseConflictError(conflicts);

      const expiresAt = sqlTime(new Date(this.now().getTime() + ttlSeconds * 1000));
      const insert = this.db.prepare(
        `INSERT INTO leases (id, task_id, agent_id, resource_type, resource_path, acquired_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      );
      return requested.map((req) => {
        const lease: Lease = { id: randomUUID(), taskId, agentId: principal.agentId, type: req.type, path: req.path, acquiredAt: nowSql, expiresAt };
        insert.run(lease.id, taskId, lease.agentId, lease.type, lease.path, nowSql, expiresAt);
        return lease;
      });
    });
  }

  /** Heartbeat: extend the caller's still-active leases. Expired leases can't be revived; re-acquire instead. */
  renew(principal: Principal, leaseIds: readonly string[], ttlSeconds = this.ttlSeconds): number {
    return withImmediateTransaction(this.db, () => {
      const nowSql = sqlTime(this.now());
      this.expireStale(nowSql);
      const expiresAt = sqlTime(new Date(this.now().getTime() + ttlSeconds * 1000));
      const stmt = this.db.prepare("UPDATE leases SET expires_at = ? WHERE id = ? AND agent_id = ? AND status = 'ACTIVE'");
      return leaseIds.reduce((n, id) => n + stmt.run(expiresAt, id, principal.agentId).changes, 0);
    });
  }

  /** Release the caller's own leases. */
  release(principal: Principal, leaseIds: readonly string[]): number {
    const stmt = this.db.prepare(
      "UPDATE leases SET status = 'RELEASED', released_at = ? WHERE id = ? AND agent_id = ? AND status = 'ACTIVE'",
    );
    const nowSql = sqlTime(this.now());
    return withImmediateTransaction(this.db, () => leaseIds.reduce((n, id) => n + stmt.run(nowSql, id, principal.agentId).changes, 0));
  }

  /** Daemon-internal: release everything a task holds (landed, abandoned, reassigned). */
  releaseAllForTask(taskId: string): number {
    return this.db
      .prepare("UPDATE leases SET status = 'RELEASED', released_at = ? WHERE task_id = ? AND status = 'ACTIVE'")
      .run(sqlTime(this.now()), taskId).changes;
  }

  /** Mark leases past their expiry as EXPIRED. Called on every acquire/renew and by a periodic sweep. */
  sweepExpired(): number {
    return withImmediateTransaction(this.db, () => this.expireStale(sqlTime(this.now())));
  }

  activeLeases(taskId?: string): Lease[] {
    const nowSql = sqlTime(this.now());
    const rows = (taskId
      ? this.db.prepare("SELECT * FROM leases WHERE status = 'ACTIVE' AND expires_at > ? AND task_id = ?").all(nowSql, taskId)
      : this.db.prepare("SELECT * FROM leases WHERE status = 'ACTIVE' AND expires_at > ?").all(nowSql)) as LeaseRow[];
    return rows.map((r) => ({
      id: r.id, taskId: r.task_id, agentId: r.agent_id, type: r.resource_type, path: r.resource_path, acquiredAt: r.acquired_at, expiresAt: r.expires_at,
    }));
  }

  /**
   * Submission-time enforcement (spec v1.1 §8.2): every changed path must be covered by an
   * unexpired lease this author holds for this task. Returns normally or throws UncoveredPathsError.
   */
  assertSubmissionCovered(principal: Principal, taskId: string, changedPaths: readonly string[]): void {
    const mine = this.activeLeases(taskId).filter((l) => l.agentId === principal.agentId).map((l) => this.key(l));
    const uncovered = changedPaths
      .map(normalizeLeasePath)
      .filter((p) => !mine.some((lease) => covers(lease, comparisonKey(p, this.caseInsensitive))));
    if (uncovered.length) throw new UncoveredPathsError(taskId, uncovered);
  }

  private key(target: LeaseTarget): LeaseTarget {
    return { type: target.type, path: comparisonKey(target.path, this.caseInsensitive) };
  }

  private expireStale(nowSql: string): number {
    return this.db.prepare("UPDATE leases SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?").run(nowSql).changes;
  }

  private assertAuthorWorking(principal: Principal, taskId: string): void {
    const task = this.db.prepare('SELECT status, assigned_agent_id FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; assigned_agent_id: string | null }
      | undefined;
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (task.assigned_agent_id !== principal.agentId) throw new Error(`Only the task's author may lease paths for ${taskId}`);
    if (!WORKING_STATES.has(task.status)) throw new Error(`Task ${taskId} is ${task.status}; leases can only be taken while it is being worked on`);
  }
}
