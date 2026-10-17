// Task 5: `agentmesh update`, the whole flow with a fake GitHub and a fake npm.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Verified = { file: string; sha256: string; cleanup: () => void };
type Update = {
  RELEASES_URL: string;
  packageUrl(tag: string): string;
  compareVersions(a: string, b: string): number;
  runUpdate(args: string[], dir: string, deps: Record<string, unknown>): Promise<number>;
  downloadVerified(url: string, fetchFn: typeof fetch, tempRoot: string, write?: (file: string, bytes: Buffer) => void): Promise<Verified>;
  latestRelease(api: string, fetchFn: typeof fetch): Promise<{ version: string; tag: string; url: string }>;
  parseChecksum(text: string): { hash: string; name: string } | null;
  npmInstall(file: string, o?: { platform?: string; spawn?: (...a: unknown[]) => { status: number | null; error?: Error }; env?: Record<string, string | undefined> }): number;
};
// A script outside the TypeScript project: loaded by path so the type checker does not need to see it.
const load = async () => (await import(pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'update.mjs')).href)) as Update;

let dir: string;
let said: string[];
let failed: string[];
let installs: number;
let installedFile: string | undefined;
let cleaned: number;
const release = (tag: string): typeof fetch => (async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}` }), { status: 200 })) as typeof fetch;
const verified = (): Verified => ({ file: join(dir, 'agentmesh.tgz'), sha256: 'ab'.repeat(32), cleanup: () => void cleaned++ });
const deps = (extra: Record<string, unknown> = {}) => ({
  say: (l: string) => said.push(l),
  fail: (l: string) => failed.push(l),
  install: (file: string) => (installs++, (installedFile = file), 0),
  download: async () => verified(),
  confirm: async () => true,
  fetch: release('v0.2.0'),
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-upd-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agentmesh', version: '0.1.0' }));
  said = [];
  failed = [];
  installs = 0;
  installedFile = undefined;
  cleaned = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

describe('agentmesh update (task 5)', () => {
  it('compares versions by number', async () => {
    const { compareVersions } = await load();
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  it('says so when you already have the newest version, and installs nothing', async () => {
    const { runUpdate } = await load();
    expect(await runUpdate([], dir, deps({ fetch: release('v0.1.0') }))).toBe(0);
    expect(said.join('\n')).toContain('0.1.0 is the newest version');
    expect(installs).toBe(0);
  });

  it('--check reports a newer version and installs nothing', async () => {
    const { runUpdate } = await load();
    expect(await runUpdate(['--check'], dir, deps())).toBe(0);
    expect(said.join('\n')).toContain('0.2.0 is available (you have 0.1.0)');
    expect(installs).toBe(0);
  });

  it('asks first, and installs nothing if you say no', async () => {
    const { runUpdate } = await load();
    let question = '';
    expect(await runUpdate([], dir, deps({ confirm: async (q: string) => ((question = q), false) }))).toBe(0);
    expect(question).toContain('https://github.com/zetabyte1195-cyber/agentmesh/releases/download/v0.2.0/agentmesh.tgz'); // the version that was announced, not "latest"
    expect(question).toContain('checks it against the checksum');
    expect(installs).toBe(0);
    expect(said.join('\n')).toContain('Not installed');
  });

  it('installs when you say yes, or with --yes', async () => {
    const { runUpdate } = await load();
    expect(await runUpdate([], dir, deps())).toBe(0);
    expect(await runUpdate(['--yes'], dir, deps({ confirm: async () => { throw new Error('must not ask'); } }))).toBe(0);
    expect(installs).toBe(2);
    expect(said.join('\n')).toContain('Updated to 0.2.0');
  });

  it('installs the file that was checked, says so, and removes it afterwards', async () => {
    const { runUpdate } = await load();
    expect(await runUpdate(['--yes'], dir, deps())).toBe(0);
    expect(installedFile).toBe(join(dir, 'agentmesh.tgz'));
    expect(said.join('\n')).toMatch(/matches the checksum published with the release \(sha256 abababababababab/);
    expect(cleaned).toBe(1);
  });

  it('installs nothing, and says why, when the download cannot be checked', async () => {
    const { runUpdate, RELEASES_URL } = await load();
    const broken = async () => {
      throw new Error('The download does not match its checksum (expected 1234..., got 5678...). It may be damaged.');
    };
    expect(await runUpdate(['--yes'], dir, deps({ download: broken }))).toBe(1);
    expect(installs).toBe(0);
    const text = failed.join('\n');
    expect(text).toContain('Not installed: The download does not match its checksum');
    expect(text).toContain(RELEASES_URL); // where to get it by hand
    expect(text).toMatch(/compare the checksum by hand/);
    expect(text).not.toMatch(/npm install/); // never a way to install what just failed its check
  });

  it('says nothing about installing unchecked when you answer no', async () => {
    const { runUpdate } = await load();
    await runUpdate([], dir, deps({ confirm: async () => false }));
    expect(said.join('\n')).not.toMatch(/npm install/);
  });

  it('downloads the version that was announced, from its own tag, and hands that address to the download', async () => {
    const { runUpdate } = await load();
    let got = '';
    await runUpdate(['--yes'], dir, deps({ fetch: release('v0.3.1'), download: async (u: string) => ((got = u), verified()) }));
    expect(got).toBe('https://github.com/zetabyte1195-cyber/agentmesh/releases/download/v0.3.1/agentmesh.tgz');
  });

  it('passes its own fetch to the download, so the whole flow runs on one network layer', async () => {
    const { runUpdate } = await load();
    const seen: string[] = [];
    const sha = createHash('sha256').update('pkg').digest('hex');
    const fake = (async (url: string) => {
      seen.push(String(url));
      if (String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify({ tag_name: 'v0.2.0' }));
      if (String(url).endsWith('.sha256')) return new Response(`${sha}  agentmesh.tgz\n`);
      return new Response('pkg');
    }) as typeof fetch;
    expect(await runUpdate(['--yes'], dir, { say: () => {}, fail: (l: string) => failed.push(l), install: () => 0, fetch: fake })).toBe(0);
    expect(seen).toEqual([
      'https://api.github.com/repos/zetabyte1195-cyber/agentmesh/releases/latest',
      'https://github.com/zetabyte1195-cyber/agentmesh/releases/download/v0.2.0/agentmesh.tgz.sha256',
      'https://github.com/zetabyte1195-cyber/agentmesh/releases/download/v0.2.0/agentmesh.tgz',
    ]);
    expect(failed).toEqual([]);
  });

  it('removes the downloaded file even when starting npm throws', async () => {
    const { runUpdate } = await load();
    await expect(runUpdate(['--yes'], dir, deps({ install: () => { throw new Error('spawn failed'); } }))).rejects.toThrow('spawn failed');
    expect(cleaned).toBe(1);
  });

  it('what is installed never comes from the release data, only from the fixed address', async () => {
    const { runUpdate, packageUrl } = await load();
    const evil: typeof fetch = (async () => new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://evil.example/x', assets: [{ browser_download_url: 'https://evil.example/pwn.tgz' }] }))) as typeof fetch;
    let asked = '';
    await runUpdate([], dir, deps({ fetch: evil, confirm: async (q: string) => ((asked = q), false) }));
    expect(asked).toContain(packageUrl('v9.9.9')); // only the version number is taken from the release
    expect(asked).not.toContain('evil.example');
    expect(said.join('\n')).toContain('https://github.com/zetabyte1195-cyber/agentmesh/releases'); // not the evil page address
  });

  it('builds an address only from a plain version number, so a tag cannot steer the download elsewhere', async () => {
    const { runUpdate, packageUrl, latestRelease } = await load();
    for (const tag of ['v1.2.3/../../evil', 'v1.2.3?x=1', 'v1.2.3#', '../v1.2.3', 'v1.2.3 ', 'v1.2.3-rc1', 'v1.2.3/x', 'V1.2.3', '1.2', '']) {
      expect(() => packageUrl(tag), tag).toThrow(/not a release version number/);
      const fake = (async () => new Response(JSON.stringify({ tag_name: tag }))) as typeof fetch;
      await expect(latestRelease('https://api.example.test/x', fake), tag).rejects.toThrow(/without a plain version number/);
    }
    // and a refused tag never gets as far as a question or a download
    const bad = (async () => new Response(JSON.stringify({ tag_name: 'v9.9.9/../../evil' }))) as typeof fetch;
    let downloaded = 0;
    expect(await runUpdate(['--yes'], dir, deps({ fetch: bad, download: async () => (downloaded++, verified()) }))).toBe(1);
    expect(downloaded).toBe(0);
    expect(installs).toBe(0);
  });

  it('keeps the tag as GitHub spells it, with or without a v', async () => {
    const { latestRelease, packageUrl } = await load();
    const r = await latestRelease('https://api.example.test/x', release('0.4.0'));
    expect(r).toMatchObject({ version: '0.4.0', tag: '0.4.0' });
    expect(packageUrl(r.tag)).toBe('https://github.com/zetabyte1195-cyber/agentmesh/releases/download/0.4.0/agentmesh.tgz');
    expect((await latestRelease('https://api.example.test/x', release('v0.4.0'))).version).toBe('0.4.0');
  });

  it('explains a failed install, and a failed lookup', async () => {
    const { runUpdate } = await load();
    expect(await runUpdate(['--yes'], dir, deps({ install: () => 1 }))).toBe(1);
    expect(failed.join('\n')).toMatch(/EBUSY[\s\S]*agentmesh stop/);
    failed = [];
    const down: typeof fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect(await runUpdate([], dir, deps({ fetch: down }))).toBe(1);
    expect(failed.join('\n')).toContain('GitHub answered 503');
  });

  it('says what to do when run from a source checkout (no package.json version next to bin)', async () => {
    const { runUpdate } = await load();
    expect(await runUpdate([], join(dir, 'nowhere'), deps())).toBe(1);
    expect(failed.join('\n')).toContain('git pull');
  });
});

describe('the download is checked before anything is installed', () => {
  const bytes = Buffer.from('pretend this is a package');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const URL = 'https://example.test/agentmesh.tgz';
  /** A fake release host: the package, and its checksum file (or whatever a test puts there). */
  const host = (sum: { status?: number; body?: string }, pkg: { status?: number; body?: Buffer } = {}): typeof fetch =>
    (async (url: string) => {
      if (String(url) === `${URL}.sha256`) return new Response(sum.body ?? `${sha}  agentmesh.tgz\n`, { status: sum.status ?? 200 });
      if (String(url) === URL) return new Response(pkg.body ?? bytes, { status: pkg.status ?? 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;

  it('hands back the file when it matches the published checksum, and cleanup removes it', async () => {
    const { downloadVerified } = await load();
    const got = await downloadVerified(URL, host({}), dir);
    expect(got.sha256).toBe(sha);
    expect(readFileSync(got.file).equals(bytes)).toBe(true);
    got.cleanup();
    expect(existsSync(got.file)).toBe(false);
  });

  it('accepts the checksum file the way sha256sum writes it, in either case, with a star or a space before the name, with or without a final newline', async () => {
    const { downloadVerified } = await load();
    for (const body of [`${sha}  agentmesh.tgz`, `${sha}  agentmesh.tgz\n`, `${sha} *agentmesh.tgz\n`, `${sha.toUpperCase()}  agentmesh.tgz\r\n`]) {
      const got = await downloadVerified(URL, host({ body }), dir);
      expect(got.sha256, body).toBe(sha);
      got.cleanup();
    }
  });

  it('refuses a checksum file that is not exactly one line for this file: a bare hash, another name, several lines, a short hash', async () => {
    const { downloadVerified } = await load();
    const refuse = async (body: string, words: RegExp) => {
      await expect(downloadVerified(URL, host({ body }), dir), JSON.stringify(body)).rejects.toThrow(words);
      expect(readdirSync(dir).filter((n) => n.startsWith('agentmesh-update-'))).toEqual([]);
    };
    await refuse(sha, /not in the expected format/); // no file name: nothing says what the hash is for
    await refuse(`${sha}  other.tgz\n`, /for another file \(other\.tgz\), not for agentmesh\.tgz/);
    await refuse(`${sha}  agentmesh.tgz\n${'0'.repeat(64)}  other.tgz\n`, /not in the expected format/); // two lines: which one is meant?
    await refuse(`${sha}  agentmesh.tgz\n\n`, /not in the expected format/);
    await refuse(`${sha.slice(0, 63)}  agentmesh.tgz\n`, /not in the expected format/); // cut short
    await refuse(`${sha}0  agentmesh.tgz\n`, /not in the expected format/); // too long
    await refuse(`${sha}agentmesh.tgz\n`, /not in the expected format/);
    await refuse(`${sha}  \n`, /not in the expected format/);
    await refuse(`<html>${sha}  agentmesh.tgz</html>`, /not in the expected format/);
    await refuse('', /not in the expected format/);
  });

  it('parses the format the packer writes', async () => {
    const { parseChecksum } = await load();
    expect(parseChecksum(`${sha}  agentmesh.tgz\n`)).toEqual({ hash: sha, name: 'agentmesh.tgz' });
    expect(parseChecksum('nope')).toBeNull();
  });

  it('the checksum file the packer writes is accepted by this check (the two files agree on the format)', async () => {
    const { parseChecksum } = await load();
    const text = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'pack.mjs'), 'utf8');
    expect(text).toContain('`${sha256}  agentmesh.tgz\\n`'); // the line this test is about
    expect(parseChecksum(`${'a'.repeat(64)}  agentmesh.tgz\n`)).not.toBeNull();
  });

  it('leaves nothing behind when the package cannot be written', async () => {
    const { downloadVerified } = await load();
    const full = () => {
      throw new Error('ENOSPC: no space left on device');
    };
    await expect(downloadVerified(URL, host({}), dir, full)).rejects.toThrow(/ENOSPC/); // the real reason is what you see
    expect(readdirSync(dir).filter((n) => n.startsWith('agentmesh-update-'))).toEqual([]);
  });

  it('refuses a package that does not match, and leaves nothing behind', async () => {
    const { downloadVerified } = await load();
    await expect(downloadVerified(URL, host({}, { body: Buffer.from('tampered') }), dir)).rejects.toThrow(/does not match its checksum/);
    expect(readdirSync(dir).filter((n) => n.startsWith('agentmesh-update-'))).toEqual([]);
  });

  it('refuses when the release has no checksum file, or it is not a checksum, or it cannot be fetched', async () => {
    const { downloadVerified } = await load();
    await expect(downloadVerified(URL, host({ status: 404 }), dir)).rejects.toThrow(/no checksum file/);
    await expect(downloadVerified(URL, host({ body: 'not a checksum' }), dir)).rejects.toThrow(/not in the expected format/);
    await expect(downloadVerified(URL, host({ status: 503 }), dir)).rejects.toThrow(/GitHub answered 503/);
  });

  it('says so when the package itself cannot be downloaded', async () => {
    const { downloadVerified } = await load();
    await expect(downloadVerified(URL, host({}, { status: 500 }), dir)).rejects.toThrow(/Could not download the package \(GitHub answered 500\)/);
  });
});

describe('npm install gets the path without a shell reading it', () => {
  const spawned: { cmd: string; args?: string[]; opts: { shell?: boolean; env: Record<string, string> } }[] = [];
  const spawn = (cmd: string, a: unknown, b?: unknown) => {
    const opts = (b ?? a) as { shell?: boolean; env: Record<string, string> };
    spawned.push({ cmd, ...(Array.isArray(a) ? { args: a as string[] } : {}), opts });
    return { status: 0 };
  };
  beforeEach(() => (spawned.length = 0));
  const nasty = 'D:\\Scratch\\Jo & Co\\100%\\agentmesh-update-x1\\agentmesh.tgz';

  it('on Windows: the command line names an environment variable, never the path itself', async () => {
    const { npmInstall } = await load();
    expect(npmInstall(nasty, { platform: 'win32', spawn, env: { PATH: 'x' } })).toBe(0);
    const [call] = spawned;
    expect(call!.cmd).toBe('npm install -g "%AGENTMESH_UPDATE_FILE%"');
    expect(call!.cmd).not.toContain('Jo & Co');
    expect(call!.opts.shell).toBe(true);
    expect(call!.opts.env.AGENTMESH_UPDATE_FILE).toBe(nasty);
    expect(call!.opts.env.PATH).toBe('x'); // the rest of the environment is kept
  });

  it('elsewhere: no shell at all, the path is one argument', async () => {
    const { npmInstall } = await load();
    npmInstall('/tmp/a b/$(touch pwned)/agentmesh.tgz', { platform: 'linux', spawn, env: {} });
    const [call] = spawned;
    expect(call!.cmd).toBe('npm');
    expect(call!.args).toEqual(['install', '-g', '/tmp/a b/$(touch pwned)/agentmesh.tgz']);
    expect(call!.opts.shell).toBeUndefined();
  });

  it('passes on npm\'s exit code, and 1 when npm could not be started', async () => {
    const { npmInstall } = await load();
    expect(npmInstall('f', { platform: 'linux', spawn: () => ({ status: 7 }), env: {} })).toBe(7);
    expect(npmInstall('f', { platform: 'linux', spawn: () => ({ status: null, error: new Error('spawn npm ENOENT') }), env: {} })).toBe(1);
  });

  // The real thing: a stand-in "npm" that reports what it was given, started the way the update starts it, with a temp
  // folder whose name a command shell would misread. On Windows this goes through cmd.exe for real.
  it('hands npm the exact path, even when the temp folder has spaces, &, % or $ in its name', async () => {
    const { npmInstall } = await load();
    const bin = mkdtempSync(join(tmpdir(), 'agentmesh-fakenpm-'));
    const odd = join(mkdtempSync(join(tmpdir(), 'agentmesh-odd-')), process.platform === 'win32' ? 'Jo & Co %PATH% 100%x' : 'Jo & Co $HOME 100%x'); // %PATH% is read by the command shell as a variable: pasted into the command line it would turn the path into something else
    mkdirSync(odd);
    const file = join(odd, 'agentmesh.tgz');
    writeFileSync(file, 'x');
    const report = join(bin, 'argv.json');
    writeFileSync(join(bin, 'report.cjs'), `require('fs').writeFileSync(process.env.REPORT, JSON.stringify(process.argv.slice(2)))`);
    if (process.platform === 'win32') writeFileSync(join(bin, 'npm.cmd'), `@node "%~dp0report.cjs" %*\r\n`);
    else {
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/report.cjs" "$@"\n');
      chmodSync(join(bin, 'npm'), 0o755);
    }
    try {
      const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'; // Windows calls it Path: a second spelling would be a second variable
      const code = npmInstall(file, { env: { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`, REPORT: report } });
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(['install', '-g', file]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(join(odd, '..'), { recursive: true, force: true });
    }
  });
});
