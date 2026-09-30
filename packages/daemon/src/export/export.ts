// `agentmesh export` (V1.3; spec v1.1 §14, AC-7): a readable Markdown snapshot of the board and
// timeline, written straight from the SQLite store (read-only) so a reviewer can reconstruct any
// task's full history — claims, handoffs, findings, questions, audits, landing — without the
// cockpit running. Never opens the DB for writing: `agentmesh start` owns the schema.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../db/index.js';
import { git } from '../git/run-git.js';

export interface ExportOptions {
  repoRoot: string;
  /** Where to write the snapshot. Relative paths resolve against the repo root. Default: `.agentmesh/export.md`. */
  outputPath?: string;
  /** Test seam: override the "Generated" timestamp. */
  now?: Date;
}

export interface ExportReport {
  path: string;
  taskCount: number;
  eventCount: number;
  markdown: string;
}

interface AgentRow {
  id: string;
  name: string;
  platform: string;
  status: string;
  current_task_id: string | null;
}

interface TaskRow {
  id: string;
  phase_id: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  suggested_owner: string | null;
  assigned_agent_id: string | null;
  reviewing_agent_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  head_commit: string | null;
  diff_hash: string | null;
  acceptance_criteria: string;
  prerequisites: string;
  created_at: string;
  updated_at: string;
}

interface FindingRow {
  id: string;
  agent_id: string;
  text: string;
  file_path: string | null;
  line_number: number | null;
  severity: string;
  created_at: string;
}

interface HandoffRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  message: string;
  action_items: string;
  created_at: string;
}

interface AuditRow {
  id: string;
  auditor_agent_id: string;
  verdict: string;
  diff_hash: string;
  test_run_success: number;
  notes: string;
  created_at: string;
}

interface QuestionRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  to_role: string;
  text: string;
  resolved: number;
  answer: string | null;
  answered_by_agent_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface DecisionRow {
  id: string;
  agent_id: string;
  decision: string;
  rationale: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  kind: string;
  text: string;
  created_at: string;
}

interface TaskHistory {
  task: TaskRow;
  findings: FindingRow[];
  handoffs: HandoffRow[];
  audits: AuditRow[];
  questions: QuestionRow[];
  decisions: DecisionRow[];
}

type RelatedTable = 'findings' | 'handoffs' | 'audits' | 'questions' | 'decisions';

