// Delivering a notification to a webhook the Human configured. The body is signed so the receiver can
// check it came from this AgentMesh (HMAC-SHA256 of the exact body, in the X-AgentMesh-Signature header).
import { createHmac } from 'node:crypto';

export interface WebhookPayload {
  event: 'plan_ready' | 'question' | 'gave_up' | 'mission_done' | 'test';
  title: string;
  message: string;
  /** The cockpit's address on this computer (no login in it). */
  url: string;
  at: string;
  /** `text` and `content` repeat "title: message" for receivers that expect one of those fields. */
  text: string;
  content: string;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Accepts only http(s) addresses without embedded credentials; returns the parsed URL or throws a plain-words error. */
export function parseWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('That is not a web address. It should look like https://example.com/hook');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The address must start with https:// (or http:// for a service on your own network).');
  if (u.username || u.password) throw new Error('Put the secret in the "secret" box, not in the address.');
  return u;
}

export function buildPayload(event: WebhookPayload['event'], title: string, message: string, url: string, now: Date = new Date()): WebhookPayload {
  const text = `${title}: ${message}`;
  return { event, title, message, url, at: now.toISOString(), text, content: text };
}

/** One attempt. Never throws. A redirect counts as a failure: a signed body must not be forwarded somewhere else. */
export async function deliverOnce(url: string, secret: string | undefined, payload: WebhookPayload, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'AgentMesh-webhook', 'X-AgentMesh-Event': payload.event };
  if (secret) headers['X-AgentMesh-Signature'] = signBody(secret, body);
  try {
    const res = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `The address redirected (${res.status}); use the final address.` };
    return { ok: false, status: res.status, error: `The receiver answered ${res.status}.` };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === 'TimeoutError' ? 'The receiver did not answer within 10 seconds.' : `Could not reach it: ${e.message}` };
  }
}
