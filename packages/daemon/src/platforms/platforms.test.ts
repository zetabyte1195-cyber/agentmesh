import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAgent } from '../runner/run.js';
import { AGY_MCP_RULE, ensureAgyMcpRule } from './builtin.js';
import { customAdapter } from './custom.js';
import { createRegistry } from './registry.js';
import { npmShimTarget, probeVersion, resolveExecutable } from './resolve.js';
import type { PlatformRunContext } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-platforms-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const run: PlatformRunContext = { token: 'amt_test', mcpUrl: 'http://127.0.0.1:1/mcp', dir: 'RUNDIR', claudeMcpConfig: 'CFG.json' };
const node = process.execPath;

describe('custom platforms (defined in config, not code)', () => {
  const base = { id: 'MYTOOL', label: 'My Tool', executable: node, args: ['-e', '0', '{prompt}'] };

  it('rejects definitions that could never work, with a message a person can act on', () => {
    expect(() => customAdapter({ ...base, args: ['--go'] })).toThrow(/\{prompt\}/);
    expect(() => customAdapter({ ...base, id: 'claude_code' })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => customAdapter({ ...base, id: 'CLAUDE_CODE' })).toThrow(/reserved/);
    expect(() => customAdapter({ ...base, rulebook: '../x.md' })).toThrow(/rulebook/);
    expect(() => customAdapter({ ...base, surprise: true } as never)).toThrow();
  });

  it('is reported UNVERIFIED and names its rulebook and owner name', () => {
    const a = customAdapter({ ...base, label: 'Codex CLI' });
    expect(a).toMatchObject({ verified: false, rulebook: 'AGENTS.md', friendlyName: 'Codex' });
    expect(customAdapter({ ...base, friendlyName: 'Bob', rulebook: 'BOB.md' })).toMatchObject({ friendlyName: 'Bob', rulebook: 'BOB.md' });
  });

  it('fills placeholders as separate arguments (a prompt is never re-parsed by a shell) and sets the MCP environment', () => {
    const a = customAdapter({ ...base, args: ['--config', '{mcpConfigFile}', '--dir', '{runDir}', '--cwd', '{cwd}', 'do "this"; rm -rf /'.replace('do', '{prompt}')], env: { X: 'url={mcpUrl}' } });
    const c = a.command({ prompt: 'PLAN it', cwd: 'CWD', run });
    expect(c.args).toEqual(['--config', 'CFG.json', '--dir', 'RUNDIR', '--cwd', 'CWD', 'PLAN it "this"; rm -rf /']);
    expect(c.env).toEqual({ AGENTMESH_MCP_URL: 'http://127.0.0.1:1/mcp', X: 'url=http://127.0.0.1:1/mcp' });
    expect(c.textOutput).toBe(true);
    expect(customAdapter({ ...base, output: 'claude-stream-json' }).command({ prompt: 'p', cwd: 'c', run }).textOutput).toBe(false);
  });

  it('says plainly when the tool is not installed', () => {
    const a = customAdapter({ ...base, executable: 'definitely-not-installed-agent-xyz' });
    expect(() => a.command({ prompt: 'p', cwd: 'c', run })).toThrow(/not installed.*definitely-not-installed-agent-xyz/);
  });

  it('runs a plain-text tool: exit 0 is success and stdout is the result; a non-zero exit fails', async () => {
    const ok = customAdapter({ ...base, args: ['-e', "console.log('plan line 1'); console.log('mcp=' + process.env.AGENTMESH_MCP_URL + ' tok=' + process.env.AGENTMESH_TOKEN)", '{prompt}'] });
    const r = await startAgent({ command: ok.command({ prompt: 'x', cwd: dir, run }), cwd: dir, env: { AGENTMESH_TOKEN: 'amt_run' } }).done;
    expect(r).toMatchObject({ ok: true, exitCode: 0, failure: null });
    expect(r.result?.text).toBe('plan line 1\nmcp=http://127.0.0.1:1/mcp tok=amt_run');
    const bad = customAdapter({ ...base, args: ['-e', "console.error('nope'); process.exit(3)", '{prompt}'] });
    const f = await startAgent({ command: bad.command({ prompt: 'x', cwd: dir, run }), cwd: dir }).done;
    expect(f.ok).toBe(false);
    expect(f.failure).toContain('exited with code 3');
  });
});

