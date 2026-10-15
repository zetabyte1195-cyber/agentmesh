// Task 7: schedules, against a real MissionService. Time is injected; the zone is pinned (see cron.test.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.TZ = 'America/New_York';

import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { MISSION_MIGRATION, MissionService } from '../missions/index.js';
import { SCHEDULE_MIGRATION } from './migration.js';
import { MAX_SCHEDULES, ScheduleError, ScheduleService, type ScheduleInput } from './service.js';

let dir: string;
let db: SqliteDatabase;
let missions: MissionService;
let board: BoardService;
let human: Principal;
let claude: Principal;
let gemini: Principal;
let clock: Date;
let connected: string[];
let paused: boolean;
let announced: string[];

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
const BRIEF = 'Check the project for outdated dependencies and write a short report of what to update first.';

function service(): ScheduleService {
  return new ScheduleService({
    db,
    // Only create and get: the service cannot approve, cancel or change a mission.
    missions: { create: (p, i) => missions.create(p, i), get: (id) => missions.get(id) },
    board: { announce: (_p, text) => announced.push(text) },
    connectedAgents: () => connected,
    isPaused: () => paused,
    now: () => clock,
  });
}
let svc: ScheduleService;

const daily = (name = 'Nightly check', time = '02:00', extra: Partial<ScheduleInput> = {}): ScheduleInput => ({ name, brief: BRIEF, plannerAgentId: 'claude-1', trigger: { kind: 'daily', time }, ...extra });
const missionCount = () => (db.prepare('SELECT count(*) AS n FROM missions').get() as { n: number }).n;
const runs = (id = 'S1') => db.prepare('SELECT trigger, outcome, repeat, mission_id AS missionId FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at, rowid').all(id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-sched-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, SCHEDULE_MIGRATION]);
  const ids = new IdentityService(db);
  human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  const late: { m?: MissionService } = {};
  board = new BoardService({ db, worktrees: {} as never, taskGuard: (p, i) => late.m?.guardTask(p, i) });
  missions = new MissionService({ db, board });
  late.m = missions;
  clock = at(2026, 10, 14, 12, 0);
  connected = ['claude-1', 'gemini-1'];
  paused = false;
  announced = [];
  svc = service();
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('creating schedules', () => {
  it('stores every kind of trigger and describes it in plain words, with the next time', () => {
    expect(svc.create(daily()).when).toBe('every day at 02:00');
    expect(svc.create({ ...daily('Weekly'), trigger: { kind: 'weekly', weekday: 1, time: '09:30' } }).when).toBe('every Monday at 09:30');
    expect(svc.create({ ...daily('Cron'), trigger: { kind: 'cron', cron: '0 6 * * 1-5' } }).when).toBe('cron: 0 6 * * 1-5');
    expect(svc.create({ ...daily('Hours'), trigger: { kind: 'every_hours', hours: 6 } }).when).toBe('every 6 hours');
    expect(svc.create({ ...daily('After'), trigger: { kind: 'mission_done', watch: 'any' } }).when).toBe('when any mission finishes');
    const [first] = svc.list();
    expect(first).toMatchObject({ id: 'S1', enabled: true, plannerConnected: true, reviewerAgentIds: ['gemini-1'], nextRunAt: at(2026, 10, 15, 2, 0).toISOString(), briefPreview: expect.stringContaining('outdated dependencies') });
  });

  it('refuses what cannot work, in plain words', () => {
    const bad = (input: ScheduleInput, message: RegExp) => expect(() => svc.create(input), message.source).toThrow(message);
    bad(daily(' '), /name of up to 120/);
    bad({ ...daily(), name: 'x'.repeat(121) }, /name of up to 120/);
    bad({ ...daily(), brief: 'short' }, /between 10 and 20000/);
    bad({ ...daily(), brief: 'y'.repeat(20_001) }, /between 10 and 20000/);
    bad({ ...daily(), plannerAgentId: 'nobody-1' }, /not a connected agent/);
    bad({ ...daily(), reviewerAgentIds: ['claude-1'] }, /cannot also review/);
    bad({ ...daily(), reviewerAgentIds: ['ghost'] }, /not a connected agent/);
    bad({ ...daily(), maxRounds: 11 }, /1 to 10/);
    bad({ ...daily(), trigger: { kind: 'cron', cron: '0 0 30 2 *' } }, /never matches a real date/);
    bad({ ...daily(), trigger: { kind: 'cron', cron: 'every day' } }, /exactly 5 fields/);
    bad({ ...daily(), trigger: { kind: 'daily', time: '25:00' } }, /24-hour/);
    bad({ ...daily(), trigger: { kind: 'every_hours', hours: 0 } }, /1 to 168/);
    bad({ ...daily(), trigger: { kind: 'every_hours', hours: 200 } }, /1 to 168/);
    bad({ ...daily(), trigger: { kind: 'mission_done', watch: 'S9' } }, /no schedule S9/);
  });

  it(`keeps at most ${MAX_SCHEDULES}`, () => {
    for (let i = 0; i < MAX_SCHEDULES; i++) svc.create(daily(`s${i}`));
    expect(() => svc.create(daily('one more'))).toThrow(/up to 20 schedules/);
  });
});

