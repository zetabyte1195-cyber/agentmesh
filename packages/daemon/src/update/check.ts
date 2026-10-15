// Is there a newer AgentMesh release? One request to GitHub's public API, and only when the Human asked:
// `agentmesh update` does it on demand, and the daemon does it once a day only if "updateCheck" is on
// (it is off by default, because AgentMesh otherwise contacts nobody).
export const RELEASES_REPO = 'zetabyte1195-cyber/agentmesh';
export const LATEST_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
/** The file every release carries under this fixed name. */
export const LATEST_PACKAGE_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download/agentmesh.tgz`;

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  /** The release page. */
  url: string;
  checkedAt: string;
}

/** Compare "1.2.3"-style versions (a leading v and any -suffix are ignored). Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function fetchLatest(options: { fetch?: typeof fetch; api?: string } = {}): Promise<{ version: string; url: string }> {
  const res = await (options.fetch ?? fetch)(options.api ?? LATEST_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentMesh-update-check' }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) throw new Error('No release has been published yet.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+/.test(body.tag_name)) throw new Error('GitHub sent a release without a version number.');
  return { version: body.tag_name.replace(/^v/i, ''), url: typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : `https://github.com/${RELEASES_REPO}/releases` };
}

export interface UpdateCheckerOptions {
  current: string;
  /** Read at every check: the Human can switch it on or off in the cockpit. */
  enabled: () => boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}

const DAY_MS = 24 * 3600 * 1000;

export class UpdateChecker {
  private result: UpdateInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: UpdateCheckerOptions) {}

  /** What the last check found, or null if checking is off or has not happened. */
  info(): UpdateInfo | null {
    return this.options.enabled() ? this.result : null;
  }
  error(): string | null {
    return this.options.enabled() ? this.lastError : null;
  }

  /** Check now (even if switched off: used by the "Check now" button). */
  async check(): Promise<UpdateInfo> {
    const { version, url } = await fetchLatest(this.options.fetch ? { fetch: this.options.fetch } : {});
    this.lastError = null;
    this.result = { current: this.options.current, latest: version, newer: compareVersions(version, this.options.current) > 0, url, checkedAt: (this.options.now ?? (() => new Date()))().toISOString() };
    return this.result;
  }

  private async tick(): Promise<void> {
    if (!this.options.enabled()) return;
    const due = !this.result || Date.now() - new Date(this.result.checkedAt).getTime() > DAY_MS;
    if (!due) return;
    try {
      await this.check();
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  /** Looks every hour whether a daily check is due (so switching it on takes effect soon). */
  start(): void {
    this.stop();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3600_000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
