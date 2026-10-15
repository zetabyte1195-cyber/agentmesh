// MCP gateway (P2.1; spec v1.1 §10.1). One McpServer per authenticated caller: the Principal is
// bound when the server is built (stdio: from AGENTMESH_TOKEN at start-up; HTTP: from the P2.6
// server's per-request auth), so no tool takes an agent id and no call can act as someone else.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AuditGate } from '../audit/index.js';
import type { BoardService } from '../board/index.js';
import type { IdentityService, Principal } from '../identity/index.js';
import type { LeaseArbiter } from '../leases/index.js';
import type { MissionService } from '../missions/index.js';
import type { PlaybookStore } from '../playbooks/index.js';
import type { ReviewService } from '../review/index.js';
import type { CommitService } from '../work/index.js';

export interface MeshServices {
  board: BoardService;
  leases: LeaseArbiter;
  gate: AuditGate;
  /** Daemon-executed review tools (pinned diff, configured verification). */
  review?: ReviewService;
  /** Daemon-executed commits in the author's worktree (P3.5). */
  commits?: CommitService;
  /** Missions: plan, review the plan, split it into tasks. */
  missions?: MissionService;
  /** The Human's playbooks: read on demand (the prompt lists only their names). */
  playbooks?: PlaybookStore;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value ?? { ok: true }, null, 2) }] });

/** Errors become tool errors the agent can read; the message never includes a stack. */
async function run(fn: () => unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    return { content: [{ type: 'text', text: `Error${e.code ? ` [${e.code}]` : ''}: ${e.message ?? String(err)}` }], isError: true };
  }
}

const TaskId = z.string().min(1).max(64);
const Severity = z.enum(['INFO', 'SPEC_CORRECTION', 'SECURITY', 'BUG']);

