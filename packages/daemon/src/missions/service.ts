// Missions: the Human gives ONE brief; an agent the Human picks writes the plan; the other agents look
// for gaps; the planner merges their notes; the Human approves; the planner splits the plan into tasks;
// the normal engine (dispatch, leases, cross-audit, merge queue) builds them.
//
//   PLANNING ─(plan)→ REVIEWING ─(all reviews in)→ REVISING ─(revised plan)→ PLAN_READY ─(Human approves)→
//   SPLITTING ─(tasks created)→ IMPLEMENTING ─(all tasks committed)→ DONE          (CANCELLED from anywhere)
//
// PLAN_READY is always the Human's: approve, ask for another review round, or request changes.
// Every method takes the caller's Principal, and every state change is checked here, not by the caller.
import { randomUUID } from 'node:crypto';
import type { BoardService } from '../board/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import type { Principal } from '../identity/index.js';

export type MissionStatus = 'PLANNING' | 'REVIEWING' | 'REVISING' | 'PLAN_READY' | 'SPLITTING' | 'IMPLEMENTING' | 'DONE' | 'CANCELLED';

export class MissionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'MissionError';
  }
}

interface MissionRow {
  id: string;
  title: string;
  brief: string;
  status: MissionStatus;
  planner_agent_id: string;
  reviewer_agent_ids: string;
  round: number;
  max_rounds: number;
  created_at: string;
  updated_at: string;
}

export const MAX_BRIEF = 20_000;
export const MAX_PLAN = 100_000;
export const MISSION_PHASE_PREFIX = 'mission:';
export const missionPhase = (missionId: string) => `${MISSION_PHASE_PREFIX}${missionId}`;

const ACTIVE: ReadonlySet<MissionStatus> = new Set(['PLANNING', 'REVIEWING', 'REVISING', 'PLAN_READY', 'SPLITTING', 'IMPLEMENTING']);

export interface MissionServiceOptions {
  db: SqliteDatabase;
  board: BoardService;
}

export interface CreateMissionInput {
  title: string;
  brief: string;
  plannerAgentId: string;
  /** Default: every other agent. May be empty (the plan then goes straight to the Human). */
  reviewerAgentIds?: string[];
  maxRounds?: number;
}

export class MissionService {
  constructor(private readonly options: MissionServiceOptions) {}

  private get db(): SqliteDatabase {
    return this.options.db;
  }

  // ── reads ───────────────────────────────────────────────────────────────
  private row(missionId: string): MissionRow {
    const m = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as MissionRow | undefined;
    if (!m) throw new MissionError('NOT_FOUND', `Unknown mission ${missionId}`);
    return m;
  }

  private reviewers(m: MissionRow): string[] {
    return JSON.parse(m.reviewer_agent_ids) as string[];
  }

  private latestPlan(missionId: string) {
    return this.db.prepare('SELECT version, author_agent_id AS author, body, created_at AS createdAt FROM mission_plans WHERE mission_id = ? ORDER BY version DESC LIMIT 1').get(missionId) as
      | { version: number; author: string; body: string; createdAt: string }
      | undefined;
  }

  /** Reviews that count toward the current round (agents), plus every Human note. */
  private reviewsOf(missionId: string) {
    return this.db
      .prepare('SELECT round, plan_version AS planVersion, reviewer_agent_id AS reviewer, verdict, gaps, created_at AS createdAt FROM mission_reviews WHERE mission_id = ? ORDER BY created_at, rowid')
      .all(missionId) as { round: number; planVersion: number; reviewer: string; verdict: 'OK' | 'GAPS'; gaps: string; createdAt: string }[];
  }

  private tasksOf(missionId: string) {
    return this.db.prepare('SELECT id, title, status, assigned_agent_id AS owner, suggested_owner AS suggestedOwner, prerequisites FROM tasks WHERE phase_id = ? ORDER BY id').all(missionPhase(missionId)) as {
      id: string;
      title: string;
      status: string;
      owner: string | null;
      suggestedOwner: string | null;
      prerequisites: string;
    }[];
  }

