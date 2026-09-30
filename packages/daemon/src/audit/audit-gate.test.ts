import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  type SqliteDatabase,
  closeDatabase,
  migrate,
  openDatabase,
} from '../db/index.js';
import { diffHash } from '../git/diff.js';
import { git } from '../git/run-git.js';
import { WorktreeController } from '../git/worktrees.js';
import {
  IDENTITY_MIGRATION,
  IdentityService,
  ImpersonationError,
  type Principal,
} from '../identity/index.js';
import { LeaseArbiter, UncoveredPathsError } from '../leases/index.js';
import { AuditGate } from './gate.js';
import {
  AuditGateError,
  ChecklistValidationError,
  InvalidCommitRangeError,
  MissingTestRunSuccessError,
  SamePlatformAuditError,
  StaleAuditDiffError,
  UnauthorizedAuditError,
} from './types.js';

let repo: string;
let db: SqliteDatabase;
let wc: WorktreeController;
let leases: LeaseArbiter;
let gate: AuditGate;

const g = (dir: string, ...args: string[]) => git(dir, args);

const CLAUDE_1: Principal = { agentId: 'claude-1', platform: 'CLAUDE_CODE', paradigm: 'CLI', isHuman: false };
const CLAUDE_2: Principal = { agentId: 'claude-2', platform: 'CLAUDE_CODE', paradigm: 'CLI', isHuman: false };
const GEMINI_1: Principal = { agentId: 'gemini-1', platform: 'ANTIGRAVITY', paradigm: 'CLI', isHuman: false };
const GEMINI_2: Principal = { agentId: 'gemini-2', platform: 'ANTIGRAVITY', paradigm: 'CLI', isHuman: false };
const HUMAN: Principal = { agentId: 'human-user', platform: 'HUMAN', paradigm: 'HUMAN', isHuman: true };

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-audit-'));
  await g(repo, 'init', '-q', '-b', 'main');
  await g(repo, 'config', 'user.email', 'test@example.com');
  await g(repo, 'config', 'user.name', 'test');
  await g(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Initial Repo\n');
  await g(repo, 'add', '.');
  await g(repo, 'commit', '-q', '-m', 'Initial commit');

  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);

  const idService = new IdentityService(db);
  idService.registerAgent({ id: 'claude-1', name: 'Claude Code 1', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  idService.registerAgent({ id: 'claude-2', name: 'Claude Code 2', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  idService.registerAgent({ id: 'gemini-1', name: 'Gemini Antigravity', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  idService.registerAgent({ id: 'gemini-2', name: 'Gemini Antigravity 2', platform: 'ANTIGRAVITY', paradigm: 'CLI' });
  idService.registerAgent({ id: 'human-user', name: 'Human Supervisor', platform: 'HUMAN', paradigm: 'HUMAN' });

  wc = new WorktreeController({ repoRoot: repo });
  leases = new LeaseArbiter(db);
  gate = new AuditGate({ db, repoRoot: repo, leases });
});

afterEach(async () => {
  for (const w of await wc.list()) {
    await wc.remove(w.taskId ?? '', { deleteBranch: 'force' }).catch(() => undefined);
  }
  closeDatabase(db);
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
});

/** Helper: create task with worktree, commits, and acquired lease. */
async function setupWorkingTask(taskId: string, author: Principal, files: Record<string, string>): Promise<{ wtPath: string; hash: string }> {
  const wt = await wc.allocate(taskId, `branch-${taskId}`);
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'phase-1', ?, 'AC')").run(taskId, `Task ${taskId}`);
  db.prepare(
    "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ?, branch_name = ?, worktree_path = ?, base_commit = ? WHERE id = ?",
  ).run(author.agentId, wt.branch, wt.path, wt.baseCommit, taskId);

  for (const [path, content] of Object.entries(files)) {
    const full = join(wt.path, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    // Author leases the file
    leases.acquire(author, taskId, [{ type: 'FILE', path }]);
  }
  await g(wt.path, 'add', '.');
  await g(wt.path, 'commit', '-q', '-m', `work on ${taskId}`);
  const head = (await g(wt.path, 'rev-parse', 'HEAD')).trim();
  const hash = await diffHash(wt.path, wt.baseCommit, head);
  db.prepare('UPDATE tasks SET head_commit = ? WHERE id = ?').run(head, taskId);

  return { wtPath: wt.path, hash };
}

describe('AuditGate: submitForReview', () => {
  it('pins diff_hash and transitions task to READY_FOR_REVIEW when leases cover changes', async () => {
    const { hash } = await setupWorkingTask('T1', CLAUDE_1, { 'src/app.ts': 'console.log("hello");\n' });

    const res = await gate.submitForReview(CLAUDE_1, { taskId: 'T1' });
    expect(res.status).toBe('READY_FOR_REVIEW');
    expect(res.diffHash).toBe(hash);

    const taskRow = db.prepare('SELECT status, diff_hash FROM tasks WHERE id = ?').get('T1') as { status: string; diff_hash: string };
    expect(taskRow.status).toBe('READY_FOR_REVIEW');
    expect(taskRow.diff_hash).toBe(hash);
  });

  it('rejects submission if author edited files without an active lease', async () => {
    const wt = await wc.allocate('T2', 'branch-T2');
    writeFileSync(join(wt.path, 'unleased.ts'), 'export const secret = 42;\n');
    await g(wt.path, 'add', '.');
    await g(wt.path, 'commit', '-q', '-m', 'unleased commit');
    const head = (await g(wt.path, 'rev-parse', 'HEAD')).trim();

    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'phase-1', 'T2', 'AC')").run('T2');
    db.prepare(
      "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ?, branch_name = ?, worktree_path = ?, base_commit = ?, head_commit = ? WHERE id = ?",
    ).run(CLAUDE_1.agentId, wt.branch, wt.path, wt.baseCommit, head, 'T2');

    // No lease acquired for unleased.ts!
    await expect(gate.submitForReview(CLAUDE_1, { taskId: 'T2' })).rejects.toThrow(UncoveredPathsError);
  });

  it('rejects submission from non-author agent', async () => {
    await setupWorkingTask('T3', CLAUDE_1, { 'src/a.ts': 'x' });
    await expect(gate.submitForReview(GEMINI_1, { taskId: 'T3' })).rejects.toThrow(UnauthorizedAuditError);
  });
});

describe('AuditGate: two-agent rule & same-platform refusal', () => {
  it('refuses same-platform audit claims and submissions', async () => {
    const { hash } = await setupWorkingTask('T-same', CLAUDE_1, { 'src/same.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-same' });

    // Claude 2 (same platform CLAUDE_CODE) attempts to claim audit
    await expect(gate.claimAudit(CLAUDE_2, { taskId: 'T-same' })).rejects.toThrow(SamePlatformAuditError);

    // Claude 2 attempts direct submitAudit
    await expect(
      gate.submitAudit(CLAUDE_2, {
        taskId: 'T-same',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: true,
        notes: 'looks good to me',
      }),
    ).rejects.toThrow(SamePlatformAuditError);
  });

  it('refuses self-audit (author auditing own task)', async () => {
    const { hash } = await setupWorkingTask('T-self', CLAUDE_1, { 'src/self.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-self' });

    await expect(gate.claimAudit(CLAUDE_1, { taskId: 'T-self' })).rejects.toThrow(UnauthorizedAuditError);
    await expect(
      gate.submitAudit(CLAUDE_1, {
        taskId: 'T-self',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: true,
        notes: 'self audit',
      }),
    ).rejects.toThrow(UnauthorizedAuditError);
  });

  it('allows cross-platform peer audit (Gemini audits Claude)', async () => {
    const { hash } = await setupWorkingTask('T-cross', CLAUDE_1, { 'src/cross.ts': 'cross platform code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-cross' });

    // Gemini claims audit
    const claim = await gate.claimAudit(GEMINI_1, { taskId: 'T-cross' });
    expect(claim.status).toBe('AUDITING');
    expect(claim.auditorAgentId).toBe(GEMINI_1.agentId);

    // Gemini submits PASSED audit
    const audit = await gate.submitAudit(GEMINI_1, {
      taskId: 'T-cross',
      verdict: 'PASSED',
      diffHash: hash,
      testRunSuccess: true,
      notes: 'Cross-platform audit passed: tests pass and diff matches spec.',
    });

    expect(audit.verdict).toBe('PASSED');
    expect(audit.auditorAgentId).toBe(GEMINI_1.agentId);

    // Status updated to PASSED in DB
    const row = db.prepare('SELECT status, reviewing_agent_id FROM tasks WHERE id = ?').get('T-cross') as {
      status: string;
      reviewing_agent_id: string;
    };
    expect(row.status).toBe('PASSED');
    expect(row.reviewing_agent_id).toBe(GEMINI_1.agentId);
  });
});

describe('AuditGate: Human override', () => {
  it('allows Human to audit any task, bypassing same-platform rule', async () => {
    const { hash } = await setupWorkingTask('T-human', CLAUDE_1, { 'src/human.ts': 'human test\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-human' });

    // Human audits Claude's task
    const audit = await gate.submitAudit(HUMAN, {
      taskId: 'T-human',
      verdict: 'PASSED',
      diffHash: hash,
      testRunSuccess: true,
      notes: 'Human supervisor reviewed and verified.',
    });

    expect(audit.verdict).toBe('PASSED');
    expect(audit.auditorAgentId).toBe(HUMAN.agentId);

    const taskRow = db.prepare('SELECT status, reviewing_agent_id FROM tasks WHERE id = ?').get('T-human') as {
      status: string;
      reviewing_agent_id: string;
    };
    expect(taskRow.status).toBe('PASSED');
    expect(taskRow.reviewing_agent_id).toBe(HUMAN.agentId);
  });
});

describe('AuditGate: diff pinning & STALE_AUDIT_DIFF', () => {
  it('rejects audit submission with mismatched diff_hash (STALE_AUDIT_DIFF)', async () => {
    await setupWorkingTask('T-diff', CLAUDE_1, { 'src/diff.ts': 'original\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-diff' });

    const bogusHash = 'a'.repeat(64);
    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-diff',
        verdict: 'PASSED',
        diffHash: bogusHash,
        testRunSuccess: true,
        notes: 'reviewed older diff',
      }),
    ).rejects.toThrow(StaleAuditDiffError);
  });

  it('rejects previously valid audit if task code changes post-review', async () => {
    const { wtPath, hash: originalHash } = await setupWorkingTask('T-post', CLAUDE_1, { 'src/post.ts': 'v1\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-post' });

    // Post-submission sneaky commit by author
    writeFileSync(join(wtPath, 'src/post.ts'), 'sneaky modification\n');
    await g(wtPath, 'commit', '-q', '-am', 'sneaky modification');
    const newHead = (await g(wtPath, 'rev-parse', 'HEAD')).trim();
    const newHash = await diffHash(wtPath, (await g(wtPath, 'rev-parse', 'main')).trim(), newHead);

    // Update pinned diff in task
    db.prepare('UPDATE tasks SET diff_hash = ?, head_commit = ? WHERE id = ?').run(newHash, newHead, 'T-post');

    // Gemini attempts to audit with the old originalHash
    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-post',
        verdict: 'PASSED',
        diffHash: originalHash,
        testRunSuccess: true,
        notes: 'auditing stale diff',
      }),
    ).rejects.toThrow(StaleAuditDiffError);
  });
});