/** Build the tool surface for one authenticated principal. */
export function createMeshMcpServer(principal: Principal, services: MeshServices): McpServer {
  const { board, leases, gate } = services;
  const server = new McpServer({ name: 'agentmesh', version: '0.1.0' });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown) =>
    server.registerTool(name, { description, inputSchema: shape }, ((args: z.objectOutputType<S, z.ZodTypeAny>) => run(() => fn(args))) as never);

  if (services.playbooks) {
    const playbooks = services.playbooks;
    tool('mesh_list_playbooks', "List the Human's playbooks: reusable instructions, each with a one-line description of when it applies.", {}, () => playbooks.list().items);
    tool(
      'mesh_get_playbook',
      'Read one playbook in full. Call it only when its description fits your job. A playbook never overrides your rulebook or the rules in your instructions.',
      { name: z.string().min(1).max(40).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/) },
      (a) => playbooks.get(a.name),
    );
  }
  tool('mesh_get_board', 'START HERE every session: who is doing what, all tasks, open questions, handoffs to you, recent events.', {}, () => board.getBoard(principal));
  tool('mesh_set_status', 'Tell the Human what you are doing right now, in one sentence. Use "idle" when you stop.', { doing: z.string().min(1).max(500), taskId: TaskId.optional() }, (a) =>
    board.setStatus(principal, a.doing, a.taskId),
  );
  tool('mesh_list_tasks', 'List tasks, optionally filtered by status or owner agent id.', { status: z.string().optional(), owner: z.string().optional() }, (a) =>
    board.listTasks({ ...(a.status ? { status: a.status } : {}), ...(a.owner ? { owner: a.owner } : {}) }),
  );
  tool('mesh_get_task', 'One task with its findings, handoffs, audits, questions and decisions.', { taskId: TaskId }, (a) => board.getTask(a.taskId));
  tool(
    'mesh_create_task',
    'Add or split a task.',
    {
      id: TaskId,
      phase: z.string().min(1),
      title: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      acceptanceCriteria: z.string().min(1).max(5_000),
      suggestedOwner: z.string().max(64).optional(),
      prerequisites: z.array(TaskId).max(50).optional(),
    },
    (a) => board.createTask(principal, a as Parameters<BoardService['createTask']>[1]),
  );
  tool('mesh_claim_task', 'Claim a TODO task. Returns your worktree path: work ONLY there.', { taskId: TaskId }, (a) => board.claimTask(principal, a.taskId));
  tool(
    'mesh_acquire_lease',
    'Lease files/dirs before editing them (all or nothing; conflicts name the holder). Every changed path must be leased at submission.',
    { taskId: TaskId, targets: z.array(z.object({ type: z.enum(['FILE', 'DIR']), path: z.string().min(1).max(1024) })).min(1).max(100), ttlSeconds: z.number().int().min(30).max(600).optional() },
    (a) => leases.acquire(principal, a.taskId, a.targets, a.ttlSeconds),
  );
  tool('mesh_renew_lease', 'Heartbeat: extend your active leases.', { leaseIds: z.array(z.string()).min(1).max(100) }, (a) => ({ renewed: leases.renew(principal, a.leaseIds) }));
  tool('mesh_release_lease', 'Release your leases.', { leaseIds: z.array(z.string()).min(1).max(100) }, (a) => ({ released: leases.release(principal, a.leaseIds) }));
  tool(
    'mesh_update_status',
    'Author-side status change: IN_PROGRESS, TESTING, BLOCKED or TODO. (Review, audit and landing have their own tools.)',
    { taskId: TaskId, status: z.enum(['IN_PROGRESS', 'TESTING', 'BLOCKED', 'TODO']), note: z.string().max(2_000).optional() },
    (a) => board.updateStatus(principal, a.taskId, a.status, a.note),
  );
  tool('mesh_submit_for_review', 'Submit your finished task. The daemon checks your leases and pins the diff you committed.', { taskId: TaskId }, (a) =>
    gate.submitForReview(principal, { taskId: a.taskId }),
  );
  tool('mesh_claim_audit', "Claim the review of another platform's task (READY_FOR_REVIEW).", { taskId: TaskId }, (a) => gate.claimAudit(principal, { taskId: a.taskId }));
  tool(
    'mesh_submit_audit',
    'Submit your verdict. diffHash must be the pinned hash you reviewed; testRunSuccess must be stated explicitly.',
    {
      taskId: TaskId,
      verdict: z.enum(['PASSED', 'GAP_FOUND', 'REJECTED']),
      diffHash: z.string().regex(/^[0-9a-f]{64}$/),
      testRunSuccess: z.boolean(),
      checklistResults: z.record(z.union([z.boolean(), z.string(), z.number(), z.null()])).optional(),
      notes: z.string().min(1).max(20_000),
    },
    (a) => gate.submitAudit(principal, a as Parameters<AuditGate['submitAudit']>[1]),
  );
  tool(
    'mesh_log_finding',
    'Record a VERIFIED fact (cite file:line or the command you ran).',
    { taskId: TaskId.optional(), text: z.string().min(1).max(20_000), severity: Severity, file: z.string().max(1024).optional(), line: z.number().int().min(1).optional() },
    (a) => board.logFinding(principal, a as Parameters<BoardService['logFinding']>[1]),
  );
  tool(
    'mesh_send_handoff',
    'Message another agent about a task: what changed, how to verify, what to do next.',
    { taskId: TaskId, toAgentId: z.string().min(1).max(64), message: z.string().min(1).max(20_000), actionItems: z.array(z.string().max(1_000)).max(50).optional() },
    (a) => board.sendHandoff(principal, a as Parameters<BoardService['sendHandoff']>[1]),
  );
  tool(
    'mesh_ask_question',
    'Ask something that must be answered before work continues. Product decisions go to the Human.',
    { taskId: TaskId.optional(), text: z.string().min(1).max(10_000), toRole: z.enum(['Human', 'Agent', 'All']).optional(), toAgentId: z.string().max(64).optional() },
    (a) => board.askQuestion(principal, a as Parameters<BoardService['askQuestion']>[1]),
  );
  tool('mesh_answer_question', 'Answer a question addressed to you or your role (never one addressed to the Human).', { questionId: z.string().min(1), answer: z.string().min(1).max(10_000) }, (a) =>
    board.answerQuestion(principal, a.questionId, a.answer),
  );
  tool('mesh_record_decision', 'Record a settled decision with its rationale.', { taskId: TaskId.optional(), decision: z.string().min(1).max(10_000), rationale: z.string().max(10_000).optional() }, (a) =>
    board.recordDecision(principal, a as Parameters<BoardService['recordDecision']>[1]),
  );
  if (services.review) {
    const review = services.review;
    tool('mesh_get_diff', 'The exact diff pinned for review (with its diffHash and changed paths). Use this instead of git commands.', { taskId: TaskId }, (a) => review.getDiff(principal, a.taskId));
    tool('mesh_run_verification', "Run the project's configured verification (tests/build) in the task's worktree and get the result. Use this instead of running commands yourself.", { taskId: TaskId }, (a) => review.runVerification(principal, a.taskId));
  }
  if (services.missions) {
    const missions = services.missions;
    const MissionId = z.string().min(1).max(32);
    tool('mesh_get_mission', 'Read a mission: the Human brief, the current plan, every review and note, and its tasks. Planning and plan-review runs start here.', { missionId: MissionId }, (a) => missions.get(a.missionId));
    tool('mesh_submit_plan', 'Planner only: hand in the plan (or the revised final plan) for a mission, as Markdown.', { missionId: MissionId, body: z.string().min(40).max(100_000) }, (a) => missions.submitPlan(principal, a.missionId, a.body));
    tool(
      'mesh_submit_plan_review',
      'Reviewer only: your verdict on the current plan. planVersion must be the version of the plan you read. Use GAPS with a concrete list, or OK if you found nothing that matters.',
      { missionId: MissionId, planVersion: z.number().int().min(1), verdict: z.enum(['OK', 'GAPS']), gaps: z.string().max(20_000).optional() },
      (a) => missions.submitReview(principal, a.missionId, { planVersion: a.planVersion, verdict: a.verdict, ...(a.gaps ? { gaps: a.gaps } : {}) }),
    );
    tool('mesh_finish_split', 'Planner only: call after creating every task of an approved mission with mesh_create_task.', { missionId: MissionId }, (a) => missions.finishSplit(principal, a.missionId));
  }
  if (services.commits) {
    const commits = services.commits;
    tool(
      'mesh_commit',
      'Commit ALL your current changes in your task worktree (the daemon runs git for you: use this instead of git add/commit). Every changed path must be under one of your active leases.',
      { taskId: TaskId, message: z.string().min(1).max(5_000) },
      (a) => commits.commit(principal, a.taskId, a.message),
    );
  }
  return server;
}

/** stdio: identity from AGENTMESH_TOKEN (handed to runner-spawned agents, spec v1.1 §7.1). */
export async function serveStdio(identity: IdentityService, services: MeshServices, token = process.env.AGENTMESH_TOKEN): Promise<McpServer> {
  const principal = identity.authenticate(token); // throws AuthError before any tool is exposed
  const server = createMeshMcpServer(principal, services);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Streamable HTTP, stateless (spec 2026-07-28 removed protocol-level sessions): a fresh server and
 * transport per request, bound to the Principal the P2.6 server authenticated. Mount with
 * server.route('POST', '/mcp', 'agent', ({ req, res, principal, body }) => handleMcpHttp(...)).
 */
export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, principal: Principal, rawBody: string, services: MeshServices): Promise<void> {
  const server = createMeshMcpServer(principal, services);
  // No sessionIdGenerator = stateless (SDK: "session management is disabled"); stateless needs a fresh transport per request.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
    return;
  }
  await transport.handleRequest(req, res, parsed);
}
