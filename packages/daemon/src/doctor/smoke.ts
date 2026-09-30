// The real test that a platform works with AgentMesh: start a throwaway daemon in a throwaway
// repository, run the agent headlessly against it, and check the agent actually reached AgentMesh's
// tools (MCP + its permission rules) and did something visible through them. This is exactly what
// fails for a new user, so it is what `agentmesh doctor --test` and the cockpit's Test button run.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunContext } from '../dispatch/dispatcher.js';
import { git } from '../git/run-git.js';
import { type CustomPlatformConfig, type PlatformAdapter } from '../platforms/index.js';
import { startAgent } from '../runner/run.js';
import { initProject } from '../init/init.js';
import { startDaemon } from '../start/start.js';

export interface SmokeResult {
  ok: boolean;
  seconds: number;
  /** One or two lines a person can act on. */
  detail: string;
  /** The agent's final words, when it had any. */
  said?: string;
}

const MARKER = 'doctor: connection ok';

/** Windows keeps folders locked while a process still has them open; a leftover temp folder must never fail a check. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    // left for the OS to clean up
  }
}

export async function smokeTestPlatform(adapter: PlatformAdapter, options: { customPlatforms?: CustomPlatformConfig[]; timeoutMs?: number } = {}): Promise<SmokeResult> {
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 100) / 10;
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-doctor-'));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
  let runDir: string | null = null;
  try {
    await git(dir, ['init', '-q', '-b', 'main']);
    await git(dir, ['config', 'user.email', 'doctor@agentmesh.local']);
    await git(dir, ['config', 'user.name', 'AgentMesh doctor']);
    writeFileSync(join(dir, 'README.md'), '# connection test\n');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', 'test']);
    const agentId = `${adapter.friendlyName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'agent'}-test`;
    await initProject({ repoRoot: dir, agents: [{ id: agentId, platform: adapter.id, rulebook: adapter.rulebook }], ...(options.customPlatforms ? { customPlatforms: options.customPlatforms } : {}) });
    daemon = await startDaemon({ repoRoot: dir, port: 0, autoDispatch: false, log: () => {}, agentsOverride: [] });
    const mcpUrl = `http://127.0.0.1:${daemon.port}/mcp`;
    const token = daemon.identity.issueToken(agentId, 'doctor');
    const run = writeRunContext(token, mcpUrl);
    runDir = run.dir;
    const prompt = `You are ${agentId} in an AgentMesh connection test. Call the mesh_get_board tool, then call the mesh_set_status tool with doing set to "${MARKER}". Then reply with the single word DONE. Do not use any other tool.`;
    const running = startAgent({ command: adapter.command({ prompt, cwd: dir, run }), cwd: dir, env: { AGENTMESH_TOKEN: token }, timeoutMs: options.timeoutMs ?? 240_000 });
    const result = await running.done;
    const said = result.result?.text?.trim().slice(0, 300);
    const status = daemon.db.prepare("SELECT text FROM events WHERE agent_id = ? AND kind = 'status' ORDER BY rowid DESC LIMIT 1").get(agentId) as { text: string } | undefined;
    if (result.ok && status?.text === MARKER) return { ok: true, seconds: elapsed(), detail: `${adapter.label} reached AgentMesh and used its tools.`, ...(said ? { said } : {}) };
    const why = !result.ok
      ? `The run failed: ${result.failure ?? 'unknown'}${result.stderrTail.length ? ` (${result.stderrTail.slice(-2).join(' | ').slice(0, 300)})` : ''}`
      : 'The run finished but the agent never used AgentMesh\'s tools. Usually its MCP setup or permission rules block them.';
    return { ok: false, seconds: elapsed(), detail: why, ...(said ? { said } : {}) };
  } catch (err) {
    return { ok: false, seconds: elapsed(), detail: `Could not run the test: ${(err as Error).message}` };
  } finally {
    await daemon?.stop().catch(() => undefined);
    if (runDir) removeQuietly(runDir);
    removeQuietly(dir);
  }
}
