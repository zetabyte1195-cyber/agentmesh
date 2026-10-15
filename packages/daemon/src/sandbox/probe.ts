// `agentmesh doctor` for container mode: real checks, run through the real wrapper, because "the settings look
// right" is not the same as "a container can actually reach AgentMesh". The most common failure is a firewall
// that silently drops traffic from the container's network to this computer; the probe tells it apart from
// "nothing is listening" and says what to do.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, type IdentityService } from '../identity/index.js';
import type { Diagnosis } from '../platforms/types.js';
import { AgentListener } from './agent-listener.js';
import { type SandboxConfig, expandWrapper, isDockerLike, lintWrapper } from './config.js';
import { type Exec, realExec } from './runtime.js';
import { containerNameOf, projectIdOf } from './wrap.js';

const check = (level: Diagnosis['level'], title: string, detail: string, fix?: string): Diagnosis => ({ level, title, detail, ...(fix ? { fix } : {}) });

/** What to try when a container cannot reach this computer, by operating system. */
export function unreachableHelp(): string {
  if (process.platform === 'win32') {
    return 'Most likely Windows Firewall is blocking the connection from the container\'s network to this computer: it allows programs per network type (Public / Private / Domain), and Docker\'s network is often "Private". In "Windows Security > Firewall & network protection > Allow an app through firewall", allow Node.js JavaScript Runtime on Private networks, then run this check again. AgentMesh does not change firewall settings.';
  }
  if (process.platform === 'darwin') return 'Check the container engine\'s settings (Docker Desktop: Settings > Resources > Network) and that no firewall blocks the connection; then run this check again.';
  return 'Check that "listen.host" is an address the container can route to (on Linux, the container engine\'s bridge gateway, usually 172.17.0.1) and that no firewall blocks it; then run this check again.';
}

/** The script run inside the container: the HTTP request to the listener, then the mount checks. Whatever tool the image has is used. */
export function probeScript(url: string, cwd: string, runDir: string): string {
  const target = new URL(url);
  return [
    `URL='${url}'`,
    `if command -v curl >/dev/null 2>&1; then curl -sS -m 8 -X POST -H "Authorization: Bearer $AGENTMESH_TOKEN" -d '{}' "$URL"; echo "HTTP_EXIT=$?";`,
    `elif command -v wget >/dev/null 2>&1; then wget -q -T 8 -O - --header="Authorization: Bearer $AGENTMESH_TOKEN" --post-data='{}' "$URL"; echo "HTTP_EXIT=$?";`,
    `elif command -v node >/dev/null 2>&1; then node -e "fetch(process.argv[1],{method:'POST',headers:{Authorization:'Bearer '+process.env.AGENTMESH_TOKEN},body:'{}',signal:AbortSignal.timeout(8000)}).then(async r=>console.log(await r.text())).catch(e=>{console.error(e.message);process.exit(7)})" "$URL"; echo "HTTP_EXIT=$?";`,
    // bash can open a TCP connection by itself, so an image with only bash can still be tested (`timeout` turns a silent hang into exit 124).
    `elif command -v bash >/dev/null 2>&1; then timeout 8 bash -c 'exec 3<>/dev/tcp/${target.hostname}/${target.port} && printf "POST /mcp HTTP/1.0\\r\\nHost: ${target.host}\\r\\nAuthorization: Bearer %s\\r\\nContent-Length: 2\\r\\n\\r\\n{}" "$AGENTMESH_TOKEN" >&3 && cat <&3'; echo "HTTP_EXIT=$?";`,
    `else echo NO_HTTP_TOOL; fi`,
    `(touch '${cwd}/.agentmesh-probe' 2>/dev/null && rm -f '${cwd}/.agentmesh-probe' && echo CWD_WRITABLE) || echo CWD_READONLY`,
    `(touch '${runDir}/.agentmesh-probe' 2>/dev/null && rm -f '${runDir}/.agentmesh-probe' && echo RUNDIR_WRITABLE) || echo RUNDIR_READONLY`,
  ].join('\n');
}

/**
 * Reads what the probe container printed and says what happened, in the order that cannot mislabel a cause:
 * an answer, then "no tool to test with", then "the container did not start", then a name that does not resolve,
 * then a refusal, and only then a timeout (a silent drop, usually a firewall).
 */
