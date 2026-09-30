// A platform is an agent CLI AgentMesh can run headlessly (Claude Code, Antigravity, or one the
// user defines in .agentmesh/config.json). Everything platform-specific lives behind this interface:
// how to find it, how to launch it for one run, how to read its output, and how to check it is set up.
import type { AgentCommand } from '../runner/commands.js';

/** What the dispatcher hands over for one run (structurally the dispatcher's RunContext). */
export interface PlatformRunContext {
  token: string;
  mcpUrl: string;
  /** Temp folder holding this run's MCP config files, outside the repository. */
  dir: string;
  /** Claude-format MCP config file ({mcpServers:{agentmesh:{type:'http',url,headers}}}). */
  claudeMcpConfig: string;
}

export interface LaunchSpec {
  prompt: string;
  /** The agent's working directory: a task worktree, or a scratch checkout for planning runs. */
  cwd: string;
  run: PlatformRunContext;
  allowedTools?: readonly string[];
}

export interface Detection {
  installed: boolean;
  version?: string;
  /** The file that will be launched. */
  resolved?: string;
  problem?: string;
}

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface Diagnosis {
  level: CheckLevel;
  title: string;
  detail: string;
  /** How to fix it, as a command or a config line. */
  fix?: string;
}

export interface PlatformAdapter {
  /** The value used for `platform` in config and the database, e.g. CLAUDE_CODE. */
  id: string;
  /** Shown to people: "Claude Code". */
  label: string;
  /** Used in task ownership ("Claude") and default agent names. */
  friendlyName: string;
  /** The instruction file the tool reads on its own (CLAUDE.md, GEMINI.md, AGENTS.md...). */
  rulebook: string;
  /** True only for platforms whose headless flags, output and MCP wiring were run and checked here. */
  verified: boolean;
  /** One line for people choosing a platform. */
  summary: string;
  detect(): Promise<Detection>;
  /** Platform-specific setup checks beyond "is it installed". */
  diagnose?(): Promise<Diagnosis[]>;
  command(spec: LaunchSpec): AgentCommand;
}
