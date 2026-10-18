<script lang="ts">
  // One task in detail, beside the board: what it should do, who has it, what it waits for, what the agent is doing now (or did
  // last), the files it changed, and the locks it holds.
  import ActivityFeed from './ActivityFeed.svelte';
  import { guarded, post } from './api';
  import { blockedBy, missionOf, prerequisitesOf, statusLabel } from './board';
  import ChangedFiles from './ChangedFiles.svelte';
  import RunFeed from './RunFeed.svelte';
  import type { ActivityEntry, BoardTask, LiveRun, Run } from './types';

  type Lease = { id: string; taskId: string; agentId: string; path: string; type: string };
  let { task, tasks, leases, liveRun, byRun, runs, onClose, onReleaseLocks }: { task: BoardTask; tasks: BoardTask[]; leases: Lease[]; liveRun: (LiveRun & { agentId: string }) | null; byRun: Record<string, ActivityEntry[]>; runs: Run[]; onClose: () => void; onReleaseLocks: (taskId: string) => void } = $props();

  let panel: HTMLElement | undefined = $state();
  // Keyboard and screen-reader users land in the panel when it opens (and Escape, handled by the board, closes it).
  $effect(() => {
    void task.id;
    panel?.focus({ preventScroll: true });
  });
  let busy = $state(false);
  let error = $state('');
  // When the agent left editor settings in the folder, the daemon asks first; the person's yes is a second request.
  let confirmMessage = $state('');
  const open = guarded(
    (b) => (busy = b),
    (e) => (error = e),
    async () => {
      const r = await post<{ ok: boolean; needsConfirm?: boolean; message?: string }>('/api/workspace/open', { taskId: task.id });
      confirmMessage = r.needsConfirm ? (r.message ?? 'This folder has editor settings the agent wrote. Open it anyway?') : '';
    },
  );
  const openAnyway = guarded(
    (b) => (busy = b),
    (e) => (error = e),
    async () => {
      await post('/api/workspace/open', { taskId: task.id, confirm: true });
      confirmMessage = '';
    },
  );

  const waitsFor = $derived(prerequisitesOf(task));
  const notLanded = $derived(blockedBy(task, tasks));
  const locks = $derived(leases.filter((l) => l.taskId === task.id));
  const lastRun = $derived(runs.filter((r) => r.subject === task.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null);
  const feedRun = $derived(liveRun?.runId ?? lastRun?.id ?? null);
  const mission = $derived(missionOf(task));
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
</script>

<aside bind:this={panel} tabindex="-1" aria-label="Task details" class="min-h-full rounded-xl border border-stone-200 bg-white p-4 outline-none dark:border-stone-800 dark:bg-stone-900 2xl:min-h-0">
  <div class="flex items-start justify-between gap-3">
    <h3 class="min-w-0 text-base font-semibold"><span class="font-mono text-xs font-normal text-stone-500">{task.id}</span> {task.title}</h3>
    <button class="shrink-0 text-sm underline" onclick={onClose}>Close</button>
  </div>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
    <span class="font-medium">{statusLabel(task.status)}</span>{#if task.assigned_agent_id} · {task.assigned_agent_id}{:else if task.suggested_owner} · suggested for {task.suggested_owner}{/if}{#if mission} · mission {mission}{/if}
  </p>

  {#if task.acceptance_criteria}
    <h4 class="mt-4 text-sm font-semibold">What it has to do</h4>
    <p class="mt-1 whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-200">{task.acceptance_criteria}</p>
  {/if}

  {#if waitsFor.length}
    <p class="mt-3 text-sm">
      Builds on {waitsFor.join(', ')}.
      {#if notLanded.length}<span class="font-medium text-amber-700 dark:text-amber-400">Waiting for {notLanded.join(', ')} to be merged.</span>{:else}All of it is merged.{/if}
    </p>
  {/if}

  <h4 class="mt-4 text-sm font-semibold">{liveRun ? 'What the agent is doing' : lastRun ? `Last run: ${lastRun.agentId}, ${lastRun.status.toLowerCase()}` : 'What the agent did'}</h4>
  <div class="mt-1">
    {#if feedRun}
      {#key feedRun}<RunFeed runId={feedRun} entries={byRun[feedRun]} running={Boolean(liveRun)} />{/key}
    {:else}
      <ActivityFeed entries={[]} running={false} empty="No agent has worked on this task yet." />
    {/if}
  </div>

  <h4 class="mt-4 text-sm font-semibold">Files</h4>
  <div class="mt-1">
    {#if task.status === 'COMMITTED'}
      <p class="text-xs text-stone-500">This task is merged: its files are on your main branch, and its workspace has been removed.</p>
    {:else}
      {#key task.id}<ChangedFiles taskId={task.id} refresh={feedRun ? (byRun[feedRun]?.length ?? 0) : 0} />{/key}
    {/if}
  </div>

  {#if locks.length}
    <h4 class="mt-4 text-sm font-semibold">Locked for it</h4>
    <ul class="mt-1 text-sm">{#each locks as l (l.id)}<li class="font-mono text-xs">{l.path} <span class="text-stone-500">({l.agentId})</span></li>{/each}</ul>
    <button class={['mt-2', button]} onclick={() => onReleaseLocks(task.id)}>Release the locks</button>
  {/if}

  <div class="mt-4 flex flex-wrap items-center gap-3">
    <button class={button} disabled={busy || !task.worktree_path} title={task.worktree_path ? 'Open the task\'s folder in your editor' : 'The agent has not started on this task yet'} onclick={open}>Open in editor</button>
  </div>
  <p class="mt-2 text-xs text-stone-500">What is in the folder was written by an agent and not reviewed. If your editor asks whether you trust it, say no unless you have read it.</p>
  {#if confirmMessage}
    <div role="alert" class="mt-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm dark:bg-amber-950">
      <p>{confirmMessage}</p>
      <button class={['mt-2', button]} disabled={busy} onclick={openAnyway}>Open anyway</button>
    </div>
  {/if}
  {#if error}<p role="alert" class="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>{/if}
</aside>
