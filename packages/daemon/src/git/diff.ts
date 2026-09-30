// One definition of "the task's diff", shared by the audit gate (P1.8) and the merge queue (P1.7),
// so the hash an auditor pins and the patch the queue lands describe the same bytes
// (spec v1.1 §9.1, merge-queue.md §4.2).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { git } from './run-git.js';

/** The exact diff reviewed by an auditor: `git diff <base> <head>`. */
export function taskDiff(repo: string, base: string, head: string): Promise<string> {
  return git(repo, ['diff', '--no-color', '--no-ext-diff', base, head]);
}

/** diff_hash = SHA-256 of taskDiff (spec v1.1 §9.1). */
export async function diffHash(repo: string, base: string, head: string): Promise<string> {
  return createHash('sha256').update(await taskDiff(repo, base, head), 'utf8').digest('hex');
}

/**
 * `git patch-id --stable` of the diff: ignores line numbers and whitespace, so it survives a
 * rebase onto unrelated trunk commits (verified). Empty diff → empty string.
 */
export async function patchId(repo: string, base: string, head: string): Promise<string> {
  const diff = await taskDiff(repo, base, head);
  if (!diff) return '';
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['patch-id', '--stable'], { cwd: repo, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim().split(/\s+/)[0] ?? '') : reject(new Error(`git patch-id failed: ${err}`))));
    child.stdin.end(diff);
  });
}
