// `agentmesh status`: what is going on in this project, whether or not AgentMesh is running. Reads the
// project database read-only (safe next to a running daemon: SQLite WAL), so it never changes anything.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import type { ProjectConfig } from '../init/init.js';
import { MissionService } from '../missions/service.js';
import { isAlive, projectRoot, readDaemonRecord } from './runtime.js';

export interface StatusReport {
  root: string;
  running: { port: number; pid: number } | null;
  dispatchPaused: boolean;
  landing: 'on' | 'on without checks' | 'off';
  agents: { id: string; name: string; platform: string; status: string; doing: string | null }[];
  tasks: { id: string; title: string; status: string; owner: string | null }[];
  missions: { id: string; title: string; status: string; waitingOn: string[] }[];
  leases: { taskId: string; agentId: string; type: string; path: string; expiresAt: string }[];
  questions: { from: string; taskId: string | null; text: string }[];
}

const hasTable = (db: SqliteDatabase, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

export async function projectStatus(repoRoot: string, options: { runtimeDir?: string } = {}): Promise<StatusReport> {
  const root = await projectRoot(repoRoot);
  const dbPath = join(root, '.agentmesh', 'mesh.db');
  const configPath = join(root, '.agentmesh', 'config.json');
  if (!existsSync(configPath)) throw new Error('AgentMesh is not set up here yet: run agentmesh init');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig;
  const rec = readDaemonRecord(root, options.runtimeDir);
  const running = rec && isAlive(rec.pid) ? { port: rec.port, pid: rec.pid } : null;
  const landing = config.verifyCommand ? 'on' : config.landWithoutVerify ? 'on without checks' : 'off';
  if (!existsSync(dbPath)) {
    // Set up but never started: the database is created by the first `agentmesh start`.
    const agents = config.agents.map((a) => ({ id: a.id, name: a.id, platform: a.platform, status: 'IDLE', doing: null }));
    return { root, running, dispatchPaused: false, landing, agents, tasks: [], missions: [], leases: [], questions: [] };
  }

  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    const agents = db
      .prepare(
        `SELECT a.id, a.name, a.platform, a.status,
                (SELECT text FROM events e WHERE e.agent_id = a.id AND e.kind = 'status' ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS doing
           FROM agents a WHERE a.platform != 'HUMAN' ORDER BY a.id`,
      )
      .all() as StatusReport['agents'];
    const tasks = db.prepare('SELECT id, title, status, assigned_agent_id AS owner FROM tasks ORDER BY id').all() as StatusReport['tasks'];
    const missions = hasTable(db, 'missions')
      ? new MissionService({ db, board: {} as never }).list().map((m) => ({ id: m.id, title: m.title, status: m.status, waitingOn: m.waitingOn }))
      : [];
    const leases = db
      .prepare("SELECT task_id AS taskId, agent_id AS agentId, resource_type AS type, resource_path AS path, expires_at AS expiresAt FROM leases WHERE status = 'ACTIVE' AND expires_at > CURRENT_TIMESTAMP ORDER BY task_id")
      .all() as StatusReport['leases'];
    const questions = db.prepare("SELECT from_agent_id AS \"from\", task_id AS taskId, text FROM questions WHERE resolved = 0 AND to_role = 'Human' ORDER BY created_at").all() as StatusReport['questions'];
    const pausedKeys = new Set(hasTable(db, 'dispatch_state') ? (db.prepare("SELECT key FROM dispatch_state WHERE key = 'paused' OR key LIKE 'paused:%'").all() as { key: string }[]).map((r) => r.key) : []);
    const dispatchPaused = pausedKeys.has('paused');
    for (const a of agents) if (pausedKeys.has(`paused:${a.id}`)) a.status = 'PAUSED';
    return {
      root,
      running,
      dispatchPaused,
      landing,
      agents,
      tasks,
      missions,
      leases,
      questions,
    };
  } finally {
    closeDatabase(db);
  }
}

export function formatStatus(s: StatusReport): string {
  const out: string[] = [];
  out.push(s.running ? `AgentMesh is running: http://127.0.0.1:${s.running.port}   (agentmesh login for a cockpit link)` : 'AgentMesh is not running.   (agentmesh start)');
  out.push(`Dispatching: ${s.dispatchPaused ? 'PAUSED' : 'on'}    Merging reviewed work: ${s.landing}`);
  out.push('', `Agents (${s.agents.length})`);
  for (const a of s.agents) out.push(`  ${a.id.padEnd(12)} ${a.platform.padEnd(12)} ${a.status.padEnd(7)} ${a.doing ?? ''}`.trimEnd());
  if (s.missions.length) {
    out.push('', `Missions (${s.missions.length})`);
    for (const m of s.missions) out.push(`  ${m.id.padEnd(5)} ${m.status.padEnd(13)} ${m.title}${m.waitingOn.length ? `   waiting on: ${m.waitingOn.join(', ')}` : ''}`);
  }
  const byStatus = new Map<string, number>();
  for (const t of s.tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  out.push('', `Tasks (${s.tasks.length}): ${[...byStatus].map(([k, v]) => `${v} ${k.toLowerCase().replaceAll('_', ' ')}`).join(', ') || 'none'}`);
  for (const t of s.tasks.filter((x) => x.status !== 'COMMITTED')) out.push(`  ${t.id.padEnd(8)} ${t.status.padEnd(16)} ${(t.owner ?? '-').padEnd(10)} ${t.title}`);
  out.push('', `File locks held (${s.leases.length})`);
  for (const l of s.leases) out.push(`  ${l.taskId.padEnd(8)} ${l.agentId.padEnd(10)} ${l.type.padEnd(4)} ${l.path}`);
  out.push('', `Questions waiting for you (${s.questions.length})`);
  for (const q of s.questions) out.push(`  ${q.from}${q.taskId ? ` on ${q.taskId}` : ''}: ${q.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  return out.join('\n');
}
