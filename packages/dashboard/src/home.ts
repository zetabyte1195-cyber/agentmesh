// What the Home screen says, worked out from the daemon's snapshot. No Svelte here, so every sentence and number
// can be tested. The wording is deliberate: plain verbs, sentence case, nothing that needs explaining.
import type { Notice, ScheduleItem } from './types';
import type { UsageTotals } from './api';

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => (n < WORDS.length ? WORDS[n]! : String(n));

export interface HeadlineInput {
  connected: boolean;
  notices: readonly Notice[];
  agents: readonly { status: string; platform: string }[];
  missions: readonly { status: string }[];
}

const ACTIVE = new Set(['PLANNING', 'REVIEWING', 'REVISING', 'PLAN_READY', 'SPLITTING', 'IMPLEMENTING']);

/** The one sentence at the top of Home: what is the state of things, in the words a person would use. */
export function headline(i: HeadlineInput): { text: string; tone: 'attention' | 'calm' | 'idle' | 'offline' } {
  if (!i.connected) return { text: 'Reconnecting to AgentMesh', tone: 'offline' };
  const urgent = i.notices.filter((n) => n.urgent).length;
  if (urgent === 1) return { text: 'One thing needs you', tone: 'attention' };
  if (urgent > 1) return { text: `${count(urgent)} things need you`, tone: 'attention' };
  const workers = i.agents.filter((a) => a.platform !== 'HUMAN');
  if (workers.some((a) => a.status === 'BUSY')) return { text: 'The agents are working', tone: 'calm' };
  if (i.missions.some((m) => ACTIVE.has(m.status))) return { text: 'Waiting for the agents to pick up the next step', tone: 'calm' };
  if (!workers.length) return { text: 'Connect an agent to get started', tone: 'idle' };
  return { text: 'Nothing is running. Describe what you want built', tone: 'idle' };
}

/** A line under the headline: how many agents are working and how many missions are going. */
export function subline(agents: readonly { status: string; platform: string }[], missions: readonly { status: string }[]): string {
  const workers = agents.filter((a) => a.platform !== 'HUMAN');
  const busy = workers.filter((a) => a.status === 'BUSY').length;
  const active = missions.filter((m) => ACTIVE.has(m.status)).length;
  const parts = [workers.length ? `${busy} of ${workers.length} agent${workers.length === 1 ? '' : 's'} working` : 'No agent is connected'];
  parts.push(active ? `${active} mission${active === 1 ? '' : 's'} in progress` : 'no mission in progress');
  return parts.join(', ');
}

export interface Segments {
  total: number;
  done: number;
  working: number;
  review: number;
  todo: number;
}

/** Tasks grouped for the progress bar: merged, being built, being reviewed, not started. */
export function taskSegments(tasks: readonly { status: string }[]): Segments {
  const n = (set: string[]) => tasks.filter((t) => set.includes(t.status)).length;
  return {
    total: tasks.length,
    done: n(['COMMITTED']),
    working: n(['CLAIMED', 'IN_PROGRESS', 'TESTING', 'REJECTED']),
    review: n(['READY_FOR_REVIEW', 'AUDITING', 'PASSED']),
    todo: n(['TODO', 'DRAFT', 'BLOCKED']),
  };
}

/** What has been used so far, across agents. Cost is only the part the tools reported. */
export function spendTotals(byAgent: readonly UsageTotals[]): { costUsd: number | null; tokens: number; cachedTokens: number; unreportedRuns: number; runs: number } {
  let cost = 0;
  let any = false;
  let tokens = 0;
  let cached = 0;
  let unreported = 0;
  let runs = 0;
  for (const u of byAgent) {
    if (u.costUsd !== null) {
      cost += u.costUsd;
      any = true;
    }
    tokens += u.inputTokens + u.outputTokens; // what a mission's token limit counts; cached input is kept apart
    cached += u.cacheReadTokens;
    unreported += u.unreported;
    runs += u.runs;
  }
  return { costUsd: any ? cost : null, tokens, cachedTokens: cached, unreportedRuns: unreported, runs };
}

export const compactNumber = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** The schedule that will run soonest, if any. */
export function nextSchedule(items: readonly ScheduleItem[]): ScheduleItem | null {
  const upcoming = items.filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  return upcoming[0] ?? null;
}

/** "in 3 hours", "tomorrow at 02:00"-style wording is the cockpit's job; this gives the distance in plain units. */
export function distance(fromMs: number, toMs: number): string {
  if (toMs <= fromMs) return 'now';
  const s = Math.round((toMs - fromMs) / 1000);
  if (s < 90) return 'in a minute';
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 36) return `in ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}

/** What each notice offers the person to do, where it lives, and which element to land on. */
export function noticeAction(n: Notice): { label: string; view: 'missions' | 'board'; primary: boolean; focus?: string } {
  const mission = n.missionId ? { focus: `mission-${n.missionId}` } : {};
  if (n.kind === 'plan') return { label: 'Read the plan', view: 'missions', primary: true, ...mission };
  if (n.kind === 'question') return { label: 'Answer', view: 'board', primary: true };
  if (n.kind === 'stuck') return { label: 'See why', view: 'board', primary: false };
  if (n.kind === 'budget') return { label: 'Raise the limit', view: 'missions', primary: true, ...mission };
  return { label: 'Open', view: 'missions', primary: false, ...mission };
}

export interface FirstStep {
  id: 'connect' | 'check' | 'mission';
  text: string;
  done: boolean;
  /** Where the step is done. */
  view: 'setup' | 'missions';
  action: string;
}

/**
 * The first three things to do in a new project, in order. Null once a mission exists: the person has found their
 * way, so it never nags.
 */
export function firstSteps(input: { workers: number; landing: boolean; missions: number }): FirstStep[] | null {
  if (input.missions > 0) return null;
  const steps: FirstStep[] = [
    { id: 'connect', text: 'Connect an agent', done: input.workers > 0, view: 'setup', action: 'Open Setup' },
    { id: 'check', text: 'Say how your project is checked', done: input.landing, view: 'setup', action: 'Open Setup' },
    { id: 'mission', text: 'Describe what you want built', done: false, view: 'missions', action: 'Start a mission' },
  ];
  return steps;
}
