// Lease paths are repo-relative, forward-slash, and compared case-insensitively where the
// filesystem is (Windows): "src/A.ts" and "src/a.ts" are the same file there.
import type { LeaseResourceType } from '@agentmesh/core';

export interface LeaseTarget {
  type: LeaseResourceType;
  /** Repo-relative path. For DIR, "." means the whole repository. */
  path: string;
}

/** Normalize to "a/b/c" (DIR "." for the root). Rejects absolute paths and anything escaping the repo. */
export function normalizeLeasePath(raw: string): string {
  const input = raw.trim().replace(/\\/g, '/');
  if (input === '') throw new Error('Lease path is empty');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) throw new Error(`Lease path must be repo-relative: ${raw}`);
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new Error(`Lease path escapes the repository: ${raw}`);
    parts.push(segment);
  }
  return parts.length ? parts.join('/') : '.';
}

export function comparisonKey(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

function contains(dir: string, path: string): boolean {
  return dir === '.' || path === dir || path.startsWith(`${dir}/`);
}

/** Do two lease targets cover any common file? Paths must already be normalized and keyed. */
export function overlaps(a: LeaseTarget, b: LeaseTarget): boolean {
  if (a.type === 'FILE' && b.type === 'FILE') return a.path === b.path;
  if (a.type === 'DIR' && b.type === 'DIR') return contains(a.path, b.path) || contains(b.path, a.path);
  const [dir, file] = a.type === 'DIR' ? [a, b] : [b, a];
  return contains(dir.path, file.path);
}

/** Is `file` covered by `lease`? */
export function covers(lease: LeaseTarget, file: string): boolean {
  return lease.type === 'FILE' ? lease.path === file : contains(lease.path, file);
}
