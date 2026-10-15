// Task 1: notifications. The webhook is a real local HTTP server so the signature is checked end to end.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { DISPATCH_MIGRATION, USAGE_MIGRATION } from '../dispatch/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { MISSION_MIGRATION } from '../missions/index.js';
import { collectNotices } from './notices.js';
import { Notifier } from './notifier.js';
import { buildPayload, deliverOnce, parseWebhookUrl, signBody } from './webhook.js';

let dir: string;
let db: SqliteDatabase;
let clock: Date;
let hits: { headers: IncomingMessage['headers']; body: string }[];
let respond: { status: number; location?: string };
let server: Server;
let url: string;
let cfg: { webhookUrl?: string; webhookSecret?: string } | undefined;

const ask = (id: string, text = 'Which database should it use?', agent = 'claude-1') =>
  db.prepare("INSERT INTO questions (id, from_agent_id, to_role, text) VALUES (?, ?, 'Human', ?)").run(id, agent, text);
const notifier = () => new Notifier({ db, config: () => cfg, cockpitUrl: () => 'http://127.0.0.1:8934', now: () => clock, retryDelayMs: () => 1000 });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-notify-'));
  db = openDatabase(join(dir, 'mesh.db'));
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION, USAGE_MIGRATION]);
  new IdentityService(db).registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' });
  clock = new Date('2026-10-14T10:00:00Z');
  hits = [];
  respond = { status: 200 };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      res.writeHead(respond.status, respond.location ? { Location: respond.location } : {});
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  cfg = { webhookUrl: url, webhookSecret: 's3cret' };
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('webhook delivery', () => {
  it('signs the exact body with HMAC-SHA256 and sends text/content for simple receivers', async () => {
    const payload = buildPayload('question', 'Claude has a question', 'Which database?', 'http://127.0.0.1:8934', clock);
    expect((await deliverOnce(url, 's3cret', payload)).ok).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers['x-agentmesh-signature']).toBe(signBody('s3cret', hits[0]!.body));
    expect(hits[0]!.headers['x-agentmesh-event']).toBe('question');
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ event: 'question', text: 'Claude has a question: Which database?', content: 'Claude has a question: Which database?', at: '2026-10-14T10:00:00.000Z' });
  });

  it('sends no signature header when there is no secret', async () => {
    await deliverOnce(url, undefined, buildPayload('test', 't', 'm', 'u', clock));
    expect(hits[0]!.headers['x-agentmesh-signature']).toBeUndefined();
  });

  it('treats a redirect as a failure: a signed body is never forwarded somewhere else', async () => {
    respond = { status: 302, location: 'http://127.0.0.1:1/elsewhere' };
    const r = await deliverOnce(url, 's3cret', buildPayload('test', 't', 'm', 'u', clock));
    expect(r).toMatchObject({ ok: false, status: 302 });
    expect(hits).toHaveLength(1);
  });

  it('reports a dead address in plain words', async () => {
    const r = await deliverOnce('http://127.0.0.1:1/hook', undefined, buildPayload('test', 't', 'm', 'u', clock), { timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not reach it|did not answer/);
  });

  it('accepts only http(s) addresses without embedded credentials', () => {
    expect(parseWebhookUrl('https://example.com/hook').host).toBe('example.com');
    expect(() => parseWebhookUrl('ftp://example.com/x')).toThrow(/https:\/\//);
    expect(() => parseWebhookUrl('file:///etc/passwd')).toThrow(/https:\/\//);
    expect(() => parseWebhookUrl('not a url')).toThrow(/not a web address/);
    expect(() => parseWebhookUrl('https://user:pw@example.com/x')).toThrow(/secret/);
  });
});

describe('Notifier', () => {
  it('turning it on does not announce what was already waiting, only what comes after', async () => {
    ask('q-old');
    const n = notifier();
    expect(await n.scan()).toBe(0); // primes silently
    expect(hits).toHaveLength(0);
    ask('q-new', 'Use Postgres or SQLite?');
    expect(await n.scan()).toBe(1);
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ event: 'question', title: 'claude-1 has a question', message: 'Use Postgres or SQLite?' });
  });

  it('announces each thing once, even across a restart', async () => {
    const n = notifier();
    await n.scan();
    ask('q1');
    await n.scan();
    await n.scan();
    expect(hits).toHaveLength(1);
    await notifier().scan(); // a new process reading the same database
    expect(hits).toHaveLength(1);
  });

  it('forgets answered things, and tells you about the next one', async () => {
    const n = notifier();
    await n.scan();
    ask('q1');
    await n.scan();
    // Answering needs the Human agent (a schema rule); removing the row has the same effect on the list.
    db.prepare("DELETE FROM questions WHERE id = 'q1'").run();
    await n.scan();
    expect(db.prepare("SELECT count(*) AS n FROM dispatch_state WHERE key LIKE 'notified:%'").get()).toEqual({ n: 0 });
    ask('q2');
    await n.scan();
    expect(hits).toHaveLength(2);
  });

  it('retries a failed delivery after a wait, then succeeds, and records the outcome', async () => {
    const n = notifier();
    await n.scan();
    ask('q1');
    respond = { status: 500 };
    expect(await n.scan()).toBe(0);
    expect(n.last()).toMatchObject({ ok: false, error: 'The receiver answered 500.' });
    expect(await n.scan()).toBe(0); // still waiting: no new attempt yet
    expect(hits).toHaveLength(1);
    respond = { status: 200 };
    clock = new Date(clock.getTime() + 1500);
    expect(await n.scan()).toBe(1);
    expect(n.last()).toMatchObject({ ok: true, event: 'question' });
  });

  it('gives up on a dead address after a few tries instead of hammering it forever', async () => {
    const n = notifier();
    await n.scan();
    ask('q1');
    respond = { status: 500 };
    for (let i = 0; i < 12; i++) {
      await n.scan();
      clock = new Date(clock.getTime() + 2000);
    }
    expect(hits).toHaveLength(8);
  });

  it('removing the webhook stops it; adding one again starts from "known" again', async () => {
    const n = notifier();
    await n.scan();
    cfg = undefined;
    ask('q1');
    expect(await n.scan()).toBe(0);
    cfg = { webhookUrl: url };
    expect(await n.scan()).toBe(0); // q1 was waiting while it was off: not announced late
    expect(hits).toHaveLength(0);
    ask('q2');
    expect(await n.scan()).toBe(1);
  });

  it('sendTest says plainly when nothing is configured or the address is wrong', async () => {
    cfg = undefined;
    expect(await notifier().sendTest()).toEqual({ ok: false, error: 'No webhook address is set.' });
    cfg = { webhookUrl: 'ftp://x' };
    expect((await notifier().sendTest()).error).toMatch(/https:\/\//);
    cfg = { webhookUrl: url };
    expect((await notifier().sendTest()).ok).toBe(true);
    expect(JSON.parse(hits[0]!.body).event).toBe('test');
  });
});

describe('the "needs you" list', () => {
  it('lists open questions for the Human, and nothing for questions to agents', () => {
    ask('q1');
    db.prepare("INSERT INTO questions (id, from_agent_id, to_role, text) VALUES ('q2', 'claude-1', 'Agent', 'internal')").run();
    const list = collectNotices({ db });
    expect(list.map((x) => [x.key, x.kind, x.urgent])).toEqual([['q:q1', 'question', true]]);
  });
});