describe('firing', () => {
  it('starts one mission at the slot, and not again on the next tick; the mission stops at the plan for the Human', () => {
    svc.create(daily());
    clock = at(2026, 10, 15, 1, 59, 30);
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 15, 2, 0, 20);
    expect(svc.tick()).toBe(1);
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 15, 2, 0, 50);
    expect(svc.tick()).toBe(0);
    expect(missionCount()).toBe(1);
    const m = missions.get('M1');
    expect(m).toMatchObject({ status: 'PLANNING', planner: 'claude-1', reviewers: ['gemini-1'], title: 'Nightly check · 2026-10-15 02:00' });
    expect(runs()).toEqual([{ trigger: 'slot', outcome: 'started', repeat: 1, missionId: 'M1' }]);
    expect(announced.join('\n')).toContain('stops at the plan and waits for your approval');

    // the agents do their part; the mission then waits for the Human and builds nothing
    missions.submitPlan(claude, 'M1', '# Plan\n\nGoal: a short report.\n\n1. List outdated packages.');
    missions.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    expect(missions.get('M1')).toMatchObject({ status: 'PLAN_READY', waitingOn: ['human'], tasks: [] });
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });

  it('a schedule is only ever given create and get', () => {
    const proxy = new Proxy({}, { get: (_t, name) => { throw new Error(`a schedule touched missions.${String(name)}`); } }) as never;
    const only = new ScheduleService({ db, missions: proxy, board: { announce: () => {} }, connectedAgents: () => connected, isPaused: () => false, now: () => clock });
    expect(() => only.list()).not.toThrow(); // reading its own tables needs no mission at all
    expect(Object.keys(service() as object)).not.toContain('approve');
    expect((service() as unknown as Record<string, unknown>).approve).toBeUndefined();
  });

  it('never overlaps: while the last mission is open the slot is skipped, and identical skips are folded into one row', () => {
    svc.create(daily());
    clock = at(2026, 10, 15, 2, 0, 5);
    svc.tick();
    for (const day of [16, 17, 18]) {
      clock = at(2026, 10, day, 2, 0, 5);
      expect(svc.tick()).toBe(0);
    }
    expect(missionCount()).toBe(1);
    expect(runs()).toEqual([
      { trigger: 'slot', outcome: 'started', repeat: 1, missionId: 'M1' },
      { trigger: 'slot', outcome: 'skipped:overlap', repeat: 3, missionId: null },
    ]);
    expect(svc.list()[0]!.lastRun).toMatchObject({ outcome: 'skipped:overlap', detail: 'M1 is still planning.', repeat: 3 });
    // once the mission is finished or cancelled, the next slot starts a new one
    missions.cancel(human, 'M1');
    clock = at(2026, 10, 19, 2, 0, 5);
    expect(svc.tick()).toBe(1);
    expect(missionCount()).toBe(2);
  });

  it('says a plan waiting for approval is waiting for approval', () => {
    svc.create(daily());
    clock = at(2026, 10, 15, 2, 0, 5);
    svc.tick();
    missions.submitPlan(claude, 'M1', '# Plan\n\nGoal: a short dependency report.\n\n1. List the outdated packages.');
    missions.submitReview(gemini, 'M1', { planVersion: 1, verdict: 'OK' });
    clock = at(2026, 10, 16, 2, 0, 5);
    svc.tick();
    expect(svc.list()[0]!.lastRun!.detail).toBe('M1 is still waiting for your approval.');
  });

  it('a slot missed while off fires once, late, and an hourly schedule off for 20 hours gives one mission, not twenty', () => {
    svc.create({ ...daily('Hourly'), trigger: { kind: 'cron', cron: '0 * * * *' } });
    clock = at(2026, 10, 15, 8, 30);
    expect(svc.tick()).toBe(1);
    expect(runs()).toEqual([{ trigger: 'late', outcome: 'started', repeat: 1, missionId: 'M1' }]);
    expect(missionCount()).toBe(1);
  });

  it('drops a slot more than a day old and says so, and a new service on the same database does not fire it', () => {
    svc.create({ ...daily('Weekly'), trigger: { kind: 'weekly', weekday: 1, time: '09:00' } }); // created Wed 14 Oct
    clock = at(2026, 10, 19, 9, 0); // Mon 19
    clock = at(2026, 10, 22, 12, 0); // Thu 22: the Monday slot is 3 days old
    expect(svc.tick()).toBe(0);
    expect(runs()).toEqual([{ trigger: 'late', outcome: 'skipped:missed_over_24h', repeat: 1, missionId: null }]);
    expect(service().tick()).toBe(0); // a restart: the cursor already passed it
    expect(missionCount()).toBe(0);
  });

  it('"every N hours" never fires at creation, then fires after N hours', () => {
    svc.create({ ...daily('Hours'), trigger: { kind: 'every_hours', hours: 6 } });
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 14, 17, 59);
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 14, 18, 0, 10);
    expect(svc.tick()).toBe(1);
  });
});

