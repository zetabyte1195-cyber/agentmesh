// Dispatcher (P2.5; spec v1.1 §10.2): decides WHAT headless agent run to start and WHEN, then
// starts it with the P2.2 runner. Everything it must remember lives in SQLite, not in memory or
// a shell: an agent session going idle killed a sleep-based auto-dispatch during this build
// (board finding on P2.5).
//   • one run per agent at a time (dispatch_runs)
//   • platform back-off after quota errors, e.g. agy 429 RESOURCE_EXHAUSTED "Resets in 1h51m46s"
//   • global and per-agent pause (dispatch_state)
//   • each run gets its own token, revoked when the run ends
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BudgetService } from '../budget/index.js';
import type { SqliteDatabase } from '../db/index.js';
import type { Migration } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import type { IdentityService, Principal } from '../identity/index.js';
import type { LeaseArbiter } from '../leases/index.js';
import { type MissionService, planJob, reviewJob, reviseJob, splitJob } from '../missions/index.js';
import { MISSION_PHASE_PREFIX } from '../missions/service.js';
import type { AgentCommand } from '../runner/commands.js';
import { type RunResult, type RunningAgent, startAgent } from '../runner/run.js';
import { type SandboxRuntime, explainSandboxFailure } from '../sandbox/index.js';
import { composePrompt } from './prompt.js';
import { hasUsageTable, recordUsage } from './usage.js';

export const DISPATCH_MIGRATION: Migration = {
  version: 3,
  name: '0003_dispatch',
  up: `
    CREATE TABLE IF NOT EXISTS dispatch_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        task_id TEXT,
        -- tasks.updated_at when the run started: lets the retry brake compare DB value to DB value, never two clocks
        task_version TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('AUDIT', 'HANDOFF', 'TASK')),
        status TEXT NOT NULL CHECK(status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'QUOTA', 'STOPPED', 'ABANDONED')),
        detail TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_runs_agent ON dispatch_runs(agent_id, status);
    CREATE TABLE IF NOT EXISTS platform_backoff (
        platform TEXT PRIMARY KEY,
        until TEXT NOT NULL,
        reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
  `,
};

export type WorkKind = 'AUDIT' | 'HANDOFF' | 'TASK' | 'PLAN' | 'PLAN_REVIEW' | 'PLAN_REVISE' | 'SPLIT';

const MISSION_KINDS: ReadonlySet<WorkKind> = new Set(['PLAN', 'PLAN_REVIEW', 'PLAN_REVISE', 'SPLIT']);
/** Mission runs are recorded against "mission:<id>" where task runs use a task id. */
const missionKey = (missionId: string) => `mission:${missionId}`;

export interface StuckWork {
  agentId: string;
  /** A task id, or "mission:<id>" for a planning step. */
  subject: string;
  tries: number;
  lastEnded: string;
  lastStatus: string;
  lastDetail: string | null;
}

export interface Work {
  kind: WorkKind;
  taskId: string | null;
  /** One line telling the agent what to do; the board holds the context. */
  job: string;
  /** TASK only: already claimed by this agent; run in its existing worktree without claiming again. */
  resume?: boolean;
}

export interface DispatchableAgent {
  agentId: string;
  platform: string;
  /** Names this agent answers to in tasks.suggested_owner. Default: its id, its platform, and the friendly name ("Claude", "Gemini"). */
  ownerNames?: readonly string[];
  /** Rulebook the agent must follow, e.g. CLAUDE.md / GEMINI.md. */
  rulebook: string;
  /** Build the launch command for a prompt and working directory; `run` holds this run's MCP config files. */
  command: (prompt: string, cwd: string, run: RunContext) => AgentCommand;
}

/**
 * Per-run MCP wiring, kept OUTSIDE the repository so a token can never be committed. The dispatcher
 * creates it at launch, deletes it when the run ends, and the token inside is revoked then too.
 */
export interface RunContext {
  token: string;
  mcpUrl: string;
  /** Temp folder holding both configs; pass it to agy as an extra --add-dir. */
  dir: string;
  /** Claude-format config ({type:'http', url, headers}) for claude --mcp-config. */
  claudeMcpConfig: string;
  toolConfigs?: { opencode: string; gemini: string };
  /** The text written to toolConfigs.opencode (see PlatformRunContext). */
  opencodeConfigJson?: string;
  inContainer?: boolean;
}

