<script lang="ts">
  // Navigation. On a wide screen it is a fixed column with the title block at the bottom; on a narrow one it is a
  // bar across the top whose links scroll sideways, and the title block moves to the end of the page.
  import Icon from './Icon.svelte';
  import TitleBlock from './TitleBlock.svelte';
  import type { ThemeChoice } from './theme';
  import { NAV, type View } from './views';

  let {
    view,
    badges,
    onNavigate,
    onNewMission,
    projectName,
    agentCount,
    version,
    link,
    paused,
    onTogglePause,
    theme,
    onTheme,
    error = '',
  }: {
    view: View;
    badges: Partial<Record<View, number>>;
    onNavigate: (v: View) => void;
    onNewMission: () => void;
    projectName: string;
    agentCount: number;
    version: string | null;
    link: 'connecting' | 'live' | 'lost';
    paused: boolean | null;
    onTogglePause: () => void;
    theme: ThemeChoice;
    onTheme: (t: ThemeChoice) => void;
    error?: string;
  } = $props();
</script>

<aside class="border-b border-stone-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r lg:border-b-0 dark:border-stone-800 dark:bg-stone-900">
  <div class="flex items-center justify-between gap-3 px-4 pt-3 lg:block lg:px-5 lg:pt-5">
    <div class="flex items-center gap-2">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" class="shrink-0">
        <!-- three threads crossing: the mesh -->
        <path d="M4 9h12a6 6 0 0 1 6 6v8M4 16h6a6 6 0 0 0 6-6V5M28 9H16M4 23h8a6 6 0 0 0 6-6V9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" class="text-stone-900 dark:text-stone-100" />
        <circle cx="22" cy="23" r="2.6" class="fill-marigold-400" />
      </svg>
      <span class="font-display text-lg font-semibold tracking-wide">AgentMesh</span>
    </div>
    <button class="rounded-md bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 lg:mt-4 lg:flex lg:w-full lg:items-center lg:justify-center lg:gap-1.5" onclick={onNewMission}>
      <Icon name="plus" size={16} class="hidden lg:block" />New mission
    </button>
  </div>

  <nav aria-label="Main" class="flex gap-1 overflow-x-auto px-3 py-2 lg:mt-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:px-3">
    {#each NAV as item (item.id)}
      {@const n = badges[item.id] ?? 0}
      <button
        class={['relative flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm', view === item.id ? 'bg-stone-100 font-semibold dark:bg-stone-800' : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800']}
        aria-current={view === item.id ? 'page' : undefined}
        onclick={() => onNavigate(item.id)}
      >
        {#if view === item.id}<span class="absolute inset-y-1.5 left-0 hidden w-[3px] rounded-full bg-marigold-400 lg:block"></span>{/if}
        <Icon name={item.icon} />
        <span>{item.label}</span>
        {#if n}<span class="ml-auto rounded-full bg-marigold-400 px-1.5 text-xs font-semibold text-stone-950" title="Needs you">{n}</span>{/if}
      </button>
    {/each}
  </nav>

  <div class="hidden p-4 lg:block">
    <TitleBlock {projectName} {agentCount} {version} {link} {paused} {onTogglePause} {theme} {onTheme} {error} />
  </div>
</aside>
