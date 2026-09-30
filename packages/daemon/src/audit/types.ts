// Audit Gate Types & Interfaces (P1.8; Spec v1.1 §9, R15)
import type { TaskStatus } from '@agentmesh/core';

export type AuditVerdict = 'PASSED' | 'REJECTED' | 'GAP_FOUND';

export interface ChecklistItem {
  id: string;
  label: string;
  required?: boolean;
  description?: string;
}

export interface ChecklistSchema {
  items: readonly ChecklistItem[];
}

export type ChecklistResults = Record<string, boolean | string | number | null | undefined>;

export interface SubmitForReviewInput {
  taskId: string;
  authorAgentId?: string;
  baseCommit?: string;
  headCommit?: string;
}

export interface SubmitForReviewResult {
  taskId: string;
  status: TaskStatus;
  diffHash: string;
  baseCommit: string;
  headCommit: string;
}

export interface ClaimAuditInput {
  taskId: string;
  auditorAgentId?: string;
}

export interface ClaimAuditResult {
  taskId: string;
  status: TaskStatus;
  auditorAgentId: string;
}

export interface SubmitAuditInput {
  taskId: string;
  auditorAgentId?: string;
  verdict: AuditVerdict;
  diffHash: string;
  /** Explicit test run success status. NEVER defaulted to true (Decision d4). */
  testRunSuccess: boolean;
  checklistResults?: ChecklistResults;
  notes: string;
}

export interface AuditRecord {
  id: string;
  taskId: string;
  auditorAgentId: string;
  verdict: AuditVerdict;
  diffHash: string;
  testRunSuccess: boolean;
  checklistResults: ChecklistResults;
  notes: string;
  createdAt: string;
}

export class AuditGateError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AuditGateError';
  }
}

export class StaleAuditDiffError extends AuditGateError {
  constructor(
    readonly taskId: string,
    readonly expectedDiffHash: string,
    readonly submittedDiffHash: string,
    message?: string,
  ) {
    super(
      message ??
        `Audit diff_hash ${submittedDiffHash.slice(0, 12)} does not match task pinned diff_hash ${expectedDiffHash.slice(0, 12)} (STALE_AUDIT_DIFF)`,
      'STALE_AUDIT_DIFF',
    );
    this.name = 'StaleAuditDiffError';
  }
}

export class InvalidCommitRangeError extends AuditGateError {
  constructor(message: string) {
    super(message, 'INVALID_COMMIT_RANGE');
    this.name = 'InvalidCommitRangeError';
  }
}

export class SamePlatformAuditError extends AuditGateError {
  constructor(
    readonly authorPlatform: string,
    readonly auditorPlatform: string,
    readonly auditorId?: string,
  ) {
    super(
      `Two-agent rule violation: auditor platform (${auditorPlatform}) cannot match author platform (${authorPlatform})`,
      'SAME_PLATFORM_AUDIT',
    );
    this.name = 'SamePlatformAuditError';
  }
}

export class MissingTestRunSuccessError extends AuditGateError {
  constructor() {
    super('Audit submission requires an explicit testRunSuccess boolean (cannot be omitted or defaulted)', 'MISSING_TEST_RUN_SUCCESS');
    this.name = 'MissingTestRunSuccessError';
  }
}

export class ChecklistValidationError extends AuditGateError {
  constructor(
    readonly missingOrFailedItems: string[],
    detail?: string,
  ) {
    super(
      detail ?? `Checklist validation failed for required item(s): ${missingOrFailedItems.join(', ')}`,
      'CHECKLIST_VALIDATION_FAILED',
    );
    this.name = 'ChecklistValidationError';
  }
}

export class UnauthorizedAuditError extends AuditGateError {
  constructor(message: string) {
    super(message, 'UNAUTHORIZED_AUDIT');
    this.name = 'UnauthorizedAuditError';
  }
}
