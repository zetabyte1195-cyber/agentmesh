// V1.3 (spec v1.1 §14, AC-7): `agentmesh export` must let a reviewer reconstruct any task's full
// history — claims, handoffs, findings, questions, audits, landing — from the Markdown snapshot
// alone. Fixtures go through the real services (BoardService, LeaseArbiter, AuditGate), the same
// path a live run takes, so the DB triggers that guard that history are exercised too.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditGate } from '../audit/index.js';
import { BoardService } from '../board/index.js';
import { MIGRATIONS, closeDatabase, migrate, openDatabase, type SqliteDatabase } from '../db/index.js';
import { WorktreeController } from '../git/worktrees.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { initProject } from '../init/index.js';
import { LeaseArbiter } from '../leases/index.js';
import { exportBoard } from './export.js';

let repo: string;
let db: SqliteDatabase;
let wc: WorktreeController;
let board: BoardService;
let claude: Principal;
let gemini: Principal;
let human: Principal;

const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-export-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  await initProject({ repoRoot: repo });

  db = openDatabase(join(repo, '.agentmesh', 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  gemini = ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).principal;
  human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  wc = new WorktreeController({ repoRoot: repo });
  board = new BoardService({ db, worktrees: wc });
});

afterEach(async () => {
  for (const w of await wc.list()) await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

/** Claim, lease, commit, submit, audit PASSED — the exact sequence AC-7 must be reconstructable from. */
async function buildTaskHistory(): Promise<void> {
  board.createTask(human, { id: 'X1', phase: 'Phase 1', title: 'Task with a | pipe', acceptanceCriteria: 'must work' });
  const claim = await board.claimTask(claude, 'X1');
  const leases = new LeaseArbiter(db);
  leases.acquire(claude, 'X1', [{ type: 'FILE', path: 'greeting.txt' }]);
  writeFileSync(join(claim.worktree, 'greeting.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: claim.worktree });
  execFileSync('git', ['commit', '-q', '-m', 'X1: greeting'], { cwd: claim.worktree });

  board.logFinding(claude, { taskId: 'X1', text: 'Found a | bug\nsecond line', severity: 'BUG', file: 'greeting.txt', line: 1 });
  board.sendHandoff(claude, { taskId: 'X1', toAgentId: 'gemini-1', message: 'Please review', actionItems: ['Check output'] });
  const q = board.askQuestion(claude, { taskId: 'X1', text: 'Is this ok?', toRole: 'Human' });
  board.answerQuestion(human, q.id, 'Yes, ship it');
  board.recordDecision(claude, { taskId: 'X1', decision: 'Use approach A', rationale: 'Simpler' });

  const gate = new AuditGate({ db, repoRoot: repo, leases });
  const submitted = await gate.submitForReview(claude, { taskId: 'X1' });
  await gate.submitAudit(gemini, { taskId: 'X1', verdict: 'PASSED', diffHash: submitted.diffHash, testRunSuccess: true, notes: 'verified greeting.txt' });

  // A second task with no history at all, to exercise the "_none_" branches.
  board.createTask(human, { id: 'X2', phase: 'Phase 1', title: 'Untouched task', acceptanceCriteria: 'n/a' });
}

describe('exportBoard', () => {
  it('refuses when the daemon has never run (no .agentmesh/mesh.db)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentmesh-export-bare-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: bare });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: bare });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: bare });
    execFileSync('git', ['commit', '-q', '-m', 'base', '--allow-empty'], { cwd: bare });
    await expect(exportBoard({ repoRoot: bare })).rejects.toThrow(/agentmesh init.*agentmesh start/);
    rmSync(bare, { recursive: true, force: true, maxRetries: 3 });
  });

  it('writes a Markdown snapshot to the default path that reconstructs the full task history', async () => {
    await buildTaskHistory();
    const report = await exportBoard({ repoRoot: repo, now: new Date('2026-09-24T12:00:00.000Z') });

    expect(report.path).toBe(join(repo, '.agentmesh', 'export.md'));
    expect(report.taskCount).toBe(2);
    expect(report.eventCount).toBeGreaterThan(0);
    expect(existsSync(report.path)).toBe(true);
    expect(readFileSync(report.path, 'utf8')).toBe(report.markdown);

    const md = report.markdown;
    expect(md).toContain('# AgentMesh Board Export');
    expect(md).toContain('Generated: 2026-09-24T12:00:00.000Z');

    // Agents table.
    expect(md).toContain('| claude-1 | Claude | CLAUDE_CODE |');
    expect(md).toContain('| gemini-1 | Gemini | ANTIGRAVITY |');
    expect(md).toContain('| human | Human | HUMAN |');

    // Claim, findings, handoffs, questions, decisions, audit (AC-7).
    expect(md).toContain('### X1 — Task with a | pipe');
    expect(md).toContain('- Status: PASSED');
    expect(md).toContain('- Assigned to: claude-1');
    expect(md).toContain('- Reviewing agent: gemini-1');
    expect(md).toContain('**Findings** (1)');
    expect(md).toContain('[BUG] Found a \\| bug second line (greeting.txt:1) — claude-1');
    expect(md).toContain('**Handoffs** (2)');
    expect(md).toContain('claude-1 → gemini-1: Please review');
    expect(md).toContain('- [ ] Check output');
    expect(md).toContain('**Questions** (1)');
    expect(md).toContain('Is this ok?');
    expect(md).toMatch(/A \(human, .*\): Yes, ship it/);
    expect(md).toContain('**Decisions** (1)');
    expect(md).toContain('Use approach A — Simpler');
    expect(md).toContain('**Audits** (1)');
    expect(md).toMatch(/PASSED by gemini-1 .* tests passed: verified greeting\.txt/);

    // Untouched task shows the "no history" branches.
    expect(md).toContain('### X2 — Untouched task');
    expect(md).toContain('**Findings** (0)');
    expect(md.match(/_none_/g)?.length).toBeGreaterThanOrEqual(5); // findings, handoffs, audits, questions, decisions for X2

    // Timeline is chronological (oldest first): the claim follows the task being added.
    // (Timeline entries run through the same pipe-escaping as table cells, unlike the task heading.)
    const addedAt = md.indexOf('added X1: Task with a \\| pipe');
    const claimedAt = md.indexOf('claimed X1: Task with a \\| pipe');
    expect(addedAt).toBeGreaterThan(-1);
    expect(claimedAt).toBeGreaterThan(addedAt);
  });

  it('honors a custom, relative output path', async () => {
    await buildTaskHistory();
    const report = await exportBoard({ repoRoot: repo, outputPath: join('reports', 'board.md') });
    expect(report.path).toBe(join(repo, 'reports', 'board.md'));
    expect(existsSync(report.path)).toBe(true);
  });
});
