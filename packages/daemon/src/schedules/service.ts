// Schedules: start a mission on a timer, or when another mission finishes.
//
// Safety first: the only thing a schedule can do is CREATE an ordinary mission (it is handed only
// `create` and `get`). A mission waits for the Human's approval after its plan, so a schedule can never
// build anything on its own. Other rules:
//   • no overlap: while the mission a schedule started last is still open, the next slot is skipped
//   • no backlog: a slot missed while AgentMesh or the computer was off fires once, late, if it is under
//     24 hours old, and is dropped (and recorded) otherwise
//   • every firing, skipped ones included, is recorded with the reason
//   • three failures in a row (for example the planner agent was removed) switch the schedule off
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import type { Principal } from '../identity/index.js';
import { type CreateMissionInput, MAX_BRIEF, MissionError } from '../missions/service.js';
import { CronError, type Preset, intervalSlot, nextIntervalSlot, nextSlot, parseCron, presetToCron, previousSlot } from './cron.js';

export const MAX_SCHEDULES = 20;
const MAX_RUNS_KEPT = 200;
const LATE_LIMIT_MS = 24 * 3600 * 1000;
const ON_TIME_MS = 2 * 60 * 1000;
const FAILURES_BEFORE_OFF = 3;

const HUMAN: Principal = { agentId: 'human', platform: 'HUMAN', paradigm: 'HUMAN', isHuman: true };

export class ScheduleError extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND' | 'LIMIT' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export type TriggerInput =
  | { kind: 'cron'; cron: string }
  | ({ kind: 'daily' | 'weekly' } & Preset)
  | { kind: 'every_hours'; hours: number }
  | { kind: 'mission_done'; watch: string };

export interface ScheduleInput {
  name: string;
  brief: string;
  plannerAgentId: string;
  reviewerAgentIds?: string[];
  maxRounds?: number;
  trigger: TriggerInput;
}

interface Row {
  id: string;
  name: string;
  enabled: number;
  trigger_kind: 'cron' | 'interval' | 'mission_done';
  cron: string | null;
  preset_label: string | null;
  interval_hours: number | null;
  watch: string | null;
  brief: string;
  planner_agent_id: string;
  reviewer_agent_ids: string;
  max_rounds: number;
  anchor_at: string;
  cursor_at: string;
  last_mission_id: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  trigger: 'slot' | 'late' | 'manual' | 'event';
  slotAt: string | null;
  missionId: string | null;
  outcome: string;
  detail: string | null;
  repeat: number;
  at: string;
}

export interface ScheduleView {
  id: string;
  name: string;
  enabled: boolean;
  /** "every day at 02:00", "cron: 0 2 * * 1-5", "every 6 hours", "when any mission finishes". */
  when: string;
  kind: 'cron' | 'interval' | 'mission_done';
  cron: string | null;
  hours: number | null;
  watch: string | null;
  plannerAgentId: string;
  reviewerAgentIds: string[];
  maxRounds: number;
  plannerConnected: boolean;
  nextRunAt: string | null;
  lastRun: ScheduleRun | null;
  lastMissionId: string | null;
  lastMissionStatus: string | null;
  disabledReason: string | null;
  briefPreview: string;
}

export interface ScheduleServiceOptions {
  db: SqliteDatabase;
  /** Only create and get: a schedule can start a mission, never approve or change one. */
  missions: { create(principal: Principal, input: CreateMissionInput): { id: string }; get(id: string): { status: string } };
  board: { announce(principal: Principal, text: string): void };
  /** The agents the dispatcher can actually run right now. */
  connectedAgents: () => string[];
  /** While dispatching is paused nothing is started; a slot still under 24 hours old fires when it resumes. */
  isPaused: () => boolean;
  now?: () => Date;
}