export function classifyConnection(text: string, c: { run: { code: number | null }; url: string; bound: string; cfg: SandboxConfig; secretTail: string }): Diagnosis {
  if (text.includes(`probe-ok-${c.secretTail}`)) return check('ok', 'A container can reach AgentMesh', `The listener answered from inside a container at ${c.url}.`);
  if (/NO_HTTP_TOOL/.test(text)) return check('warn', 'Could not test the connection from inside the container', 'The image has none of curl, wget, node or bash, so the probe could not make an HTTP request. (Agent tools need at least one of them anyway.)');
  if (c.run.code !== 0 && !/HTTP_EXIT/.test(text)) {
    return check('fail', 'The probe container did not run', text.trim().split('\n').slice(-3).join(' | ') || `the container command exited with ${c.run.code}`, 'Fix what the message says (the wrapper is in the "sandbox" section of .agentmesh/config.json), then run this again.');
  }
  if (/resolve|Name or service not known|bad address|Temporary failure in name resolution|invalid host name|unknown host|nodename nor servname/i.test(text)) {
    return check('fail', `The name ${c.cfg.hostAlias} does not resolve inside the container`, 'Add it to the wrapper, e.g. "--add-host", "host.docker.internal:host-gateway", or set "hostAlias" to a name or address that works.');
  }
  if (/refused|HTTP_EXIT=7\b/i.test(text)) {
    return check('fail', 'Nothing is listening at that address', `${c.url} refused the connection (the agent listener is bound to ${c.bound}). On Docker Desktop, 127.0.0.1 normally works. On Linux a container reaches this computer through the engine's bridge: set "listen": { "host": "auto" } (or the bridge gateway address, usually 172.17.0.1).`);
  }
  if (/HTTP_EXIT=(28|124)\b|timed out|Operation timed out|Connection timed out/i.test(text)) {
    return check('fail', 'A container cannot reach AgentMesh (the connection timed out)', `${c.url} did not answer within 8 seconds. ${unreachableHelp()}`);
  }
  return check('fail', 'A container reached something unexpected', text.trim().slice(-300), 'Check "hostAlias" and "listen" in the sandbox section.');
}

export interface ProbeOptions {
  cfg: SandboxConfig;
  repoRoot: string;
  /** In-image commands to check exist, e.g. ["claude", "agy"]. */
  commands: readonly string[];
  exec?: Exec;
}