export interface DispatcherOptions {
  /** The daemon's MCP endpoint, e.g. http://127.0.0.1:8934/mcp. */
  mcpUrl?: string;
  /** The Human's note about the project (read at each launch, so edits apply to the next run). */
  context?: () => string | null | undefined;
  /** The playbook list for the prompt, within a character budget (see playbooks/). */
  playbooks?: (maxChars: number) => string;
  /** Container mode (experimental): agents it applies to run inside a container; while it is blocked they wait. */
  sandbox?: SandboxRuntime;
  /** A mission that has reached its spending limit gets no new runs (see budget/). */
  budget?: BudgetService;
  /**
   * Whether finished work can land on trunk (a project check is set, or the Human opted in to landing without one). A task
   * that builds on another waits for it to have LANDED; when nothing can ever land, an audited (PASSED) one is enough, or the
   * mission would wait for ever. Default: landing is on.
   */
  landing?: () => boolean;
  db: SqliteDatabase;
  identity: IdentityService;
  leases?: LeaseArbiter;
  agents: readonly DispatchableAgent[];
  /** Where agents run when their work has no task worktree. */
  repoRoot: string;
  now?: () => Date;
  runTimeoutMs?: number;
  /** Claim a TASK for the agent before launch (daemon wires BoardService.claimTask). Returns the worktree the agent will run in. */
  claim?: (principal: Principal, taskId: string) => Promise<{ worktree: string }>;
  /** Missions: planning work is handed out from here. */
  missions?: MissionService;
  /** Planning runs work in a disposable checkout of trunk, never in the Human's working tree. */
  scratch?: { create(name: string): Promise<string>; remove(path: string): Promise<void> };
  /** Test seam; defaults to the P2.2 runner. */
  start?: typeof startAgent;
  onRunFinished?: (run: { runId: string; agentId: string; work: Work; result: RunResult }) => void;
}

/** Parse "Resets in 1h51m46s" (as printed by agy on quota exhaustion) into milliseconds. */
export function parseResetDelay(text: string): number | null {
  const m = /resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Quota / rate-limit signals in a failed run. agy's form is verified; the rest are defensive. */
/** Provider-side outage, as agy reported during live AC-8 run #2: UNAVAILABLE (code 503). */
export function isTransientFailure(text: string): boolean {
  return /UNAVAILABLE|\b503\b|service is currently unavailable/i.test(text);
}
export const TRANSIENT_BACKOFF_MS = 2 * 60_000;

export function isQuotaFailure(text: string): boolean {
  return /RESOURCE_EXHAUSTED|quota (reached|exceeded)|rate.?limit|\b429\b/i.test(text);
}

const DEFAULT_BACKOFF_MS = 30 * 60_000;
const FRIENDLY: Record<string, string> = { CLAUDE_CODE: 'Claude', ANTIGRAVITY: 'Gemini' };
const ownerNames = (a: DispatchableAgent): string[] => [...new Set([a.agentId, a.platform, FRIENDLY[a.platform] ?? a.platform, ...(a.ownerNames ?? [])])];
/** After ANY run on a task (even a clean exit that made no progress), the same agent waits this long... */
export const RETRY_AFTER_MS = 10 * 60_000;
/** ...and after this many runs without the task changing, the work is left for the Human (no cost-burning loop). */
export const MAX_ATTEMPTS_PER_TASK = 3;
/** SQLite CURRENT_TIMESTAMP format (UTC), so run times compare correctly with handoffs.created_at. */
const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);

/**
 * Best-effort: on Windows the folder can still be locked (EBUSY) as the agent exits. A throw here
 * used to skip finish(), leaving the agent busy forever (Gemini, P2.7 audit). A leftover folder is
 * harmless: it is outside the repo and its token is revoked when the run ends.
 */
function removeRunDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // left for the OS temp cleanup
  }
}

/**
 * Write one run's MCP configs (Claude and agy formats, both verified) into a fresh temp folder OUTSIDE the
 * repository, so the run's token can never be committed. The caller deletes the folder when the run ends.
 */
export function writeRunContext(token: string, mcpUrl: string): RunContext {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-run-'));
  const headers = { Authorization: `Bearer ${token}` };
  const claudeMcpConfig = join(dir, 'claude-mcp.json');
  writeFileSync(claudeMcpConfig, JSON.stringify({ mcpServers: { agentmesh: { type: 'http', url: mcpUrl, headers } } }));
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { agentmesh: { serverUrl: mcpUrl, headers, disabled: false } } }));
  // Other tools read the same connection in their own formats. Each file holds this run's token, lives in the run folder
  // (outside the repository) and is deleted with it when the run ends.
  const opencode = join(dir, 'opencode-mcp.json');
  const opencodeConfigJson = JSON.stringify({ mcp: { agentmesh: { type: 'remote', url: mcpUrl, enabled: true, oauth: false, headers } } });
  writeFileSync(opencode, opencodeConfigJson);
  const gemini = join(dir, 'gemini-settings.json');
  writeFileSync(gemini, JSON.stringify({ mcpServers: { agentmesh: { httpUrl: mcpUrl, headers, trust: true } } }));
  return { token, mcpUrl, dir, claudeMcpConfig, toolConfigs: { opencode, gemini }, opencodeConfigJson };
}

