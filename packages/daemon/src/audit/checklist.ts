// Per-project checklist schema validation (P1.8, Spec v1.1 §9.4, R15)
import {
  type AuditVerdict,
  type ChecklistResults,
  type ChecklistSchema,
  ChecklistValidationError,
} from './types.js';

export const DEFAULT_CHECKLIST_SCHEMA: ChecklistSchema = {
  items: [
    { id: 'tests_pass', label: 'All relevant tests pass', required: true },
    { id: 'build_clean', label: 'Build and linters pass cleanly', required: true },
    { id: 'criteria_met', label: 'All task acceptance criteria met', required: true },
  ],
};

export function validateChecklist(
  schema: ChecklistSchema | undefined,
  results: ChecklistResults | undefined,
  verdict: AuditVerdict,
): void {
  if (!schema || !schema.items || schema.items.length === 0) {
    return;
  }

  const res = results ?? {};
  const failedOrMissing: string[] = [];

  for (const item of schema.items) {
    const val = res[item.id];
    // If the audit verdict is PASSED, all required checklist items must evaluate to true
    if (item.required && verdict === 'PASSED') {
      if (val !== true) {
        failedOrMissing.push(item.id);
      }
    }
  }

  if (failedOrMissing.length > 0) {
    throw new ChecklistValidationError(
      failedOrMissing,
      `Cannot pass audit: required checklist item(s) not satisfied: ${failedOrMissing.join(', ')}`,
    );
  }
}
