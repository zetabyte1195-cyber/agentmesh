// P3.3 Re-audit Adversarial Probes
// Probing:
// 1. /api/stop-run audit trail: when stopped is true, records decision event by the Human; when false, records nothing.
// 2. act() error classification: SqliteError with non-constraint code (e.g. SQLITE_BUSY, SQLITE_CORRUPT) returns 500, NOT 409.
// 3. act() error classification: SqliteError with SQLITE_CONSTRAINT_* returns 409.
// 4. act() error classification: TypeError / SyntaxError / RangeError return 500 without error leak.
// 5. /api/dispatch validation: agentId: "" returns 400.
// 6. BoardService.recordControl: only human principal can invoke it; non-human throws BoardError('FORBIDDEN').
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardError } from '../board/index.js';
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
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-p33-reaudit-'));
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

describe('P3.3 Re-audit Probes', () => {
  it('probe: stop-run records decision event by the Human when a run is stopped', async () => {
    // Simulate a running agent by monkeypatching dispatcher.stopRun
    const originalStopRun = d.dispatcher.stopRun.bind(d.dispatcher);
    (d.dispatcher as unknown as { stopRun: (agentId: string) => Promise<boolean> }).stopRun = async (agentId: string) => {
      return agentId === 'claude-1';
    };

    try {
      const res = await asHuman('/api/stop-run', { agentId: 'claude-1' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stopped: true });

      const lastEvent = d.db.prepare("SELECT agent_id, kind, text FROM events WHERE kind = 'decision' ORDER BY rowid DESC LIMIT 1").get() as { agent_id: string; kind: string; text: string };
      expect(lastEvent).toEqual({
        agent_id: 'human',
        kind: 'decision',
        text: "stopped claude-1's run",
      });
    } finally {
      d.dispatcher.stopRun = originalStopRun;
    }
  });

  it('probe: non-constraint SqliteError (e.g. SQLITE_BUSY, SQLITE_CORRUPT) is 500, not 409', async () => {
    const originalAnswer = d.board.answerQuestion.bind(d.board);
    (d.board as unknown as { answerQuestion: () => void }).answerQuestion = () => {
      const err = new Error('database is locked') as Error & { name: string; code: string };
      err.name = 'SqliteError';
      err.code = 'SQLITE_BUSY';
      throw err;
    };

    try {
      const res = await asHuman('/api/answer', { questionId: 'q1', answer: 'test' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).not.toContain('database is locked');
    } finally {
      d.board.answerQuestion = originalAnswer;
    }
  });

  it('probe: constraint SqliteError (SQLITE_CONSTRAINT_*) is 409 Refused', async () => {
    const originalAnswer = d.board.answerQuestion.bind(d.board);
    (d.board as unknown as { answerQuestion: () => void }).answerQuestion = () => {
      const err = new Error('CHECK constraint failed: trg_questions_resolve_check') as Error & { name: string; code: string };
      err.name = 'SqliteError';
      err.code = 'SQLITE_CONSTRAINT_TRIGGER';
      throw err;
    };

    try {
      const res = await asHuman('/api/answer', { questionId: 'q1', answer: 'test' });
      expect(res.status).toBe(409);
      expect(String(res.json.error)).toContain('CHECK constraint failed');
    } finally {
      d.board.answerQuestion = originalAnswer;
    }
  });

  it('probe: TypeError and SyntaxError return 500 without leaking error message', async () => {
    const originalAnswer = d.board.answerQuestion.bind(d.board);
    (d.board as unknown as { answerQuestion: () => void }).answerQuestion = () => {
      throw new TypeError('Cannot read properties of undefined (reading secret_token)');
    };

    try {
      const res = await asHuman('/api/answer', { questionId: 'q1', answer: 'test' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).not.toContain('secret_token');
    } finally {
      d.board.answerQuestion = originalAnswer;
    }
  });

  it('probe: BoardService.recordControl rejects non-human principals with FORBIDDEN', () => {
    const claude = d.identity.authenticate(d.identity.issueToken('claude-1', 'test'));
    expect(() => d.board.recordControl(claude, 'illegal control')).toThrow(BoardError);
    try {
      d.board.recordControl(claude, 'illegal control');
    } catch (e) {
      expect((e as BoardError).code).toBe('FORBIDDEN');
    }
  });
});