/** Runs every container-mode check. Starts a temporary listener (and stops it), and runs a few short containers. */
export async function probeSandbox(o: ProbeOptions): Promise<Diagnosis[]> {
  const { cfg } = o;
  const exec = o.exec ?? realExec;
  const out: Diagnosis[] = [];
  const bin = cfg.wrapper[0]!;

  for (const w of lintWrapper(cfg)) out.push(check('warn', w.startsWith('The project check') ? 'The project check runs on this computer' : 'Container wrapper', w));
  if (cfg.checks === 'container') out.push(check('info', 'The project check runs in the container', 'The image needs your project\'s tools (node, python, ...). Dependencies installed on this computer may not work in a Linux container: install them inside the image.'));
  if (!cfg.wrapper.some((w) => w.includes('{projectId}'))) {
    out.push(check('warn', 'Containers cannot be cleaned up after a crash', 'The wrapper does not label containers with {projectId} (for example "--label", "agentmesh.project={projectId}"), so a container left behind by a crash cannot be found and removed automatically.'));
  }

  if (isDockerLike(cfg)) {
    const info = await exec([bin, 'info', '--format', '{{.ServerVersion}}'], 15_000);
    if (info.code !== 0) {
      out.push(check('fail', 'The container engine is not running', (info.stderr || info.stdout).trim().split('\n')[0] ?? `${bin} did not answer`, `Start ${bin === 'podman' ? 'Podman' : 'Docker'}, then run this again.`));
      return out;
    }
    out.push(check('ok', `Container engine ${info.stdout.trim()}`, `${bin} answered.`));
    const image = await exec([bin, 'image', 'inspect', cfg.image, '--format', '{{.Id}}'], 15_000);
    if (image.code !== 0) {
      out.push(check('fail', `The image ${cfg.image} is not on this computer`, 'Agents cannot start without it.', `${bin} pull ${cfg.image}   (or build it, then run this again)`));
      return out;
    }
    out.push(check('ok', `Image ${cfg.image} is present`, ''));
  } else {
    out.push(check('info', 'Container engine', `Not docker or podman (${bin}): its health and image cannot be checked here; only the real run below is checked.`));
  }

  // The real run: a temporary listener (only the probe's own key works on it) and one container through the real wrapper.
  const secret = `probe-${randomBytes(12).toString('hex')}`;
  const identity = {
    authenticate: (token: string | null) => {
      if (token !== secret) throw new AuthError('UNKNOWN_TOKEN');
      return { agentId: 'probe', platform: 'PROBE', paradigm: 'CLI' as const, isHuman: false };
    },
  } as unknown as IdentityService;
  const listener = new AgentListener({
    identity,
    host: cfg.listen.host === 'auto' ? '127.0.0.1' : cfg.listen.host,
    port: cfg.listen.port,
    hostAlias: cfg.hostAlias,
    handler: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`probe-ok-${secret.slice(-6)}`);
    },
  });
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-probe-cwd-'));
  const runDir = mkdtempSync(join(tmpdir(), 'agentmesh-probe-run-'));
  try {
    let bound: { host: string; port: number };
    try {
      bound = await listener.listen();
    } catch (err) {
      out.push(check('fail', 'The agent listener cannot start', `${cfg.listen.host}:${cfg.listen.port} - ${(err as Error).message}`, 'Set "listen": { "host": ..., "port": ... } in the sandbox section to an address and port that are free.'));
      return out;
    }
    const projectId = projectIdOf(o.repoRoot);
    const name = containerNameOf(projectId, `probe${randomBytes(3).toString('hex')}`);
    const wrapper = expandWrapper(cfg, { name, cwd, runDir, runId: 'probe', projectId, cwdAccess: 'rw' }, ['AGENTMESH_TOKEN']);
    const url = `http://${cfg.hostAlias}:${bound.port}/mcp`;
    const run = await exec([...wrapper, 'sh', '-c', probeScript(url, cfg.containerCwd, cfg.containerRunDir)], 45_000, { AGENTMESH_TOKEN: secret });
    const text = `${run.stdout}\n${run.stderr}`;
    out.push(classifyConnection(text, { run, url, bound: bound.host, cfg, secretTail: secret.slice(-6) }));
    if (/CWD_WRITABLE/.test(text)) out.push(check('ok', 'The task workspace is writable in the container', cfg.containerCwd));
    else if (/CWD_READONLY/.test(text)) out.push(check('fail', 'The task workspace is read-only in the container', `Agents could not edit files. The wrapper should mount {cwd} at ${cfg.containerCwd} as {cwdAccess}.`));
    if (/RUNDIR_READONLY/.test(text)) out.push(check('ok', 'The run folder (with the agent\'s credentials) is read-only in the container', cfg.containerRunDir));
    else if (/RUNDIR_WRITABLE/.test(text)) out.push(check('warn', 'The run folder is writable in the container', `${cfg.containerRunDir} holds the agent's connection settings; mount it read-only (":ro").`));

    for (const command of o.commands) {
      const versionName = containerNameOf(projectId, `ver${randomBytes(3).toString('hex')}`);
      const versionWrapper = expandWrapper(cfg, { name: versionName, cwd, runDir, runId: 'probe', projectId, cwdAccess: 'rw' }, ['AGENTMESH_TOKEN']);
      const v = await exec([...versionWrapper, command, '--version'], 45_000, { AGENTMESH_TOKEN: secret });
      out.push(v.code === 0 ? check('ok', `${command} is installed in the image`, (v.stdout || v.stderr).trim().split('\n')[0] ?? '') : check('fail', `${command} is not usable in the image`, ((v.stderr || v.stdout).trim().split('\n').pop() ?? '').slice(0, 200), `Install it in ${cfg.image} and sign in once there (AgentMesh cannot do that for you).`));
    }
    out.push(check('info', 'What container mode does not do', 'It does not restrict the container\'s network (an agent can send files out), and your project\'s check command still runs on this computer, not in a container. Safety is only as strong as the image and the wrapper flags you wrote.'));
  } finally {
    await listener.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
  return out;
}
