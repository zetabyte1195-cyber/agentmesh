// Stand-ins for the daemon, for component tests: a snapshot like GET /api/state returns, a fetch that answers by path
// and remembers what it was asked, and a WebSocket that never connects anywhere.
import { vi } from 'vitest';

export const agent = (o: Record<string, unknown> = {}) => ({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', status: 'IDLE', currentTaskId: null, doing: null, ...o });

export function snapshot(o: Record<string, unknown> = {}) {
  return {
    version: '0.2.0',
    missions: [],
    notices: [],
    playbooks: null,
    schedules: null,
    sandbox: null,
    agents: [agent(), agent({ id: 'gemini-1', name: 'Gemini', platform: 'ANTIGRAVITY' })],
    tasks: [],
    openQuestions: [],
    events: [],
    leases: [],
    usage: { byAgent: [], byMission: [] },
    dispatch: { paused: false, backoffs: [], stuck: [], recentRuns: [] },
    setup: {
      project: { name: 'demo', verifyCommand: 'npm test', landWithoutVerify: false, suggestedVerifyCommand: null, landing: true, context: '', maxContext: 3500 },
      platforms: [],
      notifications: { webhookUrl: null, hasSecret: false, last: null },
      update: { enabled: false, info: null, error: null },
      recipes: [],
    },
    ...o,
  };
}

export const mission = (o: Record<string, unknown> = {}) => ({
  id: 'M1',
  title: 'Car wash booking',
  brief: 'Customers book a wash slot online',
  status: 'PLAN_READY',
  planner: 'claude-1',
  reviewers: ['gemini-1'],
  round: 1,
  maxRounds: 3,
  plan: { version: 1, author: 'claude-1', body: '# Plan\n\nA single page.' },
  reviews: [],
  waitingOn: ['human'],
  tasks: [],
  progress: { total: 0, committed: 0 },
  updatedAt: '2026-10-15 09:00:00',
  ...o,
});

export type Call = { path: string; method: string; body: unknown };
type Reply = unknown | { status: number; body: unknown };

/**
 * Replaces fetch. `routes` maps a path to what it answers (a function gets the request body); a `{ status, body }`
 * answers with that status. Unknown paths answer 404, so a test notices a call it did not expect.
 */
export function fakeDaemon(routes: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    const route = routes[path];
    if (route === undefined) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: `no route ${path}` }) };
    const reply = typeof route === 'function' ? (route as (b: unknown) => Reply)(body) : route;
    const custom = reply && typeof reply === 'object' && 'status' in reply ? (reply as unknown as { status: number; body: unknown }) : null;
    const status = custom ? custom.status : 200;
    const json = custom ? custom.body : reply;
    return { ok: status < 400, status, statusText: String(status), json: async () => json };
  });
  vi.stubGlobal('fetch', fetchStub);
  return { calls, fetch: fetchStub, posts: (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path) };
}

/** A WebSocket that never connects. `sockets` lets a test open or close it by hand. */
export class FakeSocket {
  static sockets: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.sockets.push(this);
  }
  close(): void {}
}

/** jsdom does not implement scrolling. */
export function stubScrolling(): void {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
}
