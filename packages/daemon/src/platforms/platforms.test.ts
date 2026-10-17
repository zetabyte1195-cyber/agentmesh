import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAgent } from '../runner/run.js';
import { AGY_MCP_RULE, ensureAgyMcpRule } from './builtin.js';
import { customAdapter } from './custom.js';
import { writeRunContext } from '../dispatch/dispatcher.js';
import { containerView } from '../sandbox/wrap.js';
import { createRegistry, launcher } from './registry.js';
import { recipeById } from './recipes.js';
import { npmShimTarget, probeVersion, resolveExecutable } from './resolve.js';
import type { PlatformRunContext } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-platforms-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const run: PlatformRunContext = { token: 'amt_test', mcpUrl: 'http://127.0.0.1:1/mcp', dir: 'RUNDIR', claudeMcpConfig: 'CFG.json' };
const node = process.execPath;

describe('changing a platform after it was added', () => {
  const def = (arg: string) => ({ id: 'MINE', label: 'Mine', executable: process.execPath, args: ['--model', arg, '{prompt}'] });
  const specRun = { token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', dir: process.cwd(), claudeMcpConfig: 'x' };
  const spec = { prompt: 'p', cwd: process.cwd(), run: specRun };

  it('replaces a platform that was defined, and refuses to replace one that was not, or a built-in', () => {
    const reg = createRegistry([def('one')]);
    expect(reg.replace(def('two')).id).toBe('MINE');
    expect(reg.get('MINE')!.command(spec).args).toContain('two');
    expect(reg.list().filter((p) => p.id === 'MINE')).toHaveLength(1);
    expect(() => reg.replace({ ...def('x'), id: 'OTHER' })).toThrow(/not a platform you added/);
    expect(() => reg.replace({ ...def('x'), id: 'CLAUDE_CODE' })).toThrow(/reserved|not a platform you added/);
  });

  it('check says whether a definition would be accepted, without changing anything', () => {
    const reg = createRegistry([def('one')]);
    expect(() => reg.check(def('two'))).not.toThrow();
    expect(() => reg.check({ id: 'BAD', label: 'x', executable: 'x', args: [] })).toThrow(/Invalid custom platform "BAD"/);
    expect(reg.get('MINE')!.command(spec).args).toContain('one');
    expect(reg.has('BAD')).toBe(false);
  });

  it('an agent already connected runs the new definition on its next run (its launcher looks the platform up each time)', () => {
    const reg = createRegistry([def('one')]);
    const launch = launcher(reg, 'MINE');
    expect(launch('p', process.cwd(), specRun).args).toContain('one');
    reg.replace(def('two'));
    expect(launch('p', process.cwd(), specRun).args).toContain('two');
    expect(launch('p', process.cwd(), specRun).args).not.toContain('one');
  });

  it('passes the allowed tools on, and says so plainly if the platform has gone', () => {
    const reg = createRegistry([{ id: 'TT', label: 'Tt', executable: process.execPath, args: ['{prompt}'] }]);
    expect(launcher(reg, 'TT', ['a'])('p', process.cwd(), specRun).executable).toBe(process.execPath);
    expect(() => launcher(reg, 'NOPE')('p', process.cwd(), specRun)).toThrow(/no longer defined/);
  });
});

describe('a custom platform inside a container', () => {
  const missing = join(tmpdir(), 'agentmesh-no-such-run-folder');
  const inContainer = { token: 't', mcpUrl: 'http://host.docker.internal:1/mcp', dir: '/agentmesh-run', claudeMcpConfig: '/agentmesh-run/claude-mcp.json', toolConfigs: { opencode: '/agentmesh-run/opencode-mcp.json', gemini: '/agentmesh-run/gemini-settings.json' }, inContainer: true, opencodeConfigJson: '{"mcp":{"agentmesh":{"url":"http://host.docker.internal:1/mcp"}}}' };

  it('does not read the run folder on the host: the paths it was given are the container\'s', () => {
    expect(existsSync(inContainer.toolConfigs.opencode)).toBe(false);
    const a = customAdapter({ id: 'LOCAL', label: 'Local', executable: 'claude', args: ['-p', '{prompt}', '--mcp-config', '{mcpConfigFile}'] });
    const cmd = a.command({ prompt: 'p', cwd: '/work', run: inContainer });
    expect(cmd.args).toEqual(['-p', 'p', '--mcp-config', '/agentmesh-run/claude-mcp.json']);
  });

  it('hands a tool that takes its configuration inline the text it was given, not a file that is not there', () => {
    const a = customAdapter({ id: 'OC', label: 'OC', executable: 'opencode', args: ['run', '{prompt}'], env: { OPENCODE_CONFIG_CONTENT: '{mcpConfigJson:opencode}' } });
    expect(a.command({ prompt: 'p', cwd: '/work', run: inContainer }).env!['OPENCODE_CONFIG_CONTENT']).toBe(inContainer.opencodeConfigJson);
  });

  it('on the host it still works from the file, for a run context made without the text', () => {
    const f = join(dir, 'opencode-mcp.json');
    writeFileSync(f, '{"mcp":{}}');
    const a = customAdapter({ id: 'OC', label: 'OC', executable: process.execPath, args: ['{prompt}'], env: { OPENCODE_CONFIG_CONTENT: '{mcpConfigJson:opencode}' } });
    const host = { token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', dir, claudeMcpConfig: 'x', toolConfigs: { opencode: f, gemini: 'g' } };
    expect(a.command({ prompt: 'p', cwd: dir, run: host }).env!['OPENCODE_CONFIG_CONTENT']).toBe('{"mcp":{}}');
    expect(missing).not.toBe(dir);
  });

  it('the real recipes build in a container too (the opencode one included)', () => {
    for (const id of ['CODEX', 'GEMINI_CLI', 'OPENCODE', 'CLAUDE_OLLAMA']) {
      const cfg = recipeById(id)!.config;
      expect(() => customAdapter({ ...cfg, executable: process.execPath }).command({ prompt: 'p', cwd: '/work', run: inContainer }), id).not.toThrow();
    }
  });

  it('the run context the dispatcher writes carries the same text that is in the file, and the container view keeps it', () => {
    const ctx = writeRunContext('amt_x', 'http://127.0.0.1:9/mcp');
    try {
      expect(ctx.opencodeConfigJson).toBe(readFileSync(ctx.toolConfigs!.opencode, 'utf8'));
      const view = containerView({ containerRunDir: '/agentmesh-run', containerCwd: '/work' } as never, ctx);
      expect(view.run.opencodeConfigJson).toBe(ctx.opencodeConfigJson);
      expect(view.run.toolConfigs!.opencode).toBe('/agentmesh-run/opencode-mcp.json');
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});

describe('a tool whose printed cost is not real money (a local model)', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.11, result: 'done', usage: { input_tokens: 15_000, output_tokens: 500, cache_read_input_tokens: 2_000 } };
  const adapterWith = (extra: Record<string, unknown>) => customAdapter({ id: 'LOCAL', label: 'Local', executable: process.execPath, args: ['{prompt}'], output: 'claude-stream-json', ...extra });
  const parsed = (extra: Record<string, unknown>) => {
    const spec = { prompt: 'p', cwd: process.cwd(), allowedTools: undefined, run: { claudeMcpConfig: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', dir: process.cwd() } } as never;
    return adapterWith(extra).command(spec).parse(result as never)[0] as { costUsd: number | null; usage: { inputTokens: number; outputTokens: number } | null };
  };

  it('keeps the printed cost by default, as for any other tool', () => {
    expect(parsed({}).costUsd).toBe(0.11);
  });

  it('drops the cost but keeps the tokens when reportsCost is false', () => {
    const r = parsed({ reportsCost: false });
    expect(r.costUsd).toBeNull();
    expect(r.usage).toMatchObject({ inputTokens: 15_000, outputTokens: 500 });
  });

  it('leaves every other event alone', () => {
    const spec = { prompt: 'p', cwd: process.cwd(), run: { claudeMcpConfig: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', dir: process.cwd() } } as never;
    const events = adapterWith({ reportsCost: false }).command(spec).parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as never);
    expect(events).toEqual([{ kind: 'text', text: 'hi' }]);
  });
});

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
