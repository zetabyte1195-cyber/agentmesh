import { describe, expect, it } from 'vitest';
import { diffLineKind, inline, parseMarkdown } from './markdown';

describe('plan Markdown (G10)', () => {
  it('reads what plans are written with', () => {
    const blocks = parseMarkdown(['# Car wash app', '', 'A **booking** page with `npm test`.', '', '## Tasks', '1. Scaffold', '2. Booking form', '   with validation', '', '- one', '- two', '', '```', 'code <b>', '```', '', '> note', '---'].join('\n'));
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list', 'code', 'quote', 'rule']);
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, content: [{ kind: 'text', text: 'Car wash app' }] });
    expect(blocks[1]).toEqual({ kind: 'paragraph', content: [{ kind: 'text', text: 'A ' }, { kind: 'bold', text: 'booking' }, { kind: 'text', text: ' page with ' }, { kind: 'code', text: 'npm test' }, { kind: 'text', text: '.' }] });
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true, items: [[{ text: 'Scaffold' }], [{ text: 'Booking form with validation' }]] });
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[5]).toEqual({ kind: 'code', text: 'code <b>' });
  });

  it('never produces markup: HTML in a plan stays text', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([{ kind: 'paragraph', content: [{ kind: 'text', text: '<script>alert(1)</script> and <img src=x onerror=alert(1)>' }] }]);
  });

  it('leaves lone asterisks and snake_case alone', () => {
    expect(inline('2 * 3 = 6 and my_var_name')).toEqual([{ kind: 'text', text: '2 * 3 = 6 and my_var_name' }]);
  });

  it('an unclosed code fence keeps the rest as code instead of losing it', () => {
    expect(parseMarkdown('```\nline 1\nline 2')).toEqual([{ kind: 'code', text: 'line 1\nline 2' }]);
  });
});

describe('diff colours (G10)', () => {
  it('tells added, removed, hunk and file lines apart', () => {
    expect(['+++ b/a.ts', '--- a/a.ts', 'diff --git a/a b/a', '@@ -1 +1 @@', '+new', '-old', ' same'].map(diffLineKind)).toEqual(['file', 'file', 'file', 'hunk', 'add', 'del', 'plain']);
  });
});
