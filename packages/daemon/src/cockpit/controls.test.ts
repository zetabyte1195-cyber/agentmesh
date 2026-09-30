import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init/index.js';
import { type RunningDaemon, startDaemon } from '../start/index.js';

let repo: string;
let d: RunningDaemon;
let cookie: string;
let origin: string;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: d.port, method, path, headers: { Host: `127.0.0.1:${d.port}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (c: string) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? (JSON.parse(data) as Record<string, unknown>) : {} }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const asHuman = (path: string, body: unknown) => send('POST', path, { Cookie: cookie, Origin: origin }, body);

/** Claude really claims, commits and submits T1, so the Human has something to review. */
async function submittedTask(): Promise<void> {
  const claude = d.identity.authenticate(d.identity.issueToken('claude-1', 'test'));
  const human = d.identity.authenticate(d.identity.issueToken('human', 'test'));
  d.board.createTask(human, { id: 'T1', phase: 'p', title: 'greeting', acceptanceCriteria: 'greeting.txt says hi' });
  const { worktree } = await d.board.claimTask(claude, 'T1');
  d.leases.acquire(claude, 'T1', [{ type: 'FILE', path: 'greeting.txt' }]);
  writeFileSync(join(worktree, 'greeting.txt'), 'hi\n');
  g(worktree, 'add', '.');
  g(worktree, 'commit', '-q', '-m', 'T1');
  await d.gate.submitForReview(claude, { taskId: 'T1' });
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-controls-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@example.com');
  g(repo, 'config', 'user.name', 't');
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

describe('Human controls (P3.3)', () => {
  it('are Human-only, and cookie writes need the daemon Origin', async () => {
    const agentToken = d.identity.issueToken('claude-1', 'test');
    expect((await send('POST', '/api/dispatch', { Authorization: `Bearer ${agentToken}` }, { paused: true })).status).toBe(403);
    expect((await send('POST', '/api/dispatch', { Cookie: cookie }, { paused: true })).status).toBe(403); // no Origin
    expect((await send('POST', '/api/dispatch', { Cookie: cookie, Origin: 'http://evil.example' }, { paused: true })).status).toBe(403);
    expect((await asHuman('/api/dispatch', { paused: 'yes' })).status).toBe(400); // validated
  });

  it('pause/resume dispatch', async () => {
    expect((await asHuman('/api/dispatch', { paused: true })).json).toEqual({ paused: true });
    expect(d.dispatcher.isPaused()).toBe(true);
    expect((await asHuman('/api/dispatch', { paused: false })).json).toEqual({ paused: false });
    expect((await asHuman('/api/dispatch', { paused: true, agentId: 'gemini-1' })).json).toEqual({ paused: true });
    // recorded in the timeline as the Human (P3.3 AC; Gemini's audit found these missing)
    expect(d.db.prepare("SELECT agent_id AS a, kind, text FROM events WHERE kind = 'decision' ORDER BY rowid").all()).toEqual([
      { a: 'human', kind: 'decision', text: 'paused dispatching' },
      { a: 'human', kind: 'decision', text: 'resumed dispatching' },
      { a: 'human', kind: 'decision', text: 'paused dispatching for gemini-1' },
    ]);
  });

  it('answers a question addressed to the Human', async () => {
    const claude = d.identity.authenticate(d.identity.issueToken('claude-1', 'test'));
    const q = d.board.askQuestion(claude, { text: 'Ship it?', toRole: 'Human' });
    expect((await asHuman('/api/answer', { questionId: q.id, answer: 'Yes' })).status).toBe(200);
    expect(d.db.prepare('SELECT resolved, answer, answered_by_agent_id AS by FROM questions WHERE id = ?').get(q.id)).toEqual({ resolved: 1, answer: 'Yes', by: 'human' });
    expect((await asHuman('/api/answer', { questionId: q.id, answer: 'again' })).status).toBe(409); // already answered
  });

  it('sends a message to an agent as a handoff from the Human', async () => {
    await submittedTask();
    expect((await asHuman('/api/message', { toAgentId: 'claude-1', taskId: 'T1', message: 'Please also add a newline.' })).status).toBe(200);
    expect(d.db.prepare("SELECT from_agent_id AS f, to_agent_id AS t, message FROM handoffs WHERE task_id = 'T1'").get()).toEqual({ f: 'human', t: 'claude-1', message: 'Please also add a newline.' });
  });

  it('reviews a submitted task: diff, checks, then an audit with an explicit test result', async () => {
    await submittedTask();
    const diff = await asHuman('/api/diff', { taskId: 'T1' });
    expect(diff.status).toBe(200);
    expect(String(diff.json.diff)).toContain('+hi');
    const verify = await asHuman('/api/verify', { taskId: 'T1' });
    expect(verify.json).toMatchObject({ ok: true, exitCode: 0 });

    // testRunSuccess must be stated explicitly (Human decision on P1.8)
    expect((await asHuman('/api/audit', { taskId: 'T1', verdict: 'PASSED', diffHash: diff.json.diffHash, notes: 'ok' })).status).toBe(400);
    // an audit of a different diff is refused by the gate
    expect((await asHuman('/api/audit', { taskId: 'T1', verdict: 'PASSED', diffHash: 'f'.repeat(64), testRunSuccess: true, notes: 'ok' })).status).toBe(409);

    const audit = await asHuman('/api/audit', { taskId: 'T1', verdict: 'PASSED', diffHash: diff.json.diffHash, testRunSuccess: true, notes: 'Checked greeting.txt; checks pass.' });
    expect(audit.status).toBe(200);
    expect((d.db.prepare("SELECT status, reviewing_agent_id AS r FROM tasks WHERE id = 'T1'").get() as { status: string; r: string })).toEqual({ status: 'PASSED', r: 'human' });
  });
});