describe('AuditGate: explicit testRunSuccess requirement (Decision d4)', () => {
  it('rejects audit if testRunSuccess is omitted or undefined (never defaulted)', async () => {
    const { hash } = await setupWorkingTask('T-testrun', CLAUDE_1, { 'src/t.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-testrun' });

    // Cast to any to test missing property at runtime
    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-testrun',
        verdict: 'PASSED',
        diffHash: hash,
        notes: 'forgot testRunSuccess',
      } as unknown as Parameters<typeof gate.submitAudit>[1]),
    ).rejects.toThrow(MissingTestRunSuccessError);

    // Same check for Human audits: Decision d4 strictly applies
    await expect(
      gate.submitAudit(HUMAN, {
        taskId: 'T-testrun',
        verdict: 'PASSED',
        diffHash: hash,
        notes: 'human forgot testRunSuccess',
      } as unknown as Parameters<typeof gate.submitAudit>[1]),
    ).rejects.toThrow(MissingTestRunSuccessError);
  });

  it('rejects PASSED verdict if testRunSuccess is false', async () => {
    const { hash } = await setupWorkingTask('T-false', CLAUDE_1, { 'src/f.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-false' });

    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-false',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: false,
        notes: 'passed despite failed tests',
      }),
    ).rejects.toThrow(/testRunSuccess = true/i);
  });
});

