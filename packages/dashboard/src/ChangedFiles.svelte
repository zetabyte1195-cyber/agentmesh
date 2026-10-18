<script lang="ts">
  // The files a task's workspace has changed, from git. Read when shown, and again a moment after the agent last did something
  // (not once per step), so it follows the work without asking git a hundred times a minute.
  import { onMount } from 'svelte';
  import { get } from './api';
  import type { ChangedFile } from './types';

  let { taskId, refresh = 0 }: { taskId: string; /** Changes whenever the agent did something. */ refresh?: number } = $props();

  type Answer = { taskId: string; workspace: boolean; files: ChangedFile[]; truncated: boolean };
  let answer = $state<Answer | null>(null);
  let error = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;

  async function load(): Promise<void> {
    try {
      answer = await get<Answer>(`/api/changes?taskId=${encodeURIComponent(taskId)}`);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => {
    void load();
    return () => clearTimeout(timer);
  });
  $effect(() => {
    void refresh;
    if (first) {
      first = false;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 1500);
  });

  const WORD = { added: 'added', modified: 'changed', deleted: 'deleted', renamed: 'renamed' } as const;
  const TONE = { added: 'text-green-700 dark:text-green-400', modified: 'text-stone-600 dark:text-stone-300', deleted: 'text-red-700 dark:text-red-400', renamed: 'text-sky-700 dark:text-sky-400' } as const;
</script>

<div class="text-sm">
  {#if error}
    <p role="alert" class="text-xs text-red-600 dark:text-red-400">Could not read the files: {error}</p>
  {:else if !answer}
    <p class="text-xs text-stone-500">Reading…</p>
  {:else if !answer.workspace}
    <p class="text-xs text-stone-500">No workspace yet: the agent has not started on this task.</p>
  {:else if answer.files.length === 0}
    <p class="text-xs text-stone-500">Nothing changed yet.</p>
  {:else}
    <p class="mb-1 text-xs text-stone-500">{answer.files.length} file{answer.files.length === 1 ? '' : 's'} changed</p>
    <ul class="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800" aria-label="Files changed">
      {#each answer.files as f (f.path)}
        <li class="flex items-baseline gap-2 px-2.5 py-1.5">
          <span class="min-w-0 flex-1 break-all font-mono text-xs">{f.path}{#if f.from}<span class="text-stone-400"> (was {f.from})</span>{/if}</span>
          <span class={['shrink-0 text-xs', TONE[f.status]]}>{WORD[f.status]}</span>
          {#if f.added === null}
            <span class="shrink-0 text-xs text-stone-500">binary</span>
          {:else if f.added || f.removed}
            <span class="shrink-0 font-mono text-xs"><span class="text-green-700 dark:text-green-400">+{f.added}</span> <span class="text-red-700 dark:text-red-400">−{f.removed}</span></span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if answer.truncated}<p class="mt-1 text-xs text-stone-500">This task changed more files than are listed.</p>{/if}
  {/if}
</div>
