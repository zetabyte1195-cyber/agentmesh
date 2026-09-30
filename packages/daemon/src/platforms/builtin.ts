// The two platforms whose headless mode, output format and MCP wiring have been run and checked
// on a real install (board findings P2.2, P2.7, live runs #1-#6).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { agyCommand, claudeCommand, defaultAgyExecutable } from '../runner/commands.js';
import { probeVersion } from './resolve.js';
import type { Diagnosis, PlatformAdapter } from './types.js';

/** Default Claude allowlist for headless runs: read state, run tests, use AgentMesh tools. Wildcards per `claude --help`. */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  'mcp__agentmesh',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(npm test*)',
  'Bash(npm run *)',
  // A new project has no project check yet, so agents must be able to run the test runners themselves
  // (found in the first live mission: Claude refused to submit code it could not test).
  'Bash(node --test*)',
  'Bash(npx vitest*)',
  'Bash(npx jest*)',
  'Bash(pytest*)',
  'Bash(python -m pytest*)',
  'Bash(python3 -m pytest*)',
  'Bash(go test*)',
  'Bash(cargo test*)',
  'Bash(dotnet test*)',
  'Bash(mvn test*)',
  'Bash(make test*)',
];

/** The one allow rule headless Antigravity needs: without it every AgentMesh tool call is refused and the run ends. */
export const AGY_MCP_RULE = 'mcp(agentmesh/*)';

export function agySettingsPath(home = homedir()): string {
  return join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

interface AgySettings {
  permissions?: { allow?: string[] };
  [key: string]: unknown;
}

function readAgySettings(path: string): AgySettings | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgySettings;
  } catch {
    return null;
  }
}

/**
 * Add the AgentMesh MCP allow rule to the user's Antigravity settings, keeping a backup and every other
 * setting. Only ever called on an explicit request (`agentmesh doctor --fix`, the cockpit button).
 */
export function ensureAgyMcpRule(path = agySettingsPath()): { changed: boolean; backup?: string } {
  const existed = existsSync(path);
  const settings = readAgySettings(path);
  if (existed && !settings) throw new Error(`${path} is not valid JSON; fix it by hand, AgentMesh will not overwrite it`);
  const next: AgySettings = settings ?? {};
  const allow = next.permissions?.allow ?? [];
  if (allow.includes(AGY_MCP_RULE)) return { changed: false };
  next.permissions = { ...next.permissions, allow: [...allow, AGY_MCP_RULE] };
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existed) {
    backup = `${path}.agentmesh-backup`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, ...(backup ? { backup } : {}) };
}

export const claudeAdapter: PlatformAdapter = {
  id: 'CLAUDE_CODE',
  label: 'Claude Code',
  friendlyName: 'Claude',
  rulebook: 'CLAUDE.md',
  verified: true,
  summary: 'Anthropic Claude Code CLI (`claude -p`). Sign in once with `claude`.',
  detect: () => probeVersion('claude', ['--version']),
  command: (spec) =>
    claudeCommand({ prompt: spec.prompt, worktree: spec.cwd, mcpConfigFile: spec.run.claudeMcpConfig, allowedTools: spec.allowedTools ?? DEFAULT_CLAUDE_ALLOWED_TOOLS }),
};

export const antigravityAdapter: PlatformAdapter = {
  id: 'ANTIGRAVITY',
  label: 'Antigravity (Gemini)',
  friendlyName: 'Gemini',
  rulebook: 'GEMINI.md',
  verified: true,
  summary: 'Google Antigravity CLI (`agy -p`). Sign in once with `agy`; AgentMesh needs one allow rule.',
  detect: () => probeVersion(defaultAgyExecutable(), ['--version']),
  diagnose: async (): Promise<Diagnosis[]> => {
    const path = agySettingsPath();
    const settings = readAgySettings(path);
    const rules = settings?.permissions?.allow ?? [];
    if (rules.includes(AGY_MCP_RULE)) {
      return [{ level: 'ok', title: 'Antigravity may use AgentMesh tools', detail: `${AGY_MCP_RULE} is allowed in ${path}` }];
    }
    return [
      {
        level: 'fail',
        title: 'Antigravity is not allowed to use AgentMesh tools',
        detail: `Headless runs cannot ask permission, so every AgentMesh tool call would be refused and the run would end. ${settings ? '' : `(${path} was not found or is not valid JSON.) `}The rule to add is "${AGY_MCP_RULE}" under permissions.allow.`,
        fix: 'agentmesh doctor --fix',
      },
    ];
  },
  command: (spec) => agyCommand({ prompt: spec.prompt, worktree: spec.cwd, extraDirs: [spec.run.dir] }),
};
