import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar.svelte';
import type { ThemeChoice } from './theme';
import TitleBlock from './TitleBlock.svelte';
import type { View } from './views';

type Block = { projectName: string; agentCount: number; version: string | null; link: 'connecting' | 'live' | 'lost'; paused: boolean | null; onTogglePause: () => void; theme: ThemeChoice; onTheme: (t: ThemeChoice) => void; error?: string };
type Side = Block & { view: View; badges: Partial<Record<View, number>>; onNavigate: (v: View) => void; onNewMission: () => void };

const block = (o: Partial<Block> = {}): Block => ({ projectName: 'demo', agentCount: 2, version: '0.2.0', link: 'live', paused: false, onTogglePause: vi.fn(), theme: 'auto', onTheme: vi.fn(), ...o });
const side = (o: Partial<Side> = {}): Side => ({ view: 'home', badges: {}, onNavigate: vi.fn(), onNewMission: vi.fn(), ...block(), ...o });

describe('the sidebar', () => {
  it('marks the screen you are on, and goes to the others', async () => {
    const onNavigate = vi.fn();
    render(Sidebar, side({ view: 'board', onNavigate }));
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(nav.getByRole('button', { name: /Board/ }).getAttribute('aria-current')).toBe('page');
    expect(nav.getByRole('button', { name: /Home/ }).getAttribute('aria-current')).toBeNull();
    await fireEvent.click(nav.getByRole('button', { name: /Runs/ }));
    expect(onNavigate).toHaveBeenCalledWith('runs');
  });

  it('shows how many things wait on you next to the screen they are on, and nothing when none', () => {
    render(Sidebar, side({ badges: { missions: 2, board: 1 } }));
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(nav.getByRole('button', { name: /Missions/ }).textContent).toContain('2');
    expect(nav.getByRole('button', { name: /Board/ }).textContent).toContain('1');
    expect(nav.getByRole('button', { name: /Schedules/ }).textContent).not.toMatch(/\d/);
  });

  it('"New mission" is always one click away', async () => {
    const onNewMission = vi.fn();
    render(Sidebar, side({ onNewMission }));
    await fireEvent.click(screen.getByRole('button', { name: /New mission/ }));
    expect(onNewMission).toHaveBeenCalled();
  });
});

describe('the title block', () => {
  it('names the project, the agents and the version', () => {
    render(TitleBlock, block());
    const box = within(screen.getByRole('region', { name: 'This project' }));
    expect(box.getByText('demo')).toBeTruthy();
    expect(box.getByText('2 connected')).toBeTruthy();
    expect(box.getByText('0.2.0')).toBeTruthy();
    expect(box.getByText('Live')).toBeTruthy();
  });

  it('says when the connection is gone, and is not alarmed before it has ever been made', () => {
    const lost = render(TitleBlock, block({ link: 'lost' }));
    expect(screen.getByText('Offline')).toBeTruthy();
    lost.unmount();
    render(TitleBlock, block({ link: 'connecting' }));
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
  });

  it('pauses while going, and resumes while paused', async () => {
    const onTogglePause = vi.fn();
    const going = render(TitleBlock, block({ onTogglePause }));
    expect(screen.getByText('Going')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    going.unmount();
    render(TitleBlock, block({ onTogglePause, paused: true }));
    expect(screen.getByText('Paused')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onTogglePause).toHaveBeenCalledTimes(2);
  });

  it('shows nothing to press until it is known whether work is paused', () => {
    render(TitleBlock, block({ paused: null }));
    expect(screen.queryByRole('button', { name: /Pause|Resume/ })).toBeNull();
  });

  it('offers Auto, Light and Dark, shows the chosen one, and reports a change', async () => {
    const onTheme = vi.fn();
    render(TitleBlock, block({ theme: 'dark', onTheme }));
    const group = within(screen.getByRole('group', { name: 'Theme' }));
    expect(group.getByRole('button', { name: /Dark/ }).getAttribute('aria-pressed')).toBe('true');
    expect(group.getByRole('button', { name: /Light/ }).getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(group.getByRole('button', { name: /Light/ }));
    expect(onTheme).toHaveBeenCalledWith('light');
  });

  it('shows an error from a control, as an alert', () => {
    render(TitleBlock, block({ error: 'Human only' }));
    expect(screen.getByRole('alert').textContent).toBe('Human only');
  });
});
