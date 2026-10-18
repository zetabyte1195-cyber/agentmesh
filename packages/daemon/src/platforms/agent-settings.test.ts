// Choosing the model an agent runs on, and letting Claude Code use sub-agents: what reaches each tool's command line, and how
// the list of models is found.
import { describe, expect, it } from 'vitest';
import { antigravityAdapter, claudeAdapter } from './builtin.js';
import { SUBAGENT_TOOLS, agentSettingsOf, checkAgentSettings, isValidModel, listModels, parseAgyModels } from './models.js';
import { createRegistry, launcher } from './registry.js';
import type { PlatformRunContext } from './types.js';

const run: PlatformRunContext = { token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', dir: process.cwd(), claudeMcpConfig: 'mcp.json' };
const spec = (o: Record<string, unknown> = {}) => ({ prompt: 'p', cwd: process.cwd(), run, ...o });
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('Claude Code', () => {
  it('uses its own default model unless one was chosen', () => {
    expect(claudeAdapter.command(spec()).args).not.toContain('--model');
    expect(after(claudeAdapter.command(spec({ model: 'opus' })).args, '--model')).toBe('opus');
  });

  it('may use sub-agents only when that was switched on, and then only the tools that start them', () => {
    const tools = (o: Record<string, unknown>) => claudeAdapter.command(spec(o)).args.slice(claudeAdapter.command(spec(o)).args.indexOf('--allowedTools') + 1);
    for (const t of SUBAGENT_TOOLS) expect(tools({}), t).not.toContain(t);
    for (const t of SUBAGENT_TOOLS) expect(tools({ subAgents: true }), t).toContain(t);
    expect(tools({ subAgents: true })).toContain('mcp__agentmesh'); // the rest of the allow-list is still there
    expect(tools({ subAgents: true, allowedTools: ['mcp__agentmesh'] })).toEqual(['mcp__agentmesh', ...SUBAGENT_TOOLS]);
  });

  it('never gets the bypass-everything flag from any of this', () => {
    expect(claudeAdapter.command(spec({ model: 'opus', subAgents: true })).args.join(' ')).not.toMatch(/dangerously|bypass/i);
  });
});

describe('Antigravity', () => {
  it('uses its own default model unless one was chosen, and gets the one chosen as written', () => {
    expect(antigravityAdapter.command(spec()).args).not.toContain('--model');
    expect(after(antigravityAdapter.command(spec({ model: 'gemini-3.8-flash-high' })).args, '--model')).toBe('gemini-3.8-flash-high');
  });

  it('is not given sub-agent tools by AgentMesh (it decides itself, and needs its own settings to allow them)', () => {
    expect(antigravityAdapter.command(spec({ subAgents: true })).args.join(' ')).not.toMatch(/subagent|Task/i);
  });
});

describe('a model name', () => {
  it('is a plain name: a letter or digit first, then letters, digits and . _ : / - [ ], at most 100', () => {
    for (const ok of ['opus', 'sonnet', 'claude-sonnet-5-5', 'opus[1m]', 'gemini-3.8-flash-high', 'qwen3:8b', 'org/model.v2']) expect(isValidModel(ok), ok).toBe(true);
    for (const bad of ['', ' ', '--help', '-x', 'a b', 'x;y', '$(x)', 'a\nb', 'x'.repeat(101), '..', '{prompt}']) expect(isValidModel(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('the settings of an agent in the project\'s configuration', () => {
  const cfg = { agents: [{ id: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'CLAUDE.md', model: 'opus', subAgents: true }, { id: 'gemini-1', platform: 'ANTIGRAVITY', rulebook: 'GEMINI.md' }] };
  it('reads what is set, and nothing for an agent with nothing set or one that does not exist', () => {
    expect(agentSettingsOf(cfg, 'claude-1')).toEqual({ model: 'opus', subAgents: true });
    expect(agentSettingsOf(cfg, 'gemini-1')).toEqual({});
    expect(agentSettingsOf(cfg, 'nobody')).toEqual({});
  });
  it('is read each time an agent is started, so a change applies from its next run', () => {
    const live = { agents: [{ id: 'claude-1', platform: 'CLAUDE_CODE', rulebook: 'CLAUDE.md' } as { id: string; platform: string; rulebook: string; model?: string }] };
    const registry = createRegistry();
    const start = launcher(registry, 'CLAUDE_CODE', undefined, () => agentSettingsOf(live, 'claude-1'));
    expect(start('p', process.cwd(), run).args).not.toContain('--model');
    live.agents[0]!.model = 'haiku';
    expect(after(start('p', process.cwd(), run).args, '--model')).toBe('haiku');
  });
});

describe('the list of models', () => {
  // What `agy models` printed on a real install.
  const REAL = 'Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';

  it('is read from what agy prints: an id and a name on each line, and nothing else', () => {
    expect(parseAgyModels(REAL)).toEqual([
      { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ]);
    expect(parseAgyModels('')).toEqual([]);
    expect(parseAgyModels('some warning\nanother line with spaces only\n')).toEqual([]);
    expect(parseAgyModels('--bad\tName\nok-id\tFine\n')).toEqual([{ id: 'ok-id', label: 'Fine' }]); // an id that is not a plain model name is left out
  });

  it('for Claude Code is the aliases it accepts, which always mean its latest of each', async () => {
    const r = await listModels('CLAUDE_CODE');
    expect(r.models.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(r.note).toMatch(/full name/);
  });

  it('for Antigravity is asked of agy itself, only when asked', async () => {
    const asked: string[][] = [];
    const run = async (args: string[]) => (asked.push(args), { ok: true, text: REAL });
    const r = await listModels('ANTIGRAVITY', { run });
    expect(r.models).toHaveLength(3);
    expect(asked).toEqual([['models']]);
  });

  it('says so, and offers no list, when agy cannot be asked', async () => {
    const r = await listModels('ANTIGRAVITY', { run: async () => ({ ok: false, text: 'spawn agy ENOENT' }) });
    expect(r.models).toEqual([]);
    expect(r.note).toMatch(/could not ask Antigravity/i);
  });

  it('has nothing to offer for a tool defined by hand, whose model is in its own definition', async () => {
    const r = await listModels('MY_TOOL');
    expect(r.models).toEqual([]);
    expect(r.note).toMatch(/own definition/);
  });
});

describe('what may be set on which agent', () => {
  it('lets the model be chosen for Claude Code and Antigravity, and sub-agents for Claude Code only', () => {
    expect(checkAgentSettings('CLAUDE_CODE', { model: 'opus', subAgents: true })).toBeNull();
    expect(checkAgentSettings('ANTIGRAVITY', { model: 'gemini-3.8-flash-high' })).toBeNull();
    expect(checkAgentSettings('ANTIGRAVITY', { subAgents: false })).toBeNull();
    expect(checkAgentSettings('ANTIGRAVITY', { subAgents: true })).toMatch(/Antigravity decides for itself/);
  });
  it('refuses a model that is not a plain name, in words a person can act on, and says a tool defined by hand has its own', () => {
    expect(checkAgentSettings('CLAUDE_CODE', { model: '--help' })).toMatch(/not a model name/);
    expect(checkAgentSettings('CLAUDE_CODE', { model: 'a b' })).toMatch(/not a model name/);
    expect(checkAgentSettings('MY_TOOL', { model: 'x' })).toMatch(/own definition/);
    expect(checkAgentSettings('MY_TOOL', { subAgents: true })).toMatch(/own definition/);
    expect(checkAgentSettings('MY_TOOL', {})).toBeNull(); // nothing asked, nothing refused
  });
  it('lets a model be cleared (null or blank)', () => {
    expect(checkAgentSettings('CLAUDE_CODE', { model: null })).toBeNull();
    expect(checkAgentSettings('CLAUDE_CODE', { model: '  ' })).toBeNull();
  });
});
