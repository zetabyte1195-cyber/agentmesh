import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase, migrate, MIGRATIONS } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService } from '../identity/index.js';
import { DaemonServer, SESSION_COOKIE } from '../server/index.js';
import { registerSetup } from './setup.js';
import { BoardService } from '../board/service.js';
import { createRegistry } from '../platforms/index.js';
import type { Dispatcher } from '../dispatch/index.js';
import type { ProjectConfig } from '../init/index.js';

describe('statement 1 probe', () => {
  it('does not refuse GET /api/platforms when Origin header is absent', async () => {
    const db = openDatabase(':memory:');
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
    const identity = new IdentityService(db);
    identity.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' });

    const server = new DaemonServer({ identity, humanAgentId: 'human', port: 0 });
    const registry = createRegistry([]);
    const board = new BoardService({ db });

    registerSetup({
      server,
      board,
      identity,
      dispatcher: {} as Dispatcher,
      registry,
      root: process.cwd(),
      config: { agents: [] } as unknown as ProjectConfig,
      allowedTools: [],
    });

    const port = await server.listen();
    const token = identity.issueToken('human', 'session');

    // Request without Origin header
    const res = await fetch(`http://127.0.0.1:${port}/api/platforms`, {
      method: 'GET',
      headers: {
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      },
    });

    expect(res.status).toBe(200);

    await server.close();
    closeDatabase(db);
  });
});
