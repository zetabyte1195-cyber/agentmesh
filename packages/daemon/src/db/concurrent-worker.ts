/**
 * Standalone worker process spawned to test concurrent SQLite writes.
 */
import { closeDatabase, openDatabase } from './connection.js';
import { withImmediateTransaction } from './transaction.js';

const args = process.argv.slice(2);
const dbPath = args[0];
const workerId = args[1];
const countStr = args[2];

if (!dbPath || !workerId || !countStr) {
  console.error('Usage: concurrent-worker <dbPath> <workerId> <count>');
  process.exit(1);
}

const count = parseInt(countStr, 10);
if (Number.isNaN(count) || count <= 0) {
  console.error('Invalid count argument:', countStr);
  process.exit(1);
}

const db = openDatabase(dbPath);

try {
  for (let i = 0; i < count; i++) {
    const eventId = `ev-${workerId}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    withImmediateTransaction(
      db,
      () => {
        // 1. Insert into the normative events table
        db.prepare(
          `INSERT INTO events (id, task_id, agent_id, kind, text, created_at)
           VALUES (?, NULL, NULL, 'status', ?, CURRENT_TIMESTAMP)`
        ).run(eventId, `worker ${workerId} item ${i}`);

        // 2. Atomically increment the shared counter
        db.prepare(
          `UPDATE _concurrent_test_counter SET val = val + 1 WHERE id = 'total'`
        ).run();
      },
      {
        maxRetries: 100,
        baseDelayMs: 15,
        maxDelayMs: 500,
      }
    );
  }
} finally {
  closeDatabase(db);
}

process.exit(0);
