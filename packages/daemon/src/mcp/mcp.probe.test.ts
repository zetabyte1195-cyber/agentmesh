// Adversarial security & robustness probes for MCP Gateway & BoardService (P2.1).
// Auditing tool-argument smuggling, oversized inputs, claim races, and event attribution.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditGate } from '../audit/index.js';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { DaemonServer } from '../server/index.js';
import { type MeshServices, handleMcpHttp } from './server.js';

let repo: string;
let db: SqliteDatabase;
let server: DaemonServer;
let port: number;
let services: MeshServices;
let ids: IdentityService;
let wc: WorktreeController;
const tokens: Record<string, string> = {};

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function clientFor(token: string): Promise<Client> {
  const client = new Client({ name: 'probe-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; value: unknown }> {
  try {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0]?.text ?? '';
    return r.isError ? { ok: false, value: text } : { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, value: (err as Error).message };
  }
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mcp-probe-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'probe@example.com');
  g(repo, 'config', 'user.name', 'probe');
  writeFileSync(join(repo, 'README.md'), 'probe-repo\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  tokens.claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  tokens.gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).token;
  ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });

  wc = new WorktreeController({ repoRoot: repo });
  const leases = new LeaseArbiter(db);
  services = {
    board: new BoardService({ db, worktrees: wc }),
    leases,
    gate: new AuditGate({ db, repoRoot: repo, leases }),
  };

  server = new DaemonServer({ identity: ids, humanAgentId: 'human' });
  server.route('POST', '/mcp', 'agent', async ({ req, res, principal, body }) =>
    handleMcpHttp(req, res, principal!, await body(), services),
  );
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  for (const w of await wc.list()) await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

describe('MCP Gateway Probe: Identity & Argument Smuggling', () => {
  it('cannot forge author or agent in mesh_log_finding', async () => {
    const claude = await clientFor(tokens.claude!);
    const res = await call(claude, 'mesh_log_finding', {
      text: 'Verified finding',
      severity: 'INFO',
      agentId: 'gemini-1',
      author: 'gemini-1',
    });
    expect(res.ok).toBe(true);

    const finding = db.prepare('SELECT agent_id FROM findings WHERE id = ?').get((res.value as { id: string }).id) as { agent_id: string };
    expect(finding.agent_id).toBe('claude-1'); // Must be claude-1 from token, not smuggled gemini-1
    await claude.close();
  });

  it('cannot forge from_agent_id in mesh_send_handoff', async () => {
    const claude = await clientFor(tokens.claude!);
    await call(claude, 'mesh_create_task', { id: 'T_HANDOFF', phase: 'P', title: 'Task', acceptanceCriteria: 'ok' });
    const res = await call(claude, 'mesh_send_handoff', {
      taskId: 'T_HANDOFF',
      toAgentId: 'gemini-1',
      fromAgentId: 'gemini-1',
      from: 'gemini-1',
      message: 'Take over',
    });
    expect(res.ok).toBe(true);

    const handoff = db.prepare('SELECT from_agent_id, to_agent_id FROM handoffs WHERE id = ?').get((res.value as { id: string }).id) as { from_agent_id: string; to_agent_id: string };
    expect(handoff.from_agent_id).toBe('claude-1'); // Authenticated caller, not smuggled
    expect(handoff.to_agent_id).toBe('gemini-1');
    await claude.close();
  });

  it('cannot forge author in mesh_record_decision', async () => {
    const claude = await clientFor(tokens.claude!);
    const res = await call(claude, 'mesh_record_decision', {
      decision: 'Use SQLite',
      agentId: 'gemini-1',
      rationale: 'Local-first',
    });
    expect(res.ok).toBe(true);

    const decision = db.prepare('SELECT agent_id FROM decisions WHERE id = ?').get((res.value as { id: string }).id) as { agent_id: string };
    expect(decision.agent_id).toBe('claude-1');
    await claude.close();
  });
});

describe('MCP Gateway Probe: Oversized Inputs & Zod Boundary Defense', () => {
  it('rejects oversized doing field in mesh_set_status (> 500 chars)', async () => {
    const claude = await clientFor(tokens.claude!);
    const res = await call(claude, 'mesh_set_status', { doing: 'x'.repeat(501) });
    expect(res.ok).toBe(false);
    expect(String(res.value)).toMatch(/500|invalid/i);
    await claude.close();
  });

  it('rejects oversized taskId (> 64 chars)', async () => {
    const claude = await clientFor(tokens.claude!);
    const res = await call(claude, 'mesh_get_task', { taskId: 'T'.repeat(65) });
    expect(res.ok).toBe(false);
    await claude.close();
  });

  it('rejects oversized task title (> 200 chars)', async () => {
    const claude = await clientFor(tokens.claude!);
    const res = await call(claude, 'mesh_create_task', {
      id: 'T_LONG',
      phase: 'P',
      title: 'A'.repeat(201),
      acceptanceCriteria: 'ok',
    });
    expect(res.ok).toBe(false);
    await claude.close();
  });
});

