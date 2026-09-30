// The daemon's state machine (packages/core, P1.3) and the database trigger
// trg_task_status_transition (schema.sql, S0.3) must agree on which status changes are
// structurally legal. This test asks real SQLite about every ordered pair of statuses.
import { TASK_STATUSES, type TaskStatus, isLegalTransition } from '@agentmesh/core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';

function dbAllows(from: TaskStatus, to: TaskStatus): boolean {
  const db = openDatabase(':memory:');
  try {
    migrate(db, MIGRATIONS);
    // "PASSED needs a matching PASSED audit" can fire before the transition trigger and would
    // mask the structural answer for every X → PASSED pair; it's a precondition, not legality.
    db.exec('DROP TRIGGER trg_task_prevent_unauthorized_pass');
    db.prepare("INSERT INTO agents (id, name, platform, paradigm) VALUES ('a1', 'A', 'P1', 'CLI')").run();
    // INSERT bypasses the transition trigger, so any starting status can be set up directly.
    db.prepare(
      `INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id, diff_hash)
       VALUES ('T', 'p', 't', 'ac', ?, 'a1', 'h')`,
    ).run(from);
    try {
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(to, 'T');
      return true;
    } catch (err) {
      // Only the transition trigger speaks to structural legality. Other triggers (e.g. "PASSED
      // needs a PASSED audit") reject a structurally legal move for a missing precondition.
      return !String((err as Error).message).includes('Illegal task status transition');
    }
  } finally {
    closeDatabase(db);
  }
}

describe('state machine ↔ database trigger parity', () => {
  const pairs = TASK_STATUSES.flatMap((from) => TASK_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));

  it('covers all 110 ordered pairs of distinct statuses', () => {
    expect(pairs).toHaveLength(110);
  });

  it.each(pairs)('%s → %s: TypeScript and SQLite agree', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(dbAllows(from, to));
  });

  it('there are exactly 32 legal transitions', () => {
    expect(pairs.filter(([from, to]) => isLegalTransition(from, to))).toHaveLength(32);
  });
});
