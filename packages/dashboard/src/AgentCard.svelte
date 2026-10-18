<script lang="ts" module>
export type AgentInfo = { id: string; name: string; platform: string; status: string; currentTaskId: string | null; doing: string | null };
</script>

<script lang="ts">
  // One agent: who it is, what it is doing, what it has used. The coloured edge is the agent's "thread" (its
  // platform's colour), the same marker used wherever the agent appears.
  import ActivityFeed from './ActivityFeed.svelte';
  import { formatUsage, type UsageTotals } from './api';
  import Icon from './Icon.svelte';
  import type { ActivityEntry } from './types';

  let { agent, used, paused = false, unavailable, activity = [], onStop }: { agent: AgentInfo; used?: UsageTotals | undefined; /** The latest steps of the run that is going (only shown while the agent is working). */ activity?: ActivityEntry[]; paused?: boolean; /** Set while this agent's platform is out of quota or otherwise backed off. */ unavailable?: { until: string; reason: string } | undefined; onStop: (id: string) => void } = $props();

  const THREAD: Record<string, string> = { CLAUDE_CODE: 'border-l-orange-500 dark:border-l-orange-500', ANTIGRAVITY: 'border-l-violet-500 dark:border-l-violet-500' };
  const DOT: Record<string, string> = { CLAUDE_CODE: 'bg-orange-500', ANTIGRAVITY: 'bg-violet-500' };
  const thread = $derived(THREAD[agent.platform] ?? 'border-l-teal-500 dark:border-l-teal-500');
  const dot = $derived(DOT[agent.platform] ?? 'bg-teal-500');
  // A run that is going is shown as going, even when new work is paused: pausing never stops it.
  // A run that is going (it has steps in the feed) is work, even before the agent has set a status of its own.
  const going = $derived(agent.status === 'BUSY' || activity.length > 0);
  const state = $derived(going ? 'Working' : agent.status === 'OFFLINE' ? 'Offline' : unavailable ? 'Unavailable' : paused ? 'Paused' : 'Idle');
  const until = $derived(unavailable ? new Date(unavailable.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const line = $derived(agent.doing && agent.doing !== 'idle' ? agent.doing : state === 'Working' ? 'Working' : state === 'Unavailable' ? `Unavailable until ${until}` : 'Waiting for work');
</script>

<article class={['rounded-lg border border-l-[3px] border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900', thread]} aria-label={agent.name}>
  <div class="flex items-center justify-between gap-2">
    <h3 class="truncate text-base font-semibold">{agent.name}<span class="ml-2 font-sans text-xs font-normal text-stone-500">{agent.id}</span></h3>
    <span class="flex shrink-0 items-center gap-1.5 rounded-full border border-stone-300 px-2 py-0.5 text-xs dark:border-stone-700">
      <span class={['size-2 rounded-full', state === 'Working' ? dot : state === 'Paused' || state === 'Unavailable' ? 'bg-marigold-400' : 'border border-stone-400 dark:border-stone-500']}></span>{state}
    </span>
  </div>
  <p class="mt-2 line-clamp-2 min-h-[2.75rem] text-sm text-stone-700 dark:text-stone-200">{line}</p>
  <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
    {#if agent.currentTaskId}<span class="rounded border border-stone-300 px-1.5 font-mono dark:border-stone-700">{agent.currentTaskId}</span>{/if}
    {#if used}<span title="What the agent tool reported. Antigravity reports tokens but no cost.">{formatUsage(used)}</span>{/if}
  </div>
  {#if activity.length}<div class="mt-3"><ActivityFeed entries={activity} running={true} maxHeight="max-h-32" /></div>{/if}
  {#if going}
    <button class="mt-3 flex items-center gap-1.5 rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950" onclick={() => onStop(agent.id)}><Icon name="stop" size={12} />Stop this run</button>
  {/if}
</article>
