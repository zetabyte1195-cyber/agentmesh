import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_PARADIGMS, AUDIT_VERDICTS, LEASE_RESOURCE_TYPES, TASK_STATUSES, isTaskStatus } from './index.js';

const schema = readFileSync(fileURLToPath(new URL('../../../docs/design/schema.sql', import.meta.url)), 'utf8');

// Values of `CHECK(<column> IN ('A', 'B', ...))` inside `CREATE TABLE <table> (...)`.
// Several tables have a `status` column, so the search is scoped to one table's body.
function checkValues(table: string, column: string): string[] {
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(schema)?.[1];
  if (!body) throw new Error(`CREATE TABLE ${table} not found in schema.sql`);
  const list = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(body)?.[1];
  if (!list) throw new Error(`CHECK(${column} IN (...)) not found in table ${table}`);
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('core vocabulary matches docs/design/schema.sql', () => {
  it('task statuses', () => {
    expect([...TASK_STATUSES]).toEqual(checkValues('tasks', 'status'));
  });

  it('agent paradigms', () => {
    expect([...AGENT_PARADIGMS]).toEqual(checkValues('agents', 'paradigm'));
  });

  it('audit verdicts', () => {
    expect([...AUDIT_VERDICTS]).toEqual(checkValues('audits', 'verdict'));
  });

  it('lease resource types', () => {
    expect([...LEASE_RESOURCE_TYPES]).toEqual(checkValues('leases', 'resource_type'));
  });
});

describe('isTaskStatus', () => {
  it('accepts every status and rejects anything else', () => {
    for (const s of TASK_STATUSES) expect(isTaskStatus(s)).toBe(true);
    expect(isTaskStatus('DONE')).toBe(false);
    expect(isTaskStatus('passed')).toBe(false);
  });
});
