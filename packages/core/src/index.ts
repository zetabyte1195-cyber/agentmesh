// Shared domain vocabulary for AgentMesh. The normative definitions live in
// docs/design/schema.sql and docs/design/state-machine.md; the tests in this
// package fail if these lists drift from the schema's CHECK constraints.

export const TASK_STATUSES = [
  'DRAFT',
  'TODO',
  'BLOCKED',
  'CLAIMED',
  'IN_PROGRESS',
  'TESTING',
  'READY_FOR_REVIEW',
  'AUDITING',
  'PASSED',
  'REJECTED',
  'COMMITTED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_PARADIGMS = ['CLI', 'IDE', 'DAEMON', 'HUMAN'] as const;
export type AgentParadigm = (typeof AGENT_PARADIGMS)[number];

export const AUDIT_VERDICTS = ['PASSED', 'REJECTED', 'GAP_FOUND'] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

export const LEASE_RESOURCE_TYPES = ['FILE', 'DIR'] as const;
export type LeaseResourceType = (typeof LEASE_RESOURCE_TYPES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export * from './state-machine.js';
