<script lang="ts">
  // Missions: one brief → a plan by the agent you pick → the other agents look for gaps → YOU decide →
  // the agents split it into tasks and build it. This screen is where the Human steers all of that.
  import Markdown from './Markdown.svelte';
  import { onMount } from 'svelte';
  import { formatUsage, get, post, type UsageTotals } from './api';

  type Agent = { id: string; name: string; platform: string };
  type Review = { round: number; planVersion: number; reviewer: string; verdict: 'OK' | 'GAPS'; gaps: string };
  type MissionTask = { id: string; title: string; status: string; owner: string | null; suggestedOwner: string | null };
  type Mission = {
    id: string;
    title: string;
    brief: string;
    status: string;
    planner: string;
    reviewers: string[];
    round: number;
    maxRounds: number;
    plan: { version: number; author: string; body: string } | null;
    reviews: Review[];
    waitingOn: string[];
    tasks: MissionTask[];
    progress: { total: number; committed: number };
  };

  let { missions, agents, usage = [], onChanged }: { missions: Mission[]; agents: Agent[]; usage?: ({ missionId: string } & UsageTotals)[]; onChanged: () => void } = $props();

  const STEPS = ['Plan', 'Review', 'Revise', 'Your call', 'Tasks', 'Build', 'Done'];
  const STEP_OF: Record<string, number> = { PLANNING: 0, REVIEWING: 1, REVISING: 2, PLAN_READY: 3, SPLITTING: 4, IMPLEMENTING: 5, DONE: 6 };
  const LABEL: Record<string, string> = {
    PLANNING: 'Writing the plan',
    REVIEWING: 'Being reviewed',
    REVISING: 'Merging the feedback',
    PLAN_READY: 'Waiting for you',
    SPLITTING: 'Splitting into tasks',
    IMPLEMENTING: 'Being built',
    DONE: 'Done',
    CANCELLED: 'Cancelled',
  };

  const workers = $derived(agents.filter((a) => a.platform !== 'HUMAN'));
  const nameOf = (id: string) => (id === 'human' ? 'You' : (workers.find((a) => a.id === id)?.name ?? id));
  const who = (id: string) => (id === 'human' ? 'You' : `${nameOf(id)} (${id})`);

  // ── start a mission ──
  let title = $state('');
  let brief = $state('');
  let planner = $state('');
  let skipped = $state<Record<string, boolean>>({});
  let startBusy = $state(false);
  let startError = $state('');

  $effect(() => {
    if (!planner && workers.length) planner = workers[0]!.id;
  });
  const reviewerChoices = $derived(workers.filter((a) => a.id !== planner));
  const chosenReviewers = $derived(reviewerChoices.filter((a) => !skipped[a.id]).map((a) => a.id));

  async function start(): Promise<void> {
    startBusy = true;
    startError = '';
    try {
      await post('/api/missions', { title: title.trim(), brief: brief.trim(), plannerAgentId: planner, reviewerAgentIds: chosenReviewers });
      title = '';
      brief = '';
      onChanged();
    } catch (e) {
      startError = (e as Error).message;
    } finally {
      startBusy = false;
    }
  }

  // ── starter briefs ──
  type Template = { id: string; title: string; summary: string; name: string; brief: string; tip?: string; builtIn: boolean };
  let templates = $state<{ builtIn: Template[]; mine: Template[] }>({ builtIn: [], mine: [] });
  let tip = $state('');
  let templateMessage = $state('');
  async function loadTemplates(): Promise<void> {
    try {
      templates = await get<{ builtIn: Template[]; mine: Template[] }>('/api/templates');
    } catch {
      // the form still works without starter briefs
    }
  }
  onMount(() => void loadTemplates());
  function pick(t: Template): void {
    title = t.name;
    brief = t.brief;
    tip = t.tip ?? '';
    templateMessage = '';
  }
  const blanks = $derived(/\[[^\]]+\]/.test(brief));
  async function saveTemplate(): Promise<void> {
    templateMessage = '';
    try {
      await post('/api/templates/save', { title: title.trim(), brief: brief.trim() });
      templateMessage = 'Saved. It now appears with the starter ideas above.';
      await loadTemplates();
    } catch (e) {
      templateMessage = (e as Error).message;
    }
  }
  async function deleteTemplate(id: string): Promise<void> {
    try {
      await post('/api/templates/delete', { id });
      await loadTemplates();
    } catch (e) {
      templateMessage = (e as Error).message;
    }
  }

  // ── steer one mission ──
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let notes = $state<Record<string, string>>({});
  let showBrief = $state<Record<string, boolean>>({});

  async function act(key: string, path: string, body: Record<string, unknown>): Promise<void> {
    busy[key] = true;
    errors[key] = '';
    try {
      await post(path, body);
      notes[key] = '';
      onChanged();
    } catch (e) {
      errors[key] = (e as Error).message;
    } finally {
      busy[key] = false;
    }
  }

  const latestReviews = (m: Mission) => m.reviews.filter((r) => r.round === m.round || r.reviewer === 'human');
  const badge = 'rounded-full border px-2 py-0.5 text-xs font-medium';
  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<section aria-label="Start a mission" class="mb-6 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="text-base font-semibold">What do you want built?</h2>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
    Describe it once. The agent you pick writes a plan, the others look for gaps, and nothing gets built until you say so.
  </p>
  {#if workers.length === 0}
    <p class="mt-3 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm dark:bg-amber-950">No agents are connected yet. Open <strong>Setup</strong> and connect at least one.</p>
  {:else}
    <p class="mt-3 text-xs font-medium" id="tpl-label">Start from an idea (optional)</p>
    <div class="mt-1 flex flex-wrap gap-2" role="group" aria-labelledby="tpl-label">
      {#each [...templates.builtIn, ...templates.mine] as t (t.id)}
        <div class="flex items-stretch rounded-lg border border-stone-300 dark:border-stone-700">
          <button class="px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800" onclick={() => pick(t)} title={t.summary}>
            <span class="block text-sm font-medium">{t.title}</span>
            <span class="block text-xs text-stone-500">{t.summary}</span>
          </button>
          {#if !t.builtIn}<button class="border-l border-stone-300 px-2 text-stone-500 hover:text-red-700 dark:border-stone-700" aria-label={`Delete the template ${t.title}`} title="Delete this template" onclick={() => deleteTemplate(t.id)}>×</button>{/if}
        </div>
      {/each}
    </div>
    <label class="mt-3 block text-xs font-medium" for="m-title">Name</label>
    <input id="m-title" class={field} placeholder="e.g. Car wash booking app" maxlength="200" bind:value={title} />
    <label class="mt-3 block text-xs font-medium" for="m-brief">The brief</label>
    <textarea id="m-brief" class={field} rows="9" placeholder="Who is it for, what should it do, anything that must or must not be in it." bind:value={brief}></textarea>
    {#if blanks}<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">The parts in [square brackets] are for you to fill in: replace them with your own details.</p>{/if}
    {#if tip}<p class="mt-1 text-xs text-stone-500">Tip: {tip}</p>{/if}
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <label class="text-xs font-medium">Who writes the plan
        <select class={field} bind:value={planner}>
          {#each workers as a (a.id)}<option value={a.id}>{a.name} ({a.id})</option>{/each}
        </select>
      </label>
      <fieldset>
        <legend class="text-xs font-medium">Who looks for gaps</legend>
        {#each reviewerChoices as a (a.id)}
          <label class="mt-1 mr-4 inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={!skipped[a.id]} onchange={(e) => (skipped[a.id] = !e.currentTarget.checked)} /> {a.name}</label>
        {:else}
          <p class="mt-1 text-sm text-stone-500">Nobody else is connected, so the plan comes straight to you.</p>
        {/each}
      </fieldset>
    </div>
    <div class="mt-3 flex items-center gap-3">
      <button class={primary} disabled={startBusy || !title.trim() || brief.trim().length < 10 || !planner} onclick={start}>{startBusy ? 'Starting…' : 'Start'}</button>
      <button class={button} disabled={!title.trim() || brief.trim().length < 10} title="Keep this name and brief to start from again later" onclick={saveTemplate}>Save as a template</button>
      {#if startError}<span role="alert" class="text-sm text-red-600">{startError}</span>{/if}
      {#if templateMessage}<span class="text-sm text-stone-600 dark:text-stone-300" aria-live="polite">{templateMessage}</span>{/if}
    </div>
  {/if}
</section>

{#each missions as m (m.id)}
  {@const step = STEP_OF[m.status] ?? -1}
  <article class="mb-4 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900" aria-label={`Mission ${m.id}: ${m.title}`}>
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-base font-semibold"><span class="mr-2 font-mono text-xs text-stone-500">{m.id}</span>{m.title}</h2>
      <span class={[badge, m.status === 'PLAN_READY' ? 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : m.status === 'DONE' ? 'border-green-600 text-green-700' : m.status === 'CANCELLED' ? 'border-stone-400 text-stone-500' : 'border-stone-400']}>{LABEL[m.status] ?? m.status}</span>
    </header>

    {#if step >= 0}
      <ol class="mt-3 flex flex-wrap gap-1 text-xs" aria-label="Progress">
        {#each STEPS as s, i (s)}
          <li class={['rounded-full px-2 py-0.5', i < step ? 'bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300' : i === step ? 'bg-stone-900 font-semibold text-white dark:bg-stone-100 dark:text-stone-900' : 'text-stone-400']} aria-current={i === step ? 'step' : undefined}>{s}</li>
        {/each}
      </ol>
    {/if}
    {#if m.waitingOn.length}<p class="mt-2 text-sm text-stone-600 dark:text-stone-300" aria-live="polite">Waiting on: <strong>{m.waitingOn.map(who).join(', ')}</strong></p>{/if}

    <button class="mt-2 text-xs underline" aria-expanded={Boolean(showBrief[m.id])} onclick={() => (showBrief[m.id] = !showBrief[m.id])}>{showBrief[m.id] ? 'Hide the brief' : 'Show the brief'}</button>
    {#if showBrief[m.id]}<p class="mt-1 whitespace-pre-wrap rounded-lg bg-stone-100 p-2 text-sm dark:bg-stone-950">{m.brief}</p>{/if}

    {#if m.plan}
      <details class="mt-3" open={m.status === 'PLAN_READY'}>
        <summary class="cursor-pointer text-sm font-semibold">The plan (version {m.plan.version}, by {nameOf(m.plan.author)})</summary>
        <div class="mt-2 max-h-[32rem] overflow-auto rounded-lg bg-stone-100 p-3 dark:bg-stone-950"><Markdown source={m.plan.body} /></div>
      </details>
    {/if}

    {#if latestReviews(m).length}
      <div class="mt-3">
        <h3 class="text-sm font-semibold">What the reviewers said</h3>
        {#each latestReviews(m) as r, i (i)}
          <div class="mt-2 rounded-lg border border-stone-200 p-2 text-sm dark:border-stone-800">
            <span class={[badge, r.verdict === 'OK' ? 'border-green-600 text-green-700' : 'border-amber-500 text-amber-700']}>{r.verdict === 'OK' ? 'No gaps' : 'Gaps'}</span>
            <strong class="ml-2">{r.reviewer === 'human' ? 'You' : nameOf(r.reviewer)}</strong>
            {#if r.gaps}<div class="mt-1"><Markdown source={r.gaps} /></div>{/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if m.status === 'PLAN_READY'}
      <div class="mt-4 rounded-lg border border-amber-500 bg-amber-50 p-3 dark:bg-amber-950">
        <p class="text-sm font-semibold">Your call. Nothing is built until you approve.</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button class={primary} disabled={busy[`${m.id}-approve`]} onclick={() => act(`${m.id}-approve`, '/api/missions/approve', { missionId: m.id })}>Approve and build</button>
          <button class={button} disabled={busy[`${m.id}-round`] || m.reviewers.length === 0 || m.round >= m.maxRounds} title={m.reviewers.length === 0 ? 'Nobody to review' : m.round >= m.maxRounds ? `All ${m.maxRounds} review rounds used` : 'Everyone reviews the current plan again'} onclick={() => act(`${m.id}-round`, '/api/missions/round', { missionId: m.id })}>Another review round ({m.round} of {m.maxRounds} used)</button>
        </div>
        <label class="mt-3 block text-xs font-medium" for={`changes-${m.id}`}>Or tell the planner what to change</label>
        <textarea id={`changes-${m.id}`} class={field} rows="2" placeholder="e.g. Keep it a single static page, no backend." bind:value={notes[`${m.id}-changes`]}></textarea>
        <button class={['mt-2', button]} disabled={busy[`${m.id}-changes`] || !(notes[`${m.id}-changes`] ?? '').trim()} onclick={() => act(`${m.id}-changes`, '/api/missions/changes', { missionId: m.id, note: (notes[`${m.id}-changes`] ?? '').trim() })}>Ask for these changes</button>
      </div>
    {/if}

    {#if m.status === 'REVIEWING' && m.waitingOn.length}
      <p class="mt-3 text-xs text-stone-500">A reviewer that keeps failing can be skipped:
        {#each m.waitingOn as id (id)}<button class="ml-2 underline" disabled={busy[`${m.id}-skip-${id}`]} onclick={() => act(`${m.id}-skip-${id}`, '/api/missions/skip', { missionId: m.id, agentId: id })}>skip {nameOf(id)}</button>{/each}
      </p>
    {/if}

    {#if m.tasks.length}
      <div class="mt-4">
        <h3 class="text-sm font-semibold">Tasks: {m.progress.committed} of {m.progress.total} done</h3>
        <ul class="mt-1 grid gap-1 text-sm">
          {#each m.tasks as t (t.id)}
            <li class="flex flex-wrap items-baseline gap-2"><span class="font-mono text-xs text-stone-500">{t.id}</span> {t.title} <span class={[badge, t.status === 'COMMITTED' ? 'border-green-600 text-green-700' : 'border-stone-400 text-stone-600']}>{t.status.replaceAll('_', ' ').toLowerCase()}</span> <span class="text-xs text-stone-500">{t.owner ? nameOf(t.owner) : (t.suggestedOwner ?? 'anyone')}</span></li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if usage.find((u) => u.missionId === m.id)}<p class="mt-3 text-xs text-stone-500" title="What the agent tools reported for this mission's runs. Antigravity reports tokens but no cost.">Used so far: {formatUsage(usage.find((u) => u.missionId === m.id)!)}</p>{/if}
    {#if !['DONE', 'CANCELLED'].includes(m.status)}
      <div class="mt-3 flex items-center gap-3">
        <button class="text-xs text-red-700 underline dark:text-red-400" disabled={busy[`${m.id}-cancel`]} onclick={() => act(`${m.id}-cancel`, '/api/missions/cancel', { missionId: m.id })}>Cancel this mission</button>
      </div>
    {/if}
    {#each Object.entries(errors).filter(([k, v]) => k.startsWith(m.id) && v) as [k, v] (k)}<p role="alert" class="mt-2 text-sm text-red-600">{v}</p>{/each}
  </article>
{:else}
  <p class="text-sm text-stone-500">No missions yet. Describe what you want built above.</p>
{/each}
