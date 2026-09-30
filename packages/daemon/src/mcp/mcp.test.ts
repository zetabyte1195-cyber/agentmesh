// End to end over real HTTP: P2.6 server + POST /mcp + the official MCP SDK client, with
// Claude and Gemini each holding their own token, doing a full author → audit round trip.
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
import { AuthError, IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { DaemonServer } from '../server/index.js';
import { type MeshServices, handleMcpHttp, serveStdio } from './server.js';

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
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

/** Call a tool; return parsed JSON on success or the error text. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; value: unknown }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  return r.isError ? { ok: false, value: text } : { ok: true, value: JSON.parse(text) };
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-mcp-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@example.com');
  g(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  tokens.claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  tokens.claude2 = ids.registerAgent({ id: 'claude-2', name: 'Claude 2', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  tokens.gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).token;
  ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
  wc = new WorktreeController({ repoRoot: repo });
  const leases = new LeaseArbiter(db);
  services = { board: new BoardService({ db, worktrees: wc }), leases, gate: new AuditGate({ db, repoRoot: repo, leases }) };
  server = new DaemonServer({ identity: ids, humanAgentId: 'human' });
  server.route('POST', '/mcp', 'agent', async ({ req, res, principal, body }) => handleMcpHttp(req, res, principal!, await body(), services));
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  for (const w of await wc.list()) await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

describe('MCP gateway over Streamable HTTP', { timeout: 60_000 }, () => {
  it('exposes the spec v1.1 §10.1 tools, none of which takes an agent id', async () => {
    const client = await clientFor(tokens.claude!);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'mesh_acquire_lease', 'mesh_answer_question', 'mesh_ask_question', 'mesh_claim_audit', 'mesh_claim_task', 'mesh_create_task',
        'mesh_get_board', 'mesh_get_task', 'mesh_list_tasks', 'mesh_log_finding', 'mesh_record_decision', 'mesh_release_lease',
        'mesh_renew_lease', 'mesh_send_handoff', 'mesh_set_status', 'mesh_submit_audit', 'mesh_submit_for_review', 'mesh_update_status',
      ].sort(),
    );
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      expect(props.filter((p) => /agentid$/i.test(p) && p !== 'toAgentId'), t.name).toEqual([]);
    }
    await client.close();
  });

  it('refuses callers without a valid token before any MCP handling', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('full round trip: Claude claims, leases, commits, submits; Gemini audits and passes; a second Claude cannot', async () => {
    const claude = await clientFor(tokens.claude!);
    const claude2 = await clientFor(tokens.claude2!);
    const gemini = await clientFor(tokens.gemini!);

    expect((await call(claude, 'mesh_create_task', { id: 'T1', phase: 'P', title: 'Add greeting', acceptanceCriteria: 'greeting.txt says hi' })).ok).toBe(true);
    const claim = await call(claude, 'mesh_claim_task', { taskId: 'T1' });
    expect(claim.ok).toBe(true);
    const wt = (claim.value as { worktree: string }).worktree;

    expect((await call(claude, 'mesh_acquire_lease', { taskId: 'T1', targets: [{ type: 'FILE', path: 'greeting.txt' }] })).ok).toBe(true);
    writeFileSync(join(wt, 'greeting.txt'), 'hi\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-q', '-m', 'T1: greeting');
    const submitted = await call(claude, 'mesh_submit_for_review', { taskId: 'T1' });
    expect(submitted.ok).toBe(true);
    const diffHash = (submitted.value as { diffHash: string }).diffHash;

    const sameplatform = await call(claude2, 'mesh_submit_audit', { taskId: 'T1', verdict: 'PASSED', diffHash, testRunSuccess: true, notes: 'lgtm' });
    expect(sameplatform.ok).toBe(false); // second Claude instance: two-platform rule

    expect((await call(gemini, 'mesh_claim_audit', { taskId: 'T1' })).ok).toBe(true);
    const audit = await call(gemini, 'mesh_submit_audit', { taskId: 'T1', verdict: 'PASSED', diffHash, testRunSuccess: true, notes: 'verified greeting.txt' });
    expect(audit.ok).toBe(true);

    const task = (await call(gemini, 'mesh_get_task', { taskId: 'T1' })).value as { task: { status: string; assigned_agent_id: string; reviewing_agent_id: string } };
    expect(task.task).toMatchObject({ status: 'PASSED', assigned_agent_id: 'claude-1', reviewing_agent_id: 'gemini-1' });
    for (const c of [claude, claude2, gemini]) await c.close();
  });

  it('identity comes from the token: a smuggled agentId argument is ignored', async () => {
    const claude = await clientFor(tokens.claude!);
    await call(claude, 'mesh_set_status', { doing: 'writing tests', agentId: 'gemini-1' } as Record<string, unknown>);
    const row = db.prepare("SELECT agent_id FROM events WHERE kind = 'status' ORDER BY rowid DESC LIMIT 1").get() as { agent_id: string };
    expect(row.agent_id).toBe('claude-1');
    await claude.close();
  });

  it('an agent cannot answer a question addressed to the Human', async () => {
    const claude = await clientFor(tokens.claude!);
    const gemini = await clientFor(tokens.gemini!);
    const q = (await call(claude, 'mesh_ask_question', { text: 'Ship it?', toRole: 'Human' })).value as { id: string };
    const answer = await call(gemini, 'mesh_answer_question', { questionId: q.id, answer: 'yes' });
    expect(answer.ok).toBe(false);
    expect((db.prepare('SELECT resolved FROM questions WHERE id = ?').get(q.id) as { resolved: number }).resolved).toBe(0);
    for (const c of [claude, gemini]) await c.close();
  });

  it('an agent cannot claim a task whose prerequisites are not done', async () => {
    const claude = await clientFor(tokens.claude!);
    await call(claude, 'mesh_create_task', { id: 'A', phase: 'P', title: 'first', acceptanceCriteria: 'x' });
    await call(claude, 'mesh_create_task', { id: 'B', phase: 'P', title: 'second', acceptanceCriteria: 'x', prerequisites: ['A'] });
    expect((await call(claude, 'mesh_claim_task', { taskId: 'B' })).ok).toBe(false);
    expect(await wc.list()).toEqual([]); // no worktree allocated for a refused claim
    await claude.close();
  });
});

describe('MCP gateway over stdio', () => {
  it('refuses to start without a valid AGENTMESH_TOKEN', async () => {
    await expect(serveStdio(ids, services, undefined)).rejects.toBeInstanceOf(AuthError);
    await expect(serveStdio(ids, services, 'amt_forged')).rejects.toBeInstanceOf(AuthError);
  });
});
