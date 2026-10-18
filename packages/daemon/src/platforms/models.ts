// Which model an agent runs on, and whether Claude Code may use sub-agents. Both are chosen per agent in the cockpit, kept in the
// project's configuration, and read each time the agent is started, so a change applies from its next run.
import { execFile } from 'node:child_process';
import { defaultAgyExecutable } from '../runner/commands.js';

/** The tools Claude Code starts a sub-agent with. Allowed only for an agent whose sub-agents were switched on. */
export const SUBAGENT_TOOLS = ['Task', 'Agent'] as const;

/** A model name as the tools take it (opus, claude-sonnet-5-5, opus[1m], gemini-3.8-flash-high, qwen3:8b): nothing a shell or a flag could be made of. */
export const isValidModel = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/.test(s) && !s.includes('..');

export interface AgentSettings {
  model?: string;
  subAgents?: boolean;
}

/** What the project's configuration says about one agent's model and sub-agents (nothing set is an empty object). */
export function agentSettingsOf(config: { agents: readonly { id: string; model?: string | undefined; subAgents?: boolean | undefined }[] }, agentId: string): AgentSettings {
  const a = config.agents.find((x) => x.id === agentId);
  return {
    ...(a?.model ? { model: a.model } : {}),
    ...(a?.subAgents ? { subAgents: true } : {}),
  };
}

/** Why these settings cannot be applied to an agent of this platform, in words a person can act on; null if they can. */
export function checkAgentSettings(platform: string, s: { model?: string | null | undefined; subAgents?: boolean | undefined }): string | null {
  const builtIn = platform === 'CLAUDE_CODE' || platform === 'ANTIGRAVITY';
  const model = (s.model ?? '').trim();
  if ((model || s.subAgents !== undefined) && !builtIn) return 'A tool you defined yourself takes its model and its options from its own definition (its arguments), so they are not set here.';
  if (model && !isValidModel(model)) return `"${model.slice(0, 40)}" is not a model name. Use letters, digits and . _ : / - only, for example opus or gemini-3.8-flash-high.`;
  if (s.subAgents === true && platform !== 'CLAUDE_CODE') return 'Antigravity decides for itself whether to use sub-agents (it needs its own settings to allow them); AgentMesh switches this for Claude Code only.';
  return null;
}

export interface ModelChoice {
  id: string;
  label: string;
}

/** The models `agy models` prints: a header line, then "id<TAB>name" per model. Lines that are not that, and ids that are not plain names, are left out. */
export function parseAgyModels(text: string): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [id, ...rest] = line.split('\t');
    const label = rest.join('\t').trim();
    if (id && label && isValidModel(id.trim())) out.push({ id: id.trim(), label });
  }
  return out;
}

type Run = (args: string[]) => Promise<{ ok: boolean; text: string }>;
const askAgy: Run = (args) =>
  new Promise((resolve) => {
    execFile(defaultAgyExecutable(), args, { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, text: err ? `${err.message} ${stderr}` : stdout }));
  });

/** The models to offer for a platform. Only asks a tool when asked (Antigravity: its own `agy models`). */
export async function listModels(platform: string, deps: { run?: Run } = {}): Promise<{ models: ModelChoice[]; note: string }> {
  if (platform === 'CLAUDE_CODE') {
    return {
      models: [
        { id: 'sonnet', label: 'Sonnet (the latest)' },
        { id: 'opus', label: 'Opus (the latest)' },
        { id: 'haiku', label: 'Haiku (the latest)' },
      ],
      note: 'These names always mean the latest of each. You can also type a full name, for example claude-sonnet-5-5.',
    };
  }
  if (platform === 'ANTIGRAVITY') {
    const r = await (deps.run ?? askAgy)(['models']);
    const models = r.ok ? parseAgyModels(r.text) : [];
    return { models, note: models.length ? 'As Antigravity lists them for your account.' : 'AgentMesh could not ask Antigravity which models it has. You can still type a model name.' };
  }
  return { models: [], note: 'A tool you defined yourself takes its model from its own definition (its arguments).' };
}
