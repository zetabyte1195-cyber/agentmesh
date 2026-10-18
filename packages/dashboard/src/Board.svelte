<script lang="ts">
  // The Board: every stage work moves through as a column (all of them always shown), a card per task with who has it, what it
  // waits for and what its agent is doing right now, filters for a busy project, and a panel for one task in detail.
  import { blockedBy, filterTasks, groupTasks, missionOf } from './board';
  import TaskPanel from './TaskPanel.svelte';
  import type { ActivityEntry, BoardTask, LiveRun, Run } from './types';

  type Lease = { id: string; taskId: string; agentId: string; path: string; type: string };
  type Agent = { id: string; name: string; platform: string };
  let { tasks, agents, leases, live, byRun, runs, onReleaseLocks }: { tasks: BoardTask[]; agents: Agent[]; leases: Lease[]; live: Record<string, LiveRun>; byRun: Record<string, ActivityEntry[]>; runs: Run[]; onReleaseLocks: (taskId: string) => void } = $props();

  let filters = $state({ mission: 'all', agent: 'all', text: '', hideMerged: false });
  let selectedId = $state<string | null>(null);

  const missions = $derived([...new Set(tasks.map(missionOf).filter((m): m is string => m !== null))].sort());
  const workers = $derived(agents.filter((a) => a.platform !== 'HUMAN'));
  const shown = $derived(filterTasks(tasks, filters));
  const groups = $derived(groupTasks(shown));
  const selected = $derived(tasks.find((t) => t.id === selectedId) ?? null);
  // The agent working on a task right now, with its latest step.
  const workingOn = (taskId: string) => {
    const hit = Object.entries(live).find(([, l]) => l.taskId === taskId);
    return hit ? { agentId: hit[0], ...hit[1] } : null;
  };
  const DOT: Record<string, string> = { CLAUDE_CODE: 'bg-orange-500', ANTIGRAVITY: 'bg-violet-500' };
  const dot = (agentId: string | null) => DOT[agents.find((a) => a.id === agentId)?.platform ?? ''] ?? 'bg-teal-500';

  // A task that disappears (the mission was cancelled, the board was cleaned) must not leave its panel open.
  $effect(() => {
    if (selectedId && !selected) selectedId = null;
  });

  const control = 'mt-1 rounded-lg border border-stone-300 bg-white p-1.5 text-sm dark:border-stone-700 dark:bg-stone-950';
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (selectedId = null)} />

<div class="flex flex-wrap items-end gap-x-4 gap-y-2">
  <label class="text-xs font-medium">Mission
    <select class={['block', control]} bind:value={filters.mission}>
      <option value="all">All missions</option>
      {#each missions as m (m)}<option value={m}>{m}</option>{/each}
    </select>
  </label>
  <label class="text-xs font-medium">Agent
    <select class={['block', control]} bind:value={filters.agent}>
      <option value="all">All agents</option>
      {#each workers as a (a.id)}<option value={a.id}>{a.name} ({a.id})</option>{/each}
    </select>
  </label>
  <label class="text-xs font-medium">Find a task
    <input class={['block w-44', control]} bind:value={filters.text} placeholder="id or words" autocomplete="off" />
  </label>
  <label class="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" bind:checked={filters.hideMerged} />Hide merged</label>
</div>

{#if tasks.length === 0}
  <p class="mt-4 text-sm text-stone-500">No tasks yet. They appear when you approve a mission's plan.</p>
{:else if shown.length === 0}
  <p class="mt-4 text-sm text-stone-500">No task matches. Clear the filters to see all {tasks.length}.</p>
{/if}

<div class={['mt-4 grid items-start gap-4', selected ? '2xl:grid-cols-[minmax(0,1fr)_26rem]' : '']}>
  <div class="overflow-x-auto pb-2">
    <div class="grid min-w-[78rem] grid-cols-6 gap-3">
      {#each groups as g (g.column.id)}
        <section aria-label={g.column.title} class="min-w-0 rounded-xl border border-stone-200 bg-stone-100/60 p-2 dark:border-stone-800 dark:bg-stone-900/60">
          <h3 class="flex items-baseline justify-between px-1 pb-2 text-sm font-semibold" title={g.column.hint}>{g.column.title}<span class="text-xs font-normal text-stone-500">{g.tasks.length}</span></h3>
          <ul class="grid gap-2">
            {#each g.tasks as t (t.id)}
              {@const now = workingOn(t.id)}
              {@const waits = blockedBy(t, tasks)}
              {@const locks = leases.filter((l) => l.taskId === t.id).length}
              <li>
                <button
                  class={['block w-full rounded-lg border bg-white p-2.5 text-left text-sm hover:border-stone-400 dark:bg-stone-900 dark:hover:border-stone-600', selectedId === t.id ? 'border-marigold-400 ring-1 ring-marigold-400' : 'border-stone-200 dark:border-stone-800']}
                  aria-pressed={selectedId === t.id}
                  onclick={() => (selectedId = selectedId === t.id ? null : t.id)}
                >
                  <span class="flex items-center justify-between gap-2"><span class="font-mono text-xs text-stone-500">{t.id}</span>{' '}{#if missionOf(t)}<span class="rounded border border-stone-300 px-1 text-xs text-stone-500 dark:border-stone-700">{missionOf(t)}</span>{/if}</span>{' '}
                  <span class="mt-0.5 block font-medium">{t.title}</span>{' '}
                  <span class="mt-1 flex items-center gap-1.5 text-xs text-stone-500"><span class={['size-2 shrink-0 rounded-full', dot(t.assigned_agent_id ?? t.suggested_owner)]}></span>{t.assigned_agent_id ?? `suggested: ${t.suggested_owner ?? 'anyone'}`}</span>
                  {#if now}
                    <span class="mt-1 block text-xs"><span class="flex items-center gap-1.5 font-medium text-sky-700 dark:text-sky-400"><span class="size-2 animate-pulse rounded-full bg-sky-500"></span>Working now</span>{#if now.entries.length}<span class="block truncate font-mono text-stone-600 dark:text-stone-300">{now.entries[now.entries.length - 1]!.text}</span>{/if}</span>
                  {/if}
                  {#if waits.length}<span class="mt-1 block text-xs text-amber-700 dark:text-amber-400">Blocked by {waits.join(', ')}</span>{/if}
                  {#if locks}<span class="mt-1 block text-xs text-stone-500">{locks} file lock{locks === 1 ? '' : 's'}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </div>

  {#if selected}
    {@const w = workingOn(selected.id)}
    <!-- A click outside the drawer closes it (the Close button and Escape do too). -->
    <button class="fixed inset-0 z-10 cursor-default bg-stone-950/20 2xl:hidden" tabindex="-1" aria-label="Close the task details" onclick={() => (selectedId = null)}></button>
    <!-- Beside the board on a wide screen; a drawer over its right edge on a narrower one, so the board keeps its width. -->
    <div class="fixed inset-y-0 right-0 z-20 w-full max-w-md overflow-y-auto shadow-2xl 2xl:sticky 2xl:inset-auto 2xl:top-4 2xl:z-auto 2xl:max-w-none 2xl:overflow-visible 2xl:shadow-none">
      <TaskPanel task={selected} {tasks} {leases} liveRun={w} {byRun} {runs} onClose={() => (selectedId = null)} {onReleaseLocks} />
    </div>
  {/if}
</div>