  /** One mission with everything the cockpit or an agent needs to act on it. */
  get(missionId: string) {
    const m = this.row(missionId);
    const tasks = this.tasksOf(missionId);
    const plan = this.latestPlan(missionId);
    const versions = this.db.prepare('SELECT version, author_agent_id AS author, created_at AS createdAt FROM mission_plans WHERE mission_id = ? ORDER BY version').all(missionId);
    return {
      id: m.id,
      title: m.title,
      brief: m.brief,
      status: m.status,
      planner: m.planner_agent_id,
      reviewers: this.reviewers(m),
      round: m.round,
      maxRounds: m.max_rounds,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      plan: plan ?? null,
      planVersions: versions,
      reviews: this.reviewsOf(missionId),
      /** Who the mission is waiting on right now. */
      waitingOn: this.waitingOn(m),
      tasks: tasks.map((t) => ({ ...t, prerequisites: JSON.parse(t.prerequisites) as string[] })),
      progress: { total: tasks.length, committed: tasks.filter((t) => t.status === 'COMMITTED').length },
    };
  }

  list() {
    return (this.db.prepare('SELECT id FROM missions ORDER BY created_at DESC, rowid DESC').all() as { id: string }[]).map((r) => this.get(r.id));
  }

  /** Agents that owe the mission an action, or 'human'. Empty when it is finished. */
  waitingOn(m: MissionRow): string[] {
    switch (m.status) {
      case 'PLANNING':
      case 'REVISING':
      case 'SPLITTING':
        return [m.planner_agent_id];
      case 'REVIEWING': {
        const done = new Set((this.db.prepare('SELECT reviewer_agent_id AS r FROM mission_reviews WHERE mission_id = ? AND round = ?').all(m.id, m.round) as { r: string }[]).map((x) => x.r));
        return this.reviewers(m).filter((r) => !done.has(r));
      }
      case 'PLAN_READY':
        return ['human'];
      default:
        return [];
    }
  }

  /** What the dispatcher should start for this agent, if anything. Pure read. */
  workFor(agentId: string, skip?: (missionId: string) => boolean): { kind: 'PLAN' | 'PLAN_REVIEW' | 'PLAN_REVISE' | 'SPLIT'; missionId: string } | null {
    const rows = this.db.prepare("SELECT * FROM missions WHERE status IN ('PLANNING','REVIEWING','REVISING','SPLITTING') ORDER BY created_at, rowid").all() as MissionRow[];
    for (const m of rows) {
      if (skip?.(m.id)) continue; // the caller passes over missions that are stopped or cooling down, so the next one is found
      if (!this.waitingOn(m).includes(agentId)) continue;
      const kind = m.status === 'PLANNING' ? 'PLAN' : m.status === 'REVIEWING' ? 'PLAN_REVIEW' : m.status === 'REVISING' ? 'PLAN_REVISE' : 'SPLIT';
      return { kind, missionId: m.id };
    }
    return null;
  }

  // ── Human actions ───────────────────────────────────────────────────────
  private agents(): { id: string; name: string; platform: string }[] {
    return this.db.prepare("SELECT id, name, platform FROM agents WHERE platform != 'HUMAN' ORDER BY id").all() as { id: string; name: string; platform: string }[];
  }

  private requireHuman(principal: Principal): void {
    if (!principal.isHuman) throw new MissionError('FORBIDDEN', 'Only the Human does this');
  }

