// Platforms defined in .agentmesh/config.json, so adding a tool is configuration, not code.
//
//   "customPlatforms": [{
//     "id": "CODEX", "label": "Codex CLI", "friendlyName": "Codex", "rulebook": "AGENTS.md",
//     "executable": "codex", "args": ["exec", "{prompt}"], "output": "text"
//   }]
//
// The tool must (1) run non-interactively from one command line, (2) exit 0 on success, and
// (3) be able to call MCP tools over HTTP: either by taking a Claude-format MCP config file
// ({mcpConfigFile}) or by reading AGENTMESH_MCP_URL / AGENTMESH_TOKEN from its environment.
// Such platforms are reported as UNVERIFIED until `agentmesh doctor --test` has passed for them.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentCommand } from '../runner/commands.js';
import { type RunnerEvent, parseAgyEvent, parseClaudeEvent } from '../runner/events.js';
import { probeVersion, resolveExecutable } from './resolve.js';
import type { LaunchSpec, PlatformAdapter } from './types.js';

export const RESERVED_PLATFORM_IDS = ['CLAUDE_CODE', 'ANTIGRAVITY', 'HUMAN'] as const;

export const CustomPlatformSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'id must be UPPER_SNAKE_CASE, 2-32 characters'),
    label: z.string().min(1).max(60),
    friendlyName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/, 'friendlyName: letters, digits, _ or -').optional(),
    rulebook: z.string().regex(/^[A-Za-z0-9._-]+\.md$/, 'rulebook must be a .md file name').optional(),
    executable: z.string().min(1).max(500),
    args: z.array(z.string().max(2000)).max(50),
    output: z.enum(['text', 'claude-stream-json', 'agy-stream-json']).default('text'),
    versionArgs: z.array(z.string().max(200)).max(10).default(['--version']),
    env: z.record(z.string(), z.string().max(2000)).optional(),
    // Set to false for a tool whose printed cost is not real money. Claude Code prices every run as if it were Claude, so
    // pointed at a local model (Ollama) it reports dollars nobody paid. The cost is then dropped (tokens are kept), so it
    // never counts toward a mission's dollar limit or the cockpit's totals.
    reportsCost: z.boolean().optional(),
  })
  .strict()
  .refine((p) => p.args.some((a) => a.includes('{prompt}')), { message: 'args must contain {prompt} (where the instruction goes)', path: ['args'] })
  .refine((p) => !(RESERVED_PLATFORM_IDS as readonly string[]).includes(p.id), { message: 'id is reserved for a built-in platform', path: ['id'] });

export type CustomPlatformConfig = z.input<typeof CustomPlatformSchema>;

// {mcpConfigFile} is the Claude-format file; {mcpConfigFile:opencode} and {mcpConfigFile:gemini} are the same connection in those tools' own formats.
// {mcpConfigJson:opencode} is the same opencode connection as JSON TEXT, for a tool's inline-config environment variable (it ranks above a project's own file).
const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(prompt|cwd|mcpConfigFile(?::opencode|:gemini)?|mcpConfigJson:opencode|mcpUrl|runDir)\}/g, (_m, k: string) => values[k] ?? '');

export function customAdapter(input: CustomPlatformConfig): PlatformAdapter {
  const config = CustomPlatformSchema.parse(input);
  const parseOutput = config.output === 'claude-stream-json' ? parseClaudeEvent : config.output === 'agy-stream-json' ? parseAgyEvent : () => [];
  const parse = config.reportsCost === false ? (e: Record<string, unknown>): RunnerEvent[] => parseOutput(e).map((ev) => (ev.kind === 'result' ? { ...ev, costUsd: null } : ev)) : parseOutput;
  return {
    id: config.id,
    label: config.label,
    friendlyName: config.friendlyName ?? (config.label.split(/\s+/)[0]!.replace(/[^A-Za-z0-9_-]/g, '') || config.id),
    rulebook: config.rulebook ?? 'AGENTS.md',
    verified: false,
    loopProtection: config.output === 'claude-stream-json',
    summary: `${config.label}: defined in your config, not verified by AgentMesh. Run \`agentmesh doctor --test\` to check it.`,
    detect: () => probeVersion(config.executable, config.versionArgs),
    command: (spec: LaunchSpec): AgentCommand => {
      // Inside a container the tool is whatever the image provides: it is not looked for on this computer.
      const resolved = spec.run.inContainer ? { file: config.executable, prefixArgs: [] as string[] } : resolveExecutable(config.executable);
      if (!resolved) throw new Error(`${config.label} is not installed: "${config.executable}" was not found on PATH`);
      if ('unsupported' in resolved) throw new Error(`${config.label}: ${resolved.unsupported}`);
      const values: Record<string, string> = { prompt: spec.prompt, cwd: spec.cwd, mcpConfigFile: spec.run.claudeMcpConfig, mcpUrl: spec.run.mcpUrl, runDir: spec.run.dir };
      if (spec.run.toolConfigs) {
        values['mcpConfigFile:opencode'] = spec.run.toolConfigs.opencode;
        values['mcpConfigFile:gemini'] = spec.run.toolConfigs.gemini;
      }
      // Only a tool that asks for the inline text gets it. The file is read on this computer; inside a container its path is the
      // container's, so the text the run folder was made with is used instead.
      if (spec.run.toolConfigs && [...config.args, ...Object.values(config.env ?? {})].some((t) => t.includes('{mcpConfigJson:opencode}'))) {
        values['mcpConfigJson:opencode'] = spec.run.opencodeConfigJson ?? readFileSync(spec.run.toolConfigs.opencode, 'utf8');
      }
      const env: Record<string, string> = { AGENTMESH_MCP_URL: spec.run.mcpUrl };
      for (const [k, v] of Object.entries(config.env ?? {})) env[k] = fill(v, values);
      return {
        platform: config.id,
        executable: resolved.file,
        args: [...resolved.prefixArgs, ...config.args.map((a) => fill(a, values))],
        parse,
        env,
        textOutput: config.output === 'text',
      };
    },
  };
}