describe('switching on and off, editing, running now', () => {
  it('a disabled schedule does not fire; switching it on starts the clock now, with no catch-up', () => {
    svc.create(daily());
    svc.setEnabled('S1', false);
    clock = at(2026, 10, 15, 2, 0, 5);
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 16, 3, 0);
    svc.setEnabled('S1', true); // the 15th's and 16th's slots passed while off
    expect(svc.tick()).toBe(0);
    expect(missionCount()).toBe(0);
    clock = at(2026, 10, 17, 2, 0, 5);
    expect(svc.tick()).toBe(1);
  });

  it('Run now works on a switched-off schedule, obeys the overlap rule, and does not move the timer', () => {
    svc.create(daily());
    svc.setEnabled('S1', false);
    expect(svc.runNow('S1')).toMatchObject({ trigger: 'manual', outcome: 'started', missionId: 'M1' });
    expect(svc.runNow('S1')).toMatchObject({ trigger: 'manual', outcome: 'skipped:overlap' });
    expect(missionCount()).toBe(1);
    svc.setEnabled('S1', true);
    clock = at(2026, 10, 15, 2, 0, 5); // the slot comes, but M1 (started by Run now) is still open
    svc.tick();
    expect(svc.list()[0]!.lastRun).toMatchObject({ trigger: 'slot', outcome: 'skipped:overlap' });
  });

  it('editing restarts the timer from now (no catch-up for the time before the change)', () => {
    svc.create(daily('A', '02:00'));
    clock = at(2026, 10, 15, 3, 0); // the 02:00 slot passed
    svc.update('S1', daily('A', '04:00'));
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 15, 4, 0, 5);
    expect(svc.tick()).toBe(1);
  });

  it('while dispatching is paused nothing starts; a slot under a day old fires when it resumes', () => {
    svc.create(daily());
    paused = true;
    clock = at(2026, 10, 15, 2, 0, 5);
    expect(svc.tick()).toBe(0);
    clock = at(2026, 10, 15, 9, 0);
    paused = false;
    expect(svc.tick()).toBe(1);
    expect(runs()[0]).toMatchObject({ trigger: 'late', outcome: 'started' });
  });

  it('refuses unknown ids, and deleting a schedule another one watches', () => {
    expect(() => svc.runNow('S9')).toThrow(/no schedule S9/);
    svc.create(daily());
    svc.create({ ...daily('After'), trigger: { kind: 'mission_done', watch: 'S1' } });
    expect(() => svc.remove('S1')).toThrow(/S2 watches this schedule/);
    svc.remove('S2');
    svc.remove('S1');
    expect(svc.list()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM schedule_runs').get()).toEqual({ n: 0 });
  });
});

