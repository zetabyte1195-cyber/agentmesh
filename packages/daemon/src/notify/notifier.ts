// Sends the Human's webhook a message when something new needs them. Runs inside the daemon, so it works
// with the cockpit closed (desktop notifications in the browser only work while the page is open).
//
// What has already been announced is remembered in the database, so a restart does not repeat itself.
// When the webhook is first set up, whatever is already waiting is marked as known without sending:
// turning notifications on must not fire a burst about old things.
import type { SqliteDatabase } from '../db/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import type { MissionService } from '../missions/index.js';
import { type Notice, collectNotices } from './notices.js';
import { type DeliveryResult, type WebhookPayload, buildPayload, deliverOnce, parseWebhookUrl } from './webhook.js';

export interface NotifierOptions {
  db: SqliteDatabase;
  missions?: MissionService;
  dispatcher?: Dispatcher;
  /** Read at every scan: the Human can change it in the cockpit while AgentMesh runs. */
  config: () => { webhookUrl?: string; webhookSecret?: string } | undefined;
  /** The cockpit's address to put in messages. */
  cockpitUrl: () => string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Test seam: the delay before a failed delivery is tried again. */
  retryDelayMs?: (failures: number) => number;
}

export interface LastDelivery {
  at: string;
  ok: boolean;
  event: string;
  error?: string;
}

const EVENT_OF: Record<Notice['kind'], WebhookPayload['event']> = { plan: 'plan_ready', question: 'question', stuck: 'gave_up', done: 'mission_done' };
const GIVE_UP_AFTER = 8;

export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  /** In memory only: failed deliveries wait longer each time, up to ten minutes. */
  private readonly failures = new Map<string, { n: number; retryAt: number }>();

  constructor(private readonly options: NotifierOptions) {}

  private get db(): SqliteDatabase {
    return this.options.db;
  }
  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
  private has(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM dispatch_state WHERE key = ?').get(key));
  }
  private set(key: string, value = '1'): void {
    this.db.prepare('INSERT INTO dispatch_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  last(): LastDelivery | null {
    const row = this.db.prepare("SELECT value FROM dispatch_state WHERE key = 'notify:last'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as LastDelivery) : null;
  }

  private record(event: string, result: DeliveryResult): void {
    const last: LastDelivery = { at: this.now().toISOString(), ok: result.ok, event, ...(result.error ? { error: result.error } : {}) };
    this.set('notify:last', JSON.stringify(last));
  }

  /** Send a "this works" message now. Used by the Test button. */
  async sendTest(): Promise<DeliveryResult> {
    const cfg = this.options.config();
    if (!cfg?.webhookUrl) return { ok: false, error: 'No webhook address is set.' };
    try {
      parseWebhookUrl(cfg.webhookUrl);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const payload = buildPayload('test', 'AgentMesh test', 'If you can read this, notifications work.', this.options.cockpitUrl(), this.now());
    const result = await deliverOnce(cfg.webhookUrl, cfg.webhookSecret, payload, this.options.fetch ? { fetch: this.options.fetch } : {});
    this.record('test', result);
    return result;
  }

  /** One pass: announce each notice that has not been announced yet. Returns how many were delivered. */
  async scan(): Promise<number> {
    if (this.scanning) return 0;
    const cfg = this.options.config();
    if (!cfg?.webhookUrl) {
      if (this.has('notify:armed')) this.db.prepare("DELETE FROM dispatch_state WHERE key = 'notify:armed'").run();
      return 0;
    }
    this.scanning = true;
    try {
      const notices = collectNotices({ db: this.db, ...(this.options.missions ? { missions: this.options.missions } : {}), ...(this.options.dispatcher ? { dispatcher: this.options.dispatcher } : {}), now: this.options.now ?? (() => new Date()) });
      const live = new Set(notices.map((n) => `notified:${n.key}`));

      if (!this.has('notify:armed')) {
        // First scan since the webhook was set: everything waiting now is already known to the Human.
        for (const n of notices) this.set(`notified:${n.key}`);
        this.set('notify:armed');
        return 0;
      }

      let delivered = 0;
      for (const n of notices) {
        if (this.has(`notified:${n.key}`)) continue;
        const f = this.failures.get(n.key);
        if (f && this.now().getTime() < f.retryAt) continue;
        const payload = buildPayload(EVENT_OF[n.kind], n.title, n.text, this.options.cockpitUrl(), this.now());
        const result = await deliverOnce(cfg.webhookUrl, cfg.webhookSecret, payload, this.options.fetch ? { fetch: this.options.fetch } : {});
        this.record(payload.event, result);
        if (result.ok) {
          this.set(`notified:${n.key}`);
          this.failures.delete(n.key);
          delivered++;
          continue;
        }
        const n2 = (f?.n ?? 0) + 1;
        if (n2 >= GIVE_UP_AFTER) {
          this.set(`notified:${n.key}`); // stop hammering a dead address; the failure stays visible in Setup
          this.failures.delete(n.key);
        } else {
          const wait = this.options.retryDelayMs?.(n2) ?? Math.min(10 * 60_000, 15_000 * 2 ** (n2 - 1));
          this.failures.set(n.key, { n: n2, retryAt: this.now().getTime() + wait });
        }
      }

      // Forget notices that are gone, so the table does not grow forever.
      for (const row of this.db.prepare("SELECT key FROM dispatch_state WHERE key LIKE 'notified:%'").all() as { key: string }[]) {
        if (!live.has(row.key)) this.db.prepare('DELETE FROM dispatch_state WHERE key = ?').run(row.key);
      }
      return delivered;
    } finally {
      this.scanning = false;
    }
  }

  start(intervalMs = 10_000): void {
    this.stop();
    this.timer = setInterval(() => void this.scan().catch((err: unknown) => process.emitWarning(`AgentMesh notifier: ${(err as Error).message}`)), intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
