import { describe, expect, it } from 'vitest';
import { distance, headline, nextSchedule, noticeAction, spendTotals, subline, taskSegments } from './home';
import type { Notice, ScheduleItem } from './types';

const notice = (kind: Notice['kind'], urgent = true): Notice => ({ key: `${kind}-${Math.random()}`, kind, urgent, title: 't', text: 'x' });
const agent = (status: string, platform = 'CLAUDE_CODE') => ({ status, platform });

describe('the headline says what is going on in plain words', () => {
  const base = { connected: true, notices: [] as Notice[], agents: [agent('IDLE')], missions: [] as { status: string }[] };
  it('counts what needs the person, and only what needs a decision', () => {
    expect(headline({ ...base, notices: [notice('plan')] })).toEqual({ text: 'One thing needs you', tone: 'attention' });
    expect(headline({ ...base, notices: [notice('plan'), notice('question')] }).text).toBe('Two things need you');
    expect(headline({ ...base, notices: Array.from({ length: 12 }, () => notice('question')) }).text).toBe('12 things need you');
    expect(headline({ ...base, notices: [notice('done', false)] }).tone).toBe('idle'); // good news is not a request
  });
  it('then says whether agents are working, waiting, missing, or there is simply nothing to do', () => {
    expect(headline({ ...base, agents: [agent('BUSY')] })).toEqual({ text: 'The agents are working', tone: 'calm' });
    expect(headline({ ...base, missions: [{ status: 'IMPLEMENTING' }] }).text).toMatch(/Waiting for the agents/);
    expect(headline({ ...base, agents: [] }).text).toBe('Connect an agent to get started');
    expect(headline(base).text).toBe('Nothing is running. Describe what you want built');
    expect(headline({ ...base, connected: false, notices: [notice('plan')] })).toEqual({ text: 'Reconnecting to AgentMesh', tone: 'offline' });
  });
  it('the line under it counts agents and missions', () => {
    expect(subline([agent('BUSY'), agent('IDLE'), agent('IDLE', 'HUMAN')], [{ status: 'IMPLEMENTING' }, { status: 'DONE' }])).toBe('1 of 2 agents working, 1 mission in progress');
    expect(subline([agent('IDLE')], [])).toBe('0 of 1 agent working, no mission in progress');
  });
});

describe('numbers for the tiles', () => {
  it('groups tasks for the progress bar', () => {
    const s = taskSegments(['COMMITTED', 'COMMITTED', 'IN_PROGRESS', 'REJECTED', 'READY_FOR_REVIEW', 'PASSED', 'TODO', 'BLOCKED'].map((status) => ({ status })));
    expect(s).toEqual({ total: 8, done: 2, working: 2, review: 2, todo: 2 });
    expect(taskSegments([])).toEqual({ total: 0, done: 0, working: 0, review: 0, todo: 0 });
  });
  it('adds up usage, and says nothing about cost that no tool reported', () => {
    const u = (costUsd: number | null, i: number, o: number, unreported = 0, runs = 1, cache = 0) => ({ runs, unreported, inputTokens: i, outputTokens: o, cacheReadTokens: cache, costUsd });
    expect(spendTotals([u(0.5, 100, 20), u(null, 300, 40, 2, 3)])).toEqual({ costUsd: 0.5, tokens: 460, unreportedRuns: 2, runs: 4 });
    expect(spendTotals([u(null, 10, 10)]).costUsd).toBeNull();
    expect(spendTotals([u(1, 100, 20, 0, 1, 500)]).tokens).toBe(620); // cache reads count, as in the per-agent line
    expect(spendTotals([])).toEqual({ costUsd: null, tokens: 0, unreportedRuns: 0, runs: 0 });
  });
  it('finds the schedule that fires next, ignoring those switched off', () => {
    const s = (id: string, nextRunAt: string | null, enabled = true) => ({ id, enabled, nextRunAt }) as ScheduleItem;
    expect(nextSchedule([s('S1', '2026-10-16T02:00:00Z'), s('S2', '2026-10-15T20:00:00Z'), s('S3', '2026-10-15T01:00:00Z', false), s('S4', null)])?.id).toBe('S2');
    expect(nextSchedule([])).toBeNull();
  });
  it('says how far away something is in plain units', () => {
    const t = 1_000_000_000;
    expect(distance(t, t - 5)).toBe('now');
    expect(distance(t, t + 30_000)).toBe('in a minute');
    expect(distance(t, t + 20 * 60_000)).toBe('in 20 minutes');
    expect(distance(t, t + 5 * 3600_000)).toBe('in 5 hours');
    expect(distance(t, t + 3 * 24 * 3600_000)).toBe('in 3 days');
  });
});

describe('what each item offers to do', () => {
  it('names the action by what happens, and points to where it is done', () => {
    expect(noticeAction(notice('plan'))).toEqual({ label: 'Read the plan', view: 'missions', primary: true });
    expect(noticeAction(notice('question'))).toEqual({ label: 'Answer', view: 'board', primary: true });
    expect(noticeAction(notice('stuck'))).toEqual({ label: 'See why', view: 'board', primary: true });
    expect(noticeAction(notice('done', false))).toEqual({ label: 'Open', view: 'missions', primary: false });
  });
});
