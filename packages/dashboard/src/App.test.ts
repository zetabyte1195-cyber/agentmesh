// The whole cockpit mounted against a stand-in daemon: sign-in, the first screen, navigation, and the actions that
// cross screens. This is where a prop that one component expects and another does not pass would show up.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { agent, FakeSocket, fakeDaemon, mission, snapshot, stubScrolling } from './testing';

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.sockets.length = 0;
  stubScrolling();
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it; the page itself copes without.
  }
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('WebSocket', FakeSocket); // a reconnect timer may still fire after a test
});

const routes = (snap: unknown) => ({ '/api/state': snap, '/api/templates': { builtIn: [], mine: [] } });
const open = (socket = FakeSocket.sockets.at(-1)) => socket?.onopen?.();

describe('signing in', () => {
  it('explains the one-time link when the session is not valid', async () => {
    fakeDaemon({ '/api/state': { status: 401, body: { error: 'MISSING_TOKEN' } } });
    render(App);
    expect(await screen.findByText(/one-time login link/)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });
});

describe('the first screen', () => {
  it('is Home when an agent is connected, with the project named in the title block', async () => {
    fakeDaemon(routes(snapshot()));
    render(App);
    // No live connection has been opened yet: that is "connecting", not "reconnecting".
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('Nothing is running');
    expect(within(screen.getAllByRole('region', { name: 'This project' })[0]!).getByText('demo')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Home/ }).getAttribute('aria-current')).toBe('page');
  });

  it('is Setup when only the Human is connected, because that is the only useful place', async () => {
    fakeDaemon(routes(snapshot({ agents: [agent({ id: 'human', name: 'Human', platform: 'HUMAN' })] })));
    render(App);
    await waitFor(() => expect(screen.getByRole('button', { name: /Setup/ }).getAttribute('aria-current')).toBe('page'));
  });

  it('shows the live connection, and the loss of it', async () => {
    fakeDaemon(routes(snapshot()));
    render(App);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByText('Connecting…').length).toBeGreaterThan(0);
    open();
    await waitFor(() => expect(screen.getAllByText('Live').length).toBeGreaterThan(0));
    FakeSocket.sockets.at(-1)!.onclose?.();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Reconnecting'));
    expect(screen.getAllByText('Offline').length).toBeGreaterThan(0);
  });
});

describe('things that need the person', () => {
  const waiting = () =>
    snapshot({
      missions: [mission(), mission({ id: 'M2', title: 'Nightly check', status: 'PLANNING', waitingOn: ['claude-1'], plan: null })],
      notices: [{ key: 'plan:M1:v1:r1', kind: 'plan', urgent: true, title: 'Plan ready: Car wash booking', text: 'Read it first.', missionId: 'M1' }],
    });

  it('count on the sidebar and in the tab title', async () => {
    fakeDaemon(routes(waiting()));
    render(App);
    await screen.findByRole('heading', { level: 1 });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Missions/ }).textContent).toContain('1');
    expect(document.title).toContain('(1)');
  });

  it('"Read the plan" opens Missions and lands on that mission', async () => {
    fakeDaemon(routes(waiting()));
    render(App);
    await fireEvent.click(await screen.findByRole('button', { name: 'Read the plan' }));
    await waitFor(() => expect(document.activeElement?.id).toBe('mission-M1'));
    expect(screen.getByRole('button', { name: /Missions/ }).getAttribute('aria-current')).toBe('page');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('answering a question on Home sends it and refreshes the state', async () => {
    const snap = snapshot({
      notices: [{ key: 'q:q1', kind: 'question', urgent: true, title: 'gemini-1 has a question', text: 'Limit?', questionId: 'q1' }],
      openQuestions: [{ id: 'q1', text: 'Should bookings be limited?', from_agent_id: 'gemini-1', to_role: 'Human', task_id: null }],
    });
    const daemon = fakeDaemon({ ...routes(snap), '/api/answer': { ok: true } });
    render(App);
    await fireEvent.input(await screen.findByLabelText('Your answer'), { target: { value: 'One per day.' } });
    const before = daemon.calls.filter((c) => c.path === '/api/state').length;
    await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(daemon.calls.filter((c) => c.path === '/api/state').length).toBeGreaterThan(before));
    expect(daemon.posts('/api/answer')[0]!.body).toEqual({ questionId: 'q1', answer: 'One per day.' });
  });
});

describe('controls in the title block', () => {
  it('pausing sends the change and reports a refusal in plain words', async () => {
    const daemon = fakeDaemon({ ...routes(snapshot()), '/api/dispatch': { status: 403, body: { error: 'Human only' } } });
    render(App);
    await fireEvent.click((await screen.findAllByRole('button', { name: 'Pause' }))[0]!);
    await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).toBe('Human only'));
    expect(daemon.posts('/api/dispatch')[0]!.body).toEqual({ paused: true });
  });

  it('the theme choice is applied to the page and remembered', async () => {
    fakeDaemon(routes(snapshot()));
    render(App);
    await fireEvent.click((await screen.findAllByRole('button', { name: /Dark/ }))[0]!);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(Object.keys(localStorage)[0]!)).toBe('dark');
  });

  it('"New mission" opens Missions with the name box ready to type in', async () => {
    fakeDaemon(routes(snapshot()));
    render(App);
    await fireEvent.click(await screen.findByRole('button', { name: /New mission/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('m-title'));
  });
});

describe('the screens', () => {
  it('each sidebar item opens its own screen', async () => {
    fakeDaemon(routes(snapshot({ schedules: { timezone: 'UTC', max: 20, items: [], runs: [] } })));
    render(App);
    await screen.findByRole('heading', { level: 1 });
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    await fireEvent.click(nav.getByRole('button', { name: /Board/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Board' })).toBeTruthy();
    await fireEvent.click(nav.getByRole('button', { name: /Runs/ }));
    expect(await screen.findByRole('region', { name: 'Runs' })).toBeTruthy();
    await fireEvent.click(nav.getByRole('button', { name: /Schedules/ }));
    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeTruthy();
  });

  it('warns that nothing will be merged until the project check is set up', async () => {
    const snap = snapshot();
    (snap.setup.project as { landing: boolean }).landing = false;
    fakeDaemon(routes(snap));
    render(App);
    expect(await screen.findByText(/Nothing will be added to your main branch yet/)).toBeTruthy();
  });
});
