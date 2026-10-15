import type { IconName } from './Icon.svelte';

export type View = 'home' | 'missions' | 'board' | 'runs' | 'schedules' | 'setup';

export const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'missions', label: 'Missions', icon: 'missions' },
  { id: 'board', label: 'Board', icon: 'board' },
  { id: 'runs', label: 'Runs', icon: 'runs' },
  { id: 'schedules', label: 'Schedules', icon: 'schedules' },
  { id: 'setup', label: 'Setup', icon: 'setup' },
];
