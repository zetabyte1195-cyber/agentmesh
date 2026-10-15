// What the Human should know about right now: one list, used by the cockpit (badges, desktop
// notifications, the Home screen) and by the webhook notifier, so they can never disagree.
import type { SqliteDatabase } from '../db/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import type { MissionService } from '../missions/index.js';

export type NoticeKind = 'plan' | 'question' | 'stuck' | 'done';

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
}

/** A finished mission is news for this long. */
export const DONE_NEWS_MS = 3 * 24 * 3600 * 1000;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const sqlDate = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime();

export function collectNotices(deps: { db: SqliteDatabase; missions?: MissionService; dispatcher?: Dispatcher; now?: () => Date }): Notice[] {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const out: Notice[] = [];

  for (const m of deps.missions?.list() ?? []) {
    if (m.status === 'PLAN_READY') {
      out.push({ key: `plan:${m.id}:v${m.plan?.version ?? 0}:r${m.round}`, kind: 'plan', urgent: true, title: `Plan ready: ${m.title}`, text: 'Read it, then approve it, ask for changes, or run another review round. Nothing is built until you approve.', missionId: m.id });
    } else if (m.status === 'DONE' && now - sqlDate(m.updatedAt) < DONE_NEWS_MS) {
      out.push({ key: `done:${m.id}`, kind: 'done', urgent: false, title: `Mission done: ${m.title}`, text: `${m.progress.committed} of ${m.progress.total} tasks were merged into your main branch.`, missionId: m.id });
    }
  }

  const questions = deps.db.prepare("SELECT id, task_id AS taskId, from_agent_id AS agent, text FROM questions WHERE resolved = 0 AND to_role = 'Human' ORDER BY created_at, rowid").all() as {
    id: string;
    taskId: string | null;
    agent: string;
    text: string;
  }[];
  for (const q of questions) {
    out.push({ key: `q:${q.id}`, kind: 'question', urgent: true, title: `${q.agent} has a question${q.taskId ? ` about ${q.taskId}` : ''}`, text: clip(q.text, 300), ...(q.taskId ? { taskId: q.taskId } : {}) });
  }

  for (const s of deps.dispatcher?.stuck() ?? []) {
    const what = s.subject.startsWith('mission:') ? `mission ${s.subject.slice(8)}` : `task ${s.subject}`;
    out.push({ key: `stuck:${s.agentId}:${s.subject}:${s.lastEnded}`, kind: 'stuck', urgent: true, title: `${s.agentId} gave up on ${what}`, text: clip(s.lastDetail ?? `The last run ${s.lastStatus.toLowerCase()}.`, 300) });
  }
  // What needs a decision comes first; good news after it. Within each group the order above is kept.
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}
