import { describe, expect, it } from 'vitest';
import { BoardService } from '../board/service.js';
import { openDatabase, closeDatabase, migrate, MIGRATIONS } from '../db/index.js';
import { IDENTITY_MIGRATION } from '../identity/index.js';
import { DISPATCH_MIGRATION } from '../dispatch/index.js';
import { MISSION_MIGRATION, MissionService } from './index.js';

describe('statement 2 probe', () => {
  // Fixed after this probe (Claude): the Human may still add a task at any time with any id, but the owner must exist.
  it('the Human may add a mission task at any time, but not for an owner that does not exist', () => {
    const db = openDatabase(':memory:');
    migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION, DISPATCH_MIGRATION, MISSION_MIGRATION]);
    const late: { missions?: MissionService } = {};
    const board = new BoardService({
      db,
      taskGuard: (p, input) => late.missions?.guardTask(p, input),
    });
    const missions = new MissionService({ db, board });
    late.missions = missions;

    const human = { agentId: 'human', platform: 'HUMAN', paradigm: 'HUMAN', isHuman: true };
    db.prepare("INSERT INTO agents (id, name, platform, paradigm) VALUES ('human', 'Human', 'HUMAN', 'HUMAN')").run();
    db.prepare("INSERT INTO agents (id, name, platform, paradigm) VALUES ('claude-1', 'Claude', 'CLAUDE_CODE', 'CLI')").run();

    const m = missions.create(human, {
      title: 'Mission 1',
      brief: 'A brief description of mission 1',
      plannerAgentId: 'claude-1',
    });
    expect(m.status).toBe('PLANNING');

    const input = { id: 'random-task-id', phase: 'mission:M1', title: 'Human task', acceptanceCriteria: 'Test AC' };
    expect(() => board.createTask(human, { ...input, suggestedOwner: 'completely-fake-agent' })).toThrow(/matches no agent/);
    const task = board.createTask(human, { ...input, suggestedOwner: 'claude' });
    expect(task.id).toBe('random-task-id');
    expect(task.suggested_owner).toBe('Claude');
    closeDatabase(db);
  });
});