export async function exportBoard(options: ExportOptions): Promise<ExportReport> {
  const root = resolve((await git(options.repoRoot, ['rev-parse', '--show-toplevel'])).trim());
  const dbPath = join(root, '.agentmesh', 'mesh.db');
  if (!existsSync(dbPath)) throw new Error('No .agentmesh/mesh.db: run `agentmesh init` and `agentmesh start` first.');

  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  let markdown: string;
  let taskCount: number;
  let eventCount: number;
  try {
    const agents = db.prepare('SELECT id, name, platform, status, current_task_id FROM agents ORDER BY id').all() as AgentRow[];
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[];
    const events = db.prepare('SELECT * FROM events ORDER BY created_at ASC, rowid ASC').all() as EventRow[];
    const histories: TaskHistory[] = tasks.map((task) => ({
      task,
      findings: relatedRows<FindingRow>(db, 'findings', task.id),
      handoffs: relatedRows<HandoffRow>(db, 'handoffs', task.id),
      audits: relatedRows<AuditRow>(db, 'audits', task.id),
      questions: relatedRows<QuestionRow>(db, 'questions', task.id),
      decisions: relatedRows<DecisionRow>(db, 'decisions', task.id),
    }));

    markdown = renderMarkdown(options.now ?? new Date(), agents, histories, events);
    taskCount = tasks.length;
    eventCount = events.length;
  } finally {
    closeDatabase(db);
  }

  const outputPath = resolve(root, options.outputPath ?? join('.agentmesh', 'export.md'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown);
  return { path: outputPath, taskCount, eventCount, markdown };
}

function relatedRows<T>(db: SqliteDatabase, table: RelatedTable, taskId: string): T[] {
  return db.prepare(`SELECT * FROM ${table} WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`).all(taskId) as T[];
}

function renderMarkdown(generatedAt: Date, agents: AgentRow[], histories: TaskHistory[], events: EventRow[]): string {
  const lines: string[] = ['# AgentMesh Board Export', '', `Generated: ${generatedAt.toISOString()}`, ''];

  lines.push(`## Agents (${agents.length})`, '', '| ID | Name | Platform | Status | Current task |', '| --- | --- | --- | --- | --- |');
  for (const a of agents) lines.push(`| ${cell(a.id)} | ${cell(a.name)} | ${cell(a.platform)} | ${cell(a.status)} | ${cell(a.current_task_id ?? '—')} |`);
  lines.push('');

  lines.push(`## Tasks (${histories.length})`, '');
  for (const h of histories) lines.push(renderTask(h));

  lines.push(`## Timeline (${events.length} events)`, '');
  if (!events.length) lines.push('_none_', '');
  for (const e of events) lines.push(`- ${e.created_at} · ${e.agent_id ?? '—'}${e.task_id ? ` · ${e.task_id}` : ''} · **${e.kind}** — ${oneLine(e.text)}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderTask(history: TaskHistory): string {
  const { task, findings, handoffs, audits, questions, decisions } = history;
  const prereqs = JSON.parse(task.prerequisites) as string[];
  const lines: string[] = [`### ${task.id} — ${task.title}`, ''];

  lines.push(`- Phase: ${task.phase_id}`);
  lines.push(`- Status: ${task.status}`);
  lines.push(`- Priority: ${task.priority}`);
  lines.push(`- Suggested owner: ${task.suggested_owner ?? '—'}`);
  lines.push(`- Assigned to: ${task.assigned_agent_id ?? '—'}`);
  lines.push(`- Reviewing agent: ${task.reviewing_agent_id ?? '—'}`);
  lines.push(`- Branch: ${task.branch_name ?? '—'}`);
  lines.push(`- Prerequisites: ${prereqs.length ? prereqs.join(', ') : '—'}`);
  lines.push(`- Base commit: ${task.base_commit ?? '—'}`);
  lines.push(`- Head commit: ${task.head_commit ?? '—'}`);
  lines.push(`- Diff hash: ${task.diff_hash ?? '—'}`);
  lines.push(`- Created: ${task.created_at} · Updated: ${task.updated_at}`, '');

  if (task.description.trim()) lines.push('**Description**', '', task.description.trim(), '');
  lines.push('**Acceptance criteria**', '', task.acceptance_criteria.trim(), '');

  lines.push(`**Findings** (${findings.length})`, '');
  if (!findings.length) lines.push('_none_', '');
  for (const f of findings) {
    const loc = f.file_path ? ` (${f.file_path}${f.line_number != null ? `:${f.line_number}` : ''})` : '';
    lines.push(`- [${f.severity}] ${oneLine(f.text)}${loc} — ${f.agent_id}, ${f.created_at}`);
  }
  if (findings.length) lines.push('');

  lines.push(`**Handoffs** (${handoffs.length})`, '');
  if (!handoffs.length) lines.push('_none_', '');
  for (const h of handoffs) {
    lines.push(`- ${h.from_agent_id} → ${h.to_agent_id ?? '—'}: ${oneLine(h.message)} (${h.created_at})`);
    for (const item of JSON.parse(h.action_items) as string[]) lines.push(`  - [ ] ${oneLine(item)}`);
  }
  if (handoffs.length) lines.push('');

  lines.push(`**Audits** (${audits.length})`, '');
  if (!audits.length) lines.push('_none_', '');
  for (const a of audits) {
    const notes = a.notes.trim() ? `: ${oneLine(a.notes)}` : '';
    lines.push(`- ${a.verdict} by ${a.auditor_agent_id} (${a.created_at}) — diff \`${a.diff_hash.slice(0, 12)}\`, tests ${a.test_run_success ? 'passed' : 'failed'}${notes}`);
  }
  if (audits.length) lines.push('');

  lines.push(`**Questions** (${questions.length})`, '');
  if (!questions.length) lines.push('_none_', '');
  for (const q of questions) {
    lines.push(`- Q (${q.from_agent_id} → ${q.to_agent_id ?? q.to_role}, ${q.created_at}): ${oneLine(q.text)}`);
    lines.push(q.resolved ? `  - A (${q.answered_by_agent_id ?? '—'}, ${q.resolved_at ?? '—'}): ${oneLine(q.answer ?? '')}` : '  - _unanswered_');
  }
  if (questions.length) lines.push('');

  lines.push(`**Decisions** (${decisions.length})`, '');
  if (!decisions.length) lines.push('_none_', '');
  for (const d of decisions) lines.push(`- ${oneLine(d.decision)}${d.rationale ? ` — ${oneLine(d.rationale)}` : ''} (${d.agent_id}, ${d.created_at})`);
  lines.push('', '---', '');

  return lines.join('\n');
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
