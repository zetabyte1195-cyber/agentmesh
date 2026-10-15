// How the project's check command (npm test, pytest...) is run. By default on this computer, in the task's
// workspace. Container mode can supply a runner that runs it inside the container instead: an agent in a
// container can write any file into its workspace, so a check run on the host would run the agent's code
// with your permissions (see sandbox/).
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface CheckOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}

/** Resolves with the output when the command exits 0; rejects like child_process.exec does ({ code, killed, stdout, stderr, message }) otherwise. */
export type CheckRunner = (command: string, options: CheckOptions) => Promise<{ stdout: string; stderr: string }>;

export const hostCheck: CheckRunner = (command, o) => execAsync(command, { cwd: o.cwd, windowsHide: true, timeout: o.timeoutMs, maxBuffer: o.maxBuffer });
