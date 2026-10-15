// The Runs view: every agent run with what it did and what it cost, newest first.
//
// "Success" from an agent tool only means it finished without an error. A run that ends cleanly but leaves
// its task exactly as it found it is the failure mode that matters most, so the latest run of each agent on
// each task or mission step is checked: did the task (or mission) change while it ran? Older runs are not
// judged: the task has been changed by later events too, so the comparison would prove nothing.
import type { SqliteDatabase } from '../db/index.js';
import { hasUsageTable } from './usage.js';

export type RunOutcome = 'moved' | 'no-change';

export interface RunRow {
  id: string;
  agentId: string;
  kind: string;
  /** A task id, or "mission:<id>". */
  subject: string | null;
  subjectTitle: string | null;
  status: string;
  /** The tool's final answer, or why it failed (the end of it). */
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
  seconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Only for the newest finished run per agent and subject, and only for runs that succeeded. */
  outcome: RunOutcome | null;
}

const JUDGED_KINDS = new Set(['TASK', 'AUDIT', 'PLAN', 'PLAN_REVIEW', 'PLAN_REVISE', 'SPLIT']);
const asMs = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime();

export function recentRuns(db: SqliteDatabase, limit = 60): RunRow[] {
  const usage = hasUsageTable(db);
  const hasMissions = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'missions'").get());
  const rows = db
    .prepare(
      `SELECT r.id, r.agent_id AS agentId, r.kind, r.task_id AS subject, r.task_version AS version, r.status, r.detail, r.started_at AS startedAt, r.ended_at AS endedAt
              ${usage ? ', u.input_tokens AS inputTokens, u.output_tokens AS outputTokens, u.cost_usd AS costUsd' : ''}
         FROM dispatch_runs r ${usage ? 'LEFT JOIN run_usage u ON u.run_id = r.id' : ''}
        ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`,
    )
    .all(limit) as (Omit<RunRow, 'subjectTitle' | 'seconds' | 'outcome' | 'inputTokens' | 'outputTokens' | 'costUsd'> & { version: string | null; inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null })[];

  const title = (subject: string | null): string | null => {
    if (!subject) return null;
    if (subject.startsWith('mission:')) return hasMissions ? ((db.prepare('SELECT title FROM missions WHERE id = ?').get(subject.slice(8)) as { title: string } | undefined)?.title ?? null) : null;
    return (db.prepare('SELECT title FROM tasks WHERE id = ?').get(subject) as { title: string } | undefined)?.title ?? null;
  };
  const versionNow = (subject: string): string | null => {
    const row = subject.startsWith('mission:')
      ? hasMissions
        ? db.prepare('SELECT updated_at FROM missions WHERE id = ?').get(subject.slice(8))
        : undefined
      : db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(subject);
    return (row as { updated_at: string } | undefined)?.updated_at ?? null;
  };

  const judged = new Set<string>();
  return rows.map((r) => {
    let outcome: RunOutcome | null = null;
    const pair = `${r.agentId}|${r.subject}`;
    if (r.status === 'SUCCEEDED' && r.subject && JUDGED_KINDS.has(r.kind) && !judged.has(pair)) {
      const now = versionNow(r.subject);
      if (now !== null && r.version !== null) outcome = now === r.version ? 'no-change' : 'moved';
    }
    if (r.status !== 'RUNNING' && r.subject) judged.add(pair);
    const seconds = r.endedAt ? Math.max(0, Math.round((asMs(r.endedAt) - asMs(r.startedAt)) / 1000)) : null;
    return { id: r.id, agentId: r.agentId, kind: r.kind, subject: r.subject, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, subjectTitle: title(r.subject), detail: r.detail ? r.detail.slice(-600) : null, seconds, inputTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null, costUsd: r.costUsd ?? null, outcome };
  });
}
