// The live view's parts: the feed, a task's changed files, and a run's feed that is read from the daemon when the page does not hold it.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivityFeed from './ActivityFeed.svelte';
import ChangedFiles from './ChangedFiles.svelte';
import RunFeed from './RunFeed.svelte';
import { fakeDaemon } from './testing';
import type { ActivityEntry } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const entry = (seq: number, o: Partial<ActivityEntry> = {}): ActivityEntry => ({ seq, at: '2026-10-18T10:00:05Z', kind: 'tool', text: `step ${seq}`, ...o });

describe('the feed', () => {
  it('lists what the agent did, in order, with what it said set apart from what it touched', () => {
    render(ActivityFeed, { entries: [entry(1, { kind: 'start', text: 'Started' }), entry(2, { kind: 'text', text: 'Looking at the form.' }), entry(3, { text: 'Edited src/form.ts', path: 'src/form.ts' })], running: true });
    const log = screen.getByRole('log', { name: 'What the agent is doing' });
    const items = within(log).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Started');
    expect(items[1]).toContain('Looking at the form.');
    expect(items[2]).toContain('Edited src/form.ts');
    expect(within(log).getByText('Looking at the form.').className).toMatch(/italic/); // words, not a tool call
  });

  it('says so, in words and not only in colour, when a step failed or the run failed', () => {
    render(ActivityFeed, { entries: [entry(1, { text: 'Ran npm test', failed: true }), entry(2, { kind: 'end', text: 'Failed', failed: true })], running: false });
    expect(screen.getAllByText('failed').length).toBeGreaterThanOrEqual(1);
  });

  it('shows that the run is still going, and stops saying so when it is over', () => {
    const view = render(ActivityFeed, { entries: [entry(1)], running: true });
    expect(screen.getByText('Working now')).toBeTruthy();
    view.unmount();
    render(ActivityFeed, { entries: [entry(1)], running: false });
    expect(screen.queryByText('Working now')).toBeNull();
  });

  it('shows a step that repeated once, with how many times', () => {
    render(ActivityFeed, { entries: [entry(1, { text: 'Looked up its tools', repeat: 3 }), entry(2, { text: 'Read a.ts' })], running: false });
    expect(screen.getByText('×3')).toBeTruthy();
    expect(screen.queryByText('×1')).toBeNull();
  });

  it('sets what a sub-agent did apart, and says so in words', () => {
    render(ActivityFeed, { entries: [entry(1, { text: 'Started a sub-agent: Read hello.html' }), entry(2, { text: 'Read hello.html', sub: true })], running: false });
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).not.toContain('sub-agent step');
    expect(items[1]!.textContent).toContain('sub-agent');
    expect(items[1]!.className).toMatch(/pl-/);
  });

  it('has a plain message when there is nothing yet, and shows the time of each step', () => {
    const empty = render(ActivityFeed, { entries: [], running: true, empty: 'Nothing yet.' });
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
    empty.unmount();
    render(ActivityFeed, { entries: [entry(1)], running: false });
    expect(document.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-18T10:00:05Z');
  });

  it('shows nothing but text: a file name that looks like markup is not markup', () => {
    render(ActivityFeed, { entries: [entry(1, { text: 'Wrote <img src=x onerror=alert(1)>.ts', path: '<img src=x onerror=alert(1)>.ts' })], running: false });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/Wrote <img src=x/)).toBeTruthy();
  });
});

