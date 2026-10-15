// Task 10: recipes for other agent tools. None of them is run against the real tool here (they are
// unverified by design); these tests prove the definitions are valid and that AgentMesh builds from them
// the commands and per-run files the vendors' documentation asks for.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeRunContext } from '../dispatch/dispatcher.js';
import { platformInstaller } from '../doctor/install.js';
import { CustomPlatformSchema, customAdapter } from './custom.js';
import { RECIPES, recipeById } from './recipes.js';
import { createRegistry } from './registry.js';

const URL = 'http://127.0.0.1:8934/mcp';
const TOKEN = 'amt_secret-token-for-this-run';

/** The recipe with its executable swapped for node, so the command can be built on a machine without the tool. */
const built = (id: string) => {
  const ctx = writeRunContext(TOKEN, URL);
  const adapter = customAdapter({ ...recipeById(id)!.config, executable: process.execPath, versionArgs: ['--version'] });
  const cmd = adapter.command({ prompt: 'Do the thing', cwd: process.cwd(), run: ctx });
  return { ctx, cmd, done: () => rmSync(ctx.dir, { recursive: true, force: true }) };
};

describe('the recipes are valid definitions', () => {
  it('each parses against the same schema as a hand-written one, is not a reserved name, and is shown as unverified', () => {
    expect(RECIPES.map((r) => r.id)).toEqual(['CODEX', 'GEMINI_CLI', 'OPENCODE']);
    for (const r of RECIPES) {
      expect(() => CustomPlatformSchema.parse(r.config), r.id).not.toThrow();
      expect(r.config.id).toBe(r.id);
      expect(r.caveats.length, r.id).toBeGreaterThan(0);
      expect(r.docs.every((d) => d.startsWith('https://')), r.id).toBe(true);
      expect(customAdapter(r.config).verified, r.id).toBe(false);
      expect(r.config.args.some((a) => a.includes('{prompt}')), r.id).toBe(true);
    }
  });

  it('never uses the flags that remove a tool\'s safety (yolo, dangerous bypass, full access)', () => {
    const all = JSON.stringify(RECIPES.map((r) => r.config)).toLowerCase();
    for (const bad of ['--yolo', 'dangerously', 'danger-full-access', 'bypass', '--auto"']) expect(all, bad).not.toContain(bad);
  });

  it('is honest where the documentation left something open, and does not claim the Gemini CLI is Antigravity', () => {
    const text = (id: string) => recipeById(id)!.caveats.join(' ');
    expect(text('CODEX')).toContain('issue 24135');
    expect(text('GEMINI_CLI')).toContain('NOT Antigravity');
    expect(text('OPENCODE')).toContain('Not confirmed');
    expect(text('OPENCODE')).toContain('has not been tested');
    expect(text('GEMINI_CLI')).toContain('replaces any system-level settings');
  });
});

