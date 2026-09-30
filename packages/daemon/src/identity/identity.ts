// Agent identity (P1.4, spec v1.1 §7.1): the daemon issues each agent instance a token and
// derives WHO is acting from that token, never from an agent id the caller supplies.
import type { AgentParadigm } from '@agentmesh/core';
import type { Migration, SqliteDatabase } from '../db/index.js';
import { withImmediateTransaction } from '../db/index.js';
import { generateToken, hashToken, isWellFormedToken } from './tokens.js';

/**
 * Migration 2. Credentials live in their own table so tokens survive daemon restarts:
 * IDE agents reach the daemon through a static MCP config and can't be re-issued a token
 * on every start. Only SHA-256 hashes are stored.
 */
export const IDENTITY_MIGRATION: Migration = {
  version: 2,
  name: '0002_agent_credentials',
  up: `
    CREATE TABLE IF NOT EXISTS agent_credentials (
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        label TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        revoked_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_credentials_agent ON agent_credentials(agent_id);
  `,
};

/** Who is acting, as established by a token. */
export interface Principal {
  agentId: string;
  platform: string;
  paradigm: AgentParadigm;
  isHuman: boolean;
}

export interface RegisterAgentInput {
  id: string;
  name: string;
  platform: string;
  paradigm: AgentParadigm;
  capabilities?: readonly string[];
}

export type AuthFailure = 'MISSING_TOKEN' | 'MALFORMED_TOKEN' | 'UNKNOWN_TOKEN' | 'REVOKED_TOKEN';

export class AuthError extends Error {
  constructor(readonly reason: AuthFailure) {
    super(`Authentication failed: ${reason}`);
    this.name = 'AuthError';
  }
}

export class ImpersonationError extends Error {
  constructor(
    readonly principal: Principal,
    readonly claimedAgentId: string,
  ) {
    super(`Agent ${principal.agentId} may not act as ${claimedAgentId}`);
    this.name = 'ImpersonationError';
  }
}

interface CredentialRow {
  agent_id: string;
  revoked_at: string | null;
  platform: string;
  paradigm: AgentParadigm;
}

export class IdentityService {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Register a new agent instance and issue its first token. Daemon-internal: never exposed
   * as an agent tool, so an agent can't mint identities for itself.
   */
  registerAgent(input: RegisterAgentInput): { principal: Principal; token: string } {
    return withImmediateTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO agents (id, name, platform, paradigm, capabilities) VALUES (?, ?, ?, ?, ?)')
        .run(input.id, input.name, input.platform, input.paradigm, JSON.stringify(input.capabilities ?? []));
      const token = this.insertToken(input.id, 'registration');
      return { principal: toPrincipal(input.id, input.platform, input.paradigm), token };
    });
  }

  /** Issue an additional token for an existing agent (rotation, a new cockpit session). */
  issueToken(agentId: string, label?: string): string {
    return withImmediateTransaction(this.db, () => {
      const exists = this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId);
      if (!exists) throw new Error(`Unknown agent ${agentId}`);
      return this.insertToken(agentId, label ?? null);
    });
  }

  /** Resolve a token to its principal. Every mutating request goes through this. */
  authenticate(token: string | null | undefined): Principal {
    if (!token) throw new AuthError('MISSING_TOKEN');
    if (!isWellFormedToken(token)) throw new AuthError('MALFORMED_TOKEN');
    const hash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT c.agent_id, c.revoked_at, a.platform, a.paradigm
           FROM agent_credentials c JOIN agents a ON a.id = c.agent_id
          WHERE c.token_hash = ?`,
      )
      .get(hash) as CredentialRow | undefined;
    if (!row) throw new AuthError('UNKNOWN_TOKEN');
    if (row.revoked_at) throw new AuthError('REVOKED_TOKEN');
    this.db.prepare('UPDATE agent_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hash);
    return toPrincipal(row.agent_id, row.platform, row.paradigm);
  }

  revokeToken(token: string): boolean {
    const result = this.db
      .prepare('UPDATE agent_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL')
      .run(hashToken(token));
    return result.changes > 0;
  }

  revokeAllForAgent(agentId: string): number {
    return this.db
      .prepare('UPDATE agent_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE agent_id = ? AND revoked_at IS NULL')
      .run(agentId).changes;
  }

  private insertToken(agentId: string, label: string | null): string {
    const token = generateToken();
    this.db
      .prepare('INSERT INTO agent_credentials (token_hash, agent_id, label) VALUES (?, ?, ?)')
      .run(hashToken(token), agentId, label);
    return token;
  }
}

/**
 * Guard for request payloads that still carry an agent id (legacy tools, forwarded messages):
 * the id must be the caller's own. Handlers should prefer principal.agentId and ignore payload ids.
 */
export function assertActingAs(principal: Principal, claimedAgentId: string | null | undefined): void {
  if (claimedAgentId != null && claimedAgentId !== principal.agentId) throw new ImpersonationError(principal, claimedAgentId);
}

function toPrincipal(agentId: string, platform: string, paradigm: AgentParadigm): Principal {
  return { agentId, platform, paradigm, isHuman: paradigm === 'HUMAN' && platform === 'HUMAN' };
}
