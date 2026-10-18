// The live feed of what an agent is doing, built from the events its tool streams as it works (Claude Code and Antigravity
// both say which tool they call and on which file). Kept in memory, a bounded amount per run and a bounded number of runs: it
// is for watching, not an archive, and it is gone when AgentMesh stops. Tool OUTPUT is never kept: it can hold anything from
// your files. What is kept is the name of the tool, the file or command it was given, and what the agent said in words.
import type { RunnerEvent } from '../runner/events.js';

export interface ActivityEntry {
  /** 1, 2, 3 … within the run. Entries are only ever added or, for a line of text still being written, extended. */
  seq: number;
  at: string;
  kind: 'start' | 'text' | 'tool' | 'end';
  /** One line a person can read: "Edited src/app.ts", "Ran npm test", what the agent said. */
  text: string;
  /** The file, relative to the run's workspace, for a tool that names one. */
  path?: string;
  failed?: boolean;
  /** Done by a sub-agent the agent started. */
  sub?: boolean;
  /** How many times in a row this same step happened (2 or more); a step that repeats is one line, not twenty. */
  repeat?: number;
}

export interface ActivityChange {
  runId: string;
  agentId: string;
  taskId: string | null;
  running: boolean;
  /** Only the entries that are new or changed since the last message. */
  entries: ActivityEntry[];
}

export interface ActivityOptions {
  maxEntries?: number;
  maxRuns?: number;
  /** How long changes are gathered before they are sent. */
  flushMs?: number;
  onChange?: (change: ActivityChange) => void;
  now?: () => Date;
}

interface RunRecord {
  agentId: string;
  taskId: string | null;
  cwd: string;
  running: boolean;
  entries: ActivityEntry[];
  nextSeq: number;
  dirty: Set<number>;
  toolEntries: Map<string, number>;
  timer: NodeJS.Timeout | null;
  /** The entry that is still being written, if the last thing was the agent talking. */
  openText: number | null;
}

const MAX_TEXT = 600;
const END_LABEL: Record<string, { text: string; failed: boolean }> = {
  SUCCEEDED: { text: 'Finished', failed: false },
  FAILED: { text: 'Failed', failed: true },
  QUOTA: { text: 'Out of quota', failed: true },
  STOPPED: { text: 'Stopped', failed: false },
  ABANDONED: { text: 'Interrupted', failed: true },
};

const WROTE = new Set(['write', 'write_to_file', 'create_file']);
const EDITED = new Set(['edit', 'multiedit', 'notebookedit', 'replace_file_content', 'multi_replace_file_content', 'edit_file']);
const READ = new Set(['read', 'view_file', 'read_file']);
const RAN = new Set(['bash', 'run_command', 'shell']);
const SEARCHED = new Set(['grep', 'glob', 'grep_search', 'find_by_name', 'search']);

const slashes = (p: string): string => p.replace(/\\/g, '/');
/** The path as the person sees it: relative to the run's folder when it is inside it, with forward slashes. */
function shown(path: string, cwd: string): string {
  const p = slashes(path);
  const root = slashes(cwd).replace(/\/+$/, '');
  return root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? p.slice(root.length + 1) : p;
}

function describe(event: Extract<RunnerEvent, { kind: 'tool_use' }>, cwd: string): { text: string; path?: string } {
  const key = event.name.toLowerCase();
  const target = event.target;
  const file = target && event.targetKind === 'file' ? shown(target, cwd) : null;
  if (key === 'toolsearch') return { text: 'Looked up its tools' };
  if (key === 'task' || key === 'agent') return { text: target ? `Started a sub-agent: ${target}` : 'Started a sub-agent' };
  if (key.startsWith('mcp__')) {
    const [, server = '', ...rest] = event.name.split('__');
    const tool = rest.join('__') || event.name;
    return { text: server.toLowerCase() === 'agentmesh' ? `AgentMesh: ${tool.replace(/^mesh_/, '').replace(/_/g, ' ')}` : `Used ${server}: ${tool}` };
  }
  if (file && WROTE.has(key)) return { text: `Wrote ${file}`, path: file };
  if (file && EDITED.has(key)) return { text: `Edited ${file}`, path: file };
  if (file && READ.has(key)) return { text: `Read ${file}`, path: file };
  if (file) return { text: `Used ${event.name} on ${file}`, path: file };
  if (target && RAN.has(key)) return { text: `Ran ${target}` };
  if (target && (SEARCHED.has(key) || event.targetKind === 'search')) return { text: `Searched for ${target}` };
  return { text: target ? `Used ${event.name}: ${target}` : `Used ${event.name}` };
}