export class Dispatcher {
  /** agent === null while the daemon is still claiming the task for this run. */
  private readonly running = new Map<string, { runId: string; taskId: string | null; agent: RunningAgent | null }>();
  private timer: NodeJS.Timeout | null = null;
  private usageTable: boolean | undefined;
  /** run id -> the container's name, for the runs that started in one. */
  private readonly containers = new Map<string, string | null>();
  private readonly now: () => Date;
  /** The agents this dispatcher may run; the Human can connect more while it runs (cockpit setup). */
  private readonly agents: DispatchableAgent[];

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? (() => new Date());
    this.agents = [...options.agents];
    // Runs recorded as RUNNING by a previous daemon process can't still be ours.
    options.db
      .prepare("UPDATE dispatch_runs SET status = 'ABANDONED', ended_at = ?, detail = coalesce(detail, 'daemon restarted') WHERE status = 'RUNNING'")
      .run(sqlTime(this.now()));
    // ...and their run tokens can't still be needed (Gemini, P2.5 audit: they stayed valid).
    options.db.prepare("UPDATE agent_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE label LIKE 'dispatch:%' AND revoked_at IS NULL").run();
  }

  addAgent(agent: DispatchableAgent): void {
    if (this.agents.some((a) => a.agentId === agent.agentId)) throw new Error(`Agent ${agent.agentId} is already connected`);
    this.agents.push(agent);
  }

  agentIds(): string[] {
    return this.agents.map((a) => a.agentId);
  }

  // ── Human controls (persisted) ───────────────────────────────────────────
  pause(agentId?: string): void {
    this.setState(agentId ? `paused:${agentId}` : 'paused', '1');
  }
  resume(agentId?: string): void {
    this.options.db.prepare('DELETE FROM dispatch_state WHERE key = ?').run(agentId ? `paused:${agentId}` : 'paused');
  }
  isPaused(agentId?: string): boolean {
    const get = (k: string) => Boolean(this.options.db.prepare('SELECT 1 FROM dispatch_state WHERE key = ?').get(k));
    return get('paused') || (agentId ? get(`paused:${agentId}`) : false);
  }

  /**
   * Work an agent has stopped trying: MAX_ATTEMPTS_PER_TASK runs on the same version of a task or mission
   * step without moving it forward. It stays like this until the Human looks (Try again) or the work
   * changes (a new version resets the count by itself).
   */
  stuck(): StuckWork[] {
    const db = this.options.db;
    const version = this.options.missions
      ? "(CASE WHEN r.task_id LIKE 'mission:%' THEN (SELECT updated_at FROM missions WHERE id = substr(r.task_id, 9)) ELSE (SELECT updated_at FROM tasks WHERE id = r.task_id) END)"
      : '(SELECT updated_at FROM tasks WHERE id = r.task_id)';
    const rows = db
      .prepare(
        `SELECT r.agent_id AS agentId, r.task_id AS subject, count(*) AS tries, max(r.ended_at) AS lastEnded
           FROM dispatch_runs r
          WHERE r.task_id IS NOT NULL AND r.status != 'RUNNING' AND r.task_version IS ${version} AND r.started_at >= coalesce((SELECT value FROM dispatch_state WHERE key = 'retry:' || r.agent_id || ':' || r.task_id), '')
          GROUP BY r.agent_id, r.task_id HAVING count(*) >= ?`,
      )
      .all(MAX_ATTEMPTS_PER_TASK) as { agentId: string; subject: string; tries: number; lastEnded: string }[];
    const last = db.prepare('SELECT status, detail FROM dispatch_runs WHERE agent_id = ? AND task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1');
    const stillOpen = (subject: string): boolean => {
      if (subject.startsWith('mission:')) {
        if (!this.options.missions) return false;
        const m = db.prepare('SELECT status FROM missions WHERE id = ?').get(subject.slice(8)) as { status: string } | undefined;
        return Boolean(m && m.status !== 'DONE' && m.status !== 'CANCELLED');
      }
      const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(subject) as { status: string } | undefined;
      return Boolean(t && t.status !== 'COMMITTED');
    };
    // Work of a cancelled or over-budget mission is not "given up" news: there is nothing to try again until that is dealt with.
    const stopped = this.stoppedMissions();
    return rows
      .filter((r) => stillOpen(r.subject) && !stopped.has(this.missionOf(r.subject) ?? '') && this.running.get(r.agentId)?.taskId !== r.subject)
      .map((r) => {
        const l = last.get(r.agentId, r.subject) as { status: string; detail: string | null };
        return { ...r, lastStatus: l.status, lastDetail: l.detail };
      });
  }

  /** Human control: forget this agent's past tries at this task or mission step, so it is picked up again. */
  retry(agentId: string, subject: string): void {
    this.setState(`retry:${agentId}:${subject}`, sqlTime(this.now()));
  }

  /** Platforms currently backing off, e.g. after a quota error. */
  backoffs(): { platform: string; until: string; reason: string }[] {
    return this.options.db.prepare('SELECT platform, until, reason FROM platform_backoff WHERE until > ?').all(sqlTime(this.now())) as {
      platform: string;
      until: string;
      reason: string;
    }[];
  }

  isBusy(agentId: string): boolean {
    return this.running.has(agentId);
  }

  /** True while any agent process for this task is running (or being claimed). */
  isTaskBusy(taskId: string): boolean {
    return [...this.running.values()].some((r) => r.taskId === taskId);
  }

  /** Run ticks on an interval inside the daemon process. */
  start(intervalMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop a running agent (Human control). Ends the whole process tree. */
  async stopRun(agentId: string): Promise<boolean> {
    const r = this.running.get(agentId);
    if (!r?.agent) return false;
    await r.agent.stop();
    return true;
  }

  /**
   * One scheduling pass: for each idle, unpaused agent whose platform isn't backing off, pick the
   * most useful work and start it. Returns the runs started. Never starts two runs for one agent.
   */
  tick(): { agentId: string; work: Work; runId: string }[] {
    this.options.missions?.sync(); // a mission whose tasks are all committed is done
    if (this.isPaused()) return [];
    const started: { agentId: string; work: Work; runId: string }[] = [];
    const cooling = new Set(this.backoffs().map((b) => b.platform));
    for (const agent of this.agents) {
      if (this.isBusy(agent.agentId) || this.isPaused(agent.agentId) || cooling.has(agent.platform)) continue;
      // A containerized agent waits (no run started, no attempt used) while its container engine is down: it never runs outside the container instead.
      if (this.options.sandbox?.appliesTo(agent.agentId) && this.options.sandbox.blockedReason()) continue;
      const work = this.nextWork(agent);
      if (!work) continue;
      const runId = this.launch(agent, work);
      if (runId) started.push({ agentId: agent.agentId, work, runId });
    }
    return started;
  }

  /** Missions nothing may be started for: over their spending limit, or cancelled (cancelling leaves the tasks on the board). */
  private stoppedMissions(): Set<string> {
    const stopped = new Set(this.options.budget?.reached().keys() ?? []);
    if (this.options.missions) for (const m of this.options.db.prepare("SELECT id FROM missions WHERE status = 'CANCELLED'").all() as { id: string }[]) stopped.add(m.id);
    return stopped;
  }

  /** The mission a run's subject belongs to: "mission:M1" or one of its tasks. Null for a task of no mission. */
  private missionOf(subject: string): string | null {
    if (subject.startsWith(MISSION_PHASE_PREFIX)) return subject.slice(MISSION_PHASE_PREFIX.length);
    const phase = (this.options.db.prepare('SELECT phase_id FROM tasks WHERE id = ?').get(subject) as { phase_id: string | null } | undefined)?.phase_id;
    return phase?.startsWith(MISSION_PHASE_PREFIX) ? phase.slice(MISSION_PHASE_PREFIX.length) : null;
  }

  /** Priority: audits this agent may do (they unblock others) → handoffs to it → claimable tasks for it. */
  nextWork(agent: DispatchableAgent): Work | null {
    const db = this.options.db;
    // Missions that are stopped, because they reached their spending limit or were cancelled: nothing is started for them
    // (steps, tasks, reviews, messages). Runs already going finish, as with pausing. Other missions are not held up: each
    // pick below skips these.
    const stopped = this.stoppedMissions();
    const taskStopped = (taskId: string | null | undefined): boolean => {
      if (!taskId || stopped.size === 0) return false;
      const phase = (db.prepare('SELECT phase_id FROM tasks WHERE id = ?').get(taskId) as { phase_id: string | null } | undefined)?.phase_id;
      return Boolean(phase?.startsWith(MISSION_PHASE_PREFIX) && stopped.has(phase.slice(MISSION_PHASE_PREFIX.length)));
    };
    // A mission step comes first: the Human is watching it, and it is short.
    // (A mission that is stopped, or cooling down after a failure, is passed over so the next one can be started.)
    const mission = this.options.missions?.workFor(agent.agentId, (id) => stopped.has(id) || !this.mayRetry(agent.agentId, missionKey(id)));
    if (mission) return this.missionWork(mission);

    // An audit this agent already claimed whose run ended without a verdict (it stopped to ask a question, or
    // failed) is theirs to finish: nobody else can, and the task would sit in AUDITING forever.
    const claimedAudit = (db.prepare("SELECT id FROM tasks WHERE status = 'AUDITING' AND reviewing_agent_id = ? ORDER BY updated_at, id").all(agent.agentId) as { id: string }[]).find((r) => !taskStopped(r.id) && this.mayRetry(agent.agentId, r.id));
    if (claimedAudit) {
      return { kind: 'AUDIT', taskId: claimedAudit.id, job: `You already claimed the audit of task ${claimedAudit.id} but ended without a verdict. Read the answers and messages to you (mesh_get_board, mesh_get_task), read the pinned diff with mesh_get_diff, run the project checks with mesh_run_verification, then finish with mesh_submit_audit using the pinned diffHash.` };
    }
    const audit = db
      .prepare(
        `SELECT t.id FROM tasks t JOIN agents a ON a.id = t.assigned_agent_id
          WHERE t.status = 'READY_FOR_REVIEW' AND a.platform != ? AND t.assigned_agent_id != ?
          ORDER BY t.updated_at, t.id`,
      )
      .all(agent.platform, agent.agentId)
      .map((r) => r as { id: string })
      .find((r) => !taskStopped(r.id) && this.mayRetry(agent.agentId, r.id));
    if (audit) return { kind: 'AUDIT', taskId: audit.id, job: `Audit task ${audit.id} (READY_FOR_REVIEW): mesh_claim_audit, read the pinned diff with mesh_get_diff, run the project checks with mesh_run_verification (no shell commands needed), review critically against the acceptance criteria, then mesh_submit_audit with the pinned diffHash.` };

    // A handoff is DELIVERED once a run of its recipient that started after it arrived has succeeded:
    // every run begins with mesh_get_board, which lists handoffs. Failed runs don't count, so delivery
    // is retried under the same brake as tasks (Gemini's review of the dogfood fixes: the old global
    // "since the last run started" filter lost handoffs for good, the Human's included). An agent's
    // note to the author of a task that already PASSED/landed needs no run of its own (dogfood: such
    // runs cost quota and held up landing); it is still shown on the board. The Human's always get a run.
    const retryCutoff = sqlTime(new Date(this.now().getTime() - RETRY_AFTER_MS));
    const handoffs = db
      .prepare(
        `SELECT h.task_id FROM handoffs h LEFT JOIN tasks t ON t.id = h.task_id
          WHERE h.to_agent_id = ?
            AND NOT EXISTS (SELECT 1 FROM dispatch_runs r WHERE r.agent_id = h.to_agent_id AND r.status = 'SUCCEEDED' AND r.started_at >= h.created_at)
            AND (SELECT count(*) FROM dispatch_runs r WHERE r.agent_id = h.to_agent_id AND r.kind = 'HANDOFF' AND r.status != 'RUNNING' AND r.started_at >= max(h.created_at, coalesce((SELECT value FROM dispatch_state WHERE key = 'retry:' || h.to_agent_id || ':' || h.task_id), ''))) < ?
            AND NOT EXISTS (SELECT 1 FROM dispatch_runs r WHERE r.agent_id = h.to_agent_id AND r.kind = 'HANDOFF' AND r.status != 'RUNNING' AND r.started_at >= h.created_at AND r.ended_at > ?)
            AND NOT (coalesce((SELECT platform FROM agents WHERE id = h.from_agent_id), '') != 'HUMAN'
                     AND t.status IN ('PASSED', 'COMMITTED') AND t.assigned_agent_id = h.to_agent_id)
          ORDER BY h.created_at`,
      )
      .all(agent.agentId, MAX_ATTEMPTS_PER_TASK, retryCutoff) as { task_id: string }[];
    const handoff = handoffs.find((h) => !taskStopped(h.task_id));
    if (handoff) return { kind: 'HANDOFF', taskId: handoff.task_id, job: `You have new handoffs (latest on task ${handoff.task_id}). Read them on the board and act on them.` };

    // Finish what it already holds before claiming more: a run that died after the claim (live run #4)
    // stays IN_PROGRESS, and a task sent back with GAP_FOUND becomes REJECTED (trg_audit_apply_verdict;
    // Gemini, P3.5 audit). Both stay with their author and were never picked up again.
    const heldRows = db
      .prepare("SELECT id, status FROM tasks WHERE status IN ('CLAIMED', 'IN_PROGRESS', 'TESTING', 'REJECTED') AND assigned_agent_id = ? AND worktree_path IS NOT NULL ORDER BY updated_at, id")
      .all(agent.agentId) as { id: string; status: string }[];
    // A held task of a stopped mission waits (it stays the agent's) without keeping the agent from other missions' work.
    const heldIds = heldRows.filter((r) => !taskStopped(r.id)).map((r) => r.id);
    const held = heldRows.find((r) => !taskStopped(r.id) && this.mayRetry(agent.agentId, r.id));
    if (held) {
      // REJECTED allows no leases or commits: the author reopens it first (REJECTED → IN_PROGRESS is an author move).
      const reopen = held.status === 'REJECTED' ? `It was sent back by its reviewer: read the audit notes, then reopen it with mesh_update_status (status IN_PROGRESS) before anything else. ` : '';
      return {
        kind: 'TASK',
        taskId: held.id,
        resume: true,
        job: `Continue task ${held.id}: it is already yours and your working directory is its worktree. ${reopen}Read the task, its audits and handoffs on the board (mesh_get_task) to see what is left, lease what you edit, check your work with mesh_run_verification, commit with mesh_commit, then mesh_submit_for_review.`,
      };
    }
    // A held task only cooling down still has this agent's attention: no new claims until it is finished
    // or its attempts are used up (then it is the Human's, and the agent may move on).
    if (heldIds.some((id) => !this.attemptsExhausted(agent.agentId, id))) return null;

    const todo = db
      .prepare(
        `SELECT id, prerequisites FROM tasks
          WHERE status = 'TODO' AND (suggested_owner IS NULL OR suggested_owner = 'Pair' OR suggested_owner IN (SELECT value FROM json_each(?)))
          ORDER BY priority, id`,
      )
      .all(JSON.stringify(ownerNames(agent))) as { id: string; prerequisites: string }[];
    const ready = todo.find((t) =>
      !taskStopped(t.id) &&
      this.mayRetry(agent.agentId, t.id) &&
      (JSON.parse(t.prerequisites) as string[]).every((p) => {
        const s = db.prepare('SELECT status FROM tasks WHERE id = ?').get(p) as { status: string } | undefined;
        // A task that builds on another waits until that one has LANDED on trunk, not merely passed its audit. Its workspace
        // is created from trunk, so before the landing the files it builds on are not there. (Found in a real mission: the
        // dependent task failed on a missing file, had to improvise, its patch changed under the rebase, and it needed a
        // second audit. Landing takes seconds.)
        return s?.status === 'COMMITTED' || (s?.status === 'PASSED' && this.options.landing?.() === false);
      }),
    );
    if (ready) return { kind: 'TASK', taskId: ready.id, job: `Claim task ${ready.id} with mesh_claim_task, work only in the worktree it returns, lease what you edit, check your work with mesh_run_verification, commit with mesh_commit, then mesh_submit_for_review.` };
    return null;
  }

  /**
   * Retry brake for one agent+task, counting EVERY finished run since the task last changed
   * (Gemini, P2.5 audit): a run that exits 0 without progress must not be re-dispatched every tick.
   * Real progress bumps tasks.updated_at and resets the count. "Since the task last changed" is the
   * task_version recorded at launch, not a time comparison: the dispatcher's clock and SQLite's
   * CURRENT_TIMESTAMP can differ (Gemini's clock-skew probe, P2.5).
   */
  private mayRetry(agentId: string, taskId: string): boolean {
    const row = this.attempts(agentId, taskId);
    if (row.n >= MAX_ATTEMPTS_PER_TASK) return false;
    return !row.last || row.last <= sqlTime(new Date(this.now().getTime() - RETRY_AFTER_MS));
  }

  private attemptsExhausted(agentId: string, taskId: string): boolean {
    return this.attempts(agentId, taskId).n >= MAX_ATTEMPTS_PER_TASK;
  }

  // A run ABANDONED by a daemon restart still counts as an attempt (a run that crashes the daemon cannot loop
  // forever), but its end time does not start the ten-minute wait: the agent did nothing wrong, and its
  // half-done task should resume as soon as AgentMesh is back.
  private attempts(agentId: string, taskId: string): { n: number; last: string | null } {
    // With missions, a run's subject is a task OR a mission; each has its own version column.
    const sql = this.options.missions
      ? `SELECT count(*) AS n, max(CASE WHEN r.status != 'ABANDONED' THEN r.ended_at END) AS last FROM dispatch_runs r
          WHERE r.agent_id = ? AND r.task_id = ? AND r.status != 'RUNNING' AND r.started_at >= coalesce((SELECT value FROM dispatch_state WHERE key = 'retry:' || r.agent_id || ':' || r.task_id), '')
            AND r.task_version IS (CASE WHEN r.task_id LIKE 'mission:%' THEN (SELECT updated_at FROM missions WHERE id = substr(r.task_id, 9)) ELSE (SELECT updated_at FROM tasks WHERE id = r.task_id) END)`
      : `SELECT count(*) AS n, max(CASE WHEN r.status != 'ABANDONED' THEN r.ended_at END) AS last FROM dispatch_runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.agent_id = ? AND r.task_id = ? AND r.status != 'RUNNING' AND r.task_version IS t.updated_at AND r.started_at >= coalesce((SELECT value FROM dispatch_state WHERE key = 'retry:' || r.agent_id || ':' || r.task_id), '')`;
    return this.options.db.prepare(sql).get(agentId, taskId) as { n: number; last: string | null };
  }

  private missionWork(m: { kind: 'PLAN' | 'PLAN_REVIEW' | 'PLAN_REVISE' | 'SPLIT'; missionId: string }): Work {
    const info = this.options.missions!.get(m.missionId);
    const ref = { id: info.id, title: info.title };
    const owners = (this.options.db.prepare("SELECT name FROM agents WHERE platform != 'HUMAN' ORDER BY id").all() as { name: string }[]).map((r) => r.name);
    const job = m.kind === 'PLAN' ? planJob(ref) : m.kind === 'PLAN_REVIEW' ? reviewJob(ref, info.round) : m.kind === 'PLAN_REVISE' ? reviseJob(ref) : splitJob(ref, [...new Set(owners)]);
    return { kind: m.kind, taskId: missionKey(m.missionId), job };
  }

  /** The version a run is recorded against, so the retry brake can tell "nothing changed" from progress. */
  private versionOf(subject: string): string | null {
    const row = subject.startsWith('mission:') && this.options.missions
      ? this.options.db.prepare('SELECT updated_at FROM missions WHERE id = ?').get(subject.slice(8))
      : this.options.db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(subject);
    return (row as { updated_at: string } | undefined)?.updated_at ?? null;
  }

  /**
   * Returns the run id, or null if the launch failed synchronously (recorded as FAILED; token revoked).
   * TASK work with a `claim` hook is claimed BY THE DAEMON before the agent starts, and the agent runs
   * inside the new worktree: plain `git add` / `git commit` then match its allowlist (live AC-8 run #1:
   * starting in the repo root forced `cd`/`git -C`, which the allowlist refused).
   */
  private launch(agent: DispatchableAgent, work: Work): string | null {
    const { db, identity } = this.options;
    const runId = randomUUID();
    const token = identity.issueToken(agent.agentId, `dispatch:${runId}`);
    const taskVersion = work.taskId ? this.versionOf(work.taskId) : null;
    db.prepare("INSERT INTO dispatch_runs (id, agent_id, task_id, task_version, kind, status, started_at) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?)").run(
      runId,
      agent.agentId,
      work.taskId,
      taskVersion,
      work.kind,
      sqlTime(this.now()),
    );
    const run = this.writeRunContext(token, this.options.sandbox?.appliesTo(agent.agentId) ? this.options.sandbox.mcpUrl() : undefined);
    const fail = (message: string) => {
      identity.revokeToken(token);
      removeRunDir(run.dir);
      this.running.delete(agent.agentId);
      db.prepare("UPDATE dispatch_runs SET status = 'FAILED', detail = ?, ended_at = ? WHERE id = ?").run(message, sqlTime(this.now()), runId);
    };

    if (work.kind === 'TASK' && !work.resume && work.taskId && this.options.claim) {
      this.running.set(agent.agentId, { runId, taskId: work.taskId ?? null, agent: null }); // busy while claiming
      const taskId = work.taskId;
      void this.options
        .claim(identity.authenticate(token), taskId)
        .then(({ worktree }) => {
          // The claim itself changed the task: record the post-claim version, or the retry brake
          // treats the next run as the first on a new version (dogfood V1.1: re-run 1 s after a no-op run).
          db.prepare('UPDATE dispatch_runs SET task_version = (SELECT updated_at FROM tasks WHERE id = ?) WHERE id = ?').run(taskId, runId);
          const job = `Task ${taskId} is already claimed for you, and your working directory is its worktree. Lease each file you edit (mesh_acquire_lease), do the work, check it with mesh_run_verification (the daemon runs the project's checks for you), commit with mesh_commit (the daemon runs git for you), then call mesh_submit_for_review.`;
          if (!this.startRun(agent, { ...work, job }, runId, token, run, worktree)) fail('launch failed after claim');
        })
        .catch((err: unknown) => fail(`claim failed: ${(err as Error).message}`));
      return runId;
    }

    if (MISSION_KINDS.has(work.kind)) {
      const scratch = this.options.scratch;
      if (!scratch) {
        fail('planning runs need a scratch checkout, and none is configured');
        return null;
      }
      this.running.set(agent.agentId, { runId, taskId: work.taskId ?? null, agent: null }); // busy while the checkout is made
      void scratch
        .create(`plan-${runId.slice(0, 8)}`)
        .then((cwd) => {
          const cleanup = () => void scratch.remove(cwd).catch(() => undefined);
          if (!this.startRun(agent, work, runId, token, run, cwd, cleanup)) {
            cleanup();
            fail('launch failed');
          }
        })
        .catch((err: unknown) => fail(`could not prepare a scratch checkout: ${(err as Error).message}`));
      return runId;
    }

    const worktree = work.taskId
      ? ((db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(work.taskId) as { worktree_path: string | null } | undefined)?.worktree_path ?? null)
      : null;
    // A task's workspace is deleted once it is merged; a later run about it (a handoff, say) starts in the
    // project folder instead. Spawning into a missing folder fails with a misleading "executable not found".
    const cwd = worktree && existsSync(worktree) ? worktree : this.options.repoRoot;
    if (!this.startRun(agent, work, runId, token, run, cwd)) {
      return null;
    }
    return runId;
  }

  /** Start the agent process. Returns false (after recording FAILED and revoking the token) if it throws synchronously. */
  private startRun(agent: DispatchableAgent, work: Work, runId: string, token: string, run: RunContext, cwd: string, onExit?: () => void): boolean {
    const { db, identity } = this.options;
    // Headless agy refuses reads in the main repository outside the worktree (e.g. its .agentmesh/
    // folder, which is local and not in the worktree) and a refusal ends the run: verified in dogfood V1.1.
    const base = `You are ${agent.agentId} on AgentMesh. Follow ${agent.rulebook} and start with mesh_get_board. ${work.job} Stay inside your working directory: files of the main repository outside it (such as its .agentmesh/ folder, which is local runtime state and not in your worktree) cannot be read, and a refused action ends your run. Keep mesh_set_status current and set it to idle when you finish.`;
    // The Human's note (and the playbook list) are fitted into the prompt limit: they can be shortened but never make a launch fail.
    const prompt = composePrompt(base, { note: this.options.context?.(), ...(this.options.playbooks ? { catalogue: (n: number) => this.options.playbooks!(n) } : {}) });
    let running: RunningAgent;
    try {
      const principal = identity.authenticate(token);
      // Container mode: the tool is built for the container's view of the paths, then wrapped in the container command.
      let command: AgentCommand;
      let hooks: { terminate: () => Promise<void>; cleanup: () => Promise<void> } | null = null;
      let containerName: string | null = null;
      const sandbox = this.options.sandbox;
      if (sandbox?.appliesTo(agent.agentId)) {
        const view = sandbox.view(run);
        const wrapped = sandbox.wrap(agent.command(prompt, view.cwd, view.run), { runId, cwd, runDir: run.dir, cwdIsRepoRoot: cwd === this.options.repoRoot });
        command = wrapped.command;
        containerName = wrapped.name;
        hooks = sandbox.hooks(wrapped.name);
      } else {
        command = agent.command(prompt, cwd, run);
      }
      this.containers.set(runId, containerName);
      running = (this.options.start ?? startAgent)({
        command,
        cwd,
        env: { AGENTMESH_TOKEN: token },
        ...(hooks ? { terminate: hooks.terminate, cleanup: hooks.cleanup } : {}),
        ...(this.options.runTimeoutMs ? { timeoutMs: this.options.runTimeoutMs } : {}),
        heartbeat: {
          intervalMs: 30_000,
          beat: () => {
            if (!this.options.leases || !work.taskId) return;
            const ids = this.options.leases.activeLeases(work.taskId).filter((l) => l.agentId === agent.agentId).map((l) => l.id);
            if (ids.length) this.options.leases.renew(principal, ids);
          },
        },
      });
    } catch (err) {
      // Synchronous launch failure (command builder or spawn setup threw): the token dies here.
      identity.revokeToken(token);
      removeRunDir(run.dir);
      this.running.delete(agent.agentId);
      db.prepare("UPDATE dispatch_runs SET status = 'FAILED', detail = ?, ended_at = ? WHERE id = ?").run(`launch failed: ${(err as Error).message}`, sqlTime(this.now()), runId);
      return false;
    }
    this.running.set(agent.agentId, { runId, taskId: work.taskId ?? null, agent: running });
    void running.done
      .then((result) => {
        removeRunDir(run.dir);
        onExit?.();
        this.finish(agent, work, runId, token, result);
      })
      .catch((err: unknown) => process.emitWarning(`AgentMesh dispatcher: finishing run ${runId} failed: ${(err as Error).message}`))
      .finally(() => {
        // Whatever failed above, this agent (and its task) must not stay busy forever.
        if (this.running.get(agent.agentId)?.runId === runId) this.running.delete(agent.agentId);
      });
    return true;
  }

  private finish(agent: DispatchableAgent, work: Work, runId: string, token: string, result: RunResult): void {
    const { db, identity } = this.options;
    identity.revokeToken(token); // the run's credential dies with the run
    this.running.delete(agent.agentId);
    const text = [result.failure ?? '', result.result?.text ?? '', ...result.stderrTail].join('\n');
    // Container problems are not the agent's quota: they are explained (and backed off) first.
    const containerName = this.containers.get(runId) ?? null;
    this.containers.delete(runId);
    const infra = containerName ? explainSandboxFailure(result, containerName) : null;
    // A run stopped for repeating itself was stopped by AgentMesh, but it is a failure of the agent, with its reason kept.
    let status: 'SUCCEEDED' | 'FAILED' | 'QUOTA' | 'STOPPED' = result.ok ? 'SUCCEEDED' : result.noProgress ? 'FAILED' : result.stopped && !result.timedOut ? 'STOPPED' : 'FAILED';
    if (infra && infra.backoffMs > 0) {
      db.prepare('INSERT INTO platform_backoff (platform, until, reason) VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET until = excluded.until, reason = excluded.reason').run(agent.platform, sqlTime(new Date(this.now().getTime() + infra.backoffMs)), `container: ${infra.text.slice(0, 180)}`);
    }
    if (!result.ok && !infra && !isQuotaFailure(text) && isTransientFailure(text)) {
      // Provider outage (e.g. agy: UNAVAILABLE 503, seen in live AC-8 run #2): short platform back-off.
      const until = new Date(this.now().getTime() + TRANSIENT_BACKOFF_MS);
      db.prepare('INSERT INTO platform_backoff (platform, until, reason) VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET until = excluded.until, reason = excluded.reason').run(agent.platform, sqlTime(until), 'provider unavailable (transient)');
    }
    if (!result.ok && !infra && isQuotaFailure(text)) {
      status = 'QUOTA';
      const until = new Date(this.now().getTime() + (parseResetDelay(text) ?? DEFAULT_BACKOFF_MS));
      withImmediateTransaction(db, () =>
        db
          .prepare('INSERT INTO platform_backoff (platform, until, reason) VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET until = excluded.until, reason = excluded.reason')
          .run(agent.platform, sqlTime(until), `quota: ${text.trim().split('\n')[0]?.slice(0, 200) ?? ''}`),
      );
    }
    // Keep WHY it failed, not just the exit code: live run #4 recorded only "exited with code 1",
    // and with the process gone the cause was unrecoverable.
    // Successful runs keep the agent's final answer too: a run that "succeeded" without doing the
    // work (dogfood V1.1) is otherwise undiagnosable.
    const rawDetail = (result.ok ? (result.result?.text ?? '') : text).trim().replace(/\n{2,}/g, '\n');
    const detail = (infra ? `[container] ${infra.text}\n${rawDetail}` : rawDetail).slice(-4000) || null;
    db.prepare('UPDATE dispatch_runs SET status = ?, detail = ?, ended_at = ? WHERE id = ?').run(status, detail, sqlTime(this.now()), runId);
    if (result.result && (this.usageTable ??= hasUsageTable(db))) recordUsage(db, runId, result.result.usage, result.result.costUsd);
    this.options.onRunFinished?.({ runId, agentId: agent.agentId, work, result });
  }

  /** Write this run's MCP configs (Claude and agy formats, both verified) into a fresh temp folder. */
  private writeRunContext(token: string, mcpUrl?: string): RunContext {
    return writeRunContext(token, mcpUrl ?? this.options.mcpUrl ?? 'http://127.0.0.1:8934/mcp');
  }

  private setState(key: string, value: string): void {
    this.options.db.prepare('INSERT INTO dispatch_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
