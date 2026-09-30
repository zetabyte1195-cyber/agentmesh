-- Test Suite for AgentMesh SQLite Schema v1.1
-- Blocks are separated by blank lines. Each block is executed independently by sqlcheck.mjs.

-- 1. Seed agents across platforms and initial tasks
INSERT INTO agents (id, name, platform, paradigm, capabilities, status) VALUES
  ('claude-1', 'Claude Code CLI 1', 'CLAUDE_CODE', 'CLI', '["CODE", "AUDIT"]', 'ONLINE'),
  ('claude-2', 'Claude Code CLI 2', 'CLAUDE_CODE', 'CLI', '["CODE", "AUDIT"]', 'ONLINE'),
  ('gemini-1', 'Antigravity Gemini', 'ANTIGRAVITY', 'IDE', '["ARCH", "AUDIT"]', 'ONLINE'),
  ('human-user', 'Human Architect', 'HUMAN', 'HUMAN', '["ALL"]', 'ONLINE');
INSERT INTO tasks (id, phase_id, title, description, status, prerequisites, acceptance_criteria) VALUES
  ('T1', 'Phase 1', 'Scaffold core module', 'Create base structure', 'TODO', '[]', 'Module runs cleanly'),
  ('T2', 'Phase 1', 'Integrate core module', 'Wire module into app', 'TODO', '["T1"]', 'Integration test passes');

-- 2. Legal transition: Claim T1 by claude-1 (TODO -> IN_PROGRESS)
UPDATE tasks
SET status = 'IN_PROGRESS',
    assigned_agent_id = 'claude-1',
    branch_name = 'mesh/t1-scaffold'
WHERE id = 'T1';

-- 3. Illegal transition test: Direct jump from TODO -> PASSED on T2 (Must fail)
UPDATE tasks SET status = 'PASSED' WHERE id = 'T2';

-- 4. Illegal transition test: Direct jump from IN_PROGRESS -> COMMITTED on T1 (Must fail)
UPDATE tasks SET status = 'COMMITTED' WHERE id = 'T1';

-- 5. Prerequisites integrity test: Claim T2 while prerequisite T1 is IN_PROGRESS (Must fail)
UPDATE tasks
SET status = 'IN_PROGRESS',
    assigned_agent_id = 'gemini-1'
WHERE id = 'T2';

-- 6. Prerequisites integrity test: Task cannot have itself as a prerequisite (Must fail)
INSERT INTO tasks (id, phase_id, title, description, status, prerequisites, acceptance_criteria)
VALUES ('T3', 'Phase 1', 'Cyclic task', 'Self ref', 'TODO', '["T3"]', 'None');

-- 7. Author finishes work and submits T1 for review (IN_PROGRESS -> READY_FOR_REVIEW)
UPDATE tasks
SET status = 'READY_FOR_REVIEW',
    diff_hash = 'sha256-abc123diff'
WHERE id = 'T1';

-- 8. Audit precondition test: Cannot audit task T2 in TODO status (Must fail)
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
VALUES ('a0', 'T2', 'gemini-1', 'PASSED', 'sha256-diff', 1, 'Premature audit');

-- 9. Two-agent rule: Self-audit attempt by author claude-1 (Must fail)
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
VALUES ('a1', 'T1', 'claude-1', 'PASSED', 'sha256-abc123diff', 1, 'Self-approving my own work');

-- 10. Two-agent rule: Same-PLATFORM audit attempt by claude-2 on claude-1 task (Must fail)
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
VALUES ('a2', 'T1', 'claude-2', 'PASSED', 'sha256-abc123diff', 1, 'Peer from same platform reviewing');

-- 11. Cross-platform audit: gemini-1 (ANTIGRAVITY) finds gap in claude-1 task (READY_FOR_REVIEW -> REJECTED)
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
VALUES ('a3', 'T1', 'gemini-1', 'GAP_FOUND', 'sha256-abc123diff', 0, 'Found edge case gap in error handling');

-- 12. Legal transition: Author claude-1 resumes work to address audit findings (REJECTED -> IN_PROGRESS)
UPDATE tasks
SET status = 'IN_PROGRESS'
WHERE id = 'T1';

