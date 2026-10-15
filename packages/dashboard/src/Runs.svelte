<script lang="ts">
  // Runs: every agent run, newest first. "Success" from an agent tool only means it finished without an
  // error, so the newest run on each task also says whether the task actually moved.
  import { formatUsage } from './api';
  import type { Run } from './types';

  let { runs }: { runs: Run[] } = $props();

  let filter = $state<'all' | 'problems'>('all');
  let open = $state<Record<string, boolean>>({});

  const KIND: Record<string, string> = { TASK: 'Build', AUDIT: 'Review', HANDOFF: 'Message', PLAN: 'Plan', PLAN_REVIEW: 'Plan review', PLAN_REVISE: 'Plan revision', SPLIT: 'Split into tasks' };
  const STATUS: Record<string, { label: string; tone: string }> = {
    RUNNING: { label: 'Running', tone: 'border-sky-500 text-sky-700 dark:text-sky-400' },
    SUCCEEDED: { label: 'Finished', tone: 'border-green-600 text-green-700 dark:text-green-400' },
    FAILED: { label: 'Failed', tone: 'border-red-500 text-red-700 dark:text-red-400' },
    QUOTA: { label: 'Out of quota', tone: 'border-amber-500 text-amber-700 dark:text-amber-400' },
    STOPPED: { label: 'Stopped', tone: 'border-stone-400 text-stone-600 dark:text-stone-300' },
    ABANDONED: { label: 'Interrupted', tone: 'border-stone-400 text-stone-600 dark:text-stone-300' },
  };
  const problem = (r: Run) => ['FAILED', 'QUOTA', 'ABANDONED'].includes(r.status) || r.outcome === 'no-change';
  const shown = $derived(filter === 'all' ? runs : runs.filter(problem));
  const subject = (r: Run) => (r.subject?.startsWith('mission:') ? `mission ${r.subject.slice(8)}` : (r.subject ?? ''));
  const when = (iso: string) => new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const length = (s: number | null) => (s === null ? '' : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);
  const usage = (r: Run) => (r.inputTokens !== null || r.outputTokens !== null || r.costUsd !== null ? formatUsage({ runs: 1, unreported: 0, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, cacheReadTokens: 0, costUsd: r.costUsd }).replace(/^1 run · /, '') : '');
  const badge = 'rounded-full border px-2 py-0.5 text-xs font-medium';
  const chip = (on: boolean) => ['rounded-full border px-3 py-1 text-sm', on ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900' : 'border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'];
</script>

<section aria-label="Runs">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div>
      <h2 class="text-base font-semibold">Runs</h2>
      <p class="text-sm text-stone-600 dark:text-stone-300">Each time an agent was started, what it did, how long it took and what it used.</p>
    </div>
    <div class="flex gap-2" role="group" aria-label="Filter">
      <button class={chip(filter === 'all')} aria-pressed={filter === 'all'} onclick={() => (filter = 'all')}>All ({runs.length})</button>
      <button class={chip(filter === 'problems')} aria-pressed={filter === 'problems'} onclick={() => (filter = 'problems')}>Problems ({runs.filter(problem).length})</button>
    </div>
  </div>

  {#if shown.length === 0}
    <p class="mt-4 text-sm text-stone-500">{runs.length === 0 ? 'No agent has run yet. Start a mission and the runs appear here.' : 'No problems. Every run finished.'}</p>
  {:else}
    <ul class="mt-3 grid gap-2">
      {#each shown as r (r.id)}
        {@const st = STATUS[r.status] ?? { label: r.status, tone: 'border-stone-400' }}
        <li class="rounded-xl border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span class={[badge, st.tone]}>{st.label}</span>
            {#if r.outcome === 'no-change'}<span class={[badge, 'border-amber-500 text-amber-700 dark:text-amber-400']} title="The run ended without an error, but the task is exactly as it was when the run started.">Finished, but nothing changed</span>{/if}
            {#if r.outcome === 'moved'}<span class="text-xs text-green-700 dark:text-green-400">Task moved forward</span>{/if}
            <strong>{r.agentId}</strong>
            <span>{KIND[r.kind] ?? r.kind}{r.subject ? ': ' : ''}{#if r.subject}<span class="font-mono text-xs text-stone-500">{subject(r)}</span> {r.subjectTitle ?? ''}{/if}</span>
            <span class="ml-auto text-xs text-stone-500">{when(r.startedAt)}{r.seconds !== null ? ` · ${length(r.seconds)}` : ''}{usage(r) ? ` · ${usage(r)}` : ''}</span>
          </div>
          {#if r.detail}
            <button class="mt-1 text-xs underline" aria-expanded={Boolean(open[r.id])} onclick={() => (open[r.id] = !open[r.id])}>{open[r.id] ? 'Hide' : r.status === 'SUCCEEDED' ? 'What it said' : 'Why'}</button>
            {#if open[r.id]}<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-2 font-mono text-xs dark:bg-stone-950">{r.detail}</pre>{/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
