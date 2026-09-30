// How the command line finds and talks to a running daemon (agentmesh login / stop / status / dispatch).
//
// At start the daemon issues a Human token for the command line and records {port, pid, token} in a
// file under the user's profile (never inside the project, so agents working in the project do not see
// it), readable only by the user on macOS/Linux. The command line then calls the daemon's existing
// Human-only routes with that token as a Bearer credential, so every rule and timeline entry is the same
// as for a click in the cockpit. The token is revoked and the file removed when the daemon stops.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from '../git/run-git.js';

export interface DaemonRecord {
  root: string;
  port: number;
  pid: number;
  token: string;
  startedAt: string;
}

/** The project a folder belongs to, exactly as the daemon keys its record (git top level, resolved). */
export async function projectRoot(cwd: string): Promise<string> {
  return resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
}

export function runtimeDir(home: string = process.env.AGENTMESH_HOME ?? join(homedir(), '.agentmesh')): string {
  return join(home, 'daemons');
}

export function daemonFile(root: string, dir = runtimeDir()): string {
  const key = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  return join(dir, `${key}.json`);
}

export function writeDaemonRecord(record: DaemonRecord, dir = runtimeDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = daemonFile(record.root, dir);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // an existing file keeps its old mode otherwise
  } catch {
    // Windows: the profile folder is already private to the user
  }
  return file;
}

export function readDaemonRecord(root: string, dir = runtimeDir()): DaemonRecord | null {
  const file = daemonFile(root, dir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DaemonRecord;
  } catch {
    return null;
  }
}

/** Remove the record, but only if it still belongs to this process (a restarted daemon may have replaced it). */
export function removeDaemonRecord(root: string, pid: number, dir = runtimeDir()): void {
  const current = readDaemonRecord(root, dir);
  if (current && current.pid !== pid) return;
  rmSync(daemonFile(root, dir), { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class NotRunningError extends Error {
  constructor(root: string) {
    super(`AgentMesh is not running for ${root}. Start it with: agentmesh start`);
    this.name = 'NotRunningError';
  }
}

/** Call a Human route of the daemon running for this project. Throws NotRunningError if there is none. */
export async function callDaemon<T = unknown>(root: string, method: 'GET' | 'POST', path: string, body?: unknown, dir = runtimeDir()): Promise<T> {
  const rec = readDaemonRecord(root, dir);
  if (!rec || !isAlive(rec.pid)) throw new NotRunningError(root);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${rec.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${rec.token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new NotRunningError(root);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