-- 13. Author resubmits fixed task for review (IN_PROGRESS -> READY_FOR_REVIEW)
UPDATE tasks
SET status = 'READY_FOR_REVIEW',
    diff_hash = 'sha256-fixed456diff'
WHERE id = 'T1';

-- 14. Human audit acceptance: human-user (HUMAN paradigm) audits T1 with PASSED (Must succeed)
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
VALUES ('a4', 'T1', 'human-user', 'PASSED', 'sha256-fixed456diff', 1, 'Verified fix and test suite passes');

-- 15. Audit immutability test: Attempt to modify historical audit record (Must fail)
UPDATE audits SET notes = 'Tampered audit notes' WHERE id = 'a4';

-- 16. Prerequisite satisfied: gemini-1 claims T2 now that T1 is PASSED (TODO -> IN_PROGRESS)
UPDATE tasks
SET status = 'IN_PROGRESS',
    assigned_agent_id = 'gemini-1'
WHERE id = 'T2';

-- 17. Merge queue landing: Fast-forward T1 onto trunk (PASSED -> COMMITTED)
UPDATE tasks
SET status = 'COMMITTED'
WHERE id = 'T1';

-- 18. Terminal state integrity test: Attempt to transition COMMITTED -> IN_PROGRESS on T1 (Must fail)
UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = 'T1';

-- 19. Questions HITL test: Non-human attempts to resolve question directed to Human (Must fail)
INSERT INTO questions (id, task_id, from_agent_id, to_role, text)
VALUES ('q1', 'T2', 'gemini-1', 'Human', 'Should we support custom port mappings?');
UPDATE questions
SET resolved = 1,
    answer = 'Yes, allow port mappings.',
    answered_by_agent_id = 'claude-1'
WHERE id = 'q1';

-- 20. Questions HITL test: Human successfully answers question directed to Human (Must succeed)
UPDATE questions
SET resolved = 1,
    answer = 'Yes, allow port mappings via config.',
    answered_by_agent_id = 'human-user'
WHERE id = 'q1';

-- 21. Lease resource type test: AST_SYMBOL is dropped in v1.1 and rejected (Must fail)
INSERT INTO leases (id, task_id, agent_id, resource_type, resource_path, expires_at)
VALUES ('l1', 'T2', 'gemini-1', 'AST_SYMBOL', 'src/core.ts', datetime('now', '+2 minutes'));

-- 22. Submission integrity test: READY_FOR_REVIEW without assigned author (Must fail)
INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, diff_hash)
VALUES ('T4', 'Phase 1', 'Unassigned task', 'AC', 'IN_PROGRESS', 'diff-hash-4');
UPDATE tasks SET status = 'READY_FOR_REVIEW' WHERE id = 'T4';

-- 23. Submission integrity test: READY_FOR_REVIEW without diff_hash (Must fail)
INSERT INTO tasks (id, phase_id, title, acceptance_criteria, status, assigned_agent_id)
VALUES ('T5', 'Phase 1', 'No diff task', 'AC', 'IN_PROGRESS', 'gemini-1');
UPDATE tasks SET status = 'READY_FOR_REVIEW' WHERE id = 'T5';

-- 24. Audit integrity test: Audit diff_hash mismatch / STALE_AUDIT_DIFF (Must fail)
UPDATE tasks SET status = 'IN_PROGRESS', diff_hash = 'pinned-diff-123' WHERE id = 'T2';
UPDATE tasks SET status = 'READY_FOR_REVIEW' WHERE id = 'T2';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes)
VALUES ('a5', 'T2', 'claude-1', 'PASSED', 'different-diff-999', 1, 'Auditing mismatch diff');

-- 25. Questions integrity test: Resolve question without answered_by_agent_id (Must fail)
INSERT INTO questions (id, task_id, from_agent_id, to_role, text)
VALUES ('q2', 'T2', 'gemini-1', 'Agent', 'Any questions?');
UPDATE questions SET resolved = 1, answer = 'Done' WHERE id = 'q2';

