// `agentmesh update`: install the newest release. This runs from the launcher BEFORE the program is loaded:
// on Windows, npm cannot replace the database engine while a running program has it open.
//
//   agentmesh update            look for a newer release and, if there is one, ask before installing it
//   agentmesh update --check    only say whether there is one
//   agentmesh update --yes      install without asking
//
// The only network request is one GET to GitHub's public API for this project's latest release. What gets
// installed always comes from the fixed address below, never from anything the API says.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export const REPO = 'zetabyte1195-cyber/agentmesh';
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const PACKAGE_URL = `https://github.com/${REPO}/releases/latest/download/agentmesh.tgz`;

/** Compare "1.2.3"-style versions (a leading v and any -suffix are ignored). Returns <0, 0 or >0. */
export function compareVersions(a, b) {
  const parts = (v) => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function latestRelease(api = LATEST_API, fetchFn = fetch) {
  const res = await fetchFn(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentMesh-update' }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Error('No release has been published yet.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const body = await res.json();
  if (typeof body.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+/.test(body.tag_name)) throw new Error('GitHub sent a release without a version number.');
  const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : `https://github.com/${REPO}/releases`;
  return { version: body.tag_name.replace(/^v/i, ''), url };
}

/** The installed version, from the package.json next to bin/. */
export function installedVersion(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
}

async function ask(question, input = process.stdin, output = process.stderr) {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Returns the exit code. Every dependency is a parameter so the whole flow can be tested without a network
 * or a real npm.
 */
export async function runUpdate(args, packageDir, deps = {}) {
  const say = deps.say ?? ((line) => console.log(line));
  const fail = deps.fail ?? ((line) => console.error(line));
  const confirm = deps.confirm ?? ((q) => ask(q));
  const install = deps.install ?? (() => spawnSync(`npm install -g "${PACKAGE_URL}"`, { stdio: 'inherit', shell: true }).status ?? 1);
  const checkOnly = args.includes('--check');
  const yes = args.includes('--yes') || args.includes('-y');

  let current;
  try {
    current = installedVersion(packageDir);
  } catch {
    fail('This copy of AgentMesh runs from the source folder, so it is updated with git (git pull, npm ci, npm run build).');
    return 1;
  }
  let latest;
  try {
    latest = await latestRelease(deps.api ?? process.env.AGENTMESH_UPDATE_API ?? LATEST_API, deps.fetch);
  } catch (err) {
    fail(`Could not check for a newer version: ${err.message}\nAre you connected to the internet? You can also look at https://github.com/${REPO}/releases`);
    return 1;
  }
  if (compareVersions(latest.version, current) <= 0) {
    say(`AgentMesh ${current} is the newest version.`);
    return 0;
  }
  say(`AgentMesh ${latest.version} is available (you have ${current}).\nWhat is new: ${latest.url}`);
  if (checkOnly) {
    say('To install it: agentmesh update');
    return 0;
  }
  if (!yes && !(await confirm(`Install it now? This runs: npm install -g ${PACKAGE_URL}\nStop AgentMesh first (agentmesh stop). [y/N] `))) {
    say(`Not installed. To do it yourself: npm install -g ${PACKAGE_URL}`);
    return 0;
  }
  const code = install();
  if (code !== 0) {
    fail(
      `The install did not finish (npm exit code ${code}).\n` +
        '  - If it mentions EBUSY, EPERM or "in use": AgentMesh is still running. Run agentmesh stop in every project, close any terminal using it, and try again.\n' +
        '  - If it mentions EACCES or permission: npm may not install programs for all users on this computer (see INSTALL.md, step 3).',
    );
    return 1;
  }
  say(`Updated to ${latest.version}. Your projects' data upgrades itself the next time you start AgentMesh.`);
  return 0;
}
