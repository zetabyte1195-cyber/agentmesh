// A port that clients refuse must never be the port AgentMesh listens on. (Found when about one full test run in five failed
// with "fetch failed: bad port": the system had handed a test server port 6000 or 10080.)
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DaemonServer } from './server.js';
import { BLOCKED_PORTS, blockedPortMessage, isBlockedPort, listenFree } from './ports.js';

describe('the list of ports clients refuse', () => {
  it('has the well-known ones, and not the ones AgentMesh and Ollama use', () => {
    for (const p of [6000, 10080, 4045, 4190, 5060, 6665, 6697, 22, 25, 1]) expect(isBlockedPort(p), String(p)).toBe(true);
    for (const p of [8934, 8080, 3000, 11434, 11435, 443, 80, 49152]) expect(isBlockedPort(p), String(p)).toBe(false);
  });

  it('is what this Node\'s fetch really refuses, so it cannot drift when Node changes it', async () => {
    const refused = async (port: number) => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        return false;
      } catch (e) {
        return /bad port/i.test(`${(e as Error).message} ${((e as { cause?: Error }).cause?.message) ?? ''}`);
      }
    };
    const listed = [...BLOCKED_PORTS];
    const results = await Promise.all(listed.map(refused));
    expect(listed.filter((_, i) => !results[i])).toEqual([]); // every port on the list really is refused
    // and the ports around them that are not on the list are not (a list that is too short would let one through)
    const neighbours = [...new Set(listed.flatMap((p) => [p - 1, p + 1]))].filter((p) => p > 0 && p < 65536 && !BLOCKED_PORTS.has(p));
    const neighbourResults = await Promise.all(neighbours.map(refused));
    expect(neighbours.filter((_, i) => neighbourResults[i])).toEqual([]);
  }, 60_000);
});

/** A server that hands out the ports in `offers`, one per listen, like an operating system that keeps choosing a refused one. */
function fakeServer(offers: number[]) {
  const calls = { listen: 0, close: 0 };
  let current = 0;
  const server = {
    once: () => server,
    off: () => server,
    listen: (_port: number, _host: string, cb: () => void) => {
      calls.listen++;
      current = offers.shift() ?? 0;
      queueMicrotask(cb);
      return server;
    },
    address: () => ({ port: current, address: '127.0.0.1', family: 'IPv4' }),
    close: (cb?: () => void) => {
      calls.close++;
      queueMicrotask(() => cb?.());
      return server;
    },
  };
  return { server: server as never, calls };
}

describe('listening', () => {
  it('asks again when the system offers a refused port, and returns the first usable one', async () => {
    const { server, calls } = fakeServer([6000, 10080, 40123]);
    expect(await listenFree(server, '127.0.0.1')).toBe(40123);
    expect(calls).toEqual({ listen: 3, close: 2 });
  });

  it('gives up with a clear message if the system never offers a usable port', async () => {
    const { server, calls } = fakeServer(Array.from({ length: 10 }, () => 6000));
    await expect(listenFree(server, '127.0.0.1', 0, 4)).rejects.toThrow(/kept offering ports that clients refuse/);
    expect(calls.listen).toBe(4);
  });

  it('refuses a refused port that was asked for by number, in plain words, without listening at all', async () => {
    const { server, calls } = fakeServer([]);
    await expect(listenFree(server, '127.0.0.1', 6000)).rejects.toThrow(blockedPortMessage(6000));
    expect(blockedPortMessage(6000)).toMatch(/Port 6000 cannot be used.*Pick another one \(the default is 8934\)/);
    expect(calls.listen).toBe(0);
  });

  it('a port asked for by number is used as it is', async () => {
    const { server } = fakeServer([40001]);
    expect(await listenFree(server, '127.0.0.1', 40001)).toBe(40001);
  });

  it('with a real server: returns a port a client can actually connect to', async () => {
    const http = createServer((_req, res) => res.end('ok'));
    try {
      const port = await listenFree(http, '127.0.0.1');
      expect(isBlockedPort(port)).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });

  it('the daemon\'s own server refuses a port nobody can connect to, saying why', async () => {
    const server = new DaemonServer({ identity: {} as never, humanAgentId: 'human', port: 6000 });
    await expect(server.listen()).rejects.toThrow(/Port 6000 cannot be used: browsers and Node refuse to connect to it/);
  });
});

