// Loop detection (task 7): stop a run whose agent keeps repeating the same tool call and getting the same
// result. An agent stuck like that burns its quota without moving the task.
//
// What it can and cannot see, honestly:
//   • Claude Code (stream-json): yes. Each tool call has an id, an input and a result that comes back later
//     with the same id; those are paired and compared. The wording was confirmed on a real run (see
//     fixtures/claude-two-identical-tool-calls.jsonl), including that the same command comes back with a
//     different human-readable "description" each time, which is ignored.
//   • Antigravity (agy): no. Its stream does not expose tool calls in a form that can be compared.
//   • Tools in plain-text mode: no. There is nothing to compare.
// Alternating loops (A, B, A, B, ...) and results that change every time (a timestamp in the output) are not
// detected; the existing three-tries limit per task is the backstop for those.
import { createHash } from 'node:crypto';
import type { RunnerEvent } from './events.js';

export const DEFAULT_LOOP_THRESHOLD = 3;

/** A stable short hash of any JSON value: object keys are sorted so key order never matters. */
export function stableHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(value)) ?? 'undefined').digest('hex').slice(0, 16);
}

/**
 * The part of a tool call's input that decides what it does. Claude labels every call with a prose
 * "description" that is reworded each time ("Run echo hello" / "Run echo hello again"), so it is left out.
 */
export function inputSignature(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return stableHash(Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => key !== 'description')));
  }
  return stableHash(input);
}

export class LoopDetector {
  private readonly pending = new Map<string, { name: string; input: string }>();
  private last: string | null = null;
  private streak = 0;

  constructor(private readonly threshold: number = DEFAULT_LOOP_THRESHOLD) {}

  /**
   * Feed every event of a run, in order. Returns a one-line reason the first time the same call has
   * produced the same result `threshold` times in a row, otherwise null. The reason never contains the
   * call's input or output (they may hold secrets); only the tool name and a short fingerprint.
   */
  observe(event: RunnerEvent): string | null {
    if (this.threshold < 2) return null;
    if (event.kind === 'tool_use' && event.id && event.inputHash) {
      this.pending.set(event.id, { name: event.name, input: event.inputHash });
      return null;
    }
    if (event.kind !== 'tool_result' || !event.id) return null;
    const call = this.pending.get(event.id);
    if (!call) return null; // a result for a call we did not see: ignore it
    this.pending.delete(event.id);
    const signature = `${call.name}|${call.input}|${event.outputHash}|${event.isError}`;
    this.streak = signature === this.last ? this.streak + 1 : 1;
    this.last = signature;
    if (this.streak < this.threshold) return null;
    return `no_progress: ${call.name} was called ${this.streak} times in a row with the same input and the same result (fingerprint ${call.input.slice(0, 8)}); the run was stopped`;
  }
}
