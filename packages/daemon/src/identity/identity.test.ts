import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import {
  AuthError,
  IDENTITY_MIGRATION,
  IdentityService,
  ImpersonationError,
  type Principal,
  assertActingAs,
} from './identity.js';
import { extractBearer, generateToken, hashToken, isWellFormedToken } from './tokens.js';

const ALL_MIGRATIONS = [...MIGRATIONS, IDENTITY_MIGRATION];

let dir: string;
let dbPath: string;
let db: SqliteDatabase;
let ids: IdentityService;
let tokens: Record<'claude1' | 'claude2' | 'gemini1' | 'human', string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-identity-'));
  dbPath = join(dir, 'mesh.db');
  db = openDatabase(dbPath);
  migrate(db, ALL_MIGRATIONS);
  ids = new IdentityService(db);
  tokens = {
    claude1: ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token,
    claude2: ids.registerAgent({ id: 'claude-2', name: 'Claude 2', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token,
    gemini1: ids.registerAgent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY', paradigm: 'CLI' }).token,
    human: ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).token,
  };
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** What an audit handler does: identity from the token only; a payload id is only a cross-check. */
function submitAudit(token: string, taskId: string, payloadAgentId?: string): Principal {
  const principal = ids.authenticate(token);
  assertActingAs(principal, payloadAgentId);
  db.prepare(
    `INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
     VALUES (?, ?, ?, 'PASSED', 'h1', 1, 'reviewed')`,
  ).run(`a-${Math.random().toString(36).slice(2)}`, taskId, principal.agentId);
  return principal;
}

function readyTaskBy(author: string, id = 'T1'): string {
  db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES (?, 'p', 't', 'ac')").run(id);
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', assigned_agent_id = ? WHERE id = ?").run(author, id);
  db.prepare("UPDATE tasks SET status = 'READY_FOR_REVIEW', diff_hash = 'h1' WHERE id = ?").run(id);
  return id;
}

const status = (id: string) => (db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

describe('tokens', () => {
  it('are 256-bit, prefixed, unique, and hashed to 64 hex chars', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(isWellFormedToken(a)).toBe(true);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses Bearer headers strictly', () => {
    expect(extractBearer('Bearer amt_x')).toBe('amt_x');
    expect(extractBearer('bearer   amt_x  ')).toBe('amt_x');
    for (const bad of [undefined, null, '', 'amt_x', 'Basic abc', 'Bearer', 'Bearer a b']) expect(extractBearer(bad)).toBeNull();
  });
});

describe('IdentityService', () => {
  it('derives the principal from the token', () => {
    expect(ids.authenticate(tokens.gemini1)).toEqual({ agentId: 'gemini-1', platform: 'ANTIGRAVITY', paradigm: 'CLI', isHuman: false });
    expect(ids.authenticate(tokens.human).isHuman).toBe(true);
  });

  it('rejects missing, malformed, unknown and revoked tokens with a typed reason', () => {
    const reason = (t: string | undefined) => {
      try {
        ids.authenticate(t);
      } catch (e) {
        return (e as AuthError).reason;
      }
      return 'ACCEPTED';
    };
    expect(reason(undefined)).toBe('MISSING_TOKEN');
    expect(reason('claude-1')).toBe('MALFORMED_TOKEN'); // an agent id is not a credential
    expect(reason(generateToken())).toBe('UNKNOWN_TOKEN');
    ids.revokeToken(tokens.claude1);
    expect(reason(tokens.claude1)).toBe('REVOKED_TOKEN');
  });

  it('never stores a raw token', () => {
    closeDatabase(db);
    const bytes = readFileSync(dbPath).toString('latin1') + safeRead(`${dbPath}-wal`);
    for (const t of Object.values(tokens)) expect(bytes.includes(t)).toBe(false);
    expect(bytes.includes(hashToken(tokens.gemini1))).toBe(true);
    db = openDatabase(dbPath);
  });

  it('keeps tokens valid across a daemon restart (IDE agents have static MCP configs)', () => {
    closeDatabase(db);
    db = openDatabase(dbPath);
    migrate(db, ALL_MIGRATIONS);
    ids = new IdentityService(db);
    expect(ids.authenticate(tokens.gemini1).agentId).toBe('gemini-1');
  });

  it('rotates and revokes per agent', () => {
    const second = ids.issueToken('claude-1', 'rotation');
    expect(ids.authenticate(second).agentId).toBe('claude-1');
    expect(ids.revokeAllForAgent('claude-1')).toBe(2);
    expect(() => ids.authenticate(second)).toThrow(AuthError);
    expect(ids.authenticate(tokens.gemini1).agentId).toBe('gemini-1');
  });

  it('refuses a second Human registration atomically (no orphan credential)', () => {
    const before = (db.prepare('SELECT count(*) n FROM agent_credentials').get() as { n: number }).n;
    expect(() => ids.registerAgent({ id: 'human-2', name: 'Also human', platform: 'HUMAN', paradigm: 'HUMAN' })).toThrow();
    expect((db.prepare('SELECT count(*) n FROM agent_credentials').get() as { n: number }).n).toBe(before);
  });
});

describe('an agent cannot act or audit as another (P1.4 acceptance)', () => {
  it('rejects a payload that names a different agent', () => {
    const claude = ids.authenticate(tokens.claude1);
    expect(() => assertActingAs(claude, 'gemini-1')).toThrow(ImpersonationError);
    expect(() => assertActingAs(claude, 'claude-1')).not.toThrow();
    expect(() => assertActingAs(claude, undefined)).not.toThrow();
  });

  it('Claude cannot pass its own task by claiming to be Gemini in the payload', () => {
    const task = readyTaskBy('claude-1');
    expect(() => submitAudit(tokens.claude1, task, 'gemini-1')).toThrow(ImpersonationError);
    expect(status(task)).toBe('READY_FOR_REVIEW');
  });

  it('a second Claude instance cannot audit Claude: identity comes from the token, and the DB enforces the platform rule', () => {
    const task = readyTaskBy('claude-1');
    expect(() => submitAudit(tokens.claude2, task)).toThrow(/Two-agent rule/);
    expect(status(task)).toBe('READY_FOR_REVIEW');
  });

  it('Gemini and the Human can audit Claude', () => {
    expect(submitAudit(tokens.gemini1, readyTaskBy('claude-1', 'T1')).agentId).toBe('gemini-1');
    expect(status('T1')).toBe('PASSED');
    expect(submitAudit(tokens.human, readyTaskBy('claude-1', 'T2')).isHuman).toBe(true);
    expect(status('T2')).toBe('PASSED');
  });

  it('a revoked token cannot audit', () => {
    const task = readyTaskBy('claude-1');
    ids.revokeToken(tokens.gemini1);
    expect(() => submitAudit(tokens.gemini1, task)).toThrow(AuthError);
    expect(status(task)).toBe('READY_FOR_REVIEW');
  });
});

function safeRead(path: string): string {
  try {
    return readFileSync(path).toString('latin1');
  } catch {
    return '';
  }
}
