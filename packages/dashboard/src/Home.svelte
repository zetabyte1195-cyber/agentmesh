<script lang="ts">
  // Home: the answer to "what is happening and does it need me?". The headline says it in one sentence, the tray
  // under it holds the things only you can do, and the rest is a read-only picture of the agents, the work and
  // what it has cost. A question can be answered and a failed run retried right here; everything else leads to the
  // screen that owns it.
  import type { UsageTotals } from './api';
  import AgentCard, { type AgentInfo } from './AgentCard.svelte';
  import { compactNumber, distance, firstSteps, headline, nextSchedule, spendTotals, subline, taskSegments } from './home';
  import NoticeCard from './NoticeCard.svelte';
  import type { LiveRun, Notice, Run, SchedulesState } from './types';
  import type { View } from './views';

  type HomeMission = { id: string; title: string; status: string; waitingOn: string[]; progress: { total: number; committed: number }; budget?: { reached: string | null } | null };
  let {
    connected,
    agents,
    tasks,
    missions,
    notices,
    questions,
    schedules,
    usage,
    runs,
    backoffs,
    paused,
    landing,
    live = {},
    onNavigate,
    onStop,
    onChanged,
  }: {
    connected: boolean;
    agents: AgentInfo[];
    tasks: { status: string }[];
    missions: HomeMission[];
    notices: Notice[];
    questions: { id: string; text: string }[];
    schedules: SchedulesState | null;
    usage: ({ agentId: string } & UsageTotals)[];
    runs: Run[];
    backoffs: { platform: string; until: string; reason: string }[];
    paused: boolean;
    /** Whether the project's check is set up (so finished work can be merged). */
    landing: boolean;
    /** What each agent that is working is doing right now. */
    live?: Record<string, LiveRun>;
    onNavigate: (v: View, focus?: string) => void;
    onStop: (agentId: string) => void;
    onChanged: () => void;
  } = $props();

  // A clock that moves every half minute, so "in 3 hours" does not go stale on a screen left open.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const workers = $derived(agents.filter((a) => a.platform !== 'HUMAN'));
  const head = $derived(headline({ connected, notices, agents, missions }));
  const seg = $derived(taskSegments(tasks));
  const spend = $derived(spendTotals(usage));
  const next = $derived(nextSchedule(schedules?.items ?? []));
  const activeMissions = $derived(missions.filter((m) => !['DONE', 'CANCELLED'].includes(m.status)));
  const recent = $derived(runs.slice(0, 5));
  const steps = $derived(firstSteps({ workers: workers.length, landing, missions: missions.length }));

  const MISSION_LABEL: Record<string, string> = { PLANNING: 'Writing the plan', REVIEWING: 'Being reviewed', REVISING: 'Merging the feedback', PLAN_READY: 'Waiting for you', SPLITTING: 'Splitting into tasks', IMPLEMENTING: 'Being built' };
  const RUN_LABEL: Record<string, string> = { RUNNING: 'Running', SUCCEEDED: 'Finished', FAILED: 'Failed', QUOTA: 'Out of quota', STOPPED: 'Stopped', ABANDONED: 'Interrupted' };
  const RUN_KIND: Record<string, string> = { TASK: 'Build', AUDIT: 'Review', HANDOFF: 'Message', PLAN: 'Plan', PLAN_REVIEW: 'Plan review', PLAN_REVISE: 'Plan revision', SPLIT: 'Split into tasks' };
  const usedBy = (id: string) => usage.find((u) => u.agentId === id);
  const at = (iso: string) => Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const clock = (iso: string) => new Date(at(iso)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ago = (iso: string) => {
    const m = Math.max(0, Math.round((now - at(iso)) / 60_000));
    return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const subject = (r: Run) => (r.subject?.startsWith('mission:') ? `mission ${r.subject.slice(8)}` : (r.subject ?? ''));
  const percent = (n: number, of: number) => (of ? `${(n / of) * 100}%` : '0%');

  const tile = 'flex w-full flex-col justify-start rounded-lg border border-stone-200 bg-white p-4 text-left hover:border-stone-400 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-600';
  const tileLabel = 'text-xs text-stone-500';
  const panel = 'rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900';
</script>

<div class="grid grid-cols-1 gap-6">
  <header>
    <h1 class="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
      {#if head.tone === 'attention'}<span class="mr-3 inline-block h-[0.8em] w-1 translate-y-[0.1em] rounded-full bg-marigold-400" aria-hidden="true"></span>{/if}{head.text}
    </h1>
    <p class="mt-1 text-stone-600 dark:text-stone-300">{subline(agents, missions)}{paused ? '. Work is paused' : ''}</p>
  </header>

  {#each backoffs as b (b.platform)}
    <p class="rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm dark:bg-amber-950"><strong>{b.platform}</strong> is unavailable until {clock(b.until)}. <span class="text-stone-600 dark:text-stone-300">{b.reason}</span></p>
  {/each}

  {#if notices.length}
    <section aria-label="Needs you" class="grid grid-cols-1 gap-2">
      {#each notices as n (n.key)}
        <NoticeCard notice={n} question={n.questionId ? (questions.find((q) => q.id === n.questionId)?.text ?? null) : null} {onNavigate} {onChanged} />
      {/each}
    </section>
  {/if}

  {#if steps}
    <section aria-label="Getting started" class={[panel, 'p-4']}>
      <h2 class="font-display text-lg font-semibold">Getting started</h2>
      <ol class="mt-2 grid grid-cols-1 gap-2">
        {#each steps as step, i (step.id)}
          <li class="flex items-center gap-3 text-sm">
            <span class={['grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold', step.done ? 'border-green-600 bg-green-600 text-white dark:border-green-400 dark:bg-green-400 dark:text-stone-950' : 'border-stone-400 dark:border-stone-500']} aria-hidden="true">{step.done ? '✓' : i + 1}</span>
            <span class={step.done ? 'text-stone-500 line-through dark:text-stone-400' : 'font-semibold'}>{step.text}{step.done ? ' (done)' : ''}</span>
            {#if !step.done}<button class="ml-auto shrink-0 rounded-md border border-stone-300 px-2.5 py-1 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800" onclick={() => onNavigate(step.view)}>{step.action}</button>{/if}
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  <section aria-label="At a glance" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    <button class={tile} onclick={() => onNavigate('board')}>
      <div class={tileLabel}>Tasks</div>
      <div class="mt-1 font-display text-2xl font-semibold">{seg.total ? `${seg.done} of ${seg.total} merged` : 'None yet'}</div>
      <div class="mt-3 flex h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800" role="img" aria-label={`${seg.done} merged, ${seg.review} in review, ${seg.working} being built, ${seg.todo} waiting`}>
        <span class="bg-green-600 dark:bg-green-400" style:width={percent(seg.done, seg.total)}></span>
        <span class="bg-violet-500" style:width={percent(seg.review, seg.total)}></span>
        <span class="bg-marigold-400" style:width={percent(seg.working, seg.total)}></span>
      </div>
      <div class="mt-2 text-xs text-stone-500">{seg.review} in review, {seg.working} being built, {seg.todo} waiting</div>
    </button>

    <button class={tile} onclick={() => onNavigate('runs')}>
      <div class={tileLabel}>Used so far</div>
      <div class="mt-1 font-display text-2xl font-semibold">{spend.costUsd !== null ? `$${spend.costUsd.toFixed(2)}` : spend.tokens ? `${compactNumber(spend.tokens)} tokens` : 'Nothing yet'}</div>
      <div class="mt-3 text-xs text-stone-500">
        {spend.runs} run{spend.runs === 1 ? '' : 's'}{spend.costUsd !== null && spend.tokens ? `, ${compactNumber(spend.tokens)} tokens` : ''}{spend.cachedTokens ? `, ${compactNumber(spend.cachedTokens)} read from cache` : ''}{spend.unreportedRuns ? `, ${spend.unreportedRuns} reported nothing` : ''}
      </div>
    </button>

    <button class={tile} onclick={() => onNavigate('schedules')}>
      <div class={tileLabel}>Next scheduled mission</div>
      {#if next}
        <div class="mt-1 truncate font-display text-2xl font-semibold" title={next.name}>{distance(now, at(next.nextRunAt!))}</div>
        <div class="mt-3 truncate text-xs text-stone-500">{next.name}, {next.when}</div>
      {:else}
        <div class="mt-1 font-display text-2xl font-semibold">None</div>
        <div class="mt-3 text-xs text-stone-500">Set one to start a mission on a timetable</div>
      {/if}
    </button>
  </section>

  <section aria-label="Agents">
    <h2 class="mb-2 font-display text-lg font-semibold">Agents</h2>
    {#if workers.length}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {#each workers as agent (agent.id)}
          <AgentCard {agent} used={usedBy(agent.id)} {paused} unavailable={backoffs.find((b) => b.platform === agent.platform)} activity={live[agent.id]?.entries ?? []} {onStop} />
        {/each}
      </div>
    {:else}
      <div class={[panel, 'p-4 text-sm']}>
        No agent is connected. <button class="font-semibold underline" onclick={() => onNavigate('setup')}>Connect one in Setup</button>, then describe what you want built.
      </div>
    {/if}
  </section>

  <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
    <section aria-label="Missions in progress">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="font-display text-lg font-semibold">Missions</h2>
        <button class="text-sm underline" onclick={() => onNavigate('missions')}>All missions</button>
      </div>
      {#if activeMissions.length}
        <ul class="grid grid-cols-1 gap-2">
          {#each activeMissions as m (m.id)}
            <li>
              <button class={[panel, 'block w-full p-3 text-left hover:border-stone-400 dark:hover:border-stone-600']} onclick={() => onNavigate('missions', `mission-${m.id}`)}>
                <div class="flex items-baseline justify-between gap-3">
                  <span class="truncate font-semibold">{m.title}</span>
                  <span class={['shrink-0 text-xs', m.budget?.reached ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-stone-500']}>{m.budget?.reached ? 'Stopped: limit reached' : (MISSION_LABEL[m.status] ?? m.status)}</span>
                </div>
                {#if m.progress.total}
                  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800"><span class="block h-full bg-green-600 dark:bg-green-400" style:width={percent(m.progress.committed, m.progress.total)}></span></div>
                  <div class="mt-1 text-xs text-stone-500">{m.progress.committed} of {m.progress.total} tasks merged</div>
                {/if}
                {#if m.waitingOn.length}<div class="mt-1 text-xs text-stone-500">Waiting on {m.waitingOn.map((w) => (w === 'human' ? 'you' : w)).join(', ')}</div>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <div class={[panel, 'p-4 text-sm text-stone-600 dark:text-stone-300']}>No mission is in progress. Press <strong>New mission</strong> and describe what you want built.</div>
      {/if}
    </section>

    <section aria-label="Recent runs">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="font-display text-lg font-semibold">Recent runs</h2>
        <button class="text-sm underline" onclick={() => onNavigate('runs')}>All runs</button>
      </div>
      {#if recent.length}
        <ul class={[panel, 'divide-y divide-stone-200 dark:divide-stone-800']}>
          {#each recent as r (r.id)}
            <li class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
              <span class={['font-semibold', r.status === 'FAILED' || r.status === 'QUOTA' ? 'text-red-700 dark:text-red-400' : r.status === 'RUNNING' ? 'text-sky-700 dark:text-sky-400' : '']}>{RUN_LABEL[r.status] ?? r.status}</span>
              {#if r.outcome === 'no-change'}<span class="text-xs text-amber-700 dark:text-amber-400" title="The run ended without an error, but the task is exactly as it was when the run started.">nothing changed</span>{/if}
              <span class="truncate">{r.agentId}, {RUN_KIND[r.kind] ?? r.kind}{r.subject ? ` ${subject(r)}` : ''}</span>
              <span class="ml-auto text-xs text-stone-500">{ago(r.startedAt)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <div class={[panel, 'p-4 text-sm text-stone-600 dark:text-stone-300']}>No agent has run yet. Start a mission and the runs appear here.</div>
      {/if}
    </section>
  </div>
</div>
