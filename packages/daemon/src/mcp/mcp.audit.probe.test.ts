// New adversarial probes for MCP Gateway & BoardService (P2.1 audit).
// Testing task creation validation, prerequisite verification, status transition restrictions,
// question routing permissions, and MCP error handling.
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
  const client = new Client({ name: 'mcp-audit-probe', version: '0' });
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
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mcp-audit-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'audit@example.com');
  g(repo, 'config', 'user.name', 'audit');
  writeFileSync(join(repo, 'README.md'), 'audit-repo\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  tokens.claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  tokens.gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).token;
  tokens.human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).token;

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

describe('P2.1 Audit Probe: Task Creation & ID Sanitization', () => {
  it('rejects task creation with path traversal or invalid characters in id', async () => {
    const claude = await clientFor(tokens.claude!);

    const r1 = await call(claude, 'mesh_create_task', {
      id: '../escaped-id',
      phase: 'Phase 1',
      title: 'Bad ID',
      acceptanceCriteria: 'none',
    });
    expect(r1.ok).toBe(false);

    const r2 = await call(claude, 'mesh_create_task', {
      id: 'task.with.trailing.dot.',
      phase: 'Phase 1',
      title: 'Bad ID',
      acceptanceCriteria: 'none',
    });
    expect(r2.ok).toBe(false);

    const r3 = await call(claude, 'mesh_create_task', {
      id: 'task with spaces',
      phase: 'Phase 1',
      title: 'Bad ID',
      acceptanceCriteria: 'none',
    });
    expect(r3.ok).toBe(false);

    await claude.close();
  });

  it('rejects task creation with non-existent prerequisite id', async () => {
    const claude = await clientFor(tokens.claude!);
    const r = await call(claude, 'mesh_create_task', {
      id: 'TASK_WITH_GHOST_PREREQ',
      phase: 'Phase 1',
      title: 'Ghost Prereq',
      acceptanceCriteria: 'none',
      prerequisites: ['NON_EXISTENT_PREREQ'],
    });
    expect(r.ok).toBe(false);
    expect(String(r.value)).toMatch(/Unknown prerequisite/i);
    await claude.close();
  });

  it('rejects duplicate task creation', async () => {
    const claude = await clientFor(tokens.claude!);
    const first = await call(claude, 'mesh_create_task', {
      id: 'TASK_DUP',
      phase: 'Phase 1',
      title: 'Duplicate Task',
      acceptanceCriteria: 'none',
    });
    expect(first.ok).toBe(true);

    const second = await call(claude, 'mesh_create_task', {
      id: 'TASK_DUP',
      phase: 'Phase 1',
      title: 'Duplicate Task 2',
      acceptanceCriteria: 'none',
    });
    expect(second.ok).toBe(false);
    expect(String(second.value)).toMatch(/already exists/i);
    await claude.close();
  });
});

describe('P2.1 Audit Probe: Status Transition & Role Boundary Controls', () => {
  it('rejects attempts to transition directly to PASSED via mesh_update_status', async () => {
    const claude = await clientFor(tokens.claude!);
    await call(claude, 'mesh_create_task', {
      id: 'TASK_STATUS_TEST',
      phase: 'Phase 1',
      title: 'Status Test',
      acceptanceCriteria: 'none',
    });

    // mesh_update_status schema restricts status to IN_PROGRESS, TESTING, BLOCKED, TODO
    const r = await call(claude, 'mesh_update_status', {
      taskId: 'TASK_STATUS_TEST',
      status: 'PASSED',
    });
    expect(r.ok).toBe(false);
    await claude.close();
  });

  it('peer agent cannot change status of another agent in-progress task', async () => {
    const claude = await clientFor(tokens.claude!);
    const gemini = await clientFor(tokens.gemini!);

    await call(claude, 'mesh_create_task', {
      id: 'TASK_CLAIMED_BY_CLAUDE',
      phase: 'Phase 1',
      title: 'Claude Task',
      acceptanceCriteria: 'none',
    });
    const claim = await call(claude, 'mesh_claim_task', { taskId: 'TASK_CLAIMED_BY_CLAUDE' });
    expect(claim.ok).toBe(true);

    // Gemini (peer) attempts to set it to BLOCKED
    const peerUpdate = await call(gemini, 'mesh_update_status', {
      taskId: 'TASK_CLAIMED_BY_CLAUDE',
      status: 'BLOCKED',
    });
    expect(peerUpdate.ok).toBe(false);
    expect(String(peerUpdate.value)).toMatch(/not authorized|forbidden/i);

    for (const c of [claude, gemini]) await c.close();
  });

  it('human principal cannot claim tasks directly via claimTask', async () => {
    const humanPrincipal = ids.authenticate(tokens.human);
    await expect(services.board.claimTask(humanPrincipal, 'ANY_TASK')).rejects.toThrow(
      /The Human assigns tasks; agents claim them/,
    );
  });
});

describe('P2.1 Audit Probe: Handoff & Question Target Validation', () => {
  it('mesh_send_handoff fails if target agent does not exist', async () => {
    const claude = await clientFor(tokens.claude!);
    await call(claude, 'mesh_create_task', {
      id: 'TASK_HANDOFF_TEST',
      phase: 'Phase 1',
      title: 'Handoff Test',
      acceptanceCriteria: 'none',
    });

    const r = await call(claude, 'mesh_send_handoff', {
      taskId: 'TASK_HANDOFF_TEST',
      toAgentId: 'phantom-agent',
      message: 'Hello phantom',
    });
    expect(r.ok).toBe(false);
    expect(String(r.value)).toMatch(/Unknown agent phantom-agent/i);
    await claude.close();
  });

  it('mesh_get_board reports caller identity and isolates handoffs', async () => {
    const claude = await clientFor(tokens.claude!);
    const gemini = await clientFor(tokens.gemini!);

    await call(claude, 'mesh_create_task', {
      id: 'TASK_BOARD_TEST',
      phase: 'Phase 1',
      title: 'Board Test',
      acceptanceCriteria: 'none',
    });
    await call(claude, 'mesh_send_handoff', {
      taskId: 'TASK_BOARD_TEST',
      toAgentId: 'gemini-1',
      message: 'Task ready for Gemini audit',
    });

    const boardClaude = (await call(claude, 'mesh_get_board')).value as {
      you: { agentId: string; platform: string };
      handoffsToYou: unknown[];
    };
    expect(boardClaude.you).toEqual({ agentId: 'claude-1', platform: 'CLAUDE_CODE' });
    // Claude should not have the handoff addressed to Gemini
    expect(boardClaude.handoffsToYou).toEqual([]);

    const boardGemini = (await call(gemini, 'mesh_get_board')).value as {
      you: { agentId: string; platform: string };
      handoffsToYou: { to_agent_id: string; message: string }[];
    };
    expect(boardGemini.you).toEqual({ agentId: 'gemini-1', platform: 'ANTIGRAVITY' });
    expect(boardGemini.handoffsToYou.length).toBeGreaterThanOrEqual(1);
    expect(boardGemini.handoffsToYou[0]?.to_agent_id).toBe('gemini-1');

    for (const c of [claude, gemini]) await c.close();
  });
});
