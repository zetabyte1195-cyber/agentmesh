// Human-in-the-loop controls (P3.3; spec v1.1 §11–12). Every route is Human-only ('human' auth), and
// cookie-authenticated writes must also carry the daemon's Origin (enforced by the P2.6 server).
// Everything the Human does goes through the same services, rules and events as an agent's action.
import { z } from 'zod';
import { type AuditGate, AuditGateError } from '../audit/index.js';
import { BoardError, type BoardService } from '../board/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import { MissionError, type MissionService } from '../missions/index.js';
import type { Principal } from '../identity/index.js';
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
const REFUSALS = [BoardError, AuditGateError, ReviewError, MissionError] as const;
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
      }),
      body,
    );
    return act(() => missions().create(human(principal), { title: b.title, brief: b.brief, plannerAgentId: b.plannerAgentId, ...(b.reviewerAgentIds ? { reviewerAgentIds: b.reviewerAgentIds } : {}), ...(b.maxRounds ? { maxRounds: b.maxRounds } : {}) }));
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

  o.server.route('POST', '/api/stop-run', 'human', async ({ principal, body }) => {
    const b = await parse(z.object({ agentId: z.string().min(1).max(64) }), body);
    if (!o.dispatcher) throw new HttpError(503, 'Dispatcher not running');
    const stopped = await o.dispatcher.stopRun(b.agentId);
    if (stopped) o.board.recordControl(human(principal), `stopped ${b.agentId}'s run`);
    return { stopped };
  });
}
