-- HOW TO READ: same as claude-audit-s03.sql. "CHECK constraint failed: msg IS NULL" = attack SUCCEEDED (hole open).
CREATE TABLE hole(msg TEXT CHECK(msg IS NULL));
INSERT INTO agents (id, name, platform, paradigm) VALUES ('claude-1','Claude','CLAUDE_CODE','CLI'), ('claude-2','Claude 2','CLAUDE_CODE','CLI'), ('gemini-1','Gemini','ANTIGRAVITY','CLI'), ('human','Human','HUMAN','HUMAN');
INSERT INTO tasks (id, phase_id, title, acceptance_criteria) VALUES ('E','p','e','ac'), ('F','p','f','ac');

-- H6 (expect REJECT): author deleted AFTER submission (assigned_agent_id → NULL via ON DELETE SET NULL), then a same-platform agent audits
UPDATE tasks SET status='IN_PROGRESS', assigned_agent_id='claude-1' WHERE id='E';
UPDATE tasks SET status='READY_FOR_REVIEW', diff_hash='he' WHERE id='E';
DELETE FROM agents WHERE id='claude-1';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a6','E','claude-2','PASSED','he',1,'author vanished');
INSERT INTO hole SELECT 'H6 HOLE: task PASSED by same-platform agent after author row was deleted' WHERE (SELECT status FROM tasks WHERE id='E') = 'PASSED';

-- H7 (expect REJECT): a second Claude instance relabels its platform, then audits Claude's task
INSERT INTO agents (id, name, platform, paradigm) VALUES ('claude-3','Claude 3','CLAUDE_CODE','CLI');
UPDATE tasks SET status='IN_PROGRESS', assigned_agent_id='claude-2' WHERE id='F';
UPDATE tasks SET status='READY_FOR_REVIEW', diff_hash='hf' WHERE id='F';
UPDATE agents SET platform='ANTIGRAVITY' WHERE id='claude-3';
INSERT INTO audits (id, task_id, auditor_agent_id, verdict, diff_hash, test_run_success, notes) VALUES ('a7','F','claude-3','PASSED','hf',1,'relabelled');
INSERT INTO hole SELECT 'H7 HOLE: agent changed its own platform after registration and cross-audited' WHERE (SELECT status FROM tasks WHERE id='F') = 'PASSED';

-- H8 (expect REJECT): a second well-formed Human identity
INSERT INTO agents (id, name, platform, paradigm) VALUES ('human-2','Also Human','HUMAN','HUMAN');
INSERT INTO hole SELECT 'H8 HOLE: second Human identity registered' WHERE (SELECT count(*) FROM agents WHERE paradigm='HUMAN') > 1;