describe('AuditGate: per-project checklist schema validation (R15)', () => {
  it('enforces required checklist items on PASSED verdict', async () => {
    const { hash } = await setupWorkingTask('T-check', CLAUDE_1, { 'src/check.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-check' });

    // Set custom project checklist schema
    gate.setChecklistSchema({
      items: [
        { id: 'unit_tests', label: 'Unit tests pass', required: true },
        { id: 'security_scan', label: 'Security scan clean', required: true },
        { id: 'benchmarks', label: 'Benchmarks recorded', required: false },
      ],
    });

    // Incomplete checklist (missing security_scan)
    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-check',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: true,
        checklistResults: { unit_tests: true },
        notes: 'missing security scan',
      }),
    ).rejects.toThrow(ChecklistValidationError);

    // Complete checklist satisfies gate
    const audit = await gate.submitAudit(GEMINI_1, {
      taskId: 'T-check',
      verdict: 'PASSED',
      diffHash: hash,
      testRunSuccess: true,
      checklistResults: { unit_tests: true, security_scan: true, benchmarks: false },
      notes: 'All required checklist items passed',
    });

    expect(audit.verdict).toBe('PASSED');
    expect(audit.checklistResults).toMatchObject({ unit_tests: true, security_scan: true });
  });

  it('allows failed checklist items when verdict is GAP_FOUND or REJECTED', async () => {
    const { hash } = await setupWorkingTask('T-gap', CLAUDE_1, { 'src/gap.ts': 'broken code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-gap' });

    gate.setChecklistSchema({
      items: [{ id: 'unit_tests', label: 'Unit tests pass', required: true }],
    });

    const audit = await gate.submitAudit(GEMINI_1, {
      taskId: 'T-gap',
      verdict: 'GAP_FOUND',
      diffHash: hash,
      testRunSuccess: false,
      checklistResults: { unit_tests: false },
      notes: 'Unit tests failed on edge cases: see finding.',
    });

    expect(audit.verdict).toBe('GAP_FOUND');
    const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get('T-gap') as { status: string };
    expect(taskRow.status).toBe('REJECTED');
  });
});

