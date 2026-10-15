// Task 5: the update check. No test touches the real network.
import { describe, expect, it } from 'vitest';
import { UpdateChecker, compareVersions, fetchLatest } from './check.js';

const reply = (status: number, body: unknown = {}): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('compareVersions', () => {
  it('orders versions by number, not by text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0); // a suffix is ignored, on purpose
  });
});

describe('fetchLatest', () => {
  it('reads the version and the release page', async () => {
    expect(await fetchLatest({ fetch: reply(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/zetabyte1195-cyber/agentmesh/releases/tag/v0.2.0' }) })).toEqual({
      version: '0.2.0',
      url: 'https://github.com/zetabyte1195-cyber/agentmesh/releases/tag/v0.2.0',
    });
  });
  it('never trusts a release page address that is not on github.com', async () => {
    const r = await fetchLatest({ fetch: reply(200, { tag_name: 'v0.2.0', html_url: 'https://evil.example/x' }) });
    expect(r.url).toBe('https://github.com/zetabyte1195-cyber/agentmesh/releases');
  });
  it('explains each way it can fail', async () => {
    await expect(fetchLatest({ fetch: reply(404) })).rejects.toThrow('No release has been published yet.');
    await expect(fetchLatest({ fetch: reply(500) })).rejects.toThrow('GitHub answered 500.');
    await expect(fetchLatest({ fetch: reply(200, { tag_name: 'nightly' }) })).rejects.toThrow('without a version number');
  });
});

describe('UpdateChecker', () => {
  const now = () => new Date('2026-10-14T10:00:00Z');
  it('reports nothing while switched off, and the result once on', async () => {
    let on = false;
    const c = new UpdateChecker({ current: '0.1.0', enabled: () => on, fetch: reply(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/x/y' }), now });
    await c.check();
    expect(c.info()).toBeNull();
    on = true;
    expect(c.info()).toEqual({ current: '0.1.0', latest: '0.2.0', newer: true, url: 'https://github.com/x/y', checkedAt: '2026-10-14T10:00:00.000Z' });
  });
  it('says "not newer" for the same or an older release', async () => {
    const c = new UpdateChecker({ current: '0.2.0', enabled: () => true, fetch: reply(200, { tag_name: 'v0.2.0' }), now });
    expect((await c.check()).newer).toBe(false);
  });
});
