import { git } from '../git/run-git.js';

/**
 * Paths a task changed between two commits, for submission-time lease checks.
 * --no-renames reports a rename as a deletion plus an addition, so the OLD path must be
 * leased too (a plain --name-only would list only the new name and let the deletion slip by).
 */
export async function changedPathsBetween(repo: string, base: string, head: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '--no-renames', '-z', base, head]);
  return out.split('\0').filter(Boolean);
}
