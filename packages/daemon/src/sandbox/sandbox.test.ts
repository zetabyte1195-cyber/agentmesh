// Task 9: container mode, without a real container engine. A fake "wrapper" (a node script) stands in for
// docker: it records exactly what it was asked to do, then runs the agent's command. The real-engine checks
// are in docker.test.ts (they run only when AGENTMESH_DOCKER_TESTS=1).
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, type DispatchableAgent, Dispatcher, writeRunContext } from '../dispatch/dispatcher.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { parseClaudeEvent } from '../runner/events.js';
import { AgentListener } from './agent-listener.js';
import { SandboxConfigError, expandWrapper, lintWrapper, parseSandbox, stopCommand } from './config.js';
import { explainSandboxFailure } from './diagnose.js';
import { classifyConnection, unreachableHelp } from './probe.js';
import { type Exec, SandboxRuntime } from './runtime.js';
import { containerNameOf, containerView, projectIdOf, wrapCommand } from './wrap.js';

const DOCKER_WRAPPER = ['docker', 'run', '--rm', '--name', '{name}', '--label', 'agentmesh.project={projectId}', '--init', '--cap-drop', 'ALL', '--memory', '2g', '-v', '{cwd}:{containerCwd}:{cwdAccess}', '-v', '{runDir}:{containerRunDir}:ro', '-w', '{containerCwd}', '{env}', '{image}'];
const base = (extra: object = {}) => ({ image: 'my-agents:latest', checks: 'host', wrapper: DOCKER_WRAPPER, ...extra });

