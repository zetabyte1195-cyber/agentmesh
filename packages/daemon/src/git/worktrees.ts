// Per-task git worktrees (spec v1.1 §8.1, docs/design/merge-queue.md §3, §5, §6).
import { exec } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type ExternalLink, isInside, unlinkExternalLinks } from './links.js';
import { GitError, git } from './run-git.js';

const execAsync = promisify(exec);

export type BootstrapStrategy = 'none' | 'install' | 'junction';

export interface BootstrapOptions {
  strategy: BootstrapStrategy;
  /** Shell command run inside the new worktree for strategy 'install', e.g. "npm ci". Comes from project config, never from an agent. */
  installCommand?: string;
  /** Directories of the primary tree to link in for strategy 'junction'. Default: ["node_modules"]. */
  linkDirs?: readonly string[];
  /** Files copied (never linked) from the primary tree if present, e.g. [".env"]. */
  copyFiles?: readonly string[];
}

export interface WorktreeControllerOptions {
  /** The primary tree (the Human's checkout). */
  repoRoot: string;
  /** Branch tasks are cut from and land on. Default "main". */
  trunk?: string;
  /** Where worktrees live, relative to repoRoot. Default ".agentmesh/worktrees". */
  worktreesDir?: string;
}

export interface AllocatedWorktree {
  taskId: string;
  branch: string;
  path: string;
  baseCommit: string;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  taskId: string | null;
}

export type DeleteBranch = 'never' | 'if-merged' | 'force';

export class WorktreeNotCleanError extends Error {
  constructor(
    readonly path: string,
    gitError: GitError,
  ) {
    super(`Worktree ${path} has uncommitted or untracked changes; not removed. ${gitError.stderr.trim()}`, { cause: gitError });
    this.name = 'WorktreeNotCleanError';
  }
}

/** git refused for another reason, e.g. a file still open on Windows ("Permission denied", live AC-8 run #3). */
export class WorktreeRemoveError extends Error {
  constructor(
    readonly path: string,
    gitError: GitError,
  ) {
    super(`Worktree ${path} could not be removed (a process may still have files open there). ${gitError.stderr.trim()}`, { cause: gitError });
    this.name = 'WorktreeRemoveError';
  }
}

