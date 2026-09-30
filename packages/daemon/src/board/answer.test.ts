import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, closeDatabase, migrate, openDatabase } from '../db/index.js';
import type { SqliteDatabase } from '../db/index.js';
import { IDENTITY_MIGRATION, IdentityService, type Principal } from '../identity/index.js';
import { BoardService } from './service.js';

let db: SqliteDatabase;
let board: BoardService;
let human: Principal;
let claude: Principal;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, [...MIGRATIONS, IDENTITY_MIGRATION]);
  const ids = new IdentityService(db);
  human = ids.registerAgent({ id: 'human', name: 'Human', platform: 'HUMAN', paradigm: 'HUMAN' }).principal;
  claude = ids.registerAgent({ id: 'claude-1', name: 'Claude', platform: 'CLAUDE_CODE', paradigm: 'CLI' }).principal;
  board = new BoardService({ db, worktrees: {} as never });
  board.createTask(human, { id: 'T1', phase: 'p', title: 'a task', acceptanceCriteria: 'ok' });
});
afterEach(() => closeDatabase(db));

describe('answering a question wakes the agent that asked (it usually stopped to wait)', () => {
  it('sends the asker a handoff with the answer, so the dispatcher starts its next run, and shows it on its board', () => {
    const q = board.askQuestion(claude, { taskId: 'T1', text: 'Which\n  test command\tshould I use?', toRole: 'Human' });
    board.answerQuestion(human, q.id, 'Use node --test');
    const handoff = db.prepare("SELECT from_agent_id AS f, to_agent_id AS t, task_id AS task, message FROM handoffs WHERE task_id = 'T1'").get() as { f: string; t: string; task: string; message: string };
    expect(handoff).toMatchObject({ f: 'human', t: 'claude-1', task: 'T1' });
    expect(handoff.message).toBe('Answer to your question ("Which test command should I use?"): Use node --test'); // whitespace tidied
    expect(board.getBoard(claude).answersToYou).toEqual([{ id: q.id, taskId: 'T1', text: 'Which\n  test command\tshould I use?', answer: 'Use node --test', answeredBy: 'human' }]);
    expect(board.getBoard(human).answersToYou).toEqual([]);
  });

  it('a question not about a task has nothing to hand off to, but is still answered', () => {
    const q = board.askQuestion(claude, { text: 'Ship it?', toRole: 'Human' });
    board.answerQuestion(human, q.id, 'Yes');
    expect(db.prepare('SELECT count(*) AS n FROM handoffs').get()).toEqual({ n: 0 });
    expect(board.getBoard(claude).answersToYou).toHaveLength(1);
  });

  it('answering your own question does not message yourself, and an answered question cannot be answered twice', () => {
    const q = board.askQuestion(claude, { taskId: 'T1', text: 'Self?', toRole: 'All' });
    board.answerQuestion(claude, q.id, 'yes');
    expect(db.prepare('SELECT count(*) AS n FROM handoffs').get()).toEqual({ n: 0 });
    expect(() => board.answerQuestion(human, q.id, 'again')).toThrow(/already answered/);
    expect(db.prepare('SELECT count(*) AS n FROM handoffs').get()).toEqual({ n: 0 });
  });
});
