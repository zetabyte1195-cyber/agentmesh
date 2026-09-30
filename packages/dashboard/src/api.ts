// Same-origin calls to the daemon with the cockpit session cookie. The daemon also checks the
// request's Origin (CSRF), so these only work from the cockpit page itself.

export class ApiError extends Error {}

async function unwrap<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  return unwrap<T>(await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

export async function get<T = unknown>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { credentials: 'same-origin' }));
}

/** Run an action, keeping a busy flag and an error message for the button that started it. */
export function guarded(setBusy: (b: boolean) => void, setError: (e: string) => void, action: () => Promise<void>): () => Promise<void> {
  return async () => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
}

export type UsageTotals = { runs: number; unreported: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number | null };

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "12 runs · 1.2M in / 40.1k out · $3.10", saying so when some runs reported nothing. */
export function formatUsage(u: UsageTotals): string {
  const parts = [`${u.runs} run${u.runs === 1 ? '' : 's'}`];
  if (u.inputTokens || u.outputTokens) parts.push(`${tokens(u.inputTokens + u.cacheReadTokens)} in / ${tokens(u.outputTokens)} out`);
  if (u.costUsd !== null) parts.push(`$${u.costUsd.toFixed(2)}`);
  if (u.unreported) parts.push(`${u.unreported} not reported`);
  return parts.join(' · ');
}