describe('AuditGate: defense-in-depth and impersonation safety', () => {
  it('blocks impersonation via assertActingAs', async () => {
    const { hash } = await setupWorkingTask('T-imp', CLAUDE_1, { 'src/imp.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-imp' });

    // Principal is GEMINI_1, but claimed auditorAgentId is claude-1
    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-imp',
        auditorAgentId: 'claude-1',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: true,
        notes: 'impersonating',
      }),
    ).rejects.toThrow(ImpersonationError);
  });

  it('database trigger rejects direct update of tasks to PASSED without an audit', async () => {
    await setupWorkingTask('T-db', CLAUDE_1, { 'src/db.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-db' });

    // Attempting direct bypass in SQL without inserting audit
    expect(() => {
      db.prepare("UPDATE tasks SET status = 'PASSED' WHERE id = 'T-db'").run();
    }).toThrow(/Cannot transition task to PASSED without a corresponding PASSED audit record/);
  });

  it('database trigger enforces immutability of audit records', async () => {
    const { hash } = await setupWorkingTask('T-immut', CLAUDE_1, { 'src/immut.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-immut' });

    const audit = await gate.submitAudit(GEMINI_1, {
      taskId: 'T-immut',
      verdict: 'PASSED',
      diffHash: hash,
      testRunSuccess: true,
      notes: 'Initial audit',
    });

    // UPDATE trigger raises abort
    expect(() => {
      db.prepare("UPDATE audits SET notes = 'tampered' WHERE id = ?").run(audit.id);
    }).toThrow(/Audit records are immutable and cannot be updated/);

    // DELETE trigger raises abort
    expect(() => {
      db.prepare('DELETE FROM audits WHERE id = ?').run(audit.id);
    }).toThrow(/Audit records are immutable and cannot be deleted/);
  });
});

