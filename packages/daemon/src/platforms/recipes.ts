// Ready-made definitions for other agent tools, so adding one is a button instead of editing JSON.
//
// HONESTY NOTE: none of these has been run by AgentMesh's authors. They were written from each vendor's
// published documentation (October 2026), and every one is added as "not verified": only a passing
// `agentmesh doctor --test` (or the Test button) says whether it works on your computer. Where the
// documentation left something open, the recipe says so in `caveats` instead of pretending.
import { DEFAULT_CLAUDE_ALLOWED_TOOLS } from './builtin.js';
import type { CustomPlatformConfig } from './custom.js';

export interface Recipe {
  id: string;
  title: string;
  summary: string;
  /** Plain-language things to know before relying on it. */
  caveats: string[];
  /** How to get the tool, as one line (a command only where its package name was confirmed). */
  install: string;
  /** What the person must do once on their side. */
  signIn: string;
  /** Where the vendor documents what the recipe relies on. */
  docs: string[];
  /** Choices the person makes when adding it (for example which model). Without any, `config` is added as it is. */
  fields?: readonly RecipeField[];
  /** Makes the definition from the person's choices. `config` is this with the defaults, for tests and for recipes without choices. */
  build?: (values: Record<string, string>) => CustomPlatformConfig;
  /** The choices as they are set in a definition that was added, so the cockpit can show them and change them. */
  current?: (definition: CustomPlatformConfig) => Record<string, string>;
  config: CustomPlatformConfig;
}

export interface RecipeField {
  id: string;
  label: string;
  /** What to type, in plain words. Also the message when the value is refused. */
  hint: string;
  default: string;
  /** A regular expression (as text) the value must match. */
  pattern: string;
  /** A further test the pattern cannot make (a port above 65535 fits a pattern of digits). */
  check?: (value: string) => boolean;
  /** The cockpit can suggest values for this field from the computer itself. */
  suggest?: 'ollama-models';
}

export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeError';
  }
}

/** The definition to add, from what the person chose (blank means the default). Refuses a value that does not fit, in plain words. */
export function recipeConfig(recipe: Recipe, values: Record<string, string> = {}): CustomPlatformConfig {
  // A choice the recipe does not have is refused, not ignored: a misspelt "address" must not quietly mean "this computer".
  const known = (recipe.fields ?? []).map((f) => f.id);
  for (const key of Object.keys(values)) {
    if (!known.includes(key)) throw new RecipeError(`"${key}" is not something this recipe asks for. ${known.length ? `It asks for: ${known.join(', ')}.` : 'It has no choices to make.'}`);
  }
  if (!recipe.build) return recipe.config;
  const chosen: Record<string, string> = {};
  for (const f of recipe.fields ?? []) {
    const v = (Object.hasOwn(values, f.id) ? values[f.id]! : '').trim() || f.default;
    if (!new RegExp(f.pattern).test(v) || (f.check && !f.check(v))) throw new RecipeError(`${f.label}: ${f.hint}`);
    chosen[f.id] = v;
  }
  return recipe.build(chosen);
}

/** Whether the text is an http(s) address a program can use (the pattern of a field cannot tell: 99999 is five digits). */
export function usableAddress(address: string): boolean {
  try {
    const u = new URL(address);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether an address is this computer (written as 127.0.0.1, localhost, or the same address as one number). */
export function isThisComputer(address: string): boolean {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(address).hostname);
  } catch {
    return false;
  }
}

