// P3.3 Adversarial Audit Probes
// Probing:
// 1. act() error mapping: internal runtime errors (ReferenceError, RangeError, SqliteError) incorrectly map to 409 Refused.
// 2. act() error mapping: plain Error rule refusals that don't match the narrow regex fall through to 500.
// 3. /api/stop-run lack of audit trail: stopping an agent run emits no event in the events table / timeline.
// 4. /api/dispatch with empty agentId (""): accidentally pauses global dispatch instead of validating.
// 5. Two-platform audit rule: confirms that non-human agents cannot bypass the rule via the underlying gate.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SamePlatformAuditError, UnauthorizedAuditError } from '../audit/types.js';
import { initProject } from '../init/index.js';
import { type RunningDaemon, startDaemon } from '../start/index.js';

let repo: string;
let d: RunningDaemon;
let cookie: string;
let origin: string;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: d.port,
        method,
        path,
        headers: {
          Host: `127.0.0.1:${d.port}`,
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8').on('data', (c: string) => (data += c));
        res.on('end', () => {
          let json: Record<string, unknown>;
          try {
            json = data ? (JSON.parse(data) as Record<string, unknown>) : {};
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const asHuman = (path: string, body: unknown) => send('POST', path, { Cookie: cookie, Origin: origin }, body);

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-p33-probe-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'probe@example.com');
  g(repo, 'config', 'user.name', 'probe');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  await initProject({ repoRoot: repo });
  d = await startDaemon({ repoRoot: repo, port: 0, autoDispatch: false, log: () => {} });
  origin = `http://127.0.0.1:${d.port}`;
  const login = new URL(d.loginUrl);
  const res = await new Promise<string>((resolve) => {
    request({ host: '127.0.0.1', port: d.port, path: login.pathname + login.search, headers: { Host: `127.0.0.1:${d.port}` } }, (r) => {
      r.resume();
      resolve(String(r.headers['set-cookie']).split(';')[0]!);
    }).end();
  });
  cookie = res;
});

afterEach(async () => {
  await d.stop();
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

describe('P3.3 Controls & Security probes', () => {
  // Fixed after these probes: they now assert the corrected behaviour (act() maps only domain errors and
  // SQLite constraints to 409; agentId must be non-empty). Stop-run events: see controls.test.ts.
  it('probe: an internal ReferenceError is a 500 and its message does not leak', async () => {
    // If an unexpected ReferenceError occurs in board service (e.g. simulated by mocking or monkey-patching),
    // act() catches it and turns it into 409 because e.name === "ReferenceError" matches /Error$/.
    const originalAnswer = d.board.answerQuestion.bind(d.board);
    (d.board as unknown as { answerQuestion: () => void }).answerQuestion = () => {
      throw new ReferenceError('internalVariable is not defined');
    };

    try {
      const res = await asHuman('/api/answer', { questionId: 'q1', answer: 'test' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).not.toContain('internalVariable');
    } finally {
      d.board.answerQuestion = originalAnswer;
    }
  });

  it('probe: a plain Error (not a domain refusal class) is a 500', async () => {
    // If a service throws a standard Error with a refusal message not in the regex
    // (e.g. "Worktree lease expired by policy"), act() skips it and it falls through to 500.
    const originalAnswer = d.board.answerQuestion.bind(d.board);
    (d.board as unknown as { answerQuestion: () => void }).answerQuestion = () => {
      throw new Error('Worktree lease expired by policy');
    };

    try {
      const res = await asHuman('/api/answer', { questionId: 'q1', answer: 'test' });
      // Falls through to 500 because e.name === "Error" is explicitly excluded and message lacks keywords!
      expect(res.status).toBe(500);
    } finally {
      d.board.answerQuestion = originalAnswer;
    }
  });

  it('probe: /api/stop-run for an agent with no run stops nothing and records nothing', async () => {
    const eventsBefore = d.db.prepare('SELECT count(*) as c FROM events').get() as { c: number };
    const res = await asHuman('/api/stop-run', { agentId: 'claude-1' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ stopped: false });

    // Verify events table has recorded NO audit trail for this stop-run request
    const eventsAfter = d.db.prepare('SELECT count(*) as c FROM events').get() as { c: number };
    expect(eventsAfter.c).toBe(eventsBefore.c);
  });

  it('probe: /api/dispatch with agentId: "" is rejected and does not pause global dispatch', async () => {
    // When sending agentId: "" (empty string instead of undefined)
    expect(d.dispatcher.isPaused()).toBe(false);
    const res = await asHuman('/api/dispatch', { paused: true, agentId: '' });
    expect(res.status).toBe(400);
    expect(d.dispatcher.isPaused()).toBe(false);
  });

  it('probe: two-platform rule still strictly holds for agents via AuditGate', async () => {
    // Setup task authored by claude-1
    const human = d.identity.authenticate(d.identity.issueToken('human', 'test'));
    d.board.createTask(human, { id: 'T_AUDIT', phase: 'p', title: 'Audit Test', acceptanceCriteria: 'ok' });
    const claude = d.identity.authenticate(d.identity.issueToken('claude-1', 'test'));
    const { worktree } = await d.board.claimTask(claude, 'T_AUDIT');
    d.leases.acquire(claude, 'T_AUDIT', [{ type: 'FILE', path: 'file.txt' }]);
    writeFileSync(join(worktree, 'file.txt'), 'content\n');
    g(worktree, 'add', '.');
    g(worktree, 'commit', '-q', '-m', 'work');
    await d.gate.submitForReview(claude, { taskId: 'T_AUDIT' });

    const taskRow = d.db.prepare('SELECT diff_hash FROM tasks WHERE id = ?').get('T_AUDIT') as { diff_hash: string };

    // Another Claude agent (same platform CLAUDE_CODE)
    const claude2Reg = d.identity.registerAgent({ id: 'claude-2', name: 'Claude 2', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
    const claude2 = d.identity.authenticate(claude2Reg.token);
    // Attempting audit from same platform must throw SamePlatformAuditError
    await expect(
      d.gate.submitAudit(claude2, {
        taskId: 'T_AUDIT',
        auditorAgentId: 'claude-2',
        verdict: 'PASSED',
        diffHash: taskRow.diff_hash,
        testRunSuccess: true,
        notes: 'same platform audit',
      }),
    ).rejects.toBeInstanceOf(SamePlatformAuditError);

    // Author auditing own task must throw UnauthorizedAuditError
    await expect(
      d.gate.submitAudit(claude, {
        taskId: 'T_AUDIT',
        auditorAgentId: 'claude-1',
        verdict: 'PASSED',
        diffHash: taskRow.diff_hash,
        testRunSuccess: true,
        notes: 'self audit',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedAuditError);

    // Human auditing the task must succeed
    const humanRecord = await d.gate.submitAudit(human, {
      taskId: 'T_AUDIT',
      auditorAgentId: 'human',
      verdict: 'PASSED',
      diffHash: taskRow.diff_hash,
      testRunSuccess: true,
      notes: 'human audit verified',
    });
    expect(humanRecord.verdict).toBe('PASSED');
  });
});
