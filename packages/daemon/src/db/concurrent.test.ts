import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from './connection.js';
import { migrate } from './migrator.js';

function runWorker(
  scriptPath: string,
  dbPath: string,
  workerId: string,
  count: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, dbPath, workerId, String(count)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('Two-process concurrent-writer and migration idempotency test (P1.2 acceptance)', () => {
  let tempDir: string;
  let dbPath: string;
  let workerScriptPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentmesh-concurrent-test-'));
    dbPath = join(tempDir, 'mesh.db');

    // Always use the compiled worker script from dist
    const compiledWorkerPath = fileURLToPath(new URL('../../dist/db/concurrent-worker.js', import.meta.url));
    if (!existsSync(compiledWorkerPath)) {
      throw new Error(`Compiled worker script not found at ${compiledWorkerPath}. Run tsc -b before running tests.`);
    }
    workerScriptPath = compiledWorkerPath;
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('proves two OS processes write concurrently with zero lost updates and migrations are idempotent', async () => {
    // 1. Initialize database and apply migrations
    const setupDb = openDatabase(dbPath);
    const initialMigration = migrate(setupDb);
    expect(initialMigration.applied).toHaveLength(1);
    expect(initialMigration.currentVersion).toBe(1);

    // 2. Setup the concurrent counter table
    setupDb.exec(`
      CREATE TABLE IF NOT EXISTS _concurrent_test_counter (
        id TEXT PRIMARY KEY,
        val INTEGER NOT NULL
      );
      INSERT INTO _concurrent_test_counter (id, val) VALUES ('total', 0);
    `);

    // Verify initial counter
    const initialCounter = setupDb.prepare('SELECT val FROM _concurrent_test_counter WHERE id = ?').get('total') as {
      val: number;
    };
    expect(initialCounter.val).toBe(0);

    // Close setup connection before spawning worker processes
    closeDatabase(setupDb);

    // 3. Spawn TWO real OS processes concurrently
    const ITERATIONS_PER_WORKER = 50;
    const [proc1Result, proc2Result] = await Promise.all([
      runWorker(workerScriptPath, dbPath, 'proc1', ITERATIONS_PER_WORKER),
      runWorker(workerScriptPath, dbPath, 'proc2', ITERATIONS_PER_WORKER),
    ]);

    // Both processes must exit successfully with code 0
    if (proc1Result.code !== 0) {
      console.error('Proc1 stderr:', proc1Result.stderr);
    }
    if (proc2Result.code !== 0) {
      console.error('Proc2 stderr:', proc2Result.stderr);
    }
    expect(proc1Result.code).toBe(0);
    expect(proc2Result.code).toBe(0);

    // 4. Verify ZERO LOST UPDATES
    const verifyDb = openDatabase(dbPath);
    try {
      // Counter must equal exact sum of both workers (50 + 50 = 100)
      const finalCounter = verifyDb
        .prepare('SELECT val FROM _concurrent_test_counter WHERE id = ?')
        .get('total') as { val: number };
      expect(finalCounter.val).toBe(ITERATIONS_PER_WORKER * 2);

      // Verify all events from proc1 were written
      const proc1Events = verifyDb
        .prepare("SELECT count(*) as count FROM events WHERE text LIKE 'worker proc1 %'")
        .get() as { count: number };
      expect(proc1Events.count).toBe(ITERATIONS_PER_WORKER);

      // Verify all events from proc2 were written
      const proc2Events = verifyDb
        .prepare("SELECT count(*) as count FROM events WHERE text LIKE 'worker proc2 %'")
        .get() as { count: number };
      expect(proc2Events.count).toBe(ITERATIONS_PER_WORKER);

      // Total events count
      const totalEvents = verifyDb
        .prepare("SELECT count(*) as count FROM events WHERE text LIKE 'worker %'")
        .get() as { count: number };
      expect(totalEvents.count).toBe(ITERATIONS_PER_WORKER * 2);

      // 5. Verify migrations idempotency after concurrent writes
      const postMigration = migrate(verifyDb);
      expect(postMigration.applied).toHaveLength(0);
      expect(postMigration.currentVersion).toBe(1);
    } finally {
      closeDatabase(verifyDb);
    }
  }, 30000);
});
