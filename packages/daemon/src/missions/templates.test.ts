// Task 6: mission templates.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_TEMPLATES, MAX_MY_TEMPLATES, TemplateError, TemplateStore } from './templates.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'agentmesh-tpl-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

describe('built-in templates', () => {
  it('are all acceptable as a mission brief, with unique ids and something to read', () => {
    const ids = new Set<string>();
    for (const t of BUILT_IN_TEMPLATES) {
      expect(ids.has(t.id), `duplicate id ${t.id}`).toBe(false);
      ids.add(t.id);
      expect(t.builtIn).toBe(true);
      expect(t.title.length, t.id).toBeGreaterThan(3);
      expect(t.summary.length, t.id).toBeGreaterThan(10);
      expect(t.name.length, t.id).toBeLessThanOrEqual(200); // the mission name limit
      expect(t.brief.length, t.id).toBeGreaterThanOrEqual(200);
      expect(t.brief.length, t.id).toBeLessThanOrEqual(20_000); // the mission brief limit
    }
    expect(BUILT_IN_TEMPLATES.length).toBeGreaterThanOrEqual(6);
  });

  it('leave the parts the person must fill in visibly in [brackets], and do not hide an instruction in them', () => {
    const withBlanks = BUILT_IN_TEMPLATES.filter((t) => /\[[^\]]+\]/.test(t.brief));
    expect(withBlanks.length).toBeGreaterThanOrEqual(5);
    for (const t of BUILT_IN_TEMPLATES) expect(t.brief, t.id).not.toMatch(/ignore (all|any|previous)|system prompt/i);
  });
});

describe('TemplateStore', () => {
  it('saves, lists and removes a person\'s own templates', () => {
    const s = new TemplateStore(dir);
    expect(s.list()).toEqual([]);
    const a = s.save('  My shop site  ', '  A website for my shop with three pages.  ');
    expect(a).toMatchObject({ title: 'My shop site', name: 'My shop site', brief: 'A website for my shop with three pages.', builtIn: false });
    expect(a.id).toMatch(/^mine-[0-9a-f]{8}$/);
    expect(new TemplateStore(dir).list().map((t) => t.title)).toEqual(['My shop site']); // survives a restart
    s.remove(a.id);
    expect(s.list()).toEqual([]);
  });

  it('refuses a bad name or brief, an unknown id, and too many', () => {
    const s = new TemplateStore(dir);
    expect(() => s.save('', 'a long enough brief')).toThrow(TemplateError);
    expect(() => s.save('x'.repeat(81), 'a long enough brief')).toThrow(/80 characters/);
    expect(() => s.save('ok', 'short')).toThrow(/between 10 and/);
    expect(() => s.save('ok', 'y'.repeat(20_001))).toThrow(/between 10 and/);
    expect(() => s.remove('mine-00000000')).toThrow(/does not exist/);
    expect(() => s.remove('booking-page')).toThrow(/built-in templates cannot be deleted/);
    for (let i = 0; i < MAX_MY_TEMPLATES; i++) s.save(`t${i}`, 'a long enough brief');
    expect(() => s.save('one more', 'a long enough brief')).toThrow(/up to 30 templates/);
  });

  it('keeps an unreadable file aside instead of overwriting it', () => {
    writeFileSync(join(dir, 'templates.json'), '{ this is not json');
    const s = new TemplateStore(dir);
    expect(s.list()).toEqual([]);
    s.save('fresh', 'a long enough brief');
    expect(readFileSync(join(dir, 'templates.json.unreadable'), 'utf8')).toBe('{ this is not json');
    expect(s.list().map((t) => t.title)).toEqual(['fresh']);
  });

  it('ignores entries of the wrong shape', () => {
    writeFileSync(join(dir, 'templates.json'), JSON.stringify([{ id: 'a', title: 'ok', brief: 'a long enough brief' }, { id: 5 }, null, 'x']));
    expect(new TemplateStore(dir).list().map((t) => t.id)).toEqual(['a']);
  });
});
