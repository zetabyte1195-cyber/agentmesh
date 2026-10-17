// Human-in-the-loop controls (P3.3; spec v1.1 §11–12). Every route is Human-only ('human' auth), and
// cookie-authenticated writes must also carry the daemon's Origin (enforced by the P2.6 server).
// Everything the Human does goes through the same services, rules and events as an agent's action.
import { z } from 'zod';
import { type AuditGate, AuditGateError } from '../audit/index.js';
import { BoardError, type BoardService } from '../board/index.js';
import { BudgetError, type BudgetService } from '../budget/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import { BUILT_IN_TEMPLATES, MissionError, type MissionService, TemplateError, type TemplateStore } from '../missions/index.js';
import type { Principal } from '../identity/index.js';
import { PlaybookError, type PlaybookStore } from '../playbooks/index.js';
import { ScheduleError, type ScheduleInput, type ScheduleService } from '../schedules/index.js';
import type { LeaseArbiter } from '../leases/index.js';
import { ReviewError, type ReviewService } from '../review/index.js';
import { type DaemonServer, HttpError } from '../server/index.js';

export interface ControlsOptions {
  server: DaemonServer;
  board: BoardService;
  gate: AuditGate;
  review?: ReviewService;
  dispatcher?: Dispatcher;
  missions?: MissionService;
  leases?: LeaseArbiter;
  templates?: TemplateStore;
  playbooks?: PlaybookStore;
  schedules?: ScheduleService;
  budget?: BudgetService;
}

const TaskId = z.string().min(1).max(64);

async function parse<T extends z.ZodTypeAny>(schema: T, body: () => Promise<string>): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = JSON.parse((await body()) || '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * A rule refusing the action becomes 409 with its message: the services' own error classes, or a
 * schema trigger/constraint (SQLITE_CONSTRAINT_*). Anything else is a bug and is rethrown as a 500
 * whose message stays out of the response (Gemini, P3.3 audit: the old name/regex match did both wrong).
 */
const REFUSALS = [BoardError, AuditGateError, ReviewError, MissionError, TemplateError, PlaybookError, ScheduleError, BudgetError] as const;
async function act<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (REFUSALS.some((C) => err instanceof C)) throw new HttpError(409, (err as Error).message);
    const e = err as { name?: string; code?: unknown; message?: string };
    if (e.name === 'SqliteError' && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, e.message ?? 'Refused');
    throw err;
  }
}

