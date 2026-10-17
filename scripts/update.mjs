// `agentmesh update`: install the newest release. This runs from the launcher BEFORE the program is loaded:
// on Windows, npm cannot replace the database engine while a running program has it open.
//
//   agentmesh update            look for a newer release and, if there is one, ask before installing it
//   agentmesh update --check    only say whether there is one
//   agentmesh update --yes      install without asking
//
// It talks to GitHub only: one GET to the public API for this project's latest release, and then, if you agree, two
// downloads from that release (the package and its checksum file). Of everything the API says, only the version number
// is used, after a strict check, to fill in the address of those two files. Nothing else it sends is followed.
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { URL } from 'node:url';
import { createInterface } from 'node:readline/promises';

export const REPO = 'zetabyte1195-cyber/agentmesh';
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
/** A release tag is a plain version number, with or without a v. Anything else is not trusted to build an address from. */
export const TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;
/** The package of one release, by its tag. Pinned to the tag so the version that was announced is the version that is fetched. */
export const packageUrl = (tag) => {
  if (!TAG_PATTERN.test(tag)) throw new Error('That is not a release version number.');
  return `https://github.com/${REPO}/releases/download/${tag}/agentmesh.tgz`;
};
const MANUAL = 'Download it yourself from the releases page and compare the checksum by hand first (INSTALL.md, "Want to check the download first?").';

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
  if (typeof body.tag_name !== 'string' || !TAG_PATTERN.test(body.tag_name)) throw new Error('GitHub sent a release without a plain version number.');
  const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : RELEASES_URL;
  return { version: body.tag_name.replace(/^v/, ''), tag: body.tag_name, url };
}

/**
 * The checksum file is exactly what `sha256sum` writes for one file: the SHA-256, two characters (a space, then a space or
 * a star), the file name, one line. Anything else is refused: a line that names another file, several lines, or a hash cut
 * short must not pass for "checked". Returns { hash, name }, or null.
 */
export function parseChecksum(text) {
  const m = /^([0-9a-f]{64}) [ *]([^\r\n]+)\r?\n?$/i.exec(text);
  return m ? { hash: m[1].toLowerCase(), name: m[2] } : null;
}

/**
 * Download the release package and check it against the SHA-256 file published next to it, before anything is
 * installed. Throws, in plain words, if either file is missing or they do not match. Returns the verified file.
 * This catches a damaged or cut-off download. It cannot catch a release replaced on purpose: both files come from the
 * same place.
 */
export async function downloadVerified(url, fetchFn = fetch, tempRoot = tmpdir(), write = writeFileSync) {
  const get = (u) => fetchFn(u, { headers: { 'User-Agent': 'AgentMesh-update' }, signal: AbortSignal.timeout(120_000) });
  const name = basename(new URL(url).pathname);
  const sumRes = await get(`${url}.sha256`);
  if (sumRes.status === 404) throw new Error('This release has no checksum file, so the download cannot be checked.');
  if (!sumRes.ok) throw new Error(`Could not get the checksum (GitHub answered ${sumRes.status}).`);
  const sum = parseChecksum(await sumRes.text());
  if (!sum) throw new Error(`The checksum file is not in the expected format (one line: the SHA-256, then the name ${name}).`);
  if (sum.name !== name) throw new Error(`The checksum file is for another file (${sum.name.slice(0, 60)}), not for ${name}.`);
  const pkgRes = await get(url);
  if (!pkgRes.ok) throw new Error(`Could not download the package (GitHub answered ${pkgRes.status}).`);
  const bytes = Buffer.from(await pkgRes.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sum.hash) throw new Error(`The download does not match its checksum (expected ${sum.hash.slice(0, 12)}..., got ${actual.slice(0, 12)}...). It may be damaged.`);
  const dir = mkdtempSync(join(tempRoot, 'agentmesh-update-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const file = join(dir, name);
  try {
    write(file, bytes);
  } catch (err) {
    cleanup(); // a full disk must not leave a half-written package behind
    throw err;
  }
  return { file, sha256: actual, cleanup };
}

/**
 * npm install -g <file>. The path of the file is handed over in the environment and never pasted into a command line:
 * a temp folder can have spaces, % or & in its name (a user name with one is enough), and on Windows npm can only be started
 * through the command shell, which would read them as commands. On other systems no shell is involved at all.
 */
export function npmInstall(file, { platform = process.platform, spawn = spawnSync, env = process.env } = {}) {
  const withFile = { ...env, AGENTMESH_UPDATE_FILE: file };
  const r =
    platform === 'win32'
      ? spawn('npm install -g "%AGENTMESH_UPDATE_FILE%"', { stdio: 'inherit', shell: true, env: withFile })
      : spawn('npm', ['install', '-g', file], { stdio: 'inherit', env: withFile });
  if (r.error) console.error(`Could not start npm: ${r.error.message}`);
  return r.status ?? 1;
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
  const download = deps.download ?? ((url) => downloadVerified(url, deps.fetch));
  const install = deps.install ?? ((file) => npmInstall(file));
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
    fail(`Could not check for a newer version: ${err.message}\nAre you connected to the internet? You can also look at ${RELEASES_URL}`);
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
  const url = packageUrl(latest.tag);
  if (!yes && !(await confirm(`Install it now? It downloads ${url}, checks it against the checksum published next to it, and runs npm install -g on it.\nStop AgentMesh first (agentmesh stop). [y/N] `))) {
    say('Not installed. Run agentmesh update again when you are ready.');
    return 0;
  }
  let pkg;
  try {
    pkg = await download(url);
  } catch (err) {
    fail(`Not installed: ${err.message}\n${MANUAL}\n${RELEASES_URL}`);
    return 1;
  }
  say(`Downloaded, and it matches the checksum published with the release (sha256 ${pkg.sha256.slice(0, 16)}...).`);
  let code;
  try {
    code = install(pkg.file);
  } finally {
    pkg.cleanup?.(); // also when starting npm throws
  }
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