describe('what AgentMesh builds from them', () => {
  it('Codex: the MCP server and its token variable go on the command line; the token itself never does', () => {
    const { cmd, ctx, done } = built('CODEX');
    const line = cmd.args.join(' ');
    expect(cmd.args.slice(-1)).toEqual(['Do the thing']);
    expect(line).toContain(`mcp_servers.agentmesh={url="${URL}",bearer_token_env_var="AGENTMESH_TOKEN",required=true,default_tools_approval_mode="approve"}`);
    expect(line).toContain('--sandbox workspace-write');
    expect(line).not.toContain(TOKEN);
    expect(cmd.textOutput).toBe(true);
    expect(cmd.env).toMatchObject({ AGENTMESH_MCP_URL: URL });
    expect(ctx.token).toBe(TOKEN);
    done();
  });

  it('Gemini CLI: points its system settings at a per-run file holding the connection, and trusts only the agentmesh server', () => {
    const { cmd, ctx, done } = built('GEMINI_CLI');
    expect(cmd.env!.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(ctx.toolConfigs!.gemini);
    expect(cmd.args).toEqual(expect.arrayContaining(['--approval-mode', 'auto_edit', '--allowed-mcp-server-names', 'agentmesh', '-p', 'Do the thing']));
    expect(JSON.parse(readFileSync(ctx.toolConfigs!.gemini, 'utf8'))).toEqual({ mcpServers: { agentmesh: { httpUrl: URL, headers: { Authorization: `Bearer ${TOKEN}` }, trust: true } } });
    expect(cmd.args.join(' ')).not.toContain(TOKEN);
    done();
  });

  it('opencode: the connection is INLINE config (it outranks a project\'s own file); shell is denied outright, with no prefix allow-list to chain commands past', () => {
    const { cmd, ctx, done } = built('OPENCODE');
    expect(cmd.args).toEqual(['run', 'Do the thing']);
    expect(cmd.env!.OPENCODE_CONFIG).toBeUndefined(); // the file form ranks BELOW a project's opencode.json: not used
    expect(JSON.parse(cmd.env!.OPENCODE_CONFIG_CONTENT!)).toEqual({ mcp: { agentmesh: { type: 'remote', url: URL, enabled: true, oauth: false, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    expect(cmd.env!.OPENCODE_CONFIG_CONTENT).toBe(readFileSync(ctx.toolConfigs!.opencode, 'utf8'));
    const permission = JSON.parse(cmd.env!.OPENCODE_PERMISSION!);
    expect(permission).toEqual({ bash: { '*': 'deny' }, external_directory: 'deny', doom_loop: 'deny', webfetch: 'deny', websearch: 'deny' });
    expect(JSON.stringify(permission)).not.toContain('allow');
    expect(cmd.args.join(' ')).not.toContain(TOKEN); // the token is in the child's environment only, never on a command line
    done();
  });

  it('leaves unknown braces alone, so JSON and TOML inside an argument survive', () => {
    const adapter = customAdapter({ id: 'BRACES', label: 'Braces', executable: process.execPath, args: ['-c', 'x={a="{mcpUrl}",b={c=1}}', '{prompt}'] });
    const ctx = writeRunContext(TOKEN, URL);
    expect(adapter.command({ prompt: 'p', cwd: '.', run: ctx }).args.slice(-2)).toEqual([`x={a="${URL}",b={c=1}}`, 'p']);
    rmSync(ctx.dir, { recursive: true, force: true });
  });
});

describe('the per-run files', () => {
  it('are written next to the Claude and agy ones in the run folder, outside any repository', () => {
    const ctx = writeRunContext(TOKEN, URL);
    expect(readdirSync(ctx.dir).sort()).toEqual(['.agents', 'claude-mcp.json', 'gemini-settings.json', 'opencode-mcp.json']);
    expect(existsSync(join(ctx.dir, '.agents', 'mcp_config.json'))).toBe(true);
    expect(ctx.dir.startsWith(process.cwd())).toBe(false);
    rmSync(ctx.dir, { recursive: true, force: true });
  });
});

describe('registry and installers', () => {
  it('adds a recipe while running, refuses it twice, and refuses a reserved name', () => {
    const reg = createRegistry();
    expect(reg.has('CODEX')).toBe(false);
    expect(reg.add(recipeById('CODEX')!.config).label).toBe('Codex CLI');
    expect(reg.has('CODEX')).toBe(true);
    expect(() => reg.add(recipeById('CODEX')!.config)).toThrow(/defined twice/);
    expect(() => reg.add({ id: 'CLAUDE_CODE', label: 'x', executable: 'x', args: ['{prompt}'] })).toThrow(/reserved/);
    expect(reg.list().map((p) => p.id)).toEqual(['CLAUDE_CODE', 'ANTIGRAVITY', 'CODEX']);
  });

  it('doctor --install knows the npm package for each (names checked on the registry; opencode also in its own docs)', () => {
    expect(platformInstaller('CODEX', 'linux')).toMatchObject({ display: 'npm install -g @openai/codex', binary: 'codex' });
    expect(platformInstaller('GEMINI_CLI', 'darwin')).toMatchObject({ display: 'npm install -g @google/gemini-cli', binary: 'gemini' });
    expect(platformInstaller('OPENCODE', 'win32')).toMatchObject({ display: 'npm install -g opencode-ai', binary: 'opencode', shell: true });
    expect(platformInstaller('SOMETHING_ELSE')).toBeNull();
  });
});
