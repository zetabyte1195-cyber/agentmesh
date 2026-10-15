<script lang="ts">
  // The title block: in an engineering drawing, the boxed corner that says which project this is, who is on it and
  // what state it is in. Here it holds the same things for the project: its name, the agents, the version, whether
  // work is being handed out, whether the cockpit is connected, and the theme. Squared on purpose: it is the one
  // part of the screen that is a drawing convention, not a card.
  import Icon from './Icon.svelte';
  import type { ThemeChoice } from './theme';

  let {
    projectName,
    agentCount,
    version,
    live,
    paused,
    onTogglePause,
    theme,
    onTheme,
    error = '',
  }: {
    projectName: string;
    agentCount: number;
    version: string | null;
    live: boolean;
    paused: boolean | null;
    onTogglePause: () => void;
    theme: ThemeChoice;
    onTheme: (t: ThemeChoice) => void;
    error?: string;
  } = $props();

  const THEMES: { id: ThemeChoice; label: string; icon: 'auto' | 'sun' | 'moon' }[] = [
    { id: 'auto', label: 'Auto', icon: 'auto' },
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'dark', label: 'Dark', icon: 'moon' },
  ];
  const cell = 'px-3 py-2';
  const label = 'text-xs text-stone-500';
  const rule = 'border-stone-300 dark:border-stone-700';
</script>

<section aria-label="This project" class={['border text-sm', rule]}>
  <div class={[cell, 'border-b', rule]}>
    <div class={label}>Project</div>
    <div class="truncate font-display text-base font-semibold" title={projectName}>{projectName}</div>
  </div>
  <div class={['grid grid-cols-2 divide-x border-b', rule, 'divide-stone-300 dark:divide-stone-700']}>
    <div class={cell}>
      <div class={label}>Agents</div>
      <div>{agentCount} connected</div>
    </div>
    <div class={cell}>
      <div class={label}>Version</div>
      <div>{version ?? 'unknown'}</div>
    </div>
  </div>
  <div class={['grid grid-cols-2 divide-x border-b', rule, 'divide-stone-300 dark:divide-stone-700']}>
    <div class={cell}>
      <div class={label}>Work is</div>
      {#if paused === null}
        <div>-</div>
      {:else}
        <div class={paused ? 'font-semibold text-amber-700' : ''}>{paused ? 'Paused' : 'Going'}</div>
        <button class="mt-1 flex items-center gap-1 rounded border border-stone-300 px-1.5 py-0.5 text-xs hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800" onclick={onTogglePause} title={paused ? 'Start handing out work again' : 'Stop handing out new work (runs already going finish)'}>
          <Icon name={paused ? 'play' : 'pause'} size={12} />{paused ? 'Resume' : 'Pause'}
        </button>
      {/if}
    </div>
    <div class={cell}>
      <div class={label}>Connection</div>
      <div class="flex items-center gap-1.5"><span class={['size-2 rounded-full', live ? 'bg-green-600 dark:bg-green-400' : 'bg-red-600 dark:bg-red-400']}></span>{live ? 'Live' : 'Offline'}</div>
    </div>
  </div>
  <div class={cell}>
    <div class={label}>Theme</div>
    <div class="mt-1 inline-flex overflow-hidden rounded border border-stone-300 dark:border-stone-700" role="group" aria-label="Theme">
      {#each THEMES as t (t.id)}
        <button
          class={['flex items-center gap-1 px-2 py-1 text-xs', theme === t.id ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900' : 'hover:bg-stone-100 dark:hover:bg-stone-800']}
          aria-pressed={theme === t.id}
          onclick={() => onTheme(t.id)}><Icon name={t.icon} size={12} />{t.label}</button>
      {/each}
    </div>
  </div>
  {#if error}<p role="alert" class={['border-t px-3 py-2 text-xs text-red-600', rule]}>{error}</p>{/if}
</section>