export function registerControls(o: ControlsOptions): void {
  const human = (p: Principal | null): Principal => p!;

  o.server.route('POST', '/api/answer', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ questionId: z.string().min(1), answer: z.string().trim().min(1).max(10_000) }), body);
    return act(() => o.board.answerQuestion(human(principal), b.questionId, b.answer));
  });

  o.server.route('POST', '/api/message', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ toAgentId: z.string().min(1).max(64), taskId: TaskId, message: z.string().trim().min(1).max(20_000) }), body);
    return act(() => o.board.sendHandoff(human(principal), { taskId: b.taskId, toAgentId: b.toAgentId, message: b.message }));
  });

  o.server.route('POST', '/api/diff', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ taskId: TaskId }), body);
    if (!o.review) throw new HttpError(503, 'Review tools not available');
    return act(() => o.review!.getDiff(human(principal), b.taskId));
  });

  o.server.route('POST', '/api/verify', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ taskId: TaskId }), body);
    if (!o.review) throw new HttpError(503, 'Review tools not available');
    return act(() => o.review!.runVerification(human(principal), b.taskId));
  });

  // Human audit: testRunSuccess is an explicit choice (Human decision on P1.8), never defaulted.
  o.server.route('POST', '/api/audit', 'human', async ({ principal, body }) => {
    const b = await parse(
      z.object({
        taskId: TaskId,
        verdict: z.enum(['PASSED', 'GAP_FOUND']),
        diffHash: z.string().regex(/^[0-9a-f]{64}$/),
        testRunSuccess: z.boolean(),
        notes: z.string().trim().min(1).max(20_000),
      }),
      body,
    );
    return act(() => o.gate.submitAudit(human(principal), b));
  });

  // Controls with no board row of their own are still recorded in the timeline as the Human (P3.3 AC).
  // agentId must be non-empty: "" would have paused ALL dispatching (Gemini, P3.3 audit).
  o.server.route('POST', '/api/dispatch', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ paused: z.boolean(), agentId: z.string().min(1).max(64).optional() }), body);
    if (!o.dispatcher) throw new HttpError(503, 'Dispatcher not running');
    if (b.paused) o.dispatcher.pause(b.agentId);
    else o.dispatcher.resume(b.agentId);
    o.board.recordControl(human(principal), `${b.paused ? 'paused' : 'resumed'} dispatching${b.agentId ? ` for ${b.agentId}` : ''}`);
    return { paused: o.dispatcher.isPaused(b.agentId) };
  });

  // ── missions: one brief → plan → cross-review → the Human decides → tasks → build ──
  const MissionId = z.string().min(1).max(32);
  const missions = () => {
    if (!o.missions) throw new HttpError(503, 'Missions are not enabled');
    return o.missions;
  };
  o.server.route('POST', '/api/missions', 'human', async ({ principal, body }) => {
    const b = await parse(
      z.object({
        title: z.string().trim().min(1).max(200),
        brief: z.string().trim().min(10).max(20_000),
        plannerAgentId: z.string().min(1).max(64),
        reviewerAgentIds: z.array(z.string().min(1).max(64)).max(20).optional(),
        maxRounds: z.number().int().min(1).max(10).optional(),
        // Optional spending limits: stop starting runs for this mission once it has used this much (see budget/).
        // The bounds, and the words when they are broken, are the budget service's (one set of rules, one kind of answer).
        budgetUsd: z.number().finite().nullable().optional(),
        budgetTokens: z.number().finite().nullable().optional(),
      }),
      body,
    );
    // The planner and reviewers must be agents the dispatcher can actually run. An agent that is only a row in the
    // database (removed from the configuration) would be given the work and never do it.
    if (o.dispatcher) {
      const connected = o.dispatcher.agentIds();
      for (const id of [b.plannerAgentId, ...(b.reviewerAgentIds ?? [])]) {
        if (!connected.includes(id)) throw new HttpError(409, `${id} is not a connected agent, so it cannot take part. Connected: ${connected.join(', ') || 'none'}.`);
      }
    }
    const limits = { maxCostUsd: b.budgetUsd ?? null, maxTokens: b.budgetTokens ?? null };
    const limited = limits.maxCostUsd !== null || limits.maxTokens !== null;
    if (limited && !o.budget) throw new HttpError(503, 'Spending limits are not enabled');
    return act(() => {
      if (limited) o.budget!.validate(limits); // before the mission exists: a bad limit must not leave an unlimited mission behind
      const created = missions().create(human(principal), { title: b.title, brief: b.brief, plannerAgentId: b.plannerAgentId, ...(b.reviewerAgentIds ? { reviewerAgentIds: b.reviewerAgentIds } : {}), ...(b.maxRounds ? { maxRounds: b.maxRounds } : {}) });
      if (limited) o.budget!.set(created.id, limits);
      return { ...created, budget: limited ? o.budget!.status(created.id) : null };
    });
  });
  // Set, raise, lower or remove (both null) a mission's limit. Raising it lets a stopped mission carry on.
  o.server.route('POST', '/api/missions/budget', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ missionId: MissionId, budgetUsd: z.number().finite().nullable().optional(), budgetTokens: z.number().finite().nullable().optional() }), body);
    if (!o.budget) throw new HttpError(503, 'Spending limits are not enabled');
    const status = await act(() => o.budget!.set(b.missionId, { maxCostUsd: b.budgetUsd ?? null, maxTokens: b.budgetTokens ?? null }));
    const limit = status ? [status.maxCostUsd !== null ? `$${status.maxCostUsd}` : '', status.maxTokens !== null ? `${status.maxTokens.toLocaleString('en-US')} tokens` : ''].filter(Boolean).join(' and ') : '';
    o.board.recordControl(human(principal), status ? `set the spending limit of mission ${b.missionId} to ${limit}` : `removed the spending limit of mission ${b.missionId}`);
    return { budget: status };
  });
  o.server.route('POST', '/api/missions/approve', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ missionId: MissionId }), body);
    return act(() => missions().approve(human(principal), b.missionId));
  });
  o.server.route('POST', '/api/missions/changes', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ missionId: MissionId, note: z.string().trim().min(1).max(20_000) }), body);
    return act(() => missions().requestChanges(human(principal), b.missionId, b.note));
  });
  o.server.route('POST', '/api/missions/round', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ missionId: MissionId }), body);
    return act(() => missions().anotherRound(human(principal), b.missionId));
  });
  o.server.route('POST', '/api/missions/skip', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ missionId: MissionId, agentId: z.string().min(1).max(64) }), body);
    return act(() => missions().skipReviewer(human(principal), b.missionId, b.agentId));
  });
  o.server.route('POST', '/api/missions/cancel', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ missionId: MissionId }), body);
    return act(() => missions().cancel(human(principal), b.missionId));
  });

  // An agent that gave up (three tries without progress) waits for the Human; this lets it try again.
  o.server.route('POST', '/api/retry', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ agentId: z.string().min(1).max(64), subject: z.string().min(1).max(80) }), body);
    if (!o.dispatcher) throw new HttpError(503, 'Dispatcher not running');
    if (!o.dispatcher.agentIds().includes(b.agentId)) throw new HttpError(404, `No connected agent ${b.agentId}`);
    o.dispatcher.retry(b.agentId, b.subject);
    o.board.recordControl(human(principal), `asked ${b.agentId} to try ${b.subject.startsWith('mission:') ? `mission ${b.subject.slice(8)}` : `task ${b.subject}`} again`);
    return { ok: true };
  });

  // File locks an agent still holds (it stopped, or is stuck) can be released by the Human. The agent
  // must take them again before it can commit or submit, so nothing slips through unlocked.
  o.server.route('POST', '/api/leases/release', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ taskId: TaskId }), body);
    if (!o.leases) throw new HttpError(503, 'Leases not available');
    const released = o.leases.releaseAllForTask(b.taskId);
    if (released) o.board.recordControl(human(principal), `released ${released} file lock${released === 1 ? '' : 's'} held for task ${b.taskId}`, b.taskId);
    return { released };
  });

  // Starter briefs: the built-in ones, and the ones this person saved.
  o.server.route('GET', '/api/templates', 'human', () => ({ builtIn: BUILT_IN_TEMPLATES, mine: o.templates?.list() ?? [] }));
  o.server.route('POST', '/api/templates/save', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ title: z.string().trim().min(1).max(80), brief: z.string().trim().min(10).max(20_000) }), body);
    if (!o.templates) throw new HttpError(503, 'Templates are not available');
    const t = await act(() => o.templates!.save(b.title, b.brief));
    o.board.recordControl(human(principal), `saved the mission template "${t.title}"`);
    return t;
  });
  o.server.route('POST', '/api/templates/delete', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ id: z.string().min(1).max(40) }), body);
    if (!o.templates) throw new HttpError(503, 'Templates are not available');
    await act(() => o.templates!.remove(b.id));
    o.board.recordControl(human(principal), 'deleted one of my mission templates');
    return { ok: true };
  });

  // Playbooks: reusable instructions agents read on demand (see playbooks/store.ts).
  const playbooks = () => {
    if (!o.playbooks) throw new HttpError(503, 'Playbooks are not available');
    return o.playbooks;
  };
  o.server.route('POST', '/api/playbooks/get', 'human', async ({ body }) => {
    const b = await parse(z.object({ name: z.string().min(1).max(40) }), body);
    return act(() => playbooks().get(b.name));
  });
  o.server.route('POST', '/api/playbooks/save', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ name: z.string().min(1).max(40), description: z.string().min(1).max(500), body: z.string().min(1).max(60_000) }), body);
    const meta = await act(() => playbooks().save(b));
    o.board.recordControl(human(principal), `saved the playbook "${meta.name}"`);
    return meta;
  });
  o.server.route('POST', '/api/playbooks/delete', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ name: z.string().min(1).max(40) }), body);
    await act(() => playbooks().remove(b.name));
    o.board.recordControl(human(principal), `deleted the playbook "${b.name}"`);
    return { ok: true };
  });

  // ── schedules: start a mission on a timer or when another finishes. They only ever create a mission,
  //    which then waits for the Human's approval like any other. ──
  const schedules = () => {
    if (!o.schedules) throw new HttpError(503, 'Schedules are not available');
    return o.schedules;
  };
  const Trigger = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('cron'), cron: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('daily'), time: z.string().max(5) }),
    z.object({ kind: z.literal('weekly'), weekday: z.number().int(), time: z.string().max(5) }),
    z.object({ kind: z.literal('every_hours'), hours: z.number().int() }),
    z.object({ kind: z.literal('mission_done'), watch: z.string().min(1).max(32) }),
  ]);
  const ScheduleBody = z.object({
    name: z.string().min(1).max(200),
    brief: z.string().min(1).max(20_000),
    plannerAgentId: z.string().min(1).max(64),
    reviewerAgentIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    maxRounds: z.number().int().optional(),
    trigger: Trigger,
  });
  const asInput = (b: z.infer<typeof ScheduleBody>): ScheduleInput => ({ name: b.name, brief: b.brief, plannerAgentId: b.plannerAgentId, ...(b.reviewerAgentIds ? { reviewerAgentIds: b.reviewerAgentIds } : {}), ...(b.maxRounds ? { maxRounds: b.maxRounds } : {}), trigger: b.trigger });
  const ScheduleId = z.string().regex(/^S\d{1,6}$/);

  o.server.route('POST', '/api/schedules', 'human', async ({ principal, body }) => {
    const b = await parse(ScheduleBody, body);
    const s = await act(() => schedules().create(asInput(b)));
    o.board.recordControl(human(principal), `created schedule ${s.id} "${s.name}" (${s.when})`);
    return s;
  });
  o.server.route('POST', '/api/schedules/get', 'human', async ({ body }) => {
    const b = await parse(z.object({ id: ScheduleId }), body);
    return act(() => schedules().get(b.id));
  });
  o.server.route('POST', '/api/schedules/update', 'human', async ({ principal, body }) => {
    const b = await parse(ScheduleBody.extend({ id: ScheduleId }), body);
    const s = await act(() => schedules().update(b.id, asInput(b)));
    o.board.recordControl(human(principal), `changed schedule ${s.id} "${s.name}" (${s.when})`);
    return s;
  });
  o.server.route('POST', '/api/schedules/enable', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ id: ScheduleId, enabled: z.boolean() }), body);
    const s = await act(() => schedules().setEnabled(b.id, b.enabled));
    o.board.recordControl(human(principal), `${b.enabled ? 'switched on' : 'switched off'} schedule ${s.id} "${s.name}"`);
    return s;
  });
  o.server.route('POST', '/api/schedules/run', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ id: ScheduleId }), body);
    const run = await act(() => schedules().runNow(b.id));
    o.board.recordControl(human(principal), `ran schedule ${b.id} now: ${run.outcome === 'started' ? `started ${run.missionId}` : run.outcome.replace(':', ' ')}`);
    return run;
  });
  o.server.route('POST', '/api/schedules/delete', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ id: ScheduleId }), body);
    await act(() => schedules().remove(b.id));
    o.board.recordControl(human(principal), `deleted schedule ${b.id}`);
    return { ok: true };
  });

  o.server.route('POST', '/api/stop-run', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ agentId: z.string().min(1).max(64) }), body);
    if (!o.dispatcher) throw new HttpError(503, 'Dispatcher not running');
    const stopped = await o.dispatcher.stopRun(b.agentId);
    if (stopped) o.board.recordControl(human(principal), `stopped ${b.agentId}'s run`);
    return { stopped };
  });
}
