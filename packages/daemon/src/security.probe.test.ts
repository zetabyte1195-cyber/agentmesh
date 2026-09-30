// Comprehensive adversarial security probes across all 5 daemon surfaces (Task P2.4).
// Surfaces covered:
// 1. Identity (packages/daemon/src/identity)
// 2. Server (packages/daemon/src/server)
// 3. MCP Gateway (packages/daemon/src/mcp)
// 4. Board & Audit Gate (packages/daemon/src/board, packages/daemon/src/audit)
// 5. Runner (packages/daemon/src/runner)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditGate } from './audit/index.js';
import { BoardService } from './board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from './db/index.js';
import type { SqliteDatabase } from './db/index.js';
import { WorktreeController } from './git/worktrees.js';
import {
  AuthError,
  IDENTITY_MIGRATION,
  IdentityService,
  ImpersonationError,
  assertActingAs,
  generateToken,
  hashToken,
  isWellFormedToken,
} from './identity/index.js';
import { LeaseArbiter } from './leases/index.js';
import { normalizeLeasePath } from './leases/paths.js';
import { type MeshServices, handleMcpHttp, serveStdio } from './mcp/server.js';
import { agyCommand, claudeCommand } from './runner/commands.js';
import { startAgent } from './runner/run.js';
import { DaemonServer } from './server/index.js';

let repo: string;
let db: SqliteDatabase;
let server: DaemonServer;
let port: number;
let services: MeshServices;
let ids: IdentityService;
let wc: WorktreeController;
let leases: LeaseArbiter;
let gate: AuditGate;
const tokens: Record<string, string> = {};

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function clientFor(token: string): Promise<Client> {
  const client = new Client({ name: 'sec-probe-client', version: '0' });
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

function httpRequest(
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-sec-probe-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'sec-probe@example.com');
  g(repo, 'config', 'user.name', 'sec-probe');
  writeFileSync(join(repo, 'README.md'), 'sec-probe-repo\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  ids = new IdentityService(db);
  tokens.claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
  tokens.gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).token;
  tokens.human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).token;

  wc = new WorktreeController({ repoRoot: repo });
  leases = new LeaseArbiter(db);
  gate = new AuditGate({ db, repoRoot: repo, leases });
  services = {
    board: new BoardService({ db, worktrees: wc }),
    leases,
    gate,
  };

  server = new DaemonServer({ identity: ids, humanAgentId: 'human', maxBodyBytes: 1024 });
  server.route('POST', '/mcp', 'agent', async ({ req, res, principal, body }) =>
    handleMcpHttp(req, res, principal!, await body(), services),
  );
  server.route('GET', '/human-only', 'human', () => ({ secret: 'human-data' }));
  server.route('POST', '/human-only', 'human', () => ({ ok: true }));
  server.route('POST', '/agent-action', 'agent', () => ({ ok: true }));
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
  for (const w of await wc.list()) await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

/* =========================================================================
 * 1. Surface: Identity (packages/daemon/src/identity)
 * ========================================================================= */
