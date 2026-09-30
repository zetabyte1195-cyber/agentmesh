import { createHash, randomBytes } from 'node:crypto';

/** Prefix makes tokens recognisable in logs and secret scanners ("AgentMesh Token"). */
export const TOKEN_PREFIX = 'amt_';
/** 32 random bytes = 256 bits (spec v1.1 §7.1). */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^amt_[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Only this hash is stored; the raw token exists only in the agent's hands. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** "Bearer amt_…" → "amt_…"; anything else → null. */
export function extractBearer(authorizationHeader: string | undefined | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader ?? '');
  return match?.[1] ?? null;
}
