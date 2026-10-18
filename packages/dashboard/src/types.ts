// Shapes the daemon sends in GET /api/state that more than one screen uses.
export type Run = {
  id: string;
  agentId: string;
  kind: string;
  /** A task id, or "mission:<id>". */
  subject: string | null;
  subjectTitle: string | null;
  status: string;
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
  seconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Only for the newest finished run per agent and subject. */
  outcome: 'moved' | 'no-change' | null;
};

/** A mission's spending limit and what it has used (null on the mission when it has no limit). */
export type MissionBudget = { maxCostUsd: number | null; maxTokens: number | null; usedCostUsd: number | null; usedTokens: number; reached: string | null };

export type Notice = { key: string; kind: 'plan' | 'question' | 'stuck' | 'done' | 'budget'; urgent: boolean; title: string; text: string; missionId?: string; taskId?: string; questionId?: string; agentId?: string; subject?: string };

export type NotificationsState = { webhookUrl: string | null; hasSecret: boolean; last: { at: string; ok: boolean; event: string; error?: string } | null };

export type UpdateInfo = { current: string; latest: string; newer: boolean; url: string; checkedAt: string };
export type UpdateState = { enabled: boolean; info: UpdateInfo | null; error: string | null };

export type PlaybooksState = {
  items: { name: string; description: string; bytes: number; updatedAt: string }[];
  invalid: { file: string; error: string }[];
  overflow: number;
  max: number;
  maxBytes: number;
};

export type ScheduleRunItem = { id: string; scheduleId: string; trigger: 'slot' | 'late' | 'manual' | 'event'; slotAt: string | null; missionId: string | null; outcome: string; detail: string | null; repeat: number; at: string };
export type ScheduleItem = {
  id: string;
  name: string;
  enabled: boolean;
  when: string;
  kind: 'cron' | 'interval' | 'mission_done';
  cron: string | null;
  hours: number | null;
  watch: string | null;
  plannerAgentId: string;
  reviewerAgentIds: string[];
  maxRounds: number;
  plannerConnected: boolean;
  nextRunAt: string | null;
  lastRun: ScheduleRunItem | null;
  lastMissionId: string | null;
  lastMissionStatus: string | null;
  disabledReason: string | null;
  briefPreview: string;
};
export type SchedulesState = { timezone: string; max: number; items: ScheduleItem[]; runs: ScheduleRunItem[] };

export type RecipeField = { id: string; label: string; hint: string; default: string; suggest: 'ollama-models' | null };
export type RecipeInfo = { id: string; title: string; summary: string; caveats: string[]; install: string; signIn: string; docs: string[]; fields: RecipeField[]; added: boolean; /** The choices as they are set, for a recipe that was added (null otherwise). */ current: Record<string, string> | null };

export type SandboxState = { enabled: boolean; experimental: boolean; image: string; checks: 'host' | 'container'; agents: string[] | null; listener: { host: string; port: number } | null; blockedReason: string | null; warnings: string[] };

// The live view: what an agent is doing as it works (pushed over the live connection), and what a task's workspace changed.
export type ActivityEntry = { seq: number; at: string; kind: 'start' | 'text' | 'tool' | 'end'; text: string; path?: string; failed?: boolean; /** Done by a sub-agent the agent started. */ sub?: boolean; /** The same step this many times in a row. */ repeat?: number };
export type ActivityChange = { runId: string; agentId: string; taskId: string | null; running: boolean; entries: ActivityEntry[] };
export type LiveRun = { runId: string; taskId: string | null; entries: ActivityEntry[] };
export type ChangedFile = { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; added: number | null; removed: number | null; from?: string };
/** A task as the daemon sends it (the columns of its row). */
export type BoardTask = {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  suggested_owner: string | null;
  phase_id: string | null;
  /** A JSON list of task ids, as text. */
  prerequisites: string;
  worktree_path: string | null;
  acceptance_criteria?: string;
  updated_at?: string;
};

/** What can be chosen for one agent, and what is chosen. */
export type AgentSetting = { id: string; platform: string; model: string | null; subAgents: boolean; canChooseModel: boolean; canUseSubAgents: boolean };