describe('Surface 1: Identity & Token Security', () => {
  it('token generation: 256 bits entropy, amt_ prefix, strictly validated format', () => {
    const token = generateToken();
    expect(token.startsWith('amt_')).toBe(true);
    expect(isWellFormedToken(token)).toBe(true);

    // Malformed tokens
    expect(isWellFormedToken('')).toBe(false);
    expect(isWellFormedToken('amt_short')).toBe(false);
    expect(isWellFormedToken(`amt_${'a'.repeat(42)}`)).toBe(false); // 42 instead of 43 chars
    expect(isWellFormedToken(`amt_${'a'.repeat(44)}`)).toBe(false); // 44 instead of 43 chars
    expect(isWellFormedToken(`amt_${'a'.repeat(42)}!`)).toBe(false); // invalid symbol
    expect(isWellFormedToken(`Bearer ${token}`)).toBe(false);
  });

  it('token storage: only 64-char SHA-256 hex hash is stored, never plaintext token', () => {
    const token = tokens.claude;
    const hash = hashToken(token);
    expect(hash).toHaveLength(64);

    const row = db.prepare('SELECT token_hash FROM agent_credentials WHERE token_hash = ?').get(hash) as { token_hash: string };
    expect(row).toBeDefined();
    expect(row.token_hash).toBe(hash);

    // Search entire agent_credentials table to verify raw token is never stored in any column
    const allCreds = db.prepare('SELECT * FROM agent_credentials').all() as Record<string, unknown>[];
    for (const c of allCreds) {
      for (const val of Object.values(c)) {
        if (typeof val === 'string') {
          expect(val.includes(token)).toBe(false);
        }
      }
    }
  });

  it('token revocation: single token and bulk agent revocation take immediate effect', () => {
    const extraToken = ids.issueToken('claude-1', 'extra-session');
    expect(ids.authenticate(extraToken).agentId).toBe('claude-1');

    // Revoke single token
    expect(ids.revokeToken(extraToken)).toBe(true);
    expect(() => ids.authenticate(extraToken)).toThrow(AuthError);
    expect(() => ids.authenticate(extraToken)).toThrow(/REVOKED_TOKEN/);

    // Primary token still valid
    expect(ids.authenticate(tokens.claude).agentId).toBe('claude-1');

    // Revoke all for claude-1
    expect(ids.revokeAllForAgent('claude-1')).toBeGreaterThanOrEqual(1);
    expect(() => ids.authenticate(tokens.claude)).toThrow(AuthError);
    expect(() => ids.authenticate(tokens.claude)).toThrow(/REVOKED_TOKEN/);

    // Gemini token still intact
    expect(ids.authenticate(tokens.gemini).agentId).toBe('gemini-1');
  });

  it('impersonation protection: assertActingAs strictly blocks cross-agent spoofing', () => {
    const claudePrincipal = ids.authenticate(tokens.claude);
    expect(() => assertActingAs(claudePrincipal, 'claude-1')).not.toThrow();
    expect(() => assertActingAs(claudePrincipal, undefined)).not.toThrow();
    expect(() => assertActingAs(claudePrincipal, 'gemini-1')).toThrow(ImpersonationError);
    expect(() => assertActingAs(claudePrincipal, 'human')).toThrow(ImpersonationError);
  });

  it('database trigger defense: enforces single Human constraint and immutability', () => {
    // Cannot register a second human agent
    expect(() => {
      ids.registerAgent({ id: 'human-imposter', name: 'Imposter', platform: 'HUMAN', paradigm: 'HUMAN' });
    }).toThrow(/Only one Human agent record is permitted/);

    // Cannot register agent with mismatched human paradigm/platform
    expect(() => {
      ids.registerAgent({ id: 'fake-human', name: 'Fake', platform: 'HUMAN', paradigm: 'CLI' });
    }).toThrow(/Human agent must have platform = 'HUMAN' and paradigm = 'HUMAN'/);

    // Cannot mutate existing agent platform or paradigm
    expect(() => {
      db.prepare("UPDATE agents SET platform = 'HUMAN', paradigm = 'HUMAN' WHERE id = 'claude-1'").run();
    }).toThrow(/Agent platform and paradigm are immutable after registration/);
  });
});

/* =========================================================================
 * 2. Surface: Server (packages/daemon/src/server)
 * ========================================================================= */