describe('P1.8 audit gate regressions: Claude GAP_FOUND findings 1–4', () => {
  // Finding 1 [SECURITY]: Caller-supplied baseCommit/headCommit cannot narrow the range or bypass lease check
  it('rejects caller attempts to override baseCommit/headCommit to bypass leases (Claude probe scenario)', async () => {
    // Setup Claude's exact probe scenario:
    // Only b.txt is leased. Commit c1 touches a.txt (UNLEASED), commit c2 touches b.txt (LEASED).
    const taskId = 'T-probe-security';
    const wt = await wc.allocate(taskId, `branch-${taskId}`);
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'phase-1', ?, 'AC')").run(
      taskId,
      `Task ${taskId}`,
    );
    db.prepare(
      "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ?, branch_name = ?, worktree_path = ?, base_commit = ? WHERE id = ?",
    ).run(CLAUDE_1.agentId, wt.branch, wt.path, wt.baseCommit, taskId);

    // Only lease b.txt
    leases.acquire(CLAUDE_1, taskId, [{ type: 'FILE', path: 'b.txt' }]);

    // Commit c1 touches a.txt (UNLEASED)
    writeFileSync(join(wt.path, 'a.txt'), 'unleased change in c1\n');
    await g(wt.path, 'add', 'a.txt');
    await g(wt.path, 'commit', '-q', '-m', 'commit c1 touches unleased a.txt');
    const c1 = (await g(wt.path, 'rev-parse', 'HEAD')).trim();

    // Commit c2 touches b.txt (LEASED)
    writeFileSync(join(wt.path, 'b.txt'), 'leased change in c2\n');
    await g(wt.path, 'add', 'b.txt');
    await g(wt.path, 'commit', '-q', '-m', 'commit c2 touches leased b.txt');

    // Control: standard submitForReview({ taskId }) evaluates full range base_commit..c2, touches a.txt -> rejected
    await expect(gate.submitForReview(CLAUDE_1, { taskId })).rejects.toThrow(UncoveredPathsError);

    // Probe A: Author tries to narrow range by passing baseCommit: c1 to skip a.txt -> rejected
    await expect(gate.submitForReview(CLAUDE_1, { taskId, baseCommit: c1 })).rejects.toThrow(InvalidCommitRangeError);

    // Probe B: Author tries to pass a bogus headCommit -> rejected
    await expect(gate.submitForReview(CLAUDE_1, { taskId, headCommit: c1 })).rejects.toThrow(InvalidCommitRangeError);

    // Any submission attempt must be rejected
    const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(taskRow.status).toBe('IN_PROGRESS');
  });

  // Finding 2 [BUG]: Refuses submission/audit when worktree_path or base_commit is missing (no fallback to repoRoot or trunk)
  it('refuses submitForReview and submitAudit when worktree_path or base_commit is missing', async () => {
    // Task with missing worktree_path
    const tMissingWt = 'T-missing-wt';
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'phase-1', ?, 'AC')").run(
      tMissingWt,
      tMissingWt,
    );
    db.prepare(
      "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ?, base_commit = 'abc' WHERE id = ?",
    ).run(CLAUDE_1.agentId, tMissingWt);

    await expect(gate.submitForReview(CLAUDE_1, { taskId: tMissingWt })).rejects.toThrow(AuditGateError);
    await expect(gate.submitForReview(CLAUDE_1, { taskId: tMissingWt })).rejects.toThrow(
      expect.objectContaining({ code: 'MISSING_WORKTREE' }),
    );

    // Task with missing base_commit
    const tMissingBase = 'T-missing-base';
    const wt = await wc.allocate(tMissingBase, `branch-${tMissingBase}`);
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'phase-1', ?, 'AC')").run(
      tMissingBase,
      tMissingBase,
    );
    db.prepare(
      "UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ?, worktree_path = ?, branch_name = ? WHERE id = ?",
    ).run(CLAUDE_1.agentId, wt.path, wt.branch, tMissingBase);

    await expect(gate.submitForReview(CLAUDE_1, { taskId: tMissingBase })).rejects.toThrow(AuditGateError);
    await expect(gate.submitForReview(CLAUDE_1, { taskId: tMissingBase })).rejects.toThrow(
      expect.objectContaining({ code: 'MISSING_BASE_COMMIT' }),
    );
  });

  // Finding 3 [BUG]: Worktree HEAD check at submitAudit time refuses diverged HEAD (STALE_AUDIT_DIFF)
  it('refuses submitAudit if worktree HEAD has diverged from pinned head_commit (STALE_AUDIT_DIFF)', async () => {
    const { wtPath, hash } = await setupWorkingTask('T-diverged', CLAUDE_1, { 'src/code.ts': 'initial version\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-diverged' });

    // Pinned head_commit is H1. Now author sneaks in a new commit H2 without re-submitting.
    // The DB task still has head_commit = H1 and diff_hash = hash.
    writeFileSync(join(wtPath, 'src/code.ts'), 'sneaky unreviewed change\n');
    await g(wtPath, 'commit', '-q', '-am', 'unreviewed post-submission commit');

    // Auditor submits audit citing the pinned diff_hash (which matches DB diff_hash),
    // but the daemon detects worktree HEAD !== task.head_commit
    await expect(
      gate.submitAudit(GEMINI_1, {
        taskId: 'T-diverged',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: true,
        notes: 'auditor checks out pinned diff hash',
      }),
    ).rejects.toThrow(StaleAuditDiffError);

    const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get('T-diverged') as { status: string };
    expect(taskRow.status).toBe('READY_FOR_REVIEW');
  });

  // Finding 4 [BUG]: In AUDITING status, only the claiming reviewing_agent_id (or Human) may submit the verdict
  it('in AUDITING status, enforces that only the claiming reviewing_agent_id or Human may submit verdict', async () => {
    const { hash } = await setupWorkingTask('T-audit-claim', CLAUDE_1, { 'src/claim.ts': 'code\n' });
    await gate.submitForReview(CLAUDE_1, { taskId: 'T-audit-claim' });

    // GEMINI_1 claims the audit
    const claimRes = await gate.claimAudit(GEMINI_1, { taskId: 'T-audit-claim' });
    expect(claimRes.status).toBe('AUDITING');

    // Peer GEMINI_2 (also eligible platform) tries to submit verdict on GEMINI_1's claimed audit -> rejected
    await expect(
      gate.submitAudit(GEMINI_2, {
        taskId: 'T-audit-claim',
        verdict: 'PASSED',
        diffHash: hash,
        testRunSuccess: true,
        notes: 'unauthorized peer submitting on claimed audit',
      }),
    ).rejects.toThrow(UnauthorizedAuditError);

    // Human supervisor override: Human can submit verdict on any claimed audit
    const humanAudit = await gate.submitAudit(HUMAN, {
      taskId: 'T-audit-claim',
      verdict: 'PASSED',
      diffHash: hash,
      testRunSuccess: true,
      notes: 'Human supervisor override on claimed audit',
    });
    expect(humanAudit.verdict).toBe('PASSED');

    const taskRow = db.prepare('SELECT status, reviewing_agent_id FROM tasks WHERE id = ?').get('T-audit-claim') as {
      status: string;
      reviewing_agent_id: string;
    };
    expect(taskRow.status).toBe('PASSED');
    expect(taskRow.reviewing_agent_id).toBe(HUMAN.agentId);
  });
});
