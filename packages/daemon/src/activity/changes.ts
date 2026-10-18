// The files a task's workspace differs by, as the cockpit shows them while the agent works: what it changed so far, committed or not,
// compared with where the workspace branched from the main branch. Read from git, so it is what git would say, not what the agent says.
//
// The workspace is a folder an agent can write to. So: git is run with the settings that make it run programs from a repository's
// own configuration switched off, the workspace's link back to the project is checked before git is run in it, and a file git does
// not know yet is only ever read if it is a plain file of a sensible size (never a link, a pipe or a device).
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git } from '../git/run-git.js';
import { isInside } from '../git/links.js';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Lines added and removed; null for a file git treats as binary. */
  added: number | null;
  removed: number | null;
  from?: string;
}

export interface Changes {
  files: ChangedFile[];
  truncated: boolean;
}

const STATUS: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };
const MAX_COUNTED_BYTES = 1_000_000;
/** Settings that stop git running a program named in a repository's configuration (a file-system monitor, hooks), and external diff programs. */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=.agentmesh-no-hooks', '-c', 'core.untrackedCache=false'] as const;

/**
 * Lines in a file git does not know yet. Null if it is not a plain file (a link, a pipe, a device), is too big to be worth
 * reading, or looks binary. Never follows a link: an agent could leave one pointing anywhere. Reads no more than the limit.
 */
function countLines(file: string): number | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(file).isFile()) return null; // lstat does not follow a link
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd); // what was really opened, not what the name said a moment ago
    if (!st.isFile() || st.size > MAX_COUNTED_BYTES) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAX_COUNTED_BYTES));
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const data = buf.subarray(0, read);
    if (data.includes(0)) return null;
    const text = data.toString('utf8');
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Whether git may be run in this workspace. A workspace made by `git worktree add` has a `.git` FILE that names a folder inside the
 * project's own `.git`. An agent can rewrite that file to name another repository, whose configuration could run a program when git
 * is run in it. So with a project folder given, only a workspace that still points into the project is trusted.
 */
export function trustedWorkspace(workspace: string, projectRoot?: string): boolean {
  if (!projectRoot) return true;
  try {
    const dotGit = join(workspace, '.git');
    if (!lstatSync(dotGit).isFile()) return false; // a folder there would be a repository of its own
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return false;
    const gitdir = resolve(workspace, m[1]!);
    if (!isInside(join(projectRoot, '.git', 'worktrees'), gitdir) || dirname(gitdir) === gitdir) return false;
    // It must lead back to this project's own .git, and have no configuration of its own.
    const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
    if (resolve(common).toLowerCase() !== resolve(projectRoot, '.git').toLowerCase()) return false;
    return !existsSync(join(gitdir, 'config.worktree'));
  } catch {
    return false;
  }
}

export async function changedFiles(cwd: string, trunk: string, options: { max?: number; projectRoot?: string } = {}): Promise<Changes> {
  const max = options.max ?? 200;
  const none: Changes = { files: [], truncated: false };
  if (!trustedWorkspace(cwd, options.projectRoot)) return none;
  const run = (args: string[]) => git(cwd, [...SAFE, ...args]);
  try {
    // Where this workspace branched from the main branch; HEAD itself if the main branch is not known here.
    const base = (await run(['merge-base', 'HEAD', trunk]).catch(() => 'HEAD')).trim() || 'HEAD';
    const [nameStatus, numstat, untracked] = await Promise.all([
      run(['diff', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', base]),
      run(['diff', '--no-ext-diff', '--no-textconv', '-M', '--numstat', '-z', base]),
      run(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);

    const counts = new Map<string, { added: number | null; removed: number | null }>();
    const n = numstat.split('\0');
    for (let i = 0; i < n.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(n[i] ?? '');
      if (!m) continue;
      // A rename is "added<TAB>removed<TAB>" followed by the old and the new name as two more fields.
      const path = m[3] === '' ? (n[i + 2] ?? '') : m[3]!;
      if (m[3] === '') i += 2;
      counts.set(path, { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
    }

    const files: ChangedFile[] = [];
    const s = nameStatus.split('\0');
    for (let i = 0; i < s.length; i++) {
      const code = s[i] ?? '';
      if (!code) continue;
      const status = STATUS[code[0]!];
      if (!status) continue;
      if (code[0] === 'R' || code[0] === 'C') {
        const from = s[++i] ?? '';
        const path = s[++i] ?? '';
        files.push({ path, status, from, ...(counts.get(path) ?? { added: 0, removed: 0 }) });
      } else {
        const path = s[++i] ?? '';
        files.push({ path, status, ...(counts.get(path) ?? { added: 0, removed: 0 }) });
      }
    }
    for (const path of untracked.split('\0')) {
      if (!path) continue;
      const lines = countLines(join(cwd, path));
      files.push({ path, status: 'added', added: lines, removed: lines === null ? null : 0 });
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files: files.slice(0, max), truncated: files.length > max };
  } catch {
    return none;
  }
}
