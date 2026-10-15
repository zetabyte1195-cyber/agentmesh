// Task 9 against a REAL container engine. Skipped unless AGENTMESH_DOCKER_TESTS=1 (they start containers).
// Any image that has bash works: set AGENTMESH_DOCKER_IMAGE (the default is just a stock image that has it).
// They prove what the fake wrapper cannot: real mounts, real stop-by-name, real sweep.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { startAgent } from '../runner/run.js';
import { parseSandbox } from './config.js';
import { probeSandbox } from './probe.js';
import { SandboxRuntime, realExec } from './runtime.js';
import { containerNameOf, expandWrapper, projectIdOf, wrapCommand } from './index.js';

const enabled = process.env.AGENTMESH_DOCKER_TESTS === '1';
const IMAGE = process.env.AGENTMESH_DOCKER_IMAGE ?? 'pgvector/pgvector:pg17';
const docker = (...args: string[]) => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `ERR ${(e as { stderr?: string }).stderr ?? (e as Error).message}`;
  }
};
const running = (name: string) => docker('ps', '-q', '--filter', `name=${name}`) !== '';

const WRAPPER = ['docker', 'run', '--rm', '--name', '{name}', '--label', 'agentmesh.project={projectId}', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--pids-limit', '256', '-v', '{cwd}:{containerCwd}:{cwdAccess}', '-v', '{runDir}:{containerRunDir}:ro', '-w', '{containerCwd}', '--entrypoint', 'env', '{env}', '{image}'];

describe.skipIf(!enabled)('container mode against a real engine', () => {
  const cfg = parseSandbox({ image: IMAGE, checks: 'container', wrapper: WRAPPER, commands: { CLAUDE_CODE: 'bash' } })!;
  let dir: string;
  let cwd: string;
  let runDir: string;
  const repoRoot = join(tmpdir(), 'agentmesh-docker-test-repo');
  const projectId = projectIdOf(repoRoot);

  beforeAll(() => {
    expect(docker('image', 'inspect', IMAGE, '--format', '{{.Id}}'), `the image ${IMAGE} must exist locally`).not.toMatch(/^ERR/);
    dir = mkdtempSync(join(tmpdir(), 'agentmesh-docker-'));
    cwd = join(dir, 'a workspace'); // a space on purpose
    runDir = join(dir, 'run');
    mkdirSync(cwd);
    mkdirSync(runDir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  it('mounts the workspace read-write and the run folder read-only, passes the token by name, and the engine removes the container afterwards', async () => {
    const name = containerNameOf(projectId, 'mounts01');
    const wrapper = expandWrapper(cfg, { name, cwd, runDir, runId: 'mounts01', projectId, cwdAccess: 'rw' }, ['AGENTMESH_TOKEN']);
    const script = 'echo "token=$AGENTMESH_TOKEN"; echo "wrote" > /work/created.txt && echo CWD_RW; (echo x > /agentmesh-run/nope 2>/dev/null && echo RUN_RW) || echo RUN_RO; echo "uid=$(id -u)"; echo "caps=$(grep CapEff /proc/self/status | cut -f2)"';
    expect(wrapper.join(' ')).not.toContain('amt_real-token');
    const r = await realExec([...wrapper, 'bash', '-c', script], 60_000, { AGENTMESH_TOKEN: 'amt_real-token' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('token=amt_real-token');
    expect(r.stdout).toContain('CWD_RW');
    expect(r.stdout).toContain('RUN_RO');
    expect(r.stdout).toMatch(/caps=0+\b/); // --cap-drop ALL took effect
    expect(readFileSync(join(cwd, 'created.txt'), 'utf8').trim()).toBe('wrote'); // the write is on this computer
    expect(existsSync(join(runDir, 'nope'))).toBe(false);
    expect(running(name)).toBe(false); // --rm
  }, 120_000);

  it('Stop removes the container BY NAME; stopping only the docker client would have left it running', async () => {
    const db = openDatabase(':memory:');
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
    const runtime = new SandboxRuntime({ cfg, repoRoot, identity: new IdentityService(db), handler: () => undefined });
    try {
      const runId = 'stop0001-aaaa';
      const { command, name } = wrapCommand({ platform: 'CLAUDE_CODE', executable: 'claude', args: ['-c', 'sleep 300'], parse: parseClaudeEvent }, { runId, projectId, cwd, runDir, cwdIsRepoRoot: false }, cfg);
      const hooks = runtime.hooks(name);
      const agent = startAgent({ command, cwd, env: { AGENTMESH_TOKEN: 'amt_x' }, terminate: hooks.terminate, cleanup: hooks.cleanup });
      for (let i = 0; i < 40 && !running(name); i++) await new Promise((r) => setTimeout(r, 500));
      expect(running(name), 'the container should be up').toBe(true);
      await agent.stop();
      const result = await agent.done;
      expect(result.stopped).toBe(true);
      expect(running(name), 'the container is gone after Stop').toBe(false);

      // the control: end only the docker client, as killing the process tree alone does, and the container survives
      const control = containerNameOf(projectId, 'control01');
      const w2 = wrapCommand({ platform: 'CLAUDE_CODE', executable: 'claude', args: ['-c', 'sleep 300'], parse: parseClaudeEvent }, { runId: 'control01', projectId, cwd, runDir, cwdIsRepoRoot: false }, cfg);
      const bare = startAgent({ command: w2.command, cwd, env: { AGENTMESH_TOKEN: 'amt_x' } }); // no terminate hook
      for (let i = 0; i < 40 && !running(control); i++) await new Promise((r) => setTimeout(r, 500));
      await bare.stop();
      await bare.done;
      const survived = running(control);
      docker('rm', '-f', control); // clean up whatever happened
      expect(survived, 'without the by-name removal the container outlives its process').toBe(true);
    } finally {
      closeDatabase(db);
    }
  }, 180_000);

  it('the project check runs INSIDE the container: it writes to the workspace, fails with its own exit code, and a timeout removes the container', async () => {
    const db = openDatabase(':memory:');
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
    const runtime = new SandboxRuntime({ cfg, repoRoot, identity: new IdentityService(db), handler: () => undefined });
    const run = runtime.checkRunner();
    try {
      const ok = await run('echo "ran in $(hostname)" > /work/check-ran && cat /work/check-ran && uname -s', { cwd, timeoutMs: 90_000, maxBuffer: 1024 * 1024 });
      expect(ok.stdout).toContain('Linux'); // not this computer's operating system: it really ran in the container
      expect(readFileSync(join(cwd, 'check-ran'), 'utf8')).toMatch(/^ran in /); // and wrote to the mounted workspace
      await expect(run('echo oops >&2; exit 3', { cwd, timeoutMs: 90_000, maxBuffer: 1024 * 1024 })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('oops') });
      await expect(run('sleep 60', { cwd, timeoutMs: 4000, maxBuffer: 1024 * 1024 })).rejects.toMatchObject({ killed: true });
      expect(docker('ps', '-q', '--filter', `label=agentmesh.project=${projectId}`), 'no container is left after the timeout').toBe('');
    } finally {
      closeDatabase(db);
    }
  }, 240_000);

  it('after a crash, the next start finds containers by the project label and removes them', async () => {
    const db = openDatabase(':memory:');
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
    const runtime = new SandboxRuntime({ cfg, repoRoot, identity: new IdentityService(db), handler: () => undefined });
    const leftover = containerNameOf(projectId, 'leftover');
    const other = containerNameOf('ffffffffffff', 'someone-else'); // another project's container must NOT be touched
    try {
      docker('run', '-d', '--name', leftover, '--label', `agentmesh.project=${projectId}`, '--entrypoint', 'sleep', IMAGE, '300');
      docker('run', '-d', '--name', other, '--label', 'agentmesh.project=ffffffffffff', '--entrypoint', 'sleep', IMAGE, '300');
      expect(running(leftover)).toBe(true);
      expect(await runtime.sweep()).toBe(1);
      expect(running(leftover)).toBe(false);
      expect(running(other)).toBe(true);
    } finally {
      docker('rm', '-f', leftover, other);
      closeDatabase(db);
    }
  }, 120_000);

  it('the doctor probes run for real: engine, image, mounts, and the connection from inside a container (which a firewall may block)', async () => {
    const results = await probeSandbox({ cfg, repoRoot, commands: ['bash'] });
    const byTitle = (re: RegExp) => results.find((r) => re.test(r.title));
    expect(byTitle(/Container engine/)?.level).toBe('ok');
    expect(byTitle(/Image .* is present/)?.level).toBe('ok');
    expect(byTitle(/task workspace is writable/)?.level).toBe('ok');
    expect(byTitle(/run folder .* read-only/)?.level).toBe('ok');
    expect(byTitle(/bash is installed in the image/)?.level).toBe('ok');
    // Whether a container can reach this computer depends on the machine's firewall. Either answer is acceptable;
    // what must hold is that the probe gives a definite one, and explains a failure.
    const net = results.find((r) => /container can reach AgentMesh|cannot reach AgentMesh|nothing is listening|does not resolve/.test(r.title));
    expect(net, JSON.stringify(results.map((r) => r.title))).toBeDefined();
    console.log('connection probe on this machine:', net!.level, '-', net!.title, net!.level === 'fail' ? `| ${net!.detail.slice(0, 200)}` : '');
    if (net!.level === 'fail') expect(net!.detail.length).toBeGreaterThan(40);
    expect(results.some((r) => /does not restrict the container's network/.test(r.detail))).toBe(true);
  }, 240_000);

  it('names the real causes when a container cannot reach AgentMesh: a silent drop, a name that does not exist, nothing listening', async () => {
    const connection = async (hostAlias: string) => {
      const r = await probeSandbox({ cfg: parseSandbox({ image: IMAGE, checks: 'container', wrapper: WRAPPER, hostAlias })!, repoRoot, commands: [] });
      return r.find((x) => /reach AgentMesh|nothing is listening|Nothing is listening|does not resolve|did not run|unexpected/i.test(x.title))!;
    };
    const dropped = await connection('192.0.2.1'); // a documentation-only address nothing answers at
    expect(dropped).toMatchObject({ level: 'fail', title: expect.stringMatching(/timed out/) });
    expect(dropped.detail).toMatch(/Firewall|firewall/);
    expect(await connection('no-such-host.invalid')).toMatchObject({ level: 'fail', title: expect.stringMatching(/does not resolve/) });
    expect(await connection('127.0.0.1')).toMatchObject({ level: 'fail', title: expect.stringMatching(/Nothing is listening/) }); // the container's own loopback
  }, 240_000);
});
