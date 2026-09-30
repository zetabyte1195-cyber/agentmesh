-- setup: one Claude, one Gemini, the Human; tasks A and B
-- HOW TO READ: each H-block attempts an attack. "CHECK constraint failed: msg IS NULL" = the attack SUCCEEDED (hole open).
-- A trigger error message (e.g. "Two-agent rule violation...") = the schema blocked it (hole closed). Target: every H-block shows a trigger error.
CREATE TABLE hole(msg TEXT CHECK(msg IS NULL));
INSERT INTO agents (id, name, platform, paradigm) VALUES ('claude-1','Claude','CLAUDE_CODE','CLI'), ('gemini-1','Gemini','ANTIGRAVITY','CLI'), ('human','Human','HUMAN','HUMAN');
INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('A','p','a','ac'), ('B','p','b','ac');

-- H1 (expect REJECT): a non-human resolves a Human-directed question WITHOUT setting answered_by_agent_id
INSERT INTO questions (id, from_agent_id, to_role, text) VALUES ('q1','claude-1','Human','commit policy?');
UPDATE questions SET resolved = 1, answer = 'yes, commit freely' WHERE id = 'q1';
INSERT INTO hole SELECT 'H1 HOLE: Human question resolved with no answerer' WHERE (SELECT resolved FROM questions WHERE id='q1') = 1;

-- H2 (expect REJECT): register a second "HUMAN" agent that is really Claude, then use it to self-audit
INSERT INTO agents (id, name, platform, paradigm) VALUES ('claude-as-human','Claude','CLAUDE_CODE','HUMAN');
UPDATE tasks SET status='IN_PROGRESS', assigned_agent_id='claude-1' WHERE id='A';
UPDATE tasks SET status='READY_FOR_REVIEW' WHERE id='A';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a1','A','claude-as-human','PASSED','h1',1,'self-pass via fake human');
INSERT INTO hole SELECT 'H2 HOLE: Claude passed its own task through a HUMAN-paradigm alias' WHERE (SELECT status FROM tasks WHERE id='A') = 'PASSED';

-- H3 (expect REJECT): stale PASSED audit reused after a patch-id mismatch sends the task back to review
INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('D','p','d','ac');
UPDATE tasks SET status='IN_PROGRESS', assigned_agent_id='claude-1' WHERE id='D';
UPDATE tasks SET status='READY_FOR_REVIEW', diff_hash='hash-v1' WHERE id='D';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a2','D','gemini-1','PASSED','hash-v1',1,'ok');
UPDATE tasks SET status='READY_FOR_REVIEW', diff_hash='hash-v2' WHERE id='D';
UPDATE tasks SET status='PASSED' WHERE id='D';
INSERT INTO hole SELECT 'H3 HOLE: PASSED on new diff hash-v2 using the old audit of hash-v1' WHERE (SELECT status FROM tasks WHERE id='D') = 'PASSED';

-- H4 (expect REJECT): audit of a task with no assigned author skips the platform rule entirely
UPDATE tasks SET status='IN_PROGRESS' WHERE id='B';
UPDATE tasks SET status='READY_FOR_REVIEW' WHERE id='B';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a3','B','claude-1','PASSED','h',1,'no author on record');
INSERT INTO hole SELECT 'H4 HOLE: task with NULL author audited and PASSED' WHERE (SELECT status FROM tasks WHERE id='B') = 'PASSED';

-- H5 (expect REJECT): audit diff_hash does not match the task's pinned diff_hash (spec §5.2 STALE_AUDIT_DIFF)
INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('C','p','c','ac');
UPDATE tasks SET status='IN_PROGRESS', assigned_agent_id='claude-1' WHERE id='C';
UPDATE tasks SET status='READY_FOR_REVIEW', diff_hash='real-hash' WHERE id='C';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a4','C','gemini-1','PASSED','some-other-hash',1,'reviewed a different diff');
INSERT INTO hole SELECT 'H5 HOLE: audit of a different diff accepted' WHERE (SELECT status FROM tasks WHERE id='C') = 'PASSED';
