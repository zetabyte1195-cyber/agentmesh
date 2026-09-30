// How each headless agent CLI is launched (spec v1.1 §10.2). Flags here are verified against
// the installed CLIs (board findings on P2.2); permission-bypass flags are never emitted.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type RunnerEvent, parseAgyEvent, parseClaudeEvent } from './events.js';

/** A platform id: the two built-ins, or one defined in .agentmesh/config.json (platforms/custom.ts). */
export type RunnerPlatform = string;

export interface AgentCommand {
  platform: RunnerPlatform;
  executable: string;
  args: string[];
  parse: (event: Record<string, unknown>) => RunnerEvent[];
  /** Extra environment for this command (custom platforms: AGENTMESH_MCP_URL and their own). */
  env?: Record<string, string>;
  /**
   * The tool prints plain text, not a JSON stream: exit code 0 means success and the collected
   * stdout is the result. Used by config-defined platforms.
   */
  textOutput?: boolean;
}

/**
 * Windows caps a command line at 32,767 characters. Prompts should be short anyway: they point
 * the agent at its rulebook and the board, which hold the context (spec v1.1 §10.2).
 */
export const MAX_PROMPT_LENGTH = 8_000;

export interface CommandOptions {
  prompt: string;
  /** The task's worktree: the agent's cwd and its only granted workspace. */
  worktree: string;
  /** Override the executable (tests, custom installs). */
  executable?: string;
  model?: string;
  /** Claude: a per-run MCP config file (holds the run's token); used with --strict-mcp-config so only AgentMesh is loaded. */
  mcpConfigFile?: string;
  /** Claude: tool allowlist, e.g. ["Bash(git add *)", "Bash(git commit *)"] (wildcards supported, per `claude --help`). */
  allowedTools?: readonly string[];
  /** agy: extra workspace folders. agy reads .agents/mcp_config.json from any of them (verified live, P2.7). */
  extraDirs?: readonly string[];
}

function checkPrompt(prompt: string): void {
  if (!prompt.trim()) throw new Error('Prompt is empty');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt is ${prompt.length} chars; the limit is ${MAX_PROMPT_LENGTH}`);
}

/**
 * Claude Code. stream-json requires --verbose in print mode (verified). acceptEdits lets it
 * edit files in its worktree; commands stay governed by the project's .claude/settings.json.
 */
export function claudeCommand(options: CommandOptions): AgentCommand {
  checkPrompt(options.prompt);
  const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
  if (options.model) args.push('--model', options.model);
  if (options.mcpConfigFile) args.push('--mcp-config', options.mcpConfigFile, '--strict-mcp-config');
  if (options.allowedTools?.length) args.push('--allowedTools', ...options.allowedTools);
  return { platform: 'CLAUDE_CODE', executable: options.executable ?? 'claude', args, parse: parseClaudeEvent };
}

/** Where the Antigravity installer puts agy. It isn't on PATH by default (verified on this machine). */
export function defaultAgyExecutable(): string {
  const candidate = join(homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  return existsSync(candidate) ? candidate : 'agy';
}

/**
 * Gemini via Antigravity. Headless agy auto-denies any tool without an exact allow rule in
 * ~/.gemini/antigravity-cli/settings.json, and a denial ends the run (verified).
 */
export function agyCommand(options: CommandOptions): AgentCommand {
  checkPrompt(options.prompt);
  const args = ['-p', options.prompt, '--add-dir', options.worktree, '--output-format', 'stream-json', '--mode', 'accept-edits'];
  if (options.model) args.push('--model', options.model);
  for (const dir of options.extraDirs ?? []) args.push('--add-dir', dir);
  return { platform: 'ANTIGRAVITY', executable: options.executable ?? defaultAgyExecutable(), args, parse: parseAgyEvent };
}
