// Finding and removing links that point outside a worktree.
//
// Why this exists (verified on Windows 11, see board finding on P1.6): `git worktree remove`
// follows directory junctions/symlinks inside the worktree and deletes their TARGET's
// contents. It does this even without --force when the link is git-ignored (node_modules
// usually is). So every outward link must be unlinked, and verified gone, before git is
// asked to remove the worktree.
import { readdir, readlink, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface ExternalLink {
  /** Absolute path of the link inside the worktree. */
  path: string;
  /** Absolute path the link points to, outside the worktree. */
  target: string;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate); // case-insensitive on win32
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk `root` without following any link and return every link whose target resolves
 * outside `root`. Links that stay inside (e.g. npm-workspace junctions in node_modules)
 * are harmless and are neither returned nor descended into. Unreadable directories throw:
 * if we can't look, we can't claim the tree is safe.
 */
export async function findExternalLinks(root: string): Promise<ExternalLink[]> {
  const rootAbs = resolve(root);
  const found: ExternalLink[] = [];
  const pending = [rootAbs];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dir, await readlink(path));
        if (!isInside(rootAbs, target)) found.push({ path, target });
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return found;
}

/**
 * Unlink every outward link under `root` (removing only the link, never its target),
 * then re-scan and throw if any remain. Returns what was unlinked.
 */
export async function unlinkExternalLinks(root: string): Promise<ExternalLink[]> {
  const links = await findExternalLinks(root);
  for (const link of links) await unlink(link.path);
  const remaining = await findExternalLinks(root);
  if (remaining.length) {
    throw new Error(`Refusing to continue: ${remaining.length} outward link(s) could not be removed, e.g. ${remaining[0]?.path}`);
  }
  return links;
}
