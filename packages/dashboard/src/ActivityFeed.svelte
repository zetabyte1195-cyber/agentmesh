<script lang="ts">
  // What an agent is doing, as a short list that follows the newest step. What it said is set apart from what it touched; a step
  // that failed says "failed" in words. Everything is shown as text: a file name is never read as markup.
  import type { ActivityEntry } from './types';

  let { entries, running, empty = 'Nothing yet.', maxHeight = 'max-h-64' }: { entries: ActivityEntry[]; running: boolean; empty?: string; maxHeight?: string } = $props();

  let box: HTMLElement | undefined = $state();
  let stick = true;

  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const onScroll = () => {
    if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };
  // Follow the newest step, unless the person has scrolled up to read.
  $effect(() => {
    void entries.length;
    if (box && stick) box.scrollTop = box.scrollHeight;
  });
</script>

<div class="text-sm">
  {#if running}<p class="mb-1 flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-400"><span class="size-2 animate-pulse rounded-full bg-sky-500"></span>Working now</p>{/if}
  {#if entries.length === 0}
    <p class="text-xs text-stone-500">{empty}</p>
  {:else}
    <!-- A list that scrolls must be reachable with the keyboard, or a person who cannot use a mouse cannot read the older steps. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div bind:this={box} onscroll={onScroll} class={['overflow-auto rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950', maxHeight]} role="log" aria-label="What the agent is doing" aria-live="polite" tabindex="0">
      <ol class="divide-y divide-stone-200 dark:divide-stone-800">
        {#each entries as e (e.seq)}
          <li class={['flex gap-2 py-1.5 pr-2.5', e.sub ? 'bg-sky-50/60 pl-6 dark:bg-sky-950/30' : 'pl-2.5']}>
            <time class="shrink-0 font-mono text-xs text-stone-400" datetime={e.at}>{time(e.at)}</time>
            <span class={['min-w-0 break-words', e.kind === 'text' ? 'italic text-stone-600 dark:text-stone-300' : e.kind === 'end' ? 'font-semibold' : 'font-mono text-xs leading-5', e.failed ? 'text-red-700 dark:text-red-400' : '']}>{e.text}</span>
            {#if e.sub}<span class="shrink-0 text-xs text-sky-700 dark:text-sky-400" title="A step of a sub-agent the agent started">sub-agent</span>{/if}
            {#if e.repeat && e.repeat > 1}<span class="shrink-0 text-xs text-stone-500" title="The same step, {e.repeat} times in a row">×{e.repeat}</span>{/if}
            {#if e.failed}<span class="shrink-0 rounded border border-red-500 px-1 text-xs text-red-700 dark:text-red-400">failed</span>{/if}
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</div>
