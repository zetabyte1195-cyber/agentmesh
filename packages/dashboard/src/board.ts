// The Board's rules: which column a task is in, what it waits for, and how the list is filtered. No Svelte here, so they can be tested.
import type { BoardTask } from './types';

export type Column = { id: string; title: string; hint: string; statuses: string[] };

/** Every stage work moves through, left to right. All of them are always shown, so the board does not rearrange itself. */
export const COLUMNS: Column[] = [
  { id: 'waiting', title: 'Waiting', hint: 'Not started yet', statuses: ['TODO'] },
  { id: 'building', title: 'Being built', hint: 'An agent is working on it', statuses: ['IN_PROGRESS'] },
  { id: 'review', title: 'In review', hint: 'Waiting for another agent, or you, to check it', statuses: ['READY_FOR_REVIEW', 'AUDITING'] },
  { id: 'ready', title: 'Passed', hint: 'Reviewed, waiting to be added to your main branch', statuses: ['PASSED'] },
  { id: 'attention', title: 'Needs attention', hint: 'Sent back or stuck', statuses: ['BLOCKED', 'REJECTED'] },
  { id: 'merged', title: 'Merged', hint: 'On your main branch', statuses: ['COMMITTED'] },
];

const LABEL: Record<string, string> = {
  TODO: 'Waiting',
  IN_PROGRESS: 'Being built',
  READY_FOR_REVIEW: 'Waiting for review',
  AUDITING: 'Being reviewed',
  PASSED: 'Passed review',
  BLOCKED: 'Blocked',
  REJECTED: 'Sent back',
  COMMITTED: 'Merged',
};
export const statusLabel = (status: string): string => LABEL[status] ?? status.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** "M3" for a task of mission M3; null for any other. */
export const missionOf = (t: BoardTask): string | null => (t.phase_id?.startsWith('mission:') ? t.phase_id.slice('mission:'.length) : null);

export function prerequisitesOf(t: BoardTask): string[] {
  try {
    const v: unknown = JSON.parse(t.prerequisites);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The prerequisites that have not landed on the main branch yet (a task builds on them only once they have). */
export function blockedBy(t: BoardTask, all: readonly BoardTask[]): string[] {
  return prerequisitesOf(t).filter((id) => all.find((x) => x.id === id)?.status !== 'COMMITTED');
}

export type Filters = { mission: string; agent: string; text: string; hideMerged: boolean };

export function filterTasks(tasks: readonly BoardTask[], f: Filters): BoardTask[] {
  const text = f.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.mission !== 'all' && missionOf(t) !== f.mission) return false;
    if (f.agent !== 'all' && (t.assigned_agent_id ?? t.suggested_owner) !== f.agent) return false;
    if (f.hideMerged && t.status === 'COMMITTED') return false;
    return !text || t.id.toLowerCase().includes(text) || t.title.toLowerCase().includes(text);
  });
}

/** Every column, with its tasks. A status nobody knows goes under "needs attention" rather than nowhere. */
export function groupTasks(tasks: readonly BoardTask[]): { column: Column; tasks: BoardTask[] }[] {
  const known = new Set(COLUMNS.flatMap((c) => c.statuses));
  return COLUMNS.map((column) => ({
    column,
    tasks: tasks.filter((t) => (column.id === 'attention' ? column.statuses.includes(t.status) || !known.has(t.status) : column.statuses.includes(t.status))),
  }));
}
