// What the Human should know about right now: one list, used by the cockpit (badges, desktop
// notifications, the Home screen) and by the webhook notifier, so they can never disagree.
import type { BudgetService } from '../budget/index.js';
import type { SqliteDatabase } from '../db/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import type { MissionService } from '../missions/index.js';

export type NoticeKind = 'plan' | 'question' | 'stuck' | 'done' | 'budget';

export interface Notice {
  /** Stable for as long as the same thing is waiting; a new thing gets a new key. */
  key: string;
  kind: NoticeKind;
  /** Needs a decision or an answer (as opposed to good news). */
  urgent: boolean;
  title: string;
  text: string;
  missionId?: string;
  taskId?: string;
  /** The question to answer (kind `question`): lets the cockpit answer it in place. */
  questionId?: string;
  /** Who gave up, and on what (kind `stuck`): lets the cockpit offer "Try again" in place. */
  agentId?: string;
  subject?: string;
}

/** A finished mission is news for this long. */
export const DONE_NEWS_MS = 3 * 24 * 3600 * 1000;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const sqlDate = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime();

export function collectNotices(deps: { db: SqliteDatabase; missions?: MissionService; /** The missions, when the caller already has them (reading them is not free). */ missionList?: { id: string; title: string; status: string; updatedAt: string; round: number; plan: { version: number } | null; progress: { total: number; committed: number } }[]; dispatcher?: Dispatcher; budget?: BudgetService; now?: () => Date }): Notice[] {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const out: Notice[] = [];

  const list = deps.missionList ?? deps.missions?.list() ?? [];
  for (const m of list) {
    if (m.status === 'PLAN_READY') {
      out.push({ key: `plan:${m.id}:v${m.plan?.version ?? 0}:r${m.round}`, kind: 'plan', urgent: true, title: `Plan ready: ${m.title}`, text: 'Read it, then approve it, ask for changes, or run another review round. Nothing is built until you approve.', missionId: m.id });
    } else if (m.status === 'DONE' && now - sqlDate(m.updatedAt) < DONE_NEWS_MS) {
      out.push({ key: `done:${m.id}`, kind: 'done', urgent: false, title: `Mission done: ${m.title}`, text: `${m.progress.committed} of ${m.progress.total} tasks were merged into your main branch.`, missionId: m.id });
    }
  }

  // A mission that has used up its limit has stopped: it needs the Human to raise the limit or cancel it. The key holds
  // the limits, so raising the limit and reaching the new one is a new notice, not the old one still showing.
  for (const [missionId, status] of deps.budget?.reached() ?? []) {
    const title = list.find((m) => m.id === missionId)?.title ?? missionId;
    // The key names only the limits that are used up: editing the OTHER limit does not announce the same thing again.
    const key = `budget:${missionId}:${status.reachedLimits.costUsd ?? '-'}:${status.reachedLimits.tokens ?? '-'}`;
    out.push({ key, kind: 'budget', urgent: true, title: `Spending limit reached: ${title}`, text: `${status.reached} No more runs start for it until you raise the limit or cancel it.`, missionId });
  }

  const questions = deps.db.prepare("SELECT id, task_id AS taskId, from_agent_id AS agent, text FROM questions WHERE resolved = 0 AND to_role = 'Human' ORDER BY created_at, rowid").all() as {
    id: string;
    taskId: string | null;
    agent: string;
    text: string;
  }[];
  for (const q of questions) {
    out.push({ key: `q:${q.id}`, kind: 'question', urgent: true, title: `${q.agent} has a question${q.taskId ? ` about ${q.taskId}` : ''}`, text: clip(q.text, 300), questionId: q.id, ...(q.taskId ? { taskId: q.taskId } : {}) });
  }

  for (const s of deps.dispatcher?.stuck() ?? []) {
    const what = s.subject.startsWith('mission:') ? `mission ${s.subject.slice(8)}` : `task ${s.subject}`;
    out.push({ key: `stuck:${s.agentId}:${s.subject}:${s.lastEnded}`, kind: 'stuck', urgent: true, title: `${s.agentId} gave up on ${what}`, text: clip(s.lastDetail ?? `The last run ${s.lastStatus.toLowerCase()}.`, 300), agentId: s.agentId, subject: s.subject });
  }
  // What needs a decision comes first; good news after it. Within each group the order above is kept.
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}
