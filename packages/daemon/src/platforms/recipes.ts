// Ready-made definitions for other agent tools, so adding one is a button instead of editing JSON.
//
// HONESTY NOTE: none of these has been run by AgentMesh's authors. They were written from each vendor's
// published documentation (October 2026), and every one is added as "not verified": only a passing
// `agentmesh doctor --test` (or the Test button) says whether it works on your computer. Where the
// documentation left something open, the recipe says so in `caveats` instead of pretending.
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
  config: CustomPlatformConfig;
}

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
];

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
