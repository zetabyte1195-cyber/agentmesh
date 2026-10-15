import { describe, expect, it } from 'vitest';
import { freshNotices, titleFor, type Notice } from './notify';

const n = (key: string, urgent = true): Notice => ({ key, kind: 'question', urgent, title: key, text: '' });

describe('desktop notifications (task 1)', () => {
  it('the first look only learns what is there; later looks report what is new', () => {
    const first = freshNotices(null, [n('a'), n('b')]);
    expect(first.fresh).toEqual([]);
    const next = freshNotices(first.seen, [n('a'), n('b'), n('c')]);
    expect(next.fresh.map((x) => x.key)).toEqual(['c']);
    const after = freshNotices(next.seen, [n('c')]); // a and b were dealt with
    expect(after.fresh).toEqual([]);
    expect(freshNotices(after.seen, [n('a')]).fresh.map((x) => x.key)).toEqual(['a']); // the same key coming back is news again
  });

  it('counts only what needs you in the tab title', () => {
    expect(titleFor([])).toBe('AgentMesh Cockpit');
    expect(titleFor([n('a'), n('b'), n('done', false)])).toBe('(2) AgentMesh Cockpit');
  });
});