// Claude Code pointed at a local model through Ollama. Claude Code is run in its minimal mode with a short system prompt:
// started the usual way it loads the person's own plugins, hooks, memory and skill lists (tens of thousands of tokens), which
// a small model cannot see past (found by trying it: it answered something unrelated). The project's rulebook is still given
// to it, as a system-prompt file.
const LOCAL_SYSTEM_PROMPT = 'You are a coding agent working in a git repository. Do exactly what you are asked, using the tools you are given. Be brief.';
function claudeOnOllama(v: Record<string, string>): CustomPlatformConfig {
  const model = v['model']!;
  return {
    id: 'CLAUDE_OLLAMA',
    label: 'Claude Code on a local model (Ollama)',
    friendlyName: 'Local',
    rulebook: 'CLAUDE.md',
    executable: 'claude',
    args: ['-p', '{prompt}', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--model', model, '--bare', '--system-prompt', LOCAL_SYSTEM_PROMPT, '--append-system-prompt-file', 'CLAUDE.md', '--mcp-config', '{mcpConfigFile}', '--strict-mcp-config', '--allowedTools', ...DEFAULT_CLAUDE_ALLOWED_TOOLS],
    output: 'claude-stream-json',
    // Claude Code prices every run as if it were Claude; for a local model that is money nobody paid.
    reportsCost: false,
    env: {
      ANTHROPIC_BASE_URL: v['address']!,
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: 'ollama',
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    },
  };
}
const OLLAMA_FIELDS: readonly RecipeField[] = [
  { id: 'model', label: 'Model', hint: 'Type the name of a model you have pulled, as "ollama list" shows it (for example qwen3:8b).', default: '', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$', suggest: 'ollama-models' },
  { id: 'address', label: 'Ollama address', hint: 'Type where Ollama is listening, like http://127.0.0.1:11434 (no path at the end).', default: 'http://127.0.0.1:11434', pattern: '^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$', check: usableAddress },
];


export const RECIPES: readonly Recipe[] = [
  {
    id: 'CODEX',
    title: 'Codex CLI (OpenAI)',
    summary: 'Runs `codex exec` with the AgentMesh tools, allowed to edit files in its own workspace only.',
    caveats: [
      'Known problem reported by users: on some versions, Codex cancels MCP tool calls when run non-interactively (openai/codex issue 24135, open on 2026-10-14). If the test shows "user cancelled MCP tool call", this recipe will not work yet. Do NOT "fix" it with --yolo: that removes Codex\'s sandbox entirely.',
      'Codex does not document its exit codes; AgentMesh treats exit code 0 as success.',
      'For a local model, add "--oss", "--local-provider", "ollama" before "{prompt}" in the definition (documented by OpenAI); the quality of tool calling then depends on the model.',
    ],
    install: 'npm install -g @openai/codex',
    signIn: 'Run `codex` once in a terminal and sign in (or set your API key as Codex describes).',
    docs: ['https://developers.openai.com/codex/noninteractive', 'https://developers.openai.com/codex/mcp'],
    config: {
      id: 'CODEX',
      label: 'Codex CLI',
      friendlyName: 'Codex',
      rulebook: 'AGENTS.md',
      executable: 'codex',
      args: ['exec', '--sandbox', 'workspace-write', '-c', 'mcp_servers.agentmesh={url="{mcpUrl}",bearer_token_env_var="AGENTMESH_TOKEN",required=true,default_tools_approval_mode="approve"}', '{prompt}'],
      output: 'text',
    },
  },
  {
    id: 'GEMINI_CLI',
    title: 'Gemini CLI (Google)',
    summary: 'Runs `gemini -p` with the AgentMesh tools trusted and file edits auto-approved; shell commands stay denied.',
    caveats: [
      'This is NOT Antigravity. Google replaced Gemini CLI with Antigravity for most account types on 2026-06-18. If you sign in with a Google account, use the built-in Antigravity instead. Gemini CLI still works with a paid Gemini API key or an enterprise licence.',
      'The per-run settings file is given to Gemini CLI as its SYSTEM-level settings file for that run, which replaces any system-level settings you or your organization have set (Google documents that the system level ranks above user and project settings, which is what stops a repository from redirecting the connection). If your organization manages that file, check with them first.',
      'Not confirmed in the documentation: whether the per-run settings file merges with other system-level settings, and how an untrusted folder behaves in headless mode.',
    ],
    install: 'npm install -g @google/gemini-cli',
    signIn: 'Run `gemini` once and sign in, or set GEMINI_API_KEY as Google describes.',
    docs: ['https://geminicli.com/docs/cli/headless/', 'https://geminicli.com/docs/tools/mcp-server/', 'https://geminicli.com/docs/reference/configuration/'],
    config: {
      id: 'GEMINI_CLI',
      label: 'Gemini CLI',
      friendlyName: 'GeminiCLI',
      rulebook: 'GEMINI.md',
      executable: 'gemini',
      args: ['--approval-mode', 'auto_edit', '--allowed-mcp-server-names', 'agentmesh', '-p', '{prompt}'],
      env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '{mcpConfigFile:gemini}' },
      output: 'text',
    },
  },
  {
    id: 'OPENCODE',
    title: 'opencode',
    summary: 'Runs `opencode run`; works with many model providers, including local models. Shell commands are denied (AgentMesh commits and runs checks for the agent).',
    caveats: [
      'Not confirmed in the documentation: what opencode does for permissions marked "ask" when run without --auto, how MCP tools are treated by the permission list, and its exit codes. Test it before relying on it.',
      'For a local model (for example through Ollama), add "-m", "ollama/<model>" before "{prompt}" and define the provider in your own opencode configuration, as opencode\'s provider documentation describes. Raise the model\'s context size: tool calling needs about 16k to 32k.',
      'AgentMesh gives opencode its connection as inline configuration, which opencode documents as taking priority over a project\'s own opencode.json, so a repository cannot point the agent at another server. This ordering is from the documentation and has not been tested.',
      'opencode is also in the middle of a version change (a "v2" beta exists). The recipe targets the current documentation.',
    ],
    install: 'npm install -g opencode-ai   (the command from opencode\'s own documentation; other ways are listed at https://opencode.ai/docs/)',
    signIn: 'Configure a provider and model in opencode once (opencode auth, or its configuration file).',
    docs: ['https://opencode.ai/docs/cli/', 'https://opencode.ai/docs/mcp-servers/', 'https://opencode.ai/docs/permissions/'],
    config: {
      id: 'OPENCODE',
      label: 'opencode',
      friendlyName: 'opencode',
      rulebook: 'AGENTS.md',
      executable: 'opencode',
      args: ['run', '{prompt}'],
      env: {
        // Inline config has the highest priority (above a project's own opencode.json), so a repository cannot redirect the connection.
        OPENCODE_CONFIG_CONTENT: '{mcpConfigJson:opencode}',
        // No shell at all: AgentMesh commits and runs the project checks for the agent. (An allow-list such as "git status*" is a prefix
        // pattern that a chained command could match.)
        OPENCODE_PERMISSION: '{"bash":{"*":"deny"},"external_directory":"deny","doom_loop":"deny","webfetch":"deny","websearch":"deny"}',
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      },
      output: 'text',
    },
  },
  {
    id: 'CLAUDE_OLLAMA',
    title: 'Claude Code on a local model (Ollama)',
    summary: "Runs Claude Code against a model that Ollama serves, by default on your own computer, so nothing leaves your machine and no cost is counted. Choosing another address or a model marked cloud sends your project's text to that server instead.",
    caveats: [
      "Set Ollama's context length to at least 32,768 tokens first (the slider in Ollama's settings, or OLLAMA_CONTEXT_LENGTH=32768 when it starts). Below 24 GB of video memory Ollama's default is only 4,096: the agent is then given a cut-off prompt and fails, in odd ways (it answers something unrelated, or never stops writing). Ollama recommends 64,000 or more for agents; a model has its own maximum.",
      "How far it got when tried (Windows 11, a 12 GB graphics card, Ollama 0.33.1, Claude Code 2.1.246): with the context set to 32,768, gemma4:e2b wrote a plan and split a tiny mission in under half a minute each, but its first task changed nothing (an empty \"create a folder\" task) and it passed the connection test in 4 of 6 tries; qwen3:8b got stuck calling one tool over and over, which AgentMesh's stuck-loop protection stopped. Neither was taken through a whole mission. Expect a small model to plan simply and build weakly; larger tool-calling models were not tried.",
      'It runs Claude Code in its minimal mode (--bare) with a short system prompt, because a small model gets lost in Claude Code\'s usual instructions and in your own plugins, hooks and memory. The project rulebook is still given to it.',
      'The dollar cost Claude Code prints is made up (it prices the run as Claude), so it is ignored: a dollar limit on a mission cannot see these runs. Tokens are counted, so a token limit works.',
      'It counts as its own platform for the two-platform rule: Claude or Gemini can review its work and it can review theirs. A small local model reviewing a strong model\'s work is a weak review.',
      "Only Ollama on this computer keeps everything on this computer. A model marked cloud runs on Ollama's servers, and an address that is not this computer is another machine: either way what Claude Code reads in your project (files, plans, reviews) is sent there. The card warns you when you pick one, and the timeline records the address.",
    ],
    install: 'Install Ollama (https://ollama.com) and Claude Code, then run: ollama pull <model>',
    signIn: 'No sign-in is needed for Ollama on your own computer, and Claude Code needs none for these runs.',
    docs: ['https://docs.ollama.com/integrations/claude-code', 'https://docs.ollama.com/context-length'],
    fields: OLLAMA_FIELDS,
    build: claudeOnOllama,
    current: (c) => {
      const at = (c.args ?? []).indexOf('--model');
      return { model: (at >= 0 ? c.args[at + 1] : undefined) ?? '', address: c.env?.['ANTHROPIC_BASE_URL'] ?? '' };
    },
    config: claudeOnOllama({ model: 'your-model', address: 'http://127.0.0.1:11434' }),
  },
];

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