/** How long a workspace's dependency install may take. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertTaskId(taskId: string): void {
  // No trailing '.': Windows strips it from folder names, so `git worktree add` fails (verified, P2.4).
  if (!TASK_ID.test(taskId) || taskId.includes('..') || taskId.endsWith('.')) throw new Error(`Invalid task id "${taskId}"`);
}

/** "P1.6" + "Git worktree controller" → "mesh/p1-6-git-worktree-controller" */
export function branchName(taskId: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const id = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `mesh/${id}${slug ? `-${slug}` : ''}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class WorktreeController {
  readonly repoRoot: string;
  readonly trunk: string;
  readonly worktreesRoot: string;
  private readonly worktreesDir: string;

  constructor(options: WorktreeControllerOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.trunk = options.trunk ?? 'main';
    this.worktreesDir = (options.worktreesDir ?? '.agentmesh/worktrees').replace(/\\/g, '/').replace(/\/+$/, '');
    this.worktreesRoot = resolve(this.repoRoot, this.worktreesDir);
    if (!isInside(this.repoRoot, this.worktreesRoot)) throw new Error('worktreesDir must be inside the repository');
  }

  pathFor(taskId: string): string {
    assertTaskId(taskId);
    return join(this.worktreesRoot, `wt-${taskId}`);
  }

  /** Create the task's worktree and branch from the local trunk, then bootstrap it. */
  async allocate(taskId: string, title: string, bootstrap: BootstrapOptions = { strategy: 'none' }): Promise<AllocatedWorktree> {
    const path = this.pathFor(taskId);
    if (await exists(path)) throw new Error(`Worktree for ${taskId} already exists at ${path}`);
    await this.ensureExcluded();
    const baseCommit = (await git(this.repoRoot, ['rev-parse', '--verify', `${this.trunk}^{commit}`])).trim();
    const branch = branchName(taskId, title);
    await git(this.repoRoot, ['worktree', 'add', '-b', branch, path, baseCommit]);
    try {
      await this.bootstrap(path, bootstrap);
    } catch (err) {
      // Leave nothing half-built behind; removal is link-safe.
      await this.remove(taskId, { deleteBranch: 'force' }).catch(() => undefined);
      throw err;
    }
    return { taskId, branch, path, baseCommit };
  }

  /**
   * Remove a task's worktree safely: unlink and verify every outward link FIRST (git follows
   * links on removal, even ignored ones), then `git worktree remove` without --force, so
   * uncommitted work is never discarded. Throws WorktreeNotCleanError if git refuses because of
   * uncommitted work, WorktreeRemoveError for any other refusal.
   */
  async remove(taskId: string, options: { deleteBranch?: DeleteBranch } = {}): Promise<{ unlinked: ExternalLink[] }> {
    const path = this.pathFor(taskId);
    const info = (await this.list()).find((w) => w.taskId === taskId);
    const unlinked = (await exists(path)) ? await unlinkExternalLinks(path) : [];
    try {
      await git(this.repoRoot, ['worktree', 'remove', path], { englishMessages: true });
    } catch (err) {
      // Only git's own "dirty" refusal means uncommitted work (messages forced to English above;
      // Gemini, P2.7 audit). The match only picks the error type: either way nothing is deleted.
      if (err instanceof GitError && (await exists(path))) {
        throw /contains modified or untracked files/.test(err.stderr) ? new WorktreeNotCleanError(path, err) : new WorktreeRemoveError(path, err);
      }
      throw err;
    }
    const deleteBranch = options.deleteBranch ?? 'never';
    if (deleteBranch !== 'never' && info?.branch) {
      await git(this.repoRoot, ['branch', deleteBranch === 'force' ? '-D' : '-d', info.branch]);
    }
    return { unlinked };
  }

  /** Worktrees under worktreesRoot, from `git worktree list --porcelain`. */
  async list(): Promise<WorktreeInfo[]> {
    const out = await git(this.repoRoot, ['worktree', 'list', '--porcelain']);
    const result: WorktreeInfo[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!path) continue;
      const abs = resolve(path);
      if (abs === this.repoRoot || !isInside(this.worktreesRoot, abs)) continue;
      const name = abs.slice(this.worktreesRoot.length + 1);
      const branchRef = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null;
      result.push({
        path: abs,
        head: lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
        branch: branchRef?.replace(/^refs\/heads\//, '') ?? null,
        taskId: name.startsWith('wt-') ? name.slice(3) : null,
      });
    }
    return result;
  }

  // ── scratch checkouts (planning runs) ──────────────────────────────────────
  private get scratchRoot(): string {
    return join(this.repoRoot, '.agentmesh', 'scratch');
  }

  /**
   * A disposable, detached checkout of trunk for a run that must READ the project but never change it (mission
   * planning and plan review). The agent works there instead of in the Human's working tree, so nothing it does
   * can touch the Human's files; the checkout is deleted when the run ends.
   */
  async createScratch(name: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`Invalid scratch name "${name}"`);
    const path = join(this.scratchRoot, name);
    await mkdir(this.scratchRoot, { recursive: true });
    await git(this.repoRoot, ['worktree', 'add', '--detach', '-f', path, this.trunk]);
    return path;
  }

  async removeScratch(path: string): Promise<void> {
    const abs = resolve(path);
    if (!isInside(this.scratchRoot, abs) || abs === resolve(this.scratchRoot)) throw new Error(`Refusing to remove ${path}: not a scratch checkout`);
    // git deletes THROUGH links (S0.5): unlink anything pointing outside before removing (Gemini, review A).
    if (await exists(abs)) await unlinkExternalLinks(abs).catch(() => undefined);
    await git(this.repoRoot, ['worktree', 'remove', '--force', abs]).catch(() => undefined);
    await rm(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }

  /** Startup: scratch checkouts belong to runs that are over (a crash or a stop left them). */
  async cleanScratch(): Promise<void> {
    await git(this.repoRoot, ['worktree', 'prune']).catch(() => undefined);
    await rm(this.scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    await git(this.repoRoot, ['worktree', 'prune']).catch(() => undefined);
  }

  /**
   * Crash recovery (merge-queue.md §5): prune records of worktrees whose directory vanished,
   * then report worktrees with no live task (orphaned) and live tasks with no worktree
   * (missing). Reports only; the caller decides what to clean up or block.
   */
  async reconcile(liveTaskIds: Iterable<string>): Promise<{ orphaned: WorktreeInfo[]; missing: string[] }> {
    await git(this.repoRoot, ['worktree', 'prune']);
    const live = new Set(liveTaskIds);
    const worktrees = await this.list();
    const present = new Set(worktrees.map((w) => w.taskId));
    return {
      orphaned: worktrees.filter((w) => !w.taskId || !live.has(w.taskId)),
      missing: [...live].filter((id) => !present.has(id)),
    };
  }

  /** Keep worktrees out of the primary tree's `git status` (merge-queue.md §3). */
  async ensureExcluded(): Promise<void> {
    await this.excludeLine(`/${this.worktreesDir.split('/')[0]}/`);
  }

  /** Add one pattern to the repository's local exclude file (never .gitignore), once. */
  private async excludeLine(line: string): Promise<void> {
    const commonDir = resolve(this.repoRoot, (await git(this.repoRoot, ['rev-parse', '--git-common-dir'])).trim());
    const excludePath = join(commonDir, 'info', 'exclude');
    const current = (await exists(excludePath)) ? await readFile(excludePath, 'utf8') : '';
    if (current.split(/\r?\n/).includes(line)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  }

  private async bootstrap(path: string, options: BootstrapOptions): Promise<void> {
    for (const file of options.copyFiles ?? []) {
      const src = resolve(this.repoRoot, file);
      const dest = resolve(path, file);
      if (!isInside(this.repoRoot, src) || !isInside(path, dest)) throw new Error(`copyFiles entry escapes the repository: ${file}`);
      if (!(await exists(src))) continue;
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    }
    if (options.strategy === 'junction') {
      for (const dir of options.linkDirs ?? ['node_modules']) {
        const src = resolve(this.repoRoot, dir);
        const dest = resolve(path, dir);
        if (!isInside(this.repoRoot, src) || !isInside(path, dest)) throw new Error(`linkDirs entry escapes the repository: ${dir}`);
        if (!(await exists(src))) continue;
        await mkdir(dirname(dest), { recursive: true });
        await symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
        // On macOS/Linux this is a symlink, which a `node_modules/` line in .gitignore does NOT match (it only
        // matches directories), so git would list it as new and `git add -A` would commit it. A junction on
        // Windows is a directory to git. Exclude the link by name either way.
        await this.excludeLine(`/${dir.replace(/\\/g, '/')}`);
      }
    } else if (options.strategy === 'install') {
      if (!options.installCommand) throw new Error('Bootstrap strategy "install" needs installCommand');
      // A time limit: an install waiting for a registry password would otherwise hold the claim forever (Gemini, review C).
      await execAsync(options.installCommand, { cwd: path, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: INSTALL_TIMEOUT_MS });
    }
  }
}
