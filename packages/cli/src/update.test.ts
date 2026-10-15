// Task 5: `agentmesh update`, the whole flow with a fake GitHub and a fake npm.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Update = {
  PACKAGE_URL: string;
  compareVersions(a: string, b: string): number;
  runUpdate(args: string[], dir: string, deps: Record<string, unknown>): Promise<number>;
};
// A script outside the TypeScript project: loaded by path so the type checker does not need to see it.
const load = async () => (await import(pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'update.mjs')).href)) as Update;

let dir: string;
let said: string[];
let failed: string[];
let installs: number;
const release = (tag: string): typeof fetch => (async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}` }), { status: 200 })) as typeof fetch;
const deps = (extra: Record<string, unknown> = {}) => ({ say: (l: string) => said.push(l), fail: (l: string) => failed.push(l), install: () => (installs++, 0), confirm: async () => true, fetch: release('v0.2.0'), ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-upd-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agentmesh', version: '0.1.0' }));
  said = [];
  failed = [];
  installs = 0;
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
    expect(question).toContain('npm install -g https://github.com/zetabyte1195-cyber/agentmesh/releases/latest/download/agentmesh.tgz');
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

  it('what is installed never comes from the release data, only from the fixed address', async () => {
    const { runUpdate, PACKAGE_URL } = await load();
    const evil: typeof fetch = (async () => new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://evil.example/x', assets: [{ browser_download_url: 'https://evil.example/pwn.tgz' }] }))) as typeof fetch;
    let asked = '';
    await runUpdate([], dir, deps({ fetch: evil, confirm: async (q: string) => ((asked = q), false) }));
    expect(asked).toContain(PACKAGE_URL);
    expect(asked).not.toContain('evil.example');
    expect(said.join('\n')).toContain('https://github.com/zetabyte1195-cyber/agentmesh/releases'); // not the evil page address
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