export class ActivityLog {
  private readonly runs = new Map<string, RunRecord>();
  private readonly maxEntries: number;
  private readonly maxRuns: number;
  private readonly flushMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: ActivityOptions = {}) {
    this.maxEntries = options.maxEntries ?? 300;
    this.maxRuns = options.maxRuns ?? 60;
    this.flushMs = options.flushMs ?? 250;
    this.now = options.now ?? (() => new Date());
  }

  begin(runId: string, info: { agentId: string; taskId: string | null; cwd: string }): void {
    const rec: RunRecord = { ...info, running: true, entries: [], nextSeq: 1, dirty: new Set(), toolEntries: new Map(), timer: null, openText: null };
    this.runs.set(runId, rec);
    this.add(runId, rec, 'start', 'Started');
    this.forget();
  }

  record(runId: string, event: RunnerEvent): void {
    const rec = this.runs.get(runId);
    if (!rec || !rec.running) return;
    if (event.kind === 'init') {
      // The tool says which model it really started on: that is what the first line of the feed shows.
      const first = rec.entries[0];
      if (event.model && first?.kind === 'start') {
        first.text = `Started (model ${event.model.slice(0, 80)})`;
        this.touch(runId, rec, first.seq);
      }
      return;
    }
    if (event.kind === 'text') {
      const open = rec.openText === null ? undefined : rec.entries.find((e) => e.seq === rec.openText);
      // What a sub-agent says is not joined to what the agent says.
      if (open && Boolean(open.sub) === Boolean(event.sub)) {
        if (open.text.length < MAX_TEXT) {
          open.text = (open.text + event.text).slice(0, MAX_TEXT);
          if (open.text.length >= MAX_TEXT) open.text = `${open.text.slice(0, MAX_TEXT - 1)}…`;
          this.touch(runId, rec, open.seq);
        }
      } else if (event.text.trim() !== '') {
        const t = this.add(runId, rec, 'text', event.text.slice(0, MAX_TEXT));
        if (event.sub) t.sub = true;
        rec.openText = t.seq;
      }
      return;
    }
    if (event.kind === 'tool_use') {
      rec.openText = null;
      const d = describe(event, rec.cwd);
      const last = rec.entries[rec.entries.length - 1];
      let entry: ActivityEntry;
      if (last && last.kind === 'tool' && last.text === d.text && !last.failed && Boolean(last.sub) === Boolean(event.sub)) {
        last.repeat = (last.repeat ?? 1) + 1;
        this.touch(runId, rec, last.seq);
        entry = last;
      } else {
        entry = this.add(runId, rec, 'tool', d.text, d.path);
        if (event.sub) entry.sub = true;
      }
      if (event.id) rec.toolEntries.set(event.id, entry.seq);
    } else if (event.kind === 'tool_result' && event.isError && event.id) {
      const seq = rec.toolEntries.get(event.id);
      const entry = seq === undefined ? undefined : rec.entries.find((e) => e.seq === seq);
      if (entry) {
        entry.failed = true;
        this.touch(runId, rec, entry.seq);
      }
    }
  }

  end(runId: string, status: string): void {
    const rec = this.runs.get(runId);
    if (!rec || !rec.running) return;
    rec.openText = null;
    const label = END_LABEL[status] ?? { text: status, failed: false };
    const entry = this.add(runId, rec, 'end', label.text);
    if (label.failed) entry.failed = true;
    rec.running = false;
    this.flush(runId, rec); // at once: a card must not say "working" after the work is over
    this.forget();
  }

  /** The entries of a run, only those after `afterSeq` when given. Null if this run is not (or no longer) kept. */
  entries(runId: string, afterSeq = 0): ActivityEntry[] | null {
    const rec = this.runs.get(runId);
    return rec ? rec.entries.filter((e) => e.seq > afterSeq).map((e) => ({ ...e })) : null;
  }

  isRunning(runId: string): boolean {
    return this.runs.get(runId)?.running ?? false;
  }

  info(runId: string): { agentId: string; taskId: string | null; running: boolean } | null {
    const r = this.runs.get(runId);
    return r ? { agentId: r.agentId, taskId: r.taskId, running: r.running } : null;
  }

  /** For each agent that is working now: its run and the latest few entries (what its card shows). */
  live(last = 6): Record<string, { runId: string; taskId: string | null; entries: ActivityEntry[] }> {
    const out: Record<string, { runId: string; taskId: string | null; entries: ActivityEntry[] }> = {};
    for (const [runId, r] of this.runs) if (r.running) out[r.agentId] = { runId, taskId: r.taskId, entries: r.entries.slice(-last).map((e) => ({ ...e })) };
    return out;
  }

  private add(runId: string, rec: RunRecord, kind: ActivityEntry['kind'], text: string, path?: string): ActivityEntry {
    const entry: ActivityEntry = { seq: rec.nextSeq++, at: this.now().toISOString(), kind, text, ...(path ? { path } : {}) };
    rec.entries.push(entry);
    if (rec.entries.length > this.maxEntries) rec.entries.splice(0, rec.entries.length - this.maxEntries);
    this.touch(runId, rec, entry.seq);
    return entry;
  }

  private touch(runId: string, rec: RunRecord, seq: number): void {
    rec.dirty.add(seq);
    if (rec.timer || !this.options.onChange) return;
    rec.timer = setTimeout(() => this.flush(runId, rec), this.flushMs);
    rec.timer.unref?.();
  }

  private flush(runId: string, rec: RunRecord): void {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    if (!rec.dirty.size || !this.options.onChange) return;
    const entries = rec.entries.filter((e) => rec.dirty.has(e.seq)).map((e) => ({ ...e }));
    rec.dirty.clear();
    this.options.onChange({ runId, agentId: rec.agentId, taskId: rec.taskId, running: rec.running, entries });
  }

  /** Over the limit: the oldest finished runs go. A run that is still going never does. */
  private forget(): void {
    if (this.runs.size <= this.maxRuns) return;
    for (const [id, r] of this.runs) {
      if (this.runs.size <= this.maxRuns) break;
      if (!r.running) this.runs.delete(id);
    }
  }
}