describe('the sandbox section', () => {
  it('is absent or switched off: no container mode', () => {
    expect(parseSandbox(undefined)).toBeNull();
    expect(parseSandbox(null)).toBeNull();
    expect(parseSandbox(base({ enabled: false }))).toBeNull();
  });

  it('accepts the documented example, with defaults filled in', () => {
    const cfg = parseSandbox(base({ commands: { CLAUDE_CODE: 'claude' } }))!;
    expect(cfg).toMatchObject({ image: 'my-agents:latest', containerCwd: '/work', containerRunDir: '/agentmesh-run', hostAlias: 'host.docker.internal', listen: { host: '127.0.0.1', port: 0 } });
  });

  it('refuses what would make containers unmanageable or the token unreachable, saying why', () => {
    const bad = (extra: object, message: RegExp) => expect(() => parseSandbox(base(extra)), message.source).toThrow(message);
    bad({ wrapper: ['docker', 'run', '--rm', '{env}', '{image}'] }, /name \{name\}/);
    bad({ wrapper: ['docker', 'run', '--name', '{name}', '{image}'] }, /must contain \{env\}/);
    bad({ wrapper: ['docker', 'run', '-it', '--name', '{name}', '{env}', '{image}'] }, /must not contain -it/);
    bad({ wrapper: ['docker', 'run', '--tty', '--name', '{name}', '{env}', '{image}'] }, /must not contain --tty/);
    bad({ wrapper: ['docker', 'run', '--name', '{nmae}', '{env}', '{image}'] }, /\{nmae\}, which is not a placeholder/);
    bad({ wrapper: ['docker', 'run', '--name', '{name}', 'x{env}', '{image}'] }, /\{env\} must be an item of its own/);
    bad({ wrapper: ['firejail', '--name={name}', '{env}', '{image}'] }, /give "stop"/);
    bad({ containerCwd: 'work' }, /absolute path inside the container/);
    bad({ image: '' }, /image/);
    bad({ surprise: true }, /Unrecognized key/);
    expect(() => parseSandbox(base({ wrapper: ['firejail', '--name={name}', '{env}', '{image}'], stop: ['firejail-stop', '{name}'] }))).not.toThrow();
    expect(() => parseSandbox({})).toThrow(SandboxConfigError);
  });

  it('makes you CHOOSE where the project check runs: there is no default, because both choices cost something', () => {
    const without: Record<string, unknown> = { ...base() };
    delete without.checks;
    expect(() => parseSandbox(without)).toThrow(/choose where the project check runs.*"container".*"host"/s);
    expect(() => parseSandbox(base({ checks: 'somewhere' }))).toThrow(/choose where the project check runs/);
    expect(parseSandbox(base({ checks: 'container' }))!.checks).toBe('container');
    expect(parseSandbox(base({ checks: 'host' }))!.checks).toBe('host');
  });

  it('warns about flags that undo the point of a container (without refusing: it is your configuration)', () => {
    const warnings = (wrapper: string[], checks = 'container') => lintWrapper(parseSandbox(base({ wrapper, checks }))!);
    expect(warnings(DOCKER_WRAPPER)).toEqual([]);
    expect(warnings(DOCKER_WRAPPER, 'host').join(' ')).toMatch(/project check runs on THIS computer.*undoes the container/);
    const loose = warnings(['docker', 'run', '--privileged', '--network', 'host', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', '/:/host', '--name', '{name}', '{env}', '{image}']).join('\n');
    for (const part of ['--privileged', 'socket', 'host\'s namespaces or network', 'whole drive', '--memory', '--cap-drop']) expect(loose, part).toContain(part);
  });
});

describe('building the container command', () => {
  const cfg = parseSandbox(base())!;
  const vars = { name: 'am-abc123-deadbeef', cwd: join(tmpdir(), 'a folder', 'wt'), runDir: tmpdir(), runId: 'r1', projectId: 'p1', cwdAccess: 'rw' as const };

  it('fills every placeholder, keeps a path with spaces as one argument, and passes variables by NAME only', () => {
    const w = expandWrapper(cfg, vars, ['AGENTMESH_TOKEN', 'AGENTMESH_MCP_URL']);
    expect(w).toEqual(expect.arrayContaining(['--name', 'am-abc123-deadbeef', '--label', 'agentmesh.project=p1', '-e', 'AGENTMESH_TOKEN', '-e', 'AGENTMESH_MCP_URL', 'my-agents:latest']));
    expect(w.filter((x) => x.includes('a folder'))).toHaveLength(1); // one -v value, not split on the space
    expect(w.find((x) => x.endsWith(':/work:rw'))).toBeDefined();
    expect(w.find((x) => x.endsWith(':/agentmesh-run:ro'))).toBeDefined();
    expect(w).not.toContain('{env}');
    expect(expandWrapper(cfg, { ...vars, cwdAccess: 'ro' }, []).some((x) => x.endsWith(':/work:ro'))).toBe(true);
  });

  it('{uid} is refused where the operating system has no user id', () => {
    const withUid = parseSandbox(base({ wrapper: [...DOCKER_WRAPPER.slice(0, -1), '--user', '{uid}:{gid}', '{image}'] }))!;
    if (process.platform === 'win32') expect(() => expandWrapper(withUid, vars, [])).toThrow(/not available on this operating system/);
    else expect(expandWrapper(withUid, vars, []).join(' ')).toMatch(/--user \d+:\d+/);
  });

  it('removes a container by name with docker\'s own command, or the one you gave', () => {
    expect(stopCommand(cfg, 'x')).toEqual(['docker', 'rm', '-f', 'x']);
    expect(stopCommand(parseSandbox(base({ wrapper: ['firejail', '--name={name}', '{env}', '{image}'], stop: ['fj-stop', '--name', '{name}'] }))!, 'x')).toEqual(['fj-stop', '--name', 'x']);
  });

  it('maps the run folder as the container sees it, whatever the host path looks like', () => {
    const run = writeRunContext('amt_tok', 'http://127.0.0.1:1/mcp');
    const view = containerView(cfg, run);
    expect(view.cwd).toBe('/work');
    expect(view.run.dir).toBe('/agentmesh-run');
    expect(view.run.claudeMcpConfig).toBe('/agentmesh-run/claude-mcp.json');
    expect(view.run.toolConfigs).toEqual({ opencode: '/agentmesh-run/opencode-mcp.json', gemini: '/agentmesh-run/gemini-settings.json' });
    expect(view.run.inContainer).toBe(true);
    expect(view.run.token).toBe('amt_tok');
    rmSync(run.dir, { recursive: true, force: true });
  });

  it('puts the wrapper before the agent\'s command, swaps in the in-image program, and never puts the token in the command line', () => {
    const fakeWrapper = parseSandbox(base({ wrapper: [process.execPath, 'wrapper.js', '--name', '{name}', '{env}', '{image}'], stop: ['x', '{name}'], commands: { CLAUDE_CODE: 'claude-in-image' } }))!;
    const { command, name } = wrapCommand({ platform: 'CLAUDE_CODE', executable: 'C:\\host\\path\\claude.exe', args: ['-p', 'Do it', '--mcp-config', '/agentmesh-run/claude-mcp.json'], parse: parseClaudeEvent, env: { AGENTMESH_MCP_URL: 'http://host.docker.internal:9/mcp' } }, { runId: 'aaaaaaaa-1111', projectId: projectIdOf('/repo'), cwd: tmpdir(), runDir: tmpdir(), cwdIsRepoRoot: false }, fakeWrapper);
    expect(name).toMatch(/^am-[0-9a-f]{6}-aaaaaaaa$/);
    expect(command.executable).toBe(process.execPath);
    expect(command.args.slice(0, 3)).toEqual(['wrapper.js', '--name', name]);
    expect(command.args.slice(command.args.indexOf('my-agents:latest'))).toEqual(['my-agents:latest', 'claude-in-image', '-p', 'Do it', '--mcp-config', '/agentmesh-run/claude-mcp.json']);
    expect(command.args).toEqual(expect.arrayContaining(['-e', 'AGENTMESH_TOKEN', '-e', 'AGENTMESH_MCP_URL']));
    expect(command.args.join(' ')).not.toContain('amt_');
    expect(containerNameOf('abcdef123456', 'r-1-2')).toBe('am-abcdef-r12');
  });

  it('says plainly when the container command itself is missing', () => {
    expect(() => wrapCommand({ platform: 'X', executable: 'x', args: [], parse: () => [] }, { runId: 'r', projectId: 'p', cwd: tmpdir(), runDir: tmpdir(), cwdIsRepoRoot: false }, parseSandbox(base({ wrapper: ['no-such-container-tool-xyz', '--name', '{name}', '{env}', '{image}'], stop: ['x', '{name}'] }))!)).toThrow(/was not found/);
  });
});

describe('the agent-only listener', () => {
  let db: SqliteDatabase;
  let ids: IdentityService;
  let listener: AgentListener;
  let port: number;
  let seen: string[];
  let agentToken: string;
  let humanToken: string;
  const call = (opts: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: { Host: opts.host ?? `host.docker.internal:${port}`, 'Content-Length': String(Buffer.byteLength(opts.body ?? '{}')), ...(opts.headers ?? {}) } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end(opts.body ?? '{}');
    });

  beforeEach(async () => {
    db = openDatabase(':memory:');
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
    ids = new IdentityService(db);
    agentToken = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).token;
    humanToken = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).token;
    seen = [];
    listener = new AgentListener({ identity: ids, host: '127.0.0.1', port: 0, hostAlias: 'host.docker.internal', handler: (_req, res, principal, body) => { seen.push(`${principal.agentId}:${body}`); res.writeHead(200); res.end('mcp-ok'); } });
    port = (await listener.listen()).port;
  });
  afterEach(async () => {
    await listener.close();
    closeDatabase(db);
  });

  it('lets an agent\'s own token reach MCP, by the name containers use or by loopback', async () => {
    expect(await call({ headers: { Authorization: `Bearer ${agentToken}` }, body: '{"a":1}' })).toEqual({ status: 200, body: 'mcp-ok' });
    expect((await call({ host: `127.0.0.1:${port}`, headers: { Authorization: `Bearer ${agentToken}` } })).status).toBe(200);
    expect(seen).toEqual(['claude-1:{"a":1}', 'claude-1:{}']);
  });

  it('serves NOTHING else: no cockpit, no login, no Human routes, no other methods', async () => {
    const auth = { Authorization: `Bearer ${agentToken}` };
    for (const [method, path] of [['GET', '/'], ['GET', '/login'], ['GET', '/login?code=x'], ['GET', '/api/state'], ['POST', '/api/stop'], ['POST', '/api/schedules'], ['GET', '/mcp'], ['PUT', '/mcp'], ['DELETE', '/mcp'], ['POST', '/mcp/extra'], ['GET', '/index.html']] as const) {
      expect((await call({ method, path, headers: auth })).status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a Human token, a cookie, no credentials, a bad token and a foreign Host', async () => {
    expect((await call({ headers: { Authorization: `Bearer ${humanToken}` } })).status).toBe(403);
    expect((await call({ headers: { Cookie: `agentmesh_session=${humanToken}` } })).status).toBe(401);
    expect((await call({})).status).toBe(401);
    expect((await call({ headers: { Authorization: 'Bearer amt_nope' } })).status).toBe(401);
    expect((await call({ host: 'evil.example:80', headers: { Authorization: `Bearer ${agentToken}` } })).status).toBe(403);
    expect((await call({ host: `host.docker.internal:${port + 1}`, headers: { Authorization: `Bearer ${agentToken}` } })).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('caps the body, and does not accept WebSocket upgrades', async () => {
    expect((await call({ headers: { Authorization: `Bearer ${agentToken}` }, body: 'x'.repeat(70 * 1024) })).status).toBe(413);
    const upgraded = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/ws/cockpit', headers: { Host: `127.0.0.1:${port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('error', () => resolve('closed'));
      req.on('response', (r) => resolve(`status ${r.statusCode}`));
      req.on('close', () => resolve('closed'));
      req.end();
    });
    expect(upgraded).not.toBe('upgraded');
  });
});

describe('explaining a failed container run', () => {
  const fail = (over: Partial<Parameters<typeof explainSandboxFailure>[0]>) => explainSandboxFailure({ ok: false, exitCode: 1, stderrTail: [], failure: 'exited with code 1', ...over }, 'am-x-1');

  it('names the cause, and the registry\'s own pull limit is NOT the agent\'s quota', () => {
    expect(fail({ stderrTail: ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock'] })?.text).toMatch(/engine is not running/);
    const limit = fail({ stderrTail: ['toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating'] });
    expect(limit?.text).toMatch(/pull limit \(not your agent's quota\)/);
    expect(limit?.backoffMs).toBeGreaterThan(0);
    expect(fail({ stderrTail: ['Unable to find image \'my-agents:latest\' locally', 'pull access denied for my-agents'] })?.text).toMatch(/image does not exist/);
    expect(fail({ stderrTail: ['docker: Error response from daemon: Mounts denied: The path /host_mnt/d is not shared from the host'] })?.text).toMatch(/File sharing/);
    expect(fail({ stderrTail: ['Conflict. The container name "/am-x-1" is already in use'] })?.text).toMatch(/already exists/);
    expect(fail({ exitCode: 127, stderrTail: ['exec: "claude": executable file not found in $PATH'] })?.text).toMatch(/not installed inside the image/);
    expect(fail({ exitCode: 137, stderrTail: [] })?.text).toMatch(/exit 137.*memory/);
  });

  it('says nothing about a run that succeeded, or an ordinary agent failure', () => {
    expect(explainSandboxFailure({ ok: true, exitCode: 0, stderrTail: [], failure: null }, 'x')).toBeNull();
    expect(fail({ stderrTail: ['the agent said something went wrong'] })).toBeNull();
  });
});

describe('a run through a fake wrapper (the dispatcher end to end)', () => {
  let dir: string;
  let db: SqliteDatabase;
  let ids: IdentityService;
  let log: string;
  let stopFile: string;
  let clock: Date;

  // The fake "docker": records what it was told, then runs the agent's command (everything after the image name).
  const wrapperScript = () => {
    const file = join(dir, 'fake-docker.mjs');
    writeFileSync(
      file,
      `import { appendFileSync } from 'node:fs';
import { exec, spawn } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.AGENTMESH_TOKEN ?? null, mcp: process.env.AGENTMESH_MCP_URL ?? null }) + '\\n');
const behaviour = process.env.FAKE_BEHAVIOUR ?? '';
if (behaviour.startsWith('stderr:')) { console.error(behaviour.slice(7)); process.exit(125); }
const i = args.indexOf('my-agents:latest');
const [exe, ...rest] = args.slice(i + 1);
// a check is run as "sh -c <command>": there is no sh on Windows, so the fake runs the command in the platform shell
if (exe === 'sh' && rest[0] === '-c') { exec(rest[1], (err, so, se) => { process.stdout.write(so); process.stderr.write(se); process.exit(err ? (typeof err.code === 'number' ? err.code : 1) : 0); }); }
else spawn(exe, rest, { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 1));
`,
    );
    return file;
  };
  const stopScript = () => {
    const file = join(dir, 'fake-stop.mjs');
    writeFileSync(file, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ stop: process.argv[2] }) + '\\n');\n`);
    return file;
  };
  const lines = () => (readFileSync(log, 'utf8') ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);

  let prompts: { prompt: string; cwd: string; runDir: string; claudeMcpConfig: string; inContainer: boolean | undefined; mcpUrl: string }[];
  const agent = (script: string): DispatchableAgent => ({
    agentId: 'claude-1',
    platform: 'CLAUDE_CODE',
    rulebook: 'CLAUDE.md',
    command: (prompt, cwd, run) => {
      prompts.push({ prompt, cwd, runDir: run.dir, claudeMcpConfig: run.claudeMcpConfig, inContainer: run.inContainer, mcpUrl: run.mcpUrl });
      return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [script], parse: parseClaudeEvent, env: { AGENTMESH_MCP_URL: run.mcpUrl } };
    },
  });

  let runtime: SandboxRuntime;
  let execCalls: string[][];
  let engineUp: boolean;
  const exec: Exec = async (command) => {
    execCalls.push(command);
    if (command[1] === 'info') return engineUp ? { code: 0, stdout: '29.0', stderr: '' } : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    if (command[1] === 'ps') return { code: 0, stdout: 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentmesh-sbx-'));
    log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    stopFile = stopScript();
    db = openDatabase(join(dir, 'mesh.db'));
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION]);
    ids = new IdentityService(db);
    ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
    ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });
    mkdirSync(join(dir, 'wt'));
    db.prepare("INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, worktree_path) VALUES ('T1', 'p', 'T1', 'ac', 'IN_PROGRESS', 'claude-1', ?)").run(join(dir, 'wt'));
    clock = new Date('2026-10-15T10:00:00Z');
    prompts = [];
    execCalls = [];
    engineUp = true;
    // This runtime's wrapper is a node script (the fake docker), so the run really goes through it; stop commands are recorded by the fake exec.
    runtime = new SandboxRuntime({
      cfg: parseSandbox({ image: 'my-agents:latest', checks: 'host', wrapper: [process.execPath, wrapperScript(), '--name', '{name}', '--label', 'agentmesh.project={projectId}', '{env}', '{image}'], stop: [process.execPath, stopFile, '{name}'], commands: { CLAUDE_CODE: process.execPath } })!,
      repoRoot: dir,
      identity: ids,
      handler: () => undefined,
      exec,
    });
    await runtime.start();
  });
  afterEach(async () => {
    await runtime.close();
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const okScript = () => {
    const f = join(dir, 'ok.mjs');
    writeFileSync(f, `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));`);
    return f;
  };
  const settle = async (d: Dispatcher) => {
    for (let i = 0; i < 300 && d.isBusy('claude-1'); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 50)); // let the cleanup hook finish
  };
  const dispatcher = (script: string) => new Dispatcher({ db, identity: ids, agents: [agent(script)], repoRoot: dir, now: () => clock, sandbox: runtime, runTimeoutMs: 30_000 });

  it('runs the agent through the wrapper, with the container\'s view of the paths, the container-reachable address, and the token by name only', async () => {
    const d = dispatcher(okScript());
    expect(d.tick()).toHaveLength(1);
    await settle(d);
    expect(db.prepare('SELECT status FROM dispatch_runs').get()).toEqual({ status: 'SUCCEEDED' });

    expect(prompts[0]).toMatchObject({ cwd: '/work', runDir: '/agentmesh-run', claudeMcpConfig: '/agentmesh-run/claude-mcp.json', inContainer: true });
    expect(prompts[0]!.mcpUrl).toBe(runtime.mcpUrl());
    expect(prompts[0]!.mcpUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
    const first = lines()[0] as { args: string[]; token: string | null; mcp: string | null };
    expect(first.token).toMatch(/^amt_/); // the token reached the container's environment...
    expect(first.args.join(' ')).not.toContain(first.token!); // ...and never appeared in a command line
    expect(first.args).toEqual(expect.arrayContaining(['-e', 'AGENTMESH_TOKEN', '-e', 'AGENTMESH_MCP_URL', 'my-agents:latest']));
    expect(first.mcp).toBe(runtime.mcpUrl());
  });

  it('removes the container when the run ends (once more, harmlessly), and the Human\'s Stop removes it FIRST', async () => {
    const d = dispatcher(okScript());
    d.tick();
    await settle(d);
    const stops = () => execCalls.filter((c) => c[1] === stopFile).map((c) => c[2]!);
    expect(stops()).toHaveLength(1); // cleanup
    const name = (lines()[0] as { args: string[] }).args[(lines()[0] as { args: string[] }).args.indexOf('--name') + 1]!;
    expect(stops()[0]).toBe(name);

    // a run that hangs: stopRun must remove the container before killing the process
    const hang = join(dir, 'hang.mjs');
    writeFileSync(hang, 'setInterval(() => {}, 1000);');
    db.prepare('DELETE FROM dispatch_runs').run();
    clock = new Date(clock.getTime() + 11 * 60_000);
    const d2 = dispatcher(hang);
    d2.tick();
    await new Promise((r) => setTimeout(r, 400));
    const before = stops().length;
    expect(await d2.stopRun('claude-1')).toBe(true);
    await settle(d2);
    expect(stops().length).toBeGreaterThan(before); // terminate ran (and cleanup after it)
    expect(db.prepare('SELECT status FROM dispatch_runs').get()).toEqual({ status: 'STOPPED' });
  });

  const dockerRuntime = () => new SandboxRuntime({ cfg: parseSandbox({ image: 'my-agents:latest', checks: 'host', wrapper: DOCKER_WRAPPER })!, repoRoot: dir, identity: ids, handler: () => undefined, exec });

  it('while the container engine is down, the agent WAITS: no run, no attempt used, nothing runs outside a container', async () => {
    engineUp = false;
    const down = dockerRuntime();
    await down.start();
    expect(down.blockedReason()).toMatch(/engine is not running.*nothing runs outside a container/);
    const d = new Dispatcher({ db, identity: ids, agents: [agent(okScript())], repoRoot: dir, now: () => clock, sandbox: down });
    expect(d.tick()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM dispatch_runs').get()).toEqual({ n: 0 });
    expect(lines()).toEqual([]);
    engineUp = true;
    await down.refresh();
    expect(down.blockedReason()).toBeNull(); // it carries on by itself once the engine is back
    await down.close();
  });

  it('a registry pull limit is recorded as a CONTAINER problem with a back-off, never as the agent\'s quota', async () => {
    process.env.FAKE_BEHAVIOUR = 'stderr:toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating';
    try {
      const d = dispatcher(okScript());
      d.tick();
      await settle(d);
    } finally {
      delete process.env.FAKE_BEHAVIOUR;
    }
    const run = db.prepare('SELECT status, detail FROM dispatch_runs').get() as { status: string; detail: string };
    expect(run.status).toBe('FAILED'); // not QUOTA
    expect(run.detail).toMatch(/^\[container\] The registry refused to send the image because of its own pull limit/);
    const backoff = db.prepare('SELECT platform, reason FROM platform_backoff').get() as { platform: string; reason: string };
    expect(backoff.platform).toBe('CLAUDE_CODE');
    expect(backoff.reason).toMatch(/^container: /);
    expect(backoff.reason.startsWith('container: ')).toBe(true);
    expect(backoff.reason.startsWith('quota')).toBe(false);
  });

  it('an agent the section does not list runs as before, outside any container', async () => {
    const scoped = new SandboxRuntime({ cfg: parseSandbox({ image: 'my-agents:latest', checks: 'host', wrapper: [process.execPath, wrapperScript(), '--name', '{name}', '{env}', '{image}'], stop: ['x', '{name}'], agents: ['gemini-1'] })!, repoRoot: dir, identity: ids, handler: () => undefined, exec });
    await scoped.start();
    const d = new Dispatcher({ db, identity: ids, agents: [agent(okScript())], repoRoot: dir, now: () => clock, sandbox: scoped });
    d.tick();
    await settle(d);
    expect(prompts[0]).toMatchObject({ cwd: join(dir, 'wt'), inContainer: undefined });
    expect(lines()).toEqual([]); // the wrapper was never involved
    await scoped.close();
  });

  it('with "checks": "container" the project check runs THROUGH THE WRAPPER (not on this computer), carries no token, and fails like an ordinary check', async () => {
    const rt = new SandboxRuntime({
      cfg: parseSandbox({ image: 'my-agents:latest', checks: 'container', wrapper: [process.execPath, wrapperScript(), '--name', '{name}', '--label', 'agentmesh.project={projectId}', '{env}', '{image}'], stop: [process.execPath, stopFile, '{name}'] })!,
      repoRoot: dir,
      identity: ids,
      handler: () => undefined,
      exec,
    });
    const run = rt.checkRunner();
    const opts = { cwd: join(dir, 'wt'), timeoutMs: 20_000, maxBuffer: 1024 * 1024 };

    const ok = await run('echo from-the-check', opts);
    expect(ok.stdout).toContain('from-the-check');
    const call = lines().find((l) => 'args' in l) as { args: string[]; token: string | null };
    expect(call.args).toEqual(expect.arrayContaining(['--name', 'my-agents:latest']));
    expect(call.token).toBeNull(); // a check never needs the agent's token
    expect(call.args.join(' ')).not.toContain('-e AGENTMESH_TOKEN');
    expect(execCalls.some((c) => c[1] === stopFile)).toBe(true); // the container is removed afterwards

    await expect(run('node -e "process.stderr.write(\'2 failed\'); process.exit(3)"', opts)).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('2 failed') });

    // a timeout removes the container by name as well as ending the client
    execCalls.length = 0;
    await expect(run('node -e "setTimeout(() => {}, 4000)"', { ...opts, timeoutMs: 400 })).rejects.toMatchObject({ killed: true });
    expect(execCalls.some((c) => c[1] === stopFile)).toBe(true);
  }, 30_000);

  it('a missing container command makes the check FAIL; it never falls back to running on this computer', async () => {
    const rt = new SandboxRuntime({ cfg: parseSandbox({ image: 'x', checks: 'container', wrapper: ['no-such-container-tool-xyz', '--name', '{name}', '{env}', '{image}'], stop: ['x', '{name}'] })!, repoRoot: dir, identity: ids, handler: () => undefined, exec });
    await expect(rt.checkRunner()('echo should-not-run', { cwd: join(dir, 'wt'), timeoutMs: 5000, maxBuffer: 1024 })).rejects.toMatchObject({ code: 127 });
  });

  it('at start, containers an earlier crash left behind are found by the project label and removed', async () => {
    const rt = dockerRuntime();
    expect(await rt.sweep()).toBe(2);
    const calls = execCalls.filter((c) => c[1] === 'ps' || c[1] === 'rm');
    expect(calls[0]!.slice(1)).toEqual(['ps', '-aq', '--filter', `label=agentmesh.project=${rt.projectId}`]);
    expect(calls[1]!.slice(1)).toEqual(['rm', '-f', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(await runtime.sweep()).toBe(0); // a wrapper that is not docker or podman has no way to list: nothing is guessed
  });

});

describe('reading the connection probe (outputs recorded from a real container engine)', () => {
  const cfg = parseSandbox(base())!;
  const ctx = (code: number | null = 0) => ({ run: { code }, url: 'http://host.docker.internal:4117/mcp', bound: '127.0.0.1', cfg, secretTail: 'abc123' });

  it('an answer is a success', () => {
    expect(classifyConnection('HTTP/1.0 200 OK\r\n\r\nprobe-ok-abc123\nCWD_WRITABLE', ctx())).toMatchObject({ level: 'ok', title: 'A container can reach AgentMesh' });
  });

  it('tells the causes apart, in an order that cannot mislabel them', () => {
    expect(classifyConnection('bash: no-such-host.invalid: Name or service not known\nbash: /dev/tcp/no-such-host.invalid/4117: Invalid argument\nHTTP_EXIT=1', ctx())).toMatchObject({ level: 'fail', title: expect.stringMatching(/does not resolve/) });
    expect(classifyConnection('bash: connect: Connection refused\nbash: /dev/tcp/127.0.0.1/4026: Connection refused\nHTTP_EXIT=1', ctx())).toMatchObject({ level: 'fail', title: 'Nothing is listening at that address' });
    expect(classifyConnection('HTTP_EXIT=124\nCWD_WRITABLE', ctx())).toMatchObject({ level: 'fail', title: expect.stringMatching(/timed out/) });
    expect(classifyConnection('curl: (28) Connection timed out after 8001 milliseconds\nHTTP_EXIT=28', ctx())).toMatchObject({ title: expect.stringMatching(/timed out/) });
    // a refusal that also mentions a name must not be called a timeout, and a name failure must not be called a timeout either
    expect(classifyConnection('curl: (6) Could not resolve host: x\nHTTP_EXIT=6', ctx()).title).toMatch(/does not resolve/);
  });

  it('says so when it could not test, or the container did not even start', () => {
    expect(classifyConnection('NO_HTTP_TOOL\nCWD_WRITABLE', ctx())).toMatchObject({ level: 'warn' });
    expect(classifyConnection('docker: Error response from daemon: pull access denied for nope', ctx(125))).toMatchObject({ level: 'fail', title: 'The probe container did not run' });
    expect(classifyConnection('something odd\nHTTP_EXIT=2', ctx()).title).toBe('A container reached something unexpected');
  });

  it('the timeout advice depends on the operating system and never claims to change anything', () => {
    const help = unreachableHelp();
    expect(help.length).toBeGreaterThan(80);
    expect(help).toMatch(/does not change firewall settings|no firewall blocks it|Check/);
  });
});