describe('MCP Gateway Probe: Event Attribution & Telemetry', () => {
  it('all board events record the token agent_id and trigger onEvent callback', async () => {
    const eventsReceived: string[] = [];
    const customServices: MeshServices = {
      ...services,
      board: new BoardService({
        db,
        worktrees: wc,
        onEvent: (e) => eventsReceived.push(`${e.agentId}:${e.kind}`),
      }),
    };
    const srv = new DaemonServer({ identity: ids, humanAgentId: 'human' });
    srv.route('POST', '/mcp', 'agent', async ({ req, res, principal, body }) =>
      handleMcpHttp(req, res, principal!, await body(), customServices),
    );
    const p = await srv.listen();

    const client = new Client({ name: 'probe', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${p}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.gemini}` } },
      }),
    );

    await call(client, 'mesh_set_status', { doing: 'Running telemetry probes' });
    await call(client, 'mesh_log_finding', { text: 'Observation', severity: 'INFO' });

    expect(eventsReceived).toContain('gemini-1:status');
    expect(eventsReceived).toContain('gemini-1:finding');

    await client.close();
    await srv.close();
  });
});

describe('BoardService Probe: Claim Concurrency Race Condition Check', () => {
  it('demonstrates behavior when task status is updated concurrently between read and update', async () => {
    // Setup task in TODO
    db.prepare(`
      INSERT INTO tasks (id, phase_id, title, description, acceptance_criteria, prerequisites)
      VALUES ('T_RACE', 'Phase 1', 'Race Task', '', 'criteria', '[]')
    `).run();

    const geminiPrincipal = ids.authenticate(tokens.gemini);

    // Now simulate task status already being changed to IN_PROGRESS by another agent right before claimTask updates it
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1' WHERE id = 'T_RACE'").run();

    // Now if gemini tries to claimTask directly when status in DB is IN_PROGRESS:
    // validateTaskTransition checks the DB and rejects it
    await expect(services.board.claimTask(geminiPrincipal, 'T_RACE')).rejects.toThrow();

    // Verify task is still assigned to claude-1
    const task = db.prepare('SELECT status, assigned_agent_id FROM tasks WHERE id = ?').get('T_RACE') as { status: string; assigned_agent_id: string };
    expect(task.status).toBe('IN_PROGRESS');
    expect(task.assigned_agent_id).toBe('claude-1');
  });

  it('probes the race window during worktree allocation', async () => {
    db.prepare(`
      INSERT INTO tasks (id, phase_id, title, description, acceptance_criteria, prerequisites)
      VALUES ('T_RACE2', 'Phase 1', 'Race Task 2', '', 'criteria', '[]')
    `).run();

    const geminiPrincipal = ids.authenticate(tokens.gemini);

    // Intercept allocate to simulate another agent updating the task status concurrently
    const origAllocate = wc.allocate.bind(wc);
    wc.allocate = async (taskId, title, bootstrap) => {
      const res = await origAllocate(taskId, title, bootstrap);
      // Simulate race: another agent claims and sets IN_PROGRESS while we were allocating worktree
      db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = 'claude-1' WHERE id = 'T_RACE2'").run();
      return res;
    };

    // REGRESSION (was the race gap): the loser gets CONFLICT, no false claim event, and its worktree is removed.
    await expect(services.board.claimTask(geminiPrincipal, 'T_RACE2')).rejects.toThrow(/claimed by another agent/);
    wc.allocate = origAllocate;

    const row = db.prepare('SELECT assigned_agent_id FROM tasks WHERE id = ?').get('T_RACE2') as { assigned_agent_id: string };
    expect(row.assigned_agent_id).toBe('claude-1');
    const claimEvents = db.prepare("SELECT agent_id FROM events WHERE kind = 'claim' AND task_id = 'T_RACE2'").all() as { agent_id: string }[];
    expect(claimEvents.filter((e) => e.agent_id === 'gemini-1')).toEqual([]);
    expect((await wc.list()).filter((w) => w.taskId === 'T_RACE2')).toEqual([]);
  });

  it('probes answering an already-resolved question', async () => {
    const claudePrincipal = ids.authenticate(tokens.claude);
    const geminiPrincipal = ids.authenticate(tokens.gemini);

    // Claude asks a question to Agent
    const q = services.board.askQuestion(claudePrincipal, { text: 'Which tool?', toRole: 'Agent' });

    // Gemini answers it first
    services.board.answerQuestion(geminiPrincipal, q.id, 'Use tool A');

    // REGRESSION (was: silently ignored but still logged an 'answer' event): a second answer is refused.
    const answersBefore = (db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'answer'").get() as { n: number }).n;
    expect(() => services.board.answerQuestion(geminiPrincipal, q.id, 'Use tool B')).toThrow(/already answered/);
    expect((db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'answer'").get() as { n: number }).n).toBe(answersBefore);

    const qRow = db.prepare('SELECT answer FROM questions WHERE id = ?').get(q.id) as { answer: string };
    expect(qRow.answer).toBe('Use tool A');
  });
});


