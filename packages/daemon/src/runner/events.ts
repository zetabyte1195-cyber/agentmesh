// Normalized events from headless agent runs. Claude Code and Antigravity (agy) emit
// different stream-json schemas (verified; see board findings on P2.2); both map to this.
import { createHash } from 'node:crypto';
import { inputSignature, stableHash } from './loop.js';

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type RunnerEvent =
  | { kind: 'init'; sessionId: string | null; model: string | null }
  | { kind: 'text'; text: string }
  /** `id` and `inputHash` (the input without its prose description) let a result be paired with its call. Claude only: agy gives null. */
  | { kind: 'tool_use'; name: string; id?: string | null; inputHash?: string }
  /** A tool's result, paired by `id` with its tool_use (Claude stream-json; the wording was confirmed on a real run). */
  | { kind: 'tool_result'; id: string | null; isError: boolean; outputHash: string }
  | {
      kind: 'result';
      ok: boolean;
      turns: number | null;
      costUsd: number | null;
      usage: RunUsage | null;
      text: string | null;
      /** Actions the agent's permission rules refused. agy ends the run on one yet still reports SUCCESS (verified, dogfood V1.1). */
      denied?: string[];
    }
  | { kind: 'other'; label: string };

type Json = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** One parsed line of `claude -p --output-format stream-json --verbose`. */
export function parseClaudeEvent(e: Json): RunnerEvent[] {
  switch (e.type) {
    case 'system':
      return e.subtype === 'init'
        ? [{ kind: 'init', sessionId: str(e.session_id), model: str(e.model) }]
        : [{ kind: 'other', label: `system/${String(e.subtype)}` }];
    case 'assistant': {
      const content = obj(e.message).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((c): RunnerEvent[] => {
        const part = obj(c);
        if (part.type === 'text' && typeof part.text === 'string') return [{ kind: 'text', text: part.text }];
        if (part.type === 'tool_use') return [{ kind: 'tool_use', name: String(part.name), id: str(part.id), inputHash: inputSignature(part.input) }];
        return [];
      });
    }
    case 'user': {
      // Tool results come back as a user message: content is [{ type: 'tool_result', tool_use_id, content, is_error }]
      const content = obj(e.message).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((c): RunnerEvent[] => {
        const part = obj(c);
        if (part.type !== 'tool_result') return [];
        // content is a string, or a list of { type: 'text', text } blocks
        const text = Array.isArray(part.content) ? part.content.map((b) => str(obj(b).text) ?? '').join('\n') : (str(part.content) ?? stableHash(part.content));
        return [{ kind: 'tool_result', id: str(part.tool_use_id), isError: part.is_error === true, outputHash: createHash('sha256').update(text).digest('hex').slice(0, 16) }];
      });
    }
    case 'result': {
      const u = obj(e.usage);
      return [
        {
          kind: 'result',
          ok: e.subtype === 'success' && e.is_error !== true,
          turns: typeof e.num_turns === 'number' ? e.num_turns : null,
          costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null,
          usage: {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cacheReadTokens: num(u.cache_read_input_tokens),
            cacheWriteTokens: num(u.cache_creation_input_tokens),
          },
          text: str(e.result),
          denied: [], // Claude's refusal field is not verified yet; its runs fail on exit code instead
        },
      ];
    }
    default:
      return [{ kind: 'other', label: String(e.type) }];
  }
}

/** One parsed line of `agy -p --output-format stream-json`. */
export function parseAgyEvent(e: Json): RunnerEvent[] {
  switch (e.event) {
    case 'init':
      return [{ kind: 'init', sessionId: str(e.conversation_id), model: null }];
    case 'step_update': {
      const s = obj(e.step_update);
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta !== '') {
        return [{ kind: 'text', text: s.text_delta }];
      }
      // agy's tool-call step shape hasn't been captured yet (the probe made no tool calls), so
      // non-text steps stay 'other' with their step_type rather than being guessed at.
      return [{ kind: 'other', label: `step/${String(s.step_type)}/${String(s.state)}` }];
    }
    case 'result': {
      const r = obj(e.result);
      const u = obj(r.usage);
      return [
        {
          kind: 'result',
          ok: r.status === 'SUCCESS',
          turns: typeof r.num_turns === 'number' ? r.num_turns : null,
          costUsd: null, // agy reports no cost
          usage: { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_tokens), cacheWriteTokens: 0 },
          text: str(r.response),
          denied: Array.isArray(r.denied_actions) ? r.denied_actions.map((d) => String(obj(d).action ?? 'unknown')) : [],
        },
      ];
    }
    default:
      return [{ kind: 'other', label: String(e.event ?? e.type) }];
  }
}

/** Splits a byte stream into complete lines, carrying partial lines between chunks. */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    return lines.filter((l) => l.trim() !== '');
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}