describe('the changed files of a task', () => {
  const answer = (o: Record<string, unknown> = {}) => ({ taskId: 'T1', workspace: true, truncated: false, files: [{ path: 'src/a.ts', status: 'modified', added: 12, removed: 3 }, { path: 'b.txt', status: 'added', added: 4, removed: 0 }, { path: 'old.txt', status: 'deleted', added: 0, removed: 9 }, { path: 'img.png', status: 'added', added: null, removed: null }, { path: 'new.ts', from: 'was.ts', status: 'renamed', added: 0, removed: 0 }], ...o });

  it('lists each file with what happened to it and how many lines', async () => {
    const daemon = fakeDaemon({ '/api/changes': answer() });
    render(ChangedFiles, { taskId: 'T1', refresh: 0 });
    const list = await screen.findByRole('list', { name: 'Files changed' });
    const rows = within(list).getAllByRole('listitem').map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('src/a.ts');
    expect(rows[0]).toContain('+12');
    expect(rows[0]).toContain('−3');
    expect(rows[1]).toMatch(/b\.txt.*added|added.*b\.txt/);
    expect(rows[2]).toMatch(/deleted/);
    expect(rows[3]).toMatch(/binary/);
    expect(rows[4]).toContain('was.ts');
    expect(daemon.calls[0]!.path).toBe('/api/changes');
    expect(screen.getByText('5 files changed')).toBeTruthy();
  });

  it('says when nothing changed, when there is no workspace yet, and when the list was cut short', async () => {
    fakeDaemon({ '/api/changes': answer({ files: [] }) });
    const a = render(ChangedFiles, { taskId: 'T1', refresh: 0 });
    expect(await screen.findByText('Nothing changed yet.')).toBeTruthy();
    a.unmount();
    fakeDaemon({ '/api/changes': answer({ workspace: false, files: [] }) });
    const b = render(ChangedFiles, { taskId: 'T1', refresh: 0 });
    expect(await screen.findByText(/No workspace yet/)).toBeTruthy();
    b.unmount();
    fakeDaemon({ '/api/changes': answer({ truncated: true }) });
    render(ChangedFiles, { taskId: 'T1', refresh: 0 });
    expect(await screen.findByText(/more files than are listed/)).toBeTruthy();
  });

  it('reads again, once, a moment after the agent did something (not once per step)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const daemon = fakeDaemon({ '/api/changes': answer() });
    const view = render(ChangedFiles, { taskId: 'T1', refresh: 0 });
    await screen.findByRole('list', { name: 'Files changed' });
    expect(daemon.calls).toHaveLength(1);
    for (const n of [1, 2, 3, 4, 5]) await view.rerender({ taskId: 'T1', refresh: n });
    expect(daemon.calls).toHaveLength(1); // not yet
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(daemon.calls).toHaveLength(2));
  });

  it('says when it cannot read them', async () => {
    fakeDaemon({ '/api/changes': { status: 500, body: { error: 'boom' } } });
    render(ChangedFiles, { taskId: 'T1', refresh: 0 });
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });
});

describe('a run\'s feed', () => {
  it('uses the entries the page holds, and asks the daemon for nothing', () => {
    const daemon = fakeDaemon({});
    render(RunFeed, { runId: 'r1', entries: [entry(1, { text: 'Edited a.ts' })], running: true });
    expect(screen.getByText('Edited a.ts')).toBeTruthy();
    expect(daemon.calls).toHaveLength(0);
  });

  it('reads it from the daemon when the page does not hold it (a run from before the page was opened)', async () => {
    const daemon = fakeDaemon({ '/api/activity': { runId: 'r9', kept: true, running: false, entries: [entry(1, { text: 'Read b.ts' }), entry(2, { kind: 'end', text: 'Finished' })] } });
    render(RunFeed, { runId: 'r9', running: false });
    expect(await screen.findByText('Read b.ts')).toBeTruthy();
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(daemon.calls[0]).toMatchObject({ path: '/api/activity' });
  });

  it('says plainly that an old run is no longer kept, and why', async () => {
    fakeDaemon({ '/api/activity': { runId: 'r0', kept: false, running: false, entries: [] } });
    render(RunFeed, { runId: 'r0', running: false });
    expect(await screen.findByText(/no longer kept/)).toBeTruthy();
    expect(screen.getByText(/until AgentMesh stops/)).toBeTruthy();
  });
});