describe('registry', () => {
  it('has the two verified built-ins and adds custom ones', () => {
    const r = createRegistry([{ id: 'CODEX', label: 'Codex CLI', executable: node, args: ['{prompt}'] }]);
    expect(r.list().map((p) => [p.id, p.verified])).toEqual([['CLAUDE_CODE', true], ['ANTIGRAVITY', true], ['CODEX', false]]);
    expect(r.has('CODEX')).toBe(true);
    expect(r.has('CURSOR')).toBe(false);
  });

  it('names the broken definition, and refuses duplicates', () => {
    expect(() => createRegistry([{ id: 'BAD', label: 'Bad', executable: node, args: [] }])).toThrow(/Invalid custom platform "BAD".*\{prompt\}/);
    const one = { id: 'DUP', label: 'D', executable: node, args: ['{prompt}'] };
    expect(() => createRegistry([one, one])).toThrow(/defined twice/);
  });
});

describe('finding and launching CLIs portably', () => {
  it('finds a real executable and reports its version, or says it is missing', async () => {
    expect(resolveExecutable('definitely-not-installed-agent-xyz')).toBeNull();
    expect(await probeVersion('definitely-not-installed-agent-xyz', ['--version'])).toEqual({ installed: false });
    const v = await probeVersion(node, ['--version']);
    expect(v.installed).toBe(true);
    expect(v.version).toMatch(/^v\d+/);
  });

  it('turns a standard npm .cmd shim into the node script it runs (Node cannot spawn .cmd without a shell)', () => {
    const script = join(dir, 'node_modules', 'pkg', 'bin', 'cli.js');
    mkdirSync(join(dir, 'node_modules', 'pkg', 'bin'), { recursive: true });
    writeFileSync(script, 'console.log(1)');
    writeFileSync(join(dir, 'mytool.cmd'), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n');
    expect(npmShimTarget(join(dir, 'mytool.cmd'))).toBe(script);
    expect(resolveExecutable('mytool', { platform: 'win32', env: { PATH: dir } })).toEqual({ file: process.execPath, prefixArgs: [script] });
  });

  it('refuses a .cmd that is not an npm shim instead of launching it through a shell', () => {
    writeFileSync(join(dir, 'weird.cmd'), '@echo hi\r\n');
    const r = resolveExecutable('weird', { platform: 'win32', env: { PATH: dir } });
    expect(r).toMatchObject({ unsupported: expect.stringContaining('can\'t launch safely') });
  });
});

describe('Antigravity permission rule (the one thing every friend has to do)', () => {
  it('creates the settings file when there is none', () => {
    const path = join(dir, 'a', 'settings.json');
    expect(ensureAgyMcpRule(path)).toEqual({ changed: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissions: { allow: [AGY_MCP_RULE] } });
  });

  it('adds only its rule, keeps every other setting, backs the file up, and is idempotent', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ theme: 'dark', permissions: { allow: ['command(git status)'], deny: ['x'] } }));
    const r = ensureAgyMcpRule(path);
    expect(r.changed).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark', permissions: { allow: ['command(git status)', AGY_MCP_RULE], deny: ['x'] } });
    expect(existsSync(r.backup!)).toBe(true);
    expect(JSON.parse(readFileSync(r.backup!, 'utf8')).permissions.allow).toEqual(['command(git status)']);
    expect(ensureAgyMcpRule(path)).toEqual({ changed: false });
  });

  it('never overwrites a settings file it cannot parse', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ not json');
    expect(() => ensureAgyMcpRule(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});
