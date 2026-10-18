// The live feed as the cockpit keeps it: what the daemon pushes is merged into the entries already held. No Svelte here, so the
// rules can be tested.
import type { ActivityChange, ActivityEntry, LiveRun } from './types';

/** Most entries kept per run in the page: the daemon keeps a few hundred; the page needs what fits on a screen or two. */
export const KEEP = 200;
/** How many of an agent's latest entries its card shows. */
export const CARD_ENTRIES = 6;
/** How many runs' feeds the page holds. Older ones are asked of the daemon when they are opened. */
export const KEEP_RUNS = 30;

/** New entries are added; one with a number already held replaces it (a line of text that grew). Ordered, and bounded. */
export function mergeEntries(existing: readonly ActivityEntry[], incoming: readonly ActivityEntry[], keep = KEEP): ActivityEntry[] {
  const bySeq = new Map<number, ActivityEntry>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return all.length > keep ? all.slice(all.length - keep) : all;
}

export type ActivityState = { live: Record<string, LiveRun>; byRun: Record<string, ActivityEntry[]> };

/** What a message from the daemon does to what the page holds. Returns new objects; the input is not changed. */
export function applyChange(state: ActivityState, change: ActivityChange): ActivityState {
  const entries = mergeEntries(state.byRun[change.runId] ?? [], change.entries);
  const byRun = { ...state.byRun };
  delete byRun[change.runId]; // so the newest run is last in the order of keys
  byRun[change.runId] = entries;
  const live = { ...state.live };
  if (change.running) live[change.agentId] = { runId: change.runId, taskId: change.taskId, entries: entries.slice(-CARD_ENTRIES) };
  else if (live[change.agentId]?.runId === change.runId) delete live[change.agentId]; // a late message about an older run leaves a newer one alone
  // Over the limit: the oldest runs that are not going on any more.
  const going = new Set(Object.values(live).map((l) => l.runId));
  for (const id of Object.keys(byRun)) {
    if (Object.keys(byRun).length <= KEEP_RUNS) break;
    if (!going.has(id) && id !== change.runId) delete byRun[id];
  }
  return { live, byRun };
}
