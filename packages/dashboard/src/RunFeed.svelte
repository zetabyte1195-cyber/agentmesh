<script lang="ts">
  // One run's feed. When the page already holds the entries (it watched the run happen) they are shown; otherwise they are read
  // from the daemon, which keeps the feed of recent runs in memory until AgentMesh stops.
  import { onMount } from 'svelte';
  import ActivityFeed from './ActivityFeed.svelte';
  import { get } from './api';
  import type { ActivityEntry } from './types';

  let { runId, entries, running, maxHeight }: { runId: string; entries?: ActivityEntry[] | undefined; running: boolean; maxHeight?: string } = $props();

  let fetched = $state<{ kept: boolean; entries: ActivityEntry[] } | null>(null);
  let error = $state('');

  onMount(() => {
    if (entries) return;
    get<{ kept: boolean; entries: ActivityEntry[] }>(`/api/activity?runId=${encodeURIComponent(runId)}`)
      .then((a) => (fetched = a))
      .catch((e: Error) => (error = e.message));
  });
  const shown = $derived(entries ?? fetched?.entries ?? []);
</script>

{#if error}
  <p role="alert" class="text-xs text-red-600 dark:text-red-400">Could not read what this run did: {error}</p>
{:else if !entries && fetched && !fetched.kept}
  <p class="text-xs text-stone-500">What this run did is no longer kept. AgentMesh keeps the feed of recent runs, in memory, until AgentMesh stops.</p>
{:else if !entries && !fetched}
  <p class="text-xs text-stone-500">Reading…</p>
{:else}
  <ActivityFeed entries={shown} {running} {...maxHeight ? { maxHeight } : {}} />
{/if}