  create(principal: Principal, input: CreateMissionInput) {
    this.requireHuman(principal);
    const title = input.title.trim();
    const brief = input.brief.trim();
    if (!title || title.length > 200) throw new MissionError('INVALID', 'A mission needs a short title (up to 200 characters)');
    if (brief.length < 10 || brief.length > MAX_BRIEF) throw new MissionError('INVALID', `The brief must be between 10 and ${MAX_BRIEF} characters`);
    const agents = this.agents();
    const known = new Set(agents.map((a) => a.id));
    if (!known.has(input.plannerAgentId)) throw new MissionError('INVALID', `Unknown planner "${input.plannerAgentId}". Agents: ${[...known].join(', ') || 'none connected'}`);
    const reviewers = [...new Set(input.reviewerAgentIds ?? agents.map((a) => a.id).filter((id) => id !== input.plannerAgentId))];
    for (const r of reviewers) {
      if (!known.has(r)) throw new MissionError('INVALID', `Unknown reviewer "${r}"`);
      if (r === input.plannerAgentId) throw new MissionError('INVALID', 'The planner cannot review its own plan');
    }
    const maxRounds = input.maxRounds ?? 3;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new MissionError('INVALID', 'maxRounds must be 1-10');
    return withImmediateTransaction(this.db, () => {
      const n = (this.db.prepare("SELECT coalesce(max(CAST(substr(id, 2) AS INTEGER)), 0) AS n FROM missions").get() as { n: number }).n + 1;
      const id = `M${n}`;
      this.db
        .prepare('INSERT INTO missions (id, title, brief, status, planner_agent_id, reviewer_agent_ids, max_rounds) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, title, brief, 'PLANNING', input.plannerAgentId, JSON.stringify(reviewers), maxRounds);
      this.options.board.announce(principal, `mission ${id} started: "${title}". ${input.plannerAgentId} plans${reviewers.length ? `; ${reviewers.join(', ')} review` : '; no reviewers'}.`);
      return this.get(id);
    });
  }

  private touch(missionId: string, status: MissionStatus, extra = ''): void {
    this.db.prepare(`UPDATE missions SET status = ?, updated_at = CURRENT_TIMESTAMP${extra} WHERE id = ?`).run(status, missionId);
  }

  approve(principal: Principal, missionId: string) {
    this.requireHuman(principal);
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (m.status !== 'PLAN_READY') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}; only a ready plan can be approved`);
      this.touch(missionId, 'SPLITTING');
      this.options.board.announce(principal, `approved the plan for mission ${missionId}. ${m.planner_agent_id} now splits it into tasks.`);
      return this.get(missionId);
    });
  }

  requestChanges(principal: Principal, missionId: string, note: string) {
    this.requireHuman(principal);
    const text = note.trim();
    if (!text || text.length > MAX_BRIEF) throw new MissionError('INVALID', 'Say what should change (up to 20,000 characters)');
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (m.status !== 'PLAN_READY') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}; changes can be requested on a ready plan`);
      const plan = this.latestPlan(missionId);
      this.db.prepare("INSERT INTO mission_reviews (id, mission_id, round, plan_version, reviewer_agent_id, verdict, gaps) VALUES (?, ?, ?, ?, 'human', 'GAPS', ?)").run(randomUUID(), missionId, m.round, plan?.version ?? 1, text);
      this.touch(missionId, 'REVISING');
      this.options.board.announce(principal, `asked for changes to the plan for mission ${missionId}: ${text.slice(0, 300)}`);
      return this.get(missionId);
    });
  }

  anotherRound(principal: Principal, missionId: string) {
    this.requireHuman(principal);
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (m.status !== 'PLAN_READY') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}; another round starts from a ready plan`);
      if (!this.reviewers(m).length) throw new MissionError('INVALID', 'This mission has no reviewers');
      if (m.round >= m.max_rounds) throw new MissionError('INVALID', `Mission ${missionId} has used its ${m.max_rounds} review round(s). Approve, or request changes.`);
      this.db.prepare('UPDATE missions SET round = round + 1 WHERE id = ?').run(missionId);
      this.touch(missionId, 'REVIEWING');
      this.options.board.announce(principal, `asked for another review round on mission ${missionId} (round ${m.round + 1} of ${m.max_rounds}).`);
      return this.get(missionId);
    });
  }

  /** The Human gives up waiting on a reviewer that keeps failing: counts as an OK with a note saying so. */
  skipReviewer(principal: Principal, missionId: string, agentId: string) {
    this.requireHuman(principal);
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (m.status !== 'REVIEWING') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}, not being reviewed`);
      if (!this.waitingOn(m).includes(agentId)) throw new MissionError('INVALID', `${agentId} is not a reviewer we are waiting on`);
      const plan = this.latestPlan(missionId)!;
      this.db.prepare("INSERT INTO mission_reviews (id, mission_id, round, plan_version, reviewer_agent_id, verdict, gaps) VALUES (?, ?, ?, ?, ?, 'OK', ?)").run(randomUUID(), missionId, m.round, plan.version, agentId, 'Skipped by the Human (this reviewer did not respond).');
      this.options.board.announce(principal, `skipped ${agentId}'s review of mission ${missionId}.`);
      this.advanceAfterReview(m);
      return this.get(missionId);
    });
  }

  cancel(principal: Principal, missionId: string) {
    this.requireHuman(principal);
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (!ACTIVE.has(m.status)) throw new MissionError('CONFLICT', `Mission ${missionId} is already ${m.status}`);
      this.touch(missionId, 'CANCELLED');
      this.options.board.announce(principal, `cancelled mission ${missionId}. Tasks already created stay on the board.`);
      return this.get(missionId);
    });
  }

  // ── agent actions ───────────────────────────────────────────────────────
  submitPlan(principal: Principal, missionId: string, body: string) {
    const text = body.trim();
    if (text.length < 40 || text.length > MAX_PLAN) throw new MissionError('INVALID', `A plan is between 40 and ${MAX_PLAN} characters of Markdown`);
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (principal.isHuman || m.planner_agent_id !== principal.agentId) throw new MissionError('FORBIDDEN', `Only the planner (${m.planner_agent_id}) writes the plan for ${missionId}`);
      if (m.status !== 'PLANNING' && m.status !== 'REVISING') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}; a plan is expected only while PLANNING or REVISING`);
      const version = (this.latestPlan(missionId)?.version ?? 0) + 1;
      this.db.prepare('INSERT INTO mission_plans (id, mission_id, version, author_agent_id, body) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), missionId, version, principal.agentId, text);
      const next: MissionStatus = m.status === 'PLANNING' && this.reviewers(m).length ? 'REVIEWING' : 'PLAN_READY';
      this.touch(missionId, next);
      this.options.board.announce(principal, `submitted plan v${version} for mission ${missionId}${next === 'REVIEWING' ? `; waiting for ${this.reviewers(m).join(', ')} to review.` : '; ready for the Human.'}`);
      return { missionId, version, status: next };
    });
  }

  submitReview(principal: Principal, missionId: string, input: { planVersion: number; verdict: 'OK' | 'GAPS'; gaps?: string }) {
    const gaps = (input.gaps ?? '').trim();
    if (input.verdict === 'GAPS' && gaps.length < 10) throw new MissionError('INVALID', 'A GAPS verdict needs the concrete gaps (at least 10 characters)');
    if (gaps.length > MAX_BRIEF) throw new MissionError('INVALID', 'The review is too long');
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (!this.reviewers(m).includes(principal.agentId)) throw new MissionError('FORBIDDEN', `${principal.agentId} is not a reviewer of ${missionId}`);
      if (m.status !== 'REVIEWING') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}; reviews are taken only while REVIEWING`);
      const plan = this.latestPlan(missionId);
      if (!plan || input.planVersion !== plan.version) throw new MissionError('CONFLICT', `You reviewed plan v${input.planVersion}; the current plan is v${plan?.version}. Read it again with mesh_get_mission.`);
      if (!this.waitingOn(m).includes(principal.agentId)) throw new MissionError('CONFLICT', `You already reviewed round ${m.round} of ${missionId}`);
      this.db.prepare('INSERT INTO mission_reviews (id, mission_id, round, plan_version, reviewer_agent_id, verdict, gaps) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), missionId, m.round, plan.version, principal.agentId, input.verdict, gaps);
      this.options.board.announce(principal, `reviewed plan v${plan.version} of mission ${missionId}: ${input.verdict === 'OK' ? 'no gaps' : 'found gaps'}.`);
      const status = this.advanceAfterReview(m);
      return { missionId, status };
    });
  }

  /** When every reviewer has answered this round: gaps → planner revises; all OK → straight to the Human. */
  private advanceAfterReview(m: MissionRow): MissionStatus {
    if (this.waitingOn(this.row(m.id)).length) return 'REVIEWING';
    const gaps = (this.db.prepare("SELECT count(*) AS n FROM mission_reviews WHERE mission_id = ? AND round = ? AND verdict = 'GAPS'").get(m.id, m.round) as { n: number }).n;
    const next: MissionStatus = gaps ? 'REVISING' : 'PLAN_READY';
    this.touch(m.id, next);
    return next;
  }

  finishSplit(principal: Principal, missionId: string) {
    return withImmediateTransaction(this.db, () => {
      const m = this.row(missionId);
      if (principal.isHuman || m.planner_agent_id !== principal.agentId) throw new MissionError('FORBIDDEN', `Only the planner (${m.planner_agent_id}) finishes the split for ${missionId}`);
      if (m.status !== 'SPLITTING') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}, not SPLITTING`);
      const tasks = this.tasksOf(missionId);
      if (!tasks.length) throw new MissionError('INVALID', `No tasks yet. Create them with mesh_create_task (phase "${missionPhase(missionId)}", ids ${missionId}-1, ${missionId}-2, ...), then call this again.`);
      this.touch(missionId, 'IMPLEMENTING');
      this.options.board.announce(principal, `split mission ${missionId} into ${tasks.length} task(s): ${tasks.map((t) => t.id).join(', ')}.`);
      return { missionId, status: 'IMPLEMENTING' as const, tasks: tasks.map((t) => t.id) };
    });
  }

  /** A mission whose tasks are all committed is done. Cheap; call it from any periodic tick. */
  sync(): void {
    const running = this.db.prepare("SELECT id FROM missions WHERE status = 'IMPLEMENTING'").all() as { id: string }[];
    for (const { id } of running) {
      const tasks = this.tasksOf(id);
      if (tasks.length && tasks.every((t) => t.status === 'COMMITTED')) {
        withImmediateTransaction(this.db, () => {
          if ((this.db.prepare('SELECT status FROM missions WHERE id = ?').get(id) as { status: string }).status !== 'IMPLEMENTING') return;
          this.touch(id, 'DONE');
          this.options.board.announce({ agentId: 'human', platform: 'HUMAN', paradigm: 'HUMAN', isHuman: true }, `mission ${id} is done: all ${tasks.length} task(s) are committed.`);
        });
      }
    }
  }

  // ── guarding task creation ──────────────────────────────────────────────
  /**
   * Called by BoardService.createTask. Tasks in a mission's phase may only be created by its planner while
   * it is SPLITTING, with ids prefixed by the mission id and an owner the dispatcher can actually resolve
   * (a task nobody can be assigned to would sit forever). Fixes the owner's capitalisation in place.
   */
  guardTask(principal: Principal, input: { id: string; phase: string; suggestedOwner?: string }): void {
    if (!input.phase.startsWith(MISSION_PHASE_PREFIX)) return;
    const missionId = input.phase.slice(MISSION_PHASE_PREFIX.length);
    const m = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as MissionRow | undefined;
    if (!m) throw new MissionError('INVALID', `Phase "${input.phase}" names a mission that does not exist`);
    // The Human may add to any mission at any time, but the owner must still be someone real (Gemini, review A).
    if (!principal.isHuman) this.guardPlanner(principal, m, missionId, input);
    this.canonicaliseOwner(input);
  }

  private guardPlanner(principal: Principal, m: MissionRow, missionId: string, input: { id: string; phase: string }): void {
    if (m.planner_agent_id !== principal.agentId) throw new MissionError('FORBIDDEN', `Only the planner (${m.planner_agent_id}) creates tasks in ${input.phase}`);
    if (m.status !== 'SPLITTING') throw new MissionError('CONFLICT', `Mission ${missionId} is ${m.status}; tasks are created only while it is SPLITTING (after the Human approves the plan)`);
    if (!input.id.startsWith(`${missionId}-`)) throw new MissionError('INVALID', `Task ids in this mission must start with "${missionId}-" (for example ${missionId}-1)`);
  }

  private canonicaliseOwner(input: { suggestedOwner?: string }): void {
    if (input.suggestedOwner) {
      const valid = new Map<string, string>([['pair', 'Pair']]);
      for (const a of this.agents()) for (const v of [a.platform, a.id, a.name]) valid.set(v.toLowerCase(), v); // the friendly name is set last, so it wins
      const canonical = valid.get(input.suggestedOwner.toLowerCase());
      if (!canonical) {
        const agents = this.agents();
        throw new MissionError('INVALID', `suggestedOwner "${input.suggestedOwner}" matches no agent. Use one of: ${[...new Set(agents.map((a) => a.name))].join(', ')}, or Pair (an exact agent id such as ${agents[0]?.id ?? 'claude-1'} also works)`);
      }
      input.suggestedOwner = canonical;
    }
  }
}
