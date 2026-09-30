import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${args.join(' ')} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/**
 * Run git without a shell (arguments are never re-parsed) and return stdout. `englishMessages`
 * forces untranslated git messages (LC_ALL=C) for callers that must recognise a refusal by its text.
 */
export async function git(cwd: string, args: readonly string[], options: { englishMessages?: boolean } = {}): Promise<string> {
  try {
    const env = options.englishMessages ? { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } : undefined;
    const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: unknown; message: string };
    throw new GitError(args, e.stderr || e.message, typeof e.code === 'number' ? e.code : null);
  }
}