const sqlDate = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (n: number) => String(n).padStart(2, '0');
const localStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export class ScheduleService {
  constructor(private readonly o: ScheduleServiceOptions) {}

  private get db(): SqliteDatabase {
    return this.o.db;
  }
  private now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  // ── validation ────────────────────────────────────────────────────────────
  private compile(t: TriggerInput): { kind: Row['trigger_kind']; cron: string | null; label: string | null; hours: number | null; watch: string | null } {
    try {
      if (t.kind === 'cron') {
        const spec = parseCron(t.cron);
        return { kind: 'cron', cron: spec.source, label: null, hours: null, watch: null };
      }
      if (t.kind === 'daily' || t.kind === 'weekly') {
        const p = presetToCron(t);
        parseCron(p.cron);
        return { kind: 'cron', cron: p.cron, label: p.label, hours: null, watch: null };
      }
      if (t.kind === 'every_hours') {
        if (!Number.isInteger(t.hours) || t.hours < 1 || t.hours > 168) throw new ScheduleError('INVALID', 'Choose a whole number of hours from 1 to 168.');
        return { kind: 'interval', cron: null, label: null, hours: t.hours, watch: null };
      }
      const watch = t.watch.trim();
      if (watch !== 'any' && !this.db.prepare('SELECT 1 FROM schedules WHERE id = ?').get(watch)) throw new ScheduleError('INVALID', `There is no schedule ${watch} to watch.`);
      return { kind: 'mission_done', cron: null, label: null, hours: null, watch };
    } catch (err) {
      if (err instanceof CronError) throw new ScheduleError('INVALID', err.message);
      throw err;
    }
  }

  private validate(input: ScheduleInput) {
    const name = input.name.trim();
    const brief = input.brief.trim();
    if (!name || name.length > 120) throw new ScheduleError('INVALID', 'Give the schedule a name of up to 120 characters.');
    if (brief.length < 10 || brief.length > MAX_BRIEF) throw new ScheduleError('INVALID', `The brief must be between 10 and ${MAX_BRIEF} characters.`);
    const connected = this.o.connectedAgents();
    if (!connected.includes(input.plannerAgentId)) throw new ScheduleError('INVALID', `${input.plannerAgentId} is not a connected agent. Connected: ${connected.join(', ') || 'none'}.`);
    const reviewers = [...new Set(input.reviewerAgentIds ?? connected.filter((a) => a !== input.plannerAgentId))];
    for (const r of reviewers) {
      if (!connected.includes(r)) throw new ScheduleError('INVALID', `${r} is not a connected agent.`);
      if (r === input.plannerAgentId) throw new ScheduleError('INVALID', 'The planner cannot also review its own plan.');
    }
    const maxRounds = input.maxRounds ?? 3;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new ScheduleError('INVALID', 'Review rounds must be 1 to 10.');
    return { name, brief, reviewers, maxRounds, trigger: this.compile(input.trigger) };
  }

  // ── Human actions ──────────────────────────────────────────────────────────
  create(input: ScheduleInput): ScheduleView {
    const v = this.validate(input);
    if ((this.db.prepare('SELECT count(*) AS n FROM schedules').get() as { n: number }).n >= MAX_SCHEDULES) throw new ScheduleError('LIMIT', `You can keep up to ${MAX_SCHEDULES} schedules. Delete one first.`);
    const id = withImmediateTransaction(this.db, () => {
      const n = (this.db.prepare("SELECT coalesce(max(CAST(substr(id, 2) AS INTEGER)), 0) AS n FROM schedules").get() as { n: number }).n + 1;
      const sid = `S${n}`;
      const now = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO schedules (id, name, trigger_kind, cron, preset_label, interval_hours, watch, brief, planner_agent_id, reviewer_agent_ids, max_rounds, anchor_at, cursor_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sid, v.name, v.trigger.kind, v.trigger.cron, v.trigger.label, v.trigger.hours, v.trigger.watch, v.brief, input.plannerAgentId, JSON.stringify(v.reviewers), v.maxRounds, now, now, now.replace('T', ' ').slice(0, 19));
      return sid;
    });
    return this.view(this.row(id));
  }

  /** Replaces a schedule's settings. The timer restarts from now: no catch-up for the time before the change. */
  update(id: string, input: ScheduleInput): ScheduleView {
    this.row(id);
    const v = this.validate(input);
    if (v.trigger.kind === 'mission_done' && v.trigger.watch === id) throw new ScheduleError('INVALID', 'A schedule cannot watch itself.');
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE schedules SET name = ?, trigger_kind = ?, cron = ?, preset_label = ?, interval_hours = ?, watch = ?, brief = ?, planner_agent_id = ?, reviewer_agent_ids = ?, max_rounds = ?,
                anchor_at = ?, cursor_at = ?, consecutive_failures = 0, disabled_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(v.name, v.trigger.kind, v.trigger.cron, v.trigger.label, v.trigger.hours, v.trigger.watch, v.brief, input.plannerAgentId, JSON.stringify(v.reviewers), v.maxRounds, now, now, id);
    return this.view(this.row(id));
  }

  setEnabled(id: string, enabled: boolean): ScheduleView {
    this.row(id);
    if (enabled) {
      // Switching on starts the clock now: the time it was off is never caught up.
      const now = this.now().toISOString();
      this.db.prepare('UPDATE schedules SET enabled = 1, anchor_at = ?, cursor_at = ?, consecutive_failures = 0, disabled_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(now, now, id);
    } else {
      this.db.prepare('UPDATE schedules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    }
    return this.view(this.row(id));
  }

  remove(id: string): void {
    this.row(id);
    const watcher = this.db.prepare("SELECT id FROM schedules WHERE trigger_kind = 'mission_done' AND watch = ? AND id != ?").get(id, id) as { id: string } | undefined;
    if (watcher) throw new ScheduleError('CONFLICT', `${watcher.id} watches this schedule. Change or delete ${watcher.id} first.`);
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  /** "Run now": obeys the no-overlap rule, works on a switched-off schedule, and does not move the timer. */
  runNow(id: string): ScheduleRun {
    this.row(id);
    return this.fire(id, 'manual', null, null);
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ScheduleError('NOT_FOUND', `There is no schedule ${id}.`);
    return r;
  }

  get(id: string): ScheduleView & { brief: string } {
    const r = this.row(id);
    return { ...this.view(r), brief: r.brief };
  }

  list(): ScheduleView[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY CAST(substr(id, 2) AS INTEGER)').all() as Row[]).map((r) => this.view(r));
  }

  runs(limit = 30): ScheduleRun[] {
    return (this.db.prepare('SELECT * FROM schedule_runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as RunRow[]).map(toRun);
  }

  private describe(r: Row): string {
    if (r.trigger_kind === 'cron') return r.preset_label ?? `cron: ${r.cron}`;
    if (r.trigger_kind === 'interval') return `every ${r.interval_hours} hour${r.interval_hours === 1 ? '' : 's'}`;
    return r.watch === 'any' ? 'when any mission finishes' : `when a mission started by ${r.watch} finishes`;
  }

  private nextAt(r: Row): string | null {
    if (!r.enabled) return null;
    const now = this.now();
    const cursor = new Date(r.cursor_at);
    try {
      if (r.trigger_kind === 'cron') return nextSlot(parseCron(r.cron!), new Date(Math.max(now.getTime() - ON_TIME_MS, cursor.getTime())))?.toISOString() ?? null;
      if (r.trigger_kind === 'interval') return nextIntervalSlot(new Date(r.anchor_at), r.interval_hours!, new Date(Math.max(now.getTime() - ON_TIME_MS, cursor.getTime()))).toISOString();
    } catch {
      return null;
    }
    return null;
  }

  private view(r: Row): ScheduleView {
    const last = this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(r.id) as RunRow | undefined;
    const missionStatus = r.last_mission_id ? this.missionStatus(r.last_mission_id) : null;
    return {
      id: r.id,
      name: r.name,
      enabled: Boolean(r.enabled),
      when: this.describe(r),
      kind: r.trigger_kind,
      cron: r.cron,
      hours: r.interval_hours,
      watch: r.watch,
      plannerAgentId: r.planner_agent_id,
      reviewerAgentIds: JSON.parse(r.reviewer_agent_ids) as string[],
      maxRounds: r.max_rounds,
      plannerConnected: this.o.connectedAgents().includes(r.planner_agent_id),
      nextRunAt: this.nextAt(r),
      lastRun: last ? toRun(last) : null,
      lastMissionId: r.last_mission_id,
      lastMissionStatus: missionStatus,
      disabledReason: r.disabled_reason,
      briefPreview: clip(r.brief.replace(/\s+/g, ' '), 200),
    };
  }

  // ── firing ─────────────────────────────────────────────────────────────────
  /** One pass: fire what is due. Returns how many missions were started. Never throws. */
  tick(): number {
    if (this.o.isPaused()) return 0;
    const now = this.now();
    let started = 0;
    for (const r of this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY CAST(substr(id, 2) AS INTEGER)').all() as Row[]) {
      try {
        const run = r.trigger_kind === 'mission_done' ? this.tickEvent(r, now) : this.tickSlot(r, now);
        started += run;
      } catch (err) {
        process.emitWarning(`AgentMesh schedule ${r.id}: ${(err as Error).message}`);
      }
    }
    return started;
  }

  private tickSlot(r: Row, now: Date): number {
    const cursor = new Date(r.cursor_at);
    let slot: Date | null;
    if (r.trigger_kind === 'cron') slot = previousSlot(parseCron(r.cron!), now, new Date(Math.max(cursor.getTime(), now.getTime() - 400 * 24 * 3600 * 1000)));
    else slot = intervalSlot(new Date(r.anchor_at), r.interval_hours!, now);
    if (!slot || slot.getTime() <= cursor.getTime()) return 0;
    const age = now.getTime() - slot.getTime();
    if (age > LATE_LIMIT_MS) {
      withImmediateTransaction(this.db, () => {
        this.record(r, 'late', slot, null, null, 'skipped:missed_over_24h', `The slot at ${localStamp(slot)} passed more than a day ago (AgentMesh or the computer was off), so it was not run.`, true);
        this.db.prepare('UPDATE schedules SET cursor_at = ? WHERE id = ?').run(slot.toISOString(), r.id);
      });
      return 0;
    }
    return this.fire(r.id, age < ON_TIME_MS ? 'slot' : 'late', slot, null).outcome === 'started' ? 1 : 0;
  }

  private tickEvent(r: Row, now: Date): number {
    const since = Math.max(sqlDate(r.created_at), now.getTime() - LATE_LIMIT_MS);
    const sinceSql = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
    const candidates = this.db
      .prepare(
        `SELECT m.id FROM missions m
          WHERE m.status = 'DONE' AND m.updated_at >= ?
            AND m.id NOT IN (SELECT source_mission_id FROM schedule_runs WHERE schedule_id = ? AND source_mission_id IS NOT NULL)
            AND m.id NOT IN (SELECT mission_id FROM schedule_runs WHERE trigger = 'event' AND mission_id IS NOT NULL)
            AND (? = 'any' OR m.id IN (SELECT mission_id FROM schedule_runs WHERE schedule_id = ? AND mission_id IS NOT NULL))
          ORDER BY m.updated_at, m.id`,
      )
      .all(sinceSql, r.id, r.watch, r.watch) as { id: string }[];
    let started = 0;
    for (const c of candidates) if (this.fire(r.id, 'event', null, c.id).outcome === 'started') started++;
    return started;
  }

  private fire(id: string, trigger: ScheduleRun['trigger'], slot: Date | null, source: string | null): ScheduleRun {
    return withImmediateTransaction(this.db, () => {
      const r = this.row(id); // re-read inside the transaction: a "Run now" and a tick can never both fire one slot
      const advance = trigger === 'slot' || trigger === 'late';
      const done = (outcome: string, detail: string | null, missionId: string | null): ScheduleRun => {
        const run = this.record(r, trigger, slot, source, missionId, outcome, detail, trigger !== 'event');
        if (advance && slot) this.db.prepare('UPDATE schedules SET cursor_at = ? WHERE id = ?').run(slot.toISOString(), id);
        return run;
      };

      // 1. no overlap: the mission this schedule started last must be finished
      if (r.last_mission_id) {
        const status = this.missionStatus(r.last_mission_id); // null when the mission is gone: that counts as finished
        if (status && status !== 'DONE' && status !== 'CANCELLED') {
          return done('skipped:overlap', `${r.last_mission_id} is still ${status === 'PLAN_READY' ? 'waiting for your approval' : status.toLowerCase().replaceAll('_', ' ')}.`, null);
        }
      }

      // 2. the agents must still be connected (a removed planner must not strand a mission)
      const connected = this.o.connectedAgents();
      if (!connected.includes(r.planner_agent_id)) return this.failure(r, done, 'failed:planner_unavailable', `${r.planner_agent_id} is not connected any more. Pick another planner for this schedule.`);
      const wanted = JSON.parse(r.reviewer_agent_ids) as string[];
      const reviewers = wanted.filter((a) => connected.includes(a));
      if (wanted.length && !reviewers.length) return this.failure(r, done, 'failed:reviewers_unavailable', `None of the chosen reviewers (${wanted.join(', ')}) are connected, so the plan would get no cross-review.`);
      const dropped = wanted.filter((a) => !connected.includes(a));

      // 3. start the mission
      try {
        const title = clip(`${r.name} · ${localStamp(slot ?? this.now())}`, 200);
        const m = this.o.missions.create(HUMAN, { title, brief: r.brief, plannerAgentId: r.planner_agent_id, reviewerAgentIds: reviewers, maxRounds: r.max_rounds });
        const run = done('started', dropped.length ? `Started without ${dropped.join(', ')} (not connected).` : null, m.id);
        this.db.prepare('UPDATE schedules SET last_mission_id = ?, consecutive_failures = 0 WHERE id = ?').run(m.id, id);
        this.o.board.announce(HUMAN, `schedule ${r.id} "${r.name}" started mission ${m.id}. It stops at the plan and waits for your approval.`);
        return run;
      } catch (err) {
        if (err instanceof MissionError) return this.failure(r, done, 'failed:invalid_brief', err.message);
        throw err;
      }
    });
  }

  private missionStatus(id: string): string | null {
    try {
      return this.o.missions.get(id).status;
    } catch {
      return null;
    }
  }

  private failure(r: Row, done: (o: string, d: string | null, m: string | null) => ScheduleRun, outcome: string, detail: string): ScheduleRun {
    const run = done(outcome, detail, null);
    const failures = r.consecutive_failures + 1;
    if (failures >= FAILURES_BEFORE_OFF) {
      this.db.prepare('UPDATE schedules SET enabled = 0, consecutive_failures = ?, disabled_reason = ? WHERE id = ?').run(failures, `Switched off after ${failures} failures in a row: ${detail}`, r.id);
      this.o.board.announce(HUMAN, `schedule ${r.id} "${r.name}" was switched off after ${failures} failures in a row: ${detail}`);
    } else {
      this.db.prepare('UPDATE schedules SET consecutive_failures = ? WHERE id = ?').run(failures, r.id);
      this.o.board.announce(HUMAN, `schedule ${r.id} "${r.name}" could not start a mission: ${detail}`);
    }
    return run;
  }

  /** Writes the run row (folding repeated identical skips), updates the schedule's last-run fields, and trims old rows. */
  private record(r: Row, trigger: ScheduleRun['trigger'], slot: Date | null, source: string | null, missionId: string | null, outcome: string, detail: string | null, coalesce: boolean): ScheduleRun {
    const nowIso = this.now().toISOString();
    let row: RunRow | undefined;
    if (coalesce && outcome.startsWith('skipped:')) {
      const prev = this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(r.id) as RunRow | undefined;
      // Only skips of the same kind are folded together: a "Run now" skip is not an automatic one.
      if (prev && prev.outcome === outcome && prev.detail === detail && (prev.trigger === 'manual') === (trigger === 'manual')) {
        this.db.prepare('UPDATE schedule_runs SET repeat = repeat + 1, slot_at = ? WHERE id = ?').run(slot ? slot.toISOString() : prev.slot_at, prev.id);
        row = { ...prev, repeat: prev.repeat + 1 };
      }
    }
    if (!row) {
      const rid = randomUUID();
      this.db
        .prepare('INSERT INTO schedule_runs (id, schedule_id, trigger, slot_at, source_mission_id, mission_id, detail, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rid, r.id, trigger, slot ? slot.toISOString() : null, source, missionId, detail, outcome, nowIso);
      row = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(rid) as RunRow;
      this.db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)').run(r.id, r.id, MAX_RUNS_KEPT);
    }
    this.db.prepare('UPDATE schedules SET last_run_at = ?, last_outcome = ? WHERE id = ?').run(nowIso, outcome, r.id);
    return toRun(row);
  }
}

interface RunRow {
  id: string;
  schedule_id: string;
  trigger: ScheduleRun['trigger'];
  slot_at: string | null;
  source_mission_id: string | null;
  mission_id: string | null;
  detail: string | null;
  outcome: string;
  repeat: number;
  created_at: string;
}
const toRun = (r: RunRow): ScheduleRun => ({ id: r.id, scheduleId: r.schedule_id, trigger: r.trigger, slotAt: r.slot_at, missionId: r.mission_id, outcome: r.outcome, detail: r.detail, repeat: r.repeat, at: r.created_at });