describe('"when a mission finishes"', () => {
  const finish = (id: string) => db.prepare("UPDATE missions SET status = 'DONE', updated_at = ? WHERE id = ?").run(sqlTime(clock), id);

  it('starts one follow-up per finished mission, once, even across a restart', () => {
    svc.create({ ...daily('After'), trigger: { kind: 'mission_done', watch: 'any' } });
    clock = at(2026, 10, 14, 13, 0);
    missions.create(human, { title: 'Build it', brief: BRIEF, plannerAgentId: 'claude-1' });
    expect(svc.tick()).toBe(0); // not finished yet
    finish('M1');
    expect(svc.tick()).toBe(1);
    expect(service().tick()).toBe(0);
    expect(svc.tick()).toBe(0);
    expect(runs()).toEqual([{ trigger: 'event', outcome: 'started', repeat: 1, missionId: 'M2' }]);
  });

  it('is not started by a cancelled mission, an old one, or one that an event itself started (no chains, no loops)', () => {
    svc.create({ ...daily('After'), trigger: { kind: 'mission_done', watch: 'any' } });
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, updated_at) VALUES ('M9', 'Old', ?, 'DONE', 'claude-1', '2020-01-01 00:00:00')").run(BRIEF);
    db.prepare("INSERT INTO missions (id, title, brief, status, planner_agent_id, updated_at) VALUES ('M8', 'Cancelled', ?, 'CANCELLED', 'claude-1', ?)").run(BRIEF, sqlTime(clock));
    clock = at(2026, 10, 14, 13, 0);
    expect(svc.tick()).toBe(0);
    missions.create(human, { title: 'Real', brief: BRIEF, plannerAgentId: 'claude-1' });
    finish('M10');
    expect(svc.tick()).toBe(1); // started M11
    finish('M11'); // the follow-up finishes too
    clock = at(2026, 10, 14, 13, 5);
    expect(svc.tick()).toBe(0); // it must not trigger yet another
    expect(missionCount()).toBe(4);
  });

  it('several finishing during downtime give one follow-up, the rest recorded as skipped (no backlog)', () => {
    svc.create({ ...daily('After'), trigger: { kind: 'mission_done', watch: 'any' } });
    clock = at(2026, 10, 14, 13, 0);
    for (const t of ['A', 'B', 'C']) missions.create(human, { title: t, brief: BRIEF, plannerAgentId: 'claude-1' });
    for (const id of ['M1', 'M2', 'M3']) finish(id);
    expect(svc.tick()).toBe(1);
    expect(runs()).toEqual([
      { trigger: 'event', outcome: 'started', repeat: 1, missionId: 'M4' },
      { trigger: 'event', outcome: 'skipped:overlap', repeat: 1, missionId: null },
      { trigger: 'event', outcome: 'skipped:overlap', repeat: 1, missionId: null },
    ]);
  });

  it('can watch just one schedule\'s missions', () => {
    svc.create(daily('Nightly')); // S1
    svc.create({ ...daily('After nightly'), trigger: { kind: 'mission_done', watch: 'S1' } }); // S2
    clock = at(2026, 10, 14, 13, 0);
    missions.create(human, { title: 'Other', brief: BRIEF, plannerAgentId: 'claude-1' }); // M1, not from S1
    finish('M1');
    expect(svc.tick()).toBe(0);
    svc.runNow('S1'); // M2 from S1
    finish('M2');
    expect(svc.tick()).toBe(1);
  });
});

describe('when agents go away', () => {
  it('a removed planner fails the slot with a clear reason, and the third failure in a row switches it off', () => {
    svc.create(daily());
    connected = ['gemini-1'];
    for (const day of [15, 16, 17]) {
      clock = at(2026, 10, day, 2, 0, 5);
      svc.tick();
    }
    expect(missionCount()).toBe(0);
    const s = svc.list()[0]!;
    expect(s).toMatchObject({ enabled: false, plannerConnected: false });
    expect(s.disabledReason).toMatch(/Switched off after 3 failures in a row: claude-1 is not connected any more/);
    expect(runs().map((r) => (r as { outcome: string }).outcome)).toEqual(['failed:planner_unavailable', 'failed:planner_unavailable', 'failed:planner_unavailable']);
    expect(announced.filter((a) => a.includes('switched off'))).toHaveLength(1);
    svc.setEnabled('S1', true);
    expect(svc.list()[0]).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('starts with the reviewers that are left and says which are missing; with none left it fails rather than skip cross-review', () => {
    connected = ['claude-1', 'gemini-1', 'codex-1'];
    db.prepare("INSERT INTO agents (id, name, platform, paradigm) VALUES ('codex-1', 'Codex', 'CODEX', 'CLI')").run();
    svc.create(daily('Two reviewers', '02:00', { reviewerAgentIds: ['gemini-1', 'codex-1'] }));
    connected = ['claude-1', 'gemini-1'];
    clock = at(2026, 10, 15, 2, 0, 5);
    svc.tick();
    expect(missions.get('M1').reviewers).toEqual(['gemini-1']);
    expect(svc.list()[0]!.lastRun!.detail).toBe('Started without codex-1 (not connected).');
    missions.cancel(human, 'M1');
    connected = ['claude-1'];
    clock = at(2026, 10, 16, 2, 0, 5);
    svc.tick();
    expect(svc.list()[0]!.lastRun).toMatchObject({ outcome: 'failed:reviewers_unavailable' });
    expect(missionCount()).toBe(1);
  });
});

describe('storage', () => {
  it('keeps a bounded history, and the database refuses an outcome it does not know', () => {
    svc.create({ ...daily('Often'), trigger: { kind: 'cron', cron: '* * * * *' } });
    for (let i = 1; i <= 230; i++) {
      clock = new Date(clock.getTime() + 60_000);
      svc.tick();
    }
    expect((db.prepare('SELECT count(*) AS n FROM schedule_runs').get() as { n: number }).n).toBeLessThanOrEqual(200);
    expect(() => db.prepare("INSERT INTO schedule_runs (id, schedule_id, trigger, outcome) VALUES ('x', 'S1', 'slot', 'weird')").run()).toThrow(/CHECK/);
  });

  it('the migration can run twice without harm', () => {
    expect(() => migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, SCHEDULE_MIGRATION])).not.toThrow();
    expect(ScheduleError).toBeDefined();
  });
});