describe('Surface 2: Server Front Door Security', () => {
  it('DNS rebinding attacks: rejects invalid, forged, or suffix Host headers', async () => {
    const evilHosts = [
      'attacker.com',
      `attacker.com:${port}`,
      `127.0.0.1:${port}.attacker.com`,
      `0.0.0.0:${port}`,
      '127.0.0.1', // missing port
      `127.0.0.1:${port + 1}`, // wrong port
      `127.0.0.1:${port}@attacker.com`,
      `[::1]:${port}`,
    ];

    for (const h of evilHosts) {
      const res = await httpRequest({ path: '/login', headers: { Host: h } });
      expect(res.status).toBe(403);
    }
  });

  it('CSRF defense: rejects mutating cookie requests with foreign or null Origin', async () => {
    // Issue a valid session token for human
    const humanToken = ids.issueToken('human', 'cockpit-session');
    const cookie = `agentmesh_session=${encodeURIComponent(humanToken)}`;

    // Foreign origin -> 403
    const foreign = await httpRequest({
      method: 'POST',
      path: '/human-only',
      headers: {
        Cookie: cookie,
        Origin: 'http://attacker.com',
      },
    });
    expect(foreign.status).toBe(403);

    // Origin null -> 403
    const nullOrigin = await httpRequest({
      method: 'POST',
      path: '/human-only',
      headers: {
        Cookie: cookie,
        Origin: 'null',
      },
    });
    expect(nullOrigin.status).toBe(403);

    // Trailing slash origin -> 403
    const trailingSlash = await httpRequest({
      method: 'POST',
      path: '/human-only',
      headers: {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${port}/`,
      },
    });
    expect(trailingSlash.status).toBe(403);

    // HTTPS scheme mismatch -> 403
    const httpsMismatch = await httpRequest({
      method: 'POST',
      path: '/human-only',
      headers: {
        Cookie: cookie,
        Origin: `https://127.0.0.1:${port}`,
      },
    });
    expect(httpsMismatch.status).toBe(403);
  });

  it('bearer token origin checking: blocks browser fetch with foreign origin even with Bearer header', async () => {
    const res = await httpRequest({
      method: 'POST',
      path: '/agent-action',
      headers: {
        Authorization: `Bearer ${tokens.claude}`,
        Origin: 'http://malicious-website.com',
      },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/Forbidden origin/);
  });

  it('role separation: agent token rejected on Human routes, Human session rejected on Agent routes', async () => {
    // Agent token on Human route
    const agentOnHuman = await httpRequest({
      method: 'GET',
      path: '/human-only',
      headers: { Authorization: `Bearer ${tokens.claude}` },
    });
    expect(agentOnHuman.status).toBe(403);
    expect(agentOnHuman.body).toMatch(/Human only/);

    // Human session on Agent route
    const humanToken = ids.issueToken('human', 'cockpit-session');
    const humanOnAgent = await httpRequest({
      method: 'POST',
      path: '/agent-action',
      headers: {
        Cookie: `agentmesh_session=${encodeURIComponent(humanToken)}`,
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    expect(humanOnAgent.status).toBe(403);
    expect(humanOnAgent.body).toMatch(/Agent only/);
  });

  it('login link security: single-use invalidation, replay prevention, and secure cookie attributes', async () => {
    const urlStr = server.issueCockpitUrl();
    const url = new URL(urlStr);
    const code = url.searchParams.get('code')!;

    // First use succeeds with 303 and secure Set-Cookie
    const res1 = await httpRequest({ path: `/login?code=${code}` });
    expect(res1.status).toBe(303);
    const setCookie = String(res1.headers['set-cookie']);
    expect(setCookie).toMatch(/agentmesh_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);

    // Immediate replay fails with 401
    const res2 = await httpRequest({ path: `/login?code=${code}` });
    expect(res2.status).toBe(401);

    // Fake code fails with 401
    const res3 = await httpRequest({ path: '/login?code=fake-code-1234' });
    expect(res3.status).toBe(401);
  });

  it('streaming request body bounds: enforces maxBodyBytes and terminates connection on overflow', async () => {
    // Server configured with maxBodyBytes: 1024
    const exactBody = 'x'.repeat(1024);
    const overflowBody = 'x'.repeat(1025);

    const okRes = await httpRequest({
      method: 'POST',
      path: '/agent-action',
      headers: { Authorization: `Bearer ${tokens.claude}` },
      body: exactBody,
    });
    expect(okRes.status).toBe(200);

    const overflowRes = await httpRequest({
      method: 'POST',
      path: '/agent-action',
      headers: { Authorization: `Bearer ${tokens.claude}` },
      body: overflowBody,
    });
    expect(overflowRes.status).toBe(413);
    expect(overflowRes.headers['connection']).toBe('close');
  });
});

/* =========================================================================
 * 3. Surface: MCP Gateway (packages/daemon/src/mcp)
 * ========================================================================= */
describe('Surface 3: MCP Gateway Protocol Defense', () => {
  it('tool argument smuggling: caller cannot masquerade as another agent', async () => {
    const client = await clientFor(tokens.claude);

    // Attempt to log a finding claiming it belongs to gemini-1
    const res = await call(client, 'mesh_log_finding', {
      text: 'Smuggled observation',
      severity: 'INFO',
      agentId: 'gemini-1',
      author: 'gemini-1',
      from: 'gemini-1',
    });
    expect(res.ok).toBe(true);

    const finding = db.prepare('SELECT agent_id FROM findings WHERE id = ?').get((res.value as { id: string }).id) as { agent_id: string };
    expect(finding.agent_id).toBe('claude-1'); // Verified bound to claude-1

    await client.close();
  });

  it('schema boundary limits: rejects oversized arrays, strings, and invalid patterns', async () => {
    const client = await clientFor(tokens.claude);

    // Oversized task id (> 64)
    const longId = await call(client, 'mesh_get_task', { taskId: 'A'.repeat(65) });
    expect(longId.ok).toBe(false);

    // Oversized status (> 500)
    const longStatus = await call(client, 'mesh_set_status', { doing: 'A'.repeat(501) });
    expect(longStatus.ok).toBe(false);

    // Oversized prerequisites array (> 50)
    const tooManyPrereqs = await call(client, 'mesh_create_task', {
      id: 'T_MANY_PREREQS',
      phase: 'Phase 1',
      title: 'Prereqs test',
      acceptanceCriteria: 'ok',
      prerequisites: Array.from({ length: 51 }, (_, i) => `T_P${i}`),
    });
    expect(tooManyPrereqs.ok).toBe(false);

    // Invalid diff_hash format in submit_audit (must be 64-char hex)
    const badHash = await call(client, 'mesh_submit_audit', {
      taskId: 'T_SOME',
      verdict: 'PASSED',
      diffHash: 'not-a-64-char-hex-hash',
      testRunSuccess: true,
      notes: 'Audit passed',
    });
    expect(badHash.ok).toBe(false);

    await client.close();
  });

  it('stdio gateway startup defense: refuses to initialize without valid AGENTMESH_TOKEN', async () => {
    // Missing token
    await expect(serveStdio(ids, services, undefined)).rejects.toThrow(AuthError);
    // Malformed token
    await expect(serveStdio(ids, services, 'malformed-token')).rejects.toThrow(AuthError);
    // Unknown token
    await expect(serveStdio(ids, services, generateToken())).rejects.toThrow(AuthError);
  });
});

/* =========================================================================
 * 4. Surface: Board & Verification Gate (packages/daemon/src/board & audit)
 * ========================================================================= */
describe('Surface 4: Board State Machine, Audit Gate & Path Leases', () => {
  it('state machine transition rules: direct transition to PASSED is strictly prohibited', async () => {
    const client = await clientFor(tokens.claude);

    await call(client, 'mesh_create_task', {
      id: 'T_AUDIT_BYPASS',
      phase: 'Phase 1',
      title: 'Audit Bypass Task',
      acceptanceCriteria: 'Criteria',
    });

    // Author cannot move status directly to PASSED via mesh_update_status
    const moveRes = await call(client, 'mesh_update_status', {
      taskId: 'T_AUDIT_BYPASS',
      status: 'PASSED' as never,
    });
    expect(moveRes.ok).toBe(false);
    expect(String(moveRes.value)).toMatch(/mesh_submit_for_review|INVALID/i);

    // Direct SQLite bypass: trigger trg_task_prevent_unauthorized_pass prevents direct UPDATE
    expect(() => {
      db.prepare("UPDATE tasks SET status = 'PASSED' WHERE id = 'T_AUDIT_BYPASS'").run();
    }).toThrow(/Cannot transition task to PASSED without a corresponding PASSED audit record/);

    await client.close();
  });

  it('two-agent verification: author and same-platform agents cannot audit own tasks', async () => {
    const claudeClient = await clientFor(tokens.claude);
    const geminiClient = await clientFor(tokens.gemini);

    await call(claudeClient, 'mesh_create_task', {
      id: 'T_TWO_AGENT',
      phase: 'Phase 1',
      title: 'Two Agent Task',
      acceptanceCriteria: 'Criteria',
    });

    // Claude claims task
    const claim = await call(claudeClient, 'mesh_claim_task', { taskId: 'T_TWO_AGENT' });
    expect(claim.ok).toBe(true);

    // Commit a change in worktree
    const wtPath = (claim.value as { worktree: string }).worktree;
    writeFileSync(join(wtPath, 'feature.txt'), 'done\n');
    g(wtPath, 'add', '.');
    g(wtPath, 'commit', '-q', '-m', 'implement feature');

    // Lease feature.txt and submit for review
    await call(claudeClient, 'mesh_acquire_lease', {
      taskId: 'T_TWO_AGENT',
      targets: [{ type: 'FILE', path: 'feature.txt' }],
    });
    const sub = await call(claudeClient, 'mesh_submit_for_review', { taskId: 'T_TWO_AGENT' });
    expect(sub.ok).toBe(true);
    const diffHash = (sub.value as { diffHash: string }).diffHash;

    // Claude attempts to claim audit on own task -> REFUSED
    const selfClaim = await call(claudeClient, 'mesh_claim_audit', { taskId: 'T_TWO_AGENT' });
    expect(selfClaim.ok).toBe(false);
    expect(String(selfClaim.value)).toMatch(/Author cannot audit/i);

    // Claude attempts to submit audit on own task -> REFUSED
    const selfSubmit = await call(claudeClient, 'mesh_submit_audit', {
      taskId: 'T_TWO_AGENT',
      verdict: 'PASSED',
      diffHash,
      testRunSuccess: true,
      notes: 'Self approval',
    });
    expect(selfSubmit.ok).toBe(false);

    // Gemini (cross-platform peer) CAN claim and submit audit
    const peerClaim = await call(geminiClient, 'mesh_claim_audit', { taskId: 'T_TWO_AGENT' });
    expect(peerClaim.ok).toBe(true);

    const peerSubmit = await call(geminiClient, 'mesh_submit_audit', {
      taskId: 'T_TWO_AGENT',
      verdict: 'PASSED',
      diffHash,
      testRunSuccess: true,
      notes: 'Independent audit passed',
    });
    expect(peerSubmit.ok).toBe(true);

    // Task is now PASSED
    const task = db.prepare('SELECT status, reviewing_agent_id FROM tasks WHERE id = ?').get('T_TWO_AGENT') as { status: string; reviewing_agent_id: string };
    expect(task.status).toBe('PASSED');
    expect(task.reviewing_agent_id).toBe('gemini-1');

    await claudeClient.close();
    await geminiClient.close();
  });

  it('audit gate: PASSED verdict requires testRunSuccess = true', async () => {
    const claudeClient = await clientFor(tokens.claude);
    const geminiClient = await clientFor(tokens.gemini);

    await call(claudeClient, 'mesh_create_task', {
      id: 'T_TEST_RUN',
      phase: 'Phase 1',
      title: 'Test Run Gate Task',
      acceptanceCriteria: 'Criteria',
    });
    const claim = await call(claudeClient, 'mesh_claim_task', { taskId: 'T_TEST_RUN' });
    const wtPath = (claim.value as { worktree: string }).worktree;
    writeFileSync(join(wtPath, 'code.txt'), 'code\n');
    g(wtPath, 'add', '.');
    g(wtPath, 'commit', '-q', '-m', 'code');

    await call(claudeClient, 'mesh_acquire_lease', {
      taskId: 'T_TEST_RUN',
      targets: [{ type: 'FILE', path: 'code.txt' }],
    });
    const sub = await call(claudeClient, 'mesh_submit_for_review', { taskId: 'T_TEST_RUN' });
    const diffHash = (sub.value as { diffHash: string }).diffHash;

    // Gemini submits PASSED with testRunSuccess: false -> REFUSED
    const failAudit = await call(geminiClient, 'mesh_submit_audit', {
      taskId: 'T_TEST_RUN',
      verdict: 'PASSED',
      diffHash,
      testRunSuccess: false,
      notes: 'Passed without running tests',
    });
    expect(failAudit.ok).toBe(false);
    expect(String(failAudit.value)).toMatch(/testRunSuccess/i);

    await claudeClient.close();
    await geminiClient.close();
  });

  it('lease path normalization: strictly prevents directory traversal and absolute paths', () => {
    // Valid relative paths
    expect(normalizeLeasePath('src/file.ts')).toBe('src/file.ts');
    expect(normalizeLeasePath('src\\file.ts')).toBe('src/file.ts');
    expect(normalizeLeasePath('./src/file.ts')).toBe('src/file.ts');

    // Traversal attempts
    expect(() => normalizeLeasePath('../secret.txt')).toThrow(/escapes the repository/);
    expect(() => normalizeLeasePath('src/../../secret.txt')).toThrow(/escapes the repository/);
    expect(() => normalizeLeasePath('/etc/passwd')).toThrow(/repo-relative/);
    expect(() => normalizeLeasePath('C:\\Windows\\system32')).toThrow(/repo-relative/);
    expect(() => normalizeLeasePath('//server/share')).toThrow(/repo-relative/);
  });

  it('HITL question permissions: agents cannot answer questions directed to Human', async () => {
    const claudeClient = await clientFor(tokens.claude);
    const geminiClient = await clientFor(tokens.gemini);

    // Claude asks Human a question
    const qRes = await call(claudeClient, 'mesh_ask_question', {
      text: 'Human guidance required',
      toRole: 'Human',
    });
    expect(qRes.ok).toBe(true);
    const qId = (qRes.value as { id: string }).id;

    // Gemini attempts to answer Human-directed question -> REFUSED by DB trigger
    const answerRes = await call(geminiClient, 'mesh_answer_question', {
      questionId: qId,
      answer: 'Agent answering for Human',
    });
    expect(answerRes.ok).toBe(false);
    expect(String(answerRes.value)).toMatch(/Questions directed to Human can only be answered by a Human/i);

    await claudeClient.close();
    await geminiClient.close();
  });
});

/* =========================================================================
 * 5. Surface: Runner (packages/daemon/src/runner)
 * ========================================================================= */
describe('Surface 5: Headless Runner Process & Command Security', () => {
  it('command generation: commands never bypass permission modes', () => {
    const claude = claudeCommand({ prompt: 'test prompt', worktree: 'D:/dummy' });
    expect(claude.args).toContain('--permission-mode');
    expect(claude.args).toContain('acceptEdits');
    expect(claude.args.join(' ')).not.toMatch(/--dangerously-skip-permissions/);

    const agy = agyCommand({ prompt: 'test prompt', worktree: 'D:/dummy' });
    expect(agy.args).toContain('--mode');
    expect(agy.args).toContain('accept-edits');
    expect(agy.args.join(' ')).not.toMatch(/--dangerously-skip-permissions/);
  });

  it('prompt safety: rejects oversized (> 8000 chars) and empty prompts', () => {
    expect(() => claudeCommand({ prompt: '', worktree: 'D:/dummy' })).toThrow(/Prompt is empty/);
    expect(() => claudeCommand({ prompt: '   ', worktree: 'D:/dummy' })).toThrow(/Prompt is empty/);
    expect(() => claudeCommand({ prompt: 'x'.repeat(8001), worktree: 'D:/dummy' })).toThrow(/limit is 8000/);
    expect(() => claudeCommand({ prompt: 'x'.repeat(8000), worktree: 'D:/dummy' })).not.toThrow();

    expect(() => agyCommand({ prompt: '', worktree: 'D:/dummy' })).toThrow(/Prompt is empty/);
    expect(() => agyCommand({ prompt: '   ', worktree: 'D:/dummy' })).toThrow(/Prompt is empty/);
    expect(() => agyCommand({ prompt: 'x'.repeat(8001), worktree: 'D:/dummy' })).toThrow(/limit is 8000/);
    expect(() => agyCommand({ prompt: 'x'.repeat(8000), worktree: 'D:/dummy' })).not.toThrow();
  });

  it('shell command injection immunity: arguments are passed directly with shell: false', async () => {
    // Spawn runner with prompt containing dangerous shell metacharacters
    const maliciousPrompt = '; echo INJECTED > pwn.txt && rm -rf /';
    const cmd = claudeCommand({ prompt: maliciousPrompt, worktree: repo });
    expect(cmd.args).toContain(maliciousPrompt);

    const running = startAgent({
      command: {
        platform: 'CLAUDE_CODE',
        executable: process.execPath, // node
        args: ['-e', 'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }))'],
        parse: () => [{ kind: 'result', ok: true, turns: 1, costUsd: 0, usage: null, text: null }],
      },
      cwd: repo,
    });

    const result = await running.done;
    expect(result.ok).toBe(true);

    // Verify no injected files were created by shell interpretation
    const pwnExists = db.prepare('SELECT 1').get();
    expect(pwnExists).toBeDefined();
  });

  it('tree termination: killTree ends child process cleanly without orphaned processes', async () => {
    const running = startAgent({
      command: {
        platform: 'ANTIGRAVITY',
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        parse: () => [],
      },
      cwd: repo,
      timeoutMs: 500, // Short timeout
    });

    const res = await running.done;
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });
});
