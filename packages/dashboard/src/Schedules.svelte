<script lang="ts">
  // Schedules: start a mission on a timer, or when another mission finishes. A scheduled mission is an
  // ordinary mission: it stops at the plan and waits for your approval, so nothing is built unattended.
  import { post } from './api';
  import type { SchedulesState, ScheduleItem } from './types';

  type Agent = { id: string; name: string; platform: string };
  let { schedules, agents, onChanged }: { schedules: SchedulesState; agents: Agent[]; onChanged: () => void } = $props();

  const workers = $derived(agents.filter((a) => a.platform !== 'HUMAN'));
  const nameOf = (id: string) => workers.find((a) => a.id === id)?.name ?? id;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ── the form ──
  type WhenKind = 'daily' | 'weekly' | 'every_hours' | 'cron' | 'mission_done';
  let editing = $state<string | null>(null); // null = closed, '' = new, 'S3' = editing S3
  let name = $state('');
  let brief = $state('');
  let planner = $state('');
  let skipped = $state<Record<string, boolean>>({});
  let whenKind = $state<WhenKind>('daily');
  let time = $state('02:00');
  let weekday = $state(1);
  let hours = $state(6);
  let cron = $state('0 6 * * 1-5');
  let watch = $state('any');
  let busy = $state(false);
  let error = $state('');

  const reviewerChoices = $derived(workers.filter((a) => a.id !== planner));
  const chosenReviewers = $derived(reviewerChoices.filter((a) => !skipped[a.id]).map((a) => a.id));
  const trigger = $derived(
    whenKind === 'daily' ? { kind: 'daily' as const, time } : whenKind === 'weekly' ? { kind: 'weekly' as const, weekday, time } : whenKind === 'every_hours' ? { kind: 'every_hours' as const, hours } : whenKind === 'cron' ? { kind: 'cron' as const, cron } : { kind: 'mission_done' as const, watch },
  );

  function startNew(): void {
    editing = '';
    name = '';
    brief = '';
    planner = workers[0]?.id ?? '';
    skipped = {};
    whenKind = 'daily';
    time = '02:00';
    error = '';
  }
  async function edit(s: ScheduleItem): Promise<void> {
    error = '';
    try {
      const full = await post<ScheduleItem & { brief: string }>('/api/schedules/get', { id: s.id });
      editing = s.id;
      name = full.name;
      brief = full.brief;
      planner = full.plannerAgentId;
      skipped = Object.fromEntries(workers.filter((a) => a.id !== full.plannerAgentId && !full.reviewerAgentIds.includes(a.id)).map((a) => [a.id, true]));
      if (full.kind === 'interval') {
        whenKind = 'every_hours';
        hours = full.hours ?? 6;
      } else if (full.kind === 'mission_done') {
        whenKind = 'mission_done';
        watch = full.watch ?? 'any';
      } else {
        const daily = /^(\d+) (\d+) \* \* \*$/.exec(full.cron ?? '');
        const weekly = /^(\d+) (\d+) \* \* ([0-6])$/.exec(full.cron ?? '');
        const hhmm = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
        if (daily) {
          whenKind = 'daily';
          time = hhmm(daily[2]!, daily[1]!);
        } else if (weekly) {
          whenKind = 'weekly';
          time = hhmm(weekly[2]!, weekly[1]!);
          weekday = Number(weekly[3]);
        } else {
          whenKind = 'cron';
          cron = full.cron ?? '';
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function save(): Promise<void> {
    busy = true;
    error = '';
    try {
      const body = { name: name.trim(), brief: brief.trim(), plannerAgentId: planner, reviewerAgentIds: chosenReviewers, trigger };
      await post(editing ? '/api/schedules/update' : '/api/schedules', editing ? { ...body, id: editing } : body);
      editing = null;
      onChanged();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  // ── row actions ──
  let rowBusy = $state<Record<string, boolean>>({});
  let rowMessage = $state<Record<string, string>>({});
  async function act(id: string, path: string, body: Record<string, unknown>, after?: (r: unknown) => string): Promise<void> {
    rowBusy[id] = true;
    rowMessage[id] = '';
    try {
      const r = await post(path, { id, ...body });
      if (after) rowMessage[id] = after(r);
      onChanged();
    } catch (e) {
      rowMessage[id] = (e as Error).message;
    } finally {
      rowBusy[id] = false;
    }
  }
  const runNow = (s: ScheduleItem) =>
    act(s.id, '/api/schedules/run', {}, (r) => {
      const run = r as { outcome: string; missionId: string | null; detail: string | null };
      return run.outcome === 'started' ? `Started mission ${run.missionId}. It will wait for your approval after the plan.` : `Not started: ${run.detail ?? run.outcome}`;
    });
  const toggle = (s: ScheduleItem) => act(s.id, '/api/schedules/enable', { enabled: !s.enabled });
  const remove = (s: ScheduleItem) => {
    if (confirm(`Delete the schedule "${s.name}"? Missions it already started are not affected.`)) void act(s.id, '/api/schedules/delete', {});
  };

  // ── display ──
  const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ago = (iso: string) => new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const REASON: Record<string, string> = {
    'skipped:overlap': 'Skipped',
    'skipped:missed_over_24h': 'Missed (over a day ago)',
    'failed:planner_unavailable': 'Could not start',
    'failed:reviewers_unavailable': 'Could not start',
    'failed:invalid_brief': 'Could not start',
  };
  const outcomeLabel = (o: string) => (o === 'started' ? 'Started' : (REASON[o] ?? o));
  const tone = (o: string) => (o === 'started' ? 'text-green-700 dark:text-green-400' : o.startsWith('failed') ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400');

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
  const badge = 'rounded-full border px-2 py-0.5 text-xs font-medium';
</script>

<section aria-label="Schedules">
  <div class="flex flex-wrap items-start justify-between gap-2">
    <div>
      <h2 class="text-base font-semibold">Schedules</h2>
      <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
        Start a mission on a timer, or when another mission finishes: a nightly dependency check, a weekly report. A scheduled mission is a normal mission: it stops at the plan and <strong>waits for your approval</strong>, and a schedule never starts a new one while its last one is still open.
      </p>
      <p class="mt-1 text-xs text-stone-500">All times are this computer's own time ({schedules.timezone}). If AgentMesh or the computer was off at a slot, it runs once when it is back (within a day), never a backlog.</p>
    </div>
    <button class={primary} disabled={editing !== null || schedules.items.length >= schedules.max || workers.length === 0} onclick={startNew}>New schedule</button>
  </div>

  {#if editing !== null}
    <form class="mt-4 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3 class="text-sm font-semibold">{editing ? `Edit ${editing}` : 'New schedule'}</h3>
      <label class="mt-3 block text-xs font-medium" for="sc-name">Name</label>
      <input id="sc-name" class={field} maxlength="120" placeholder="e.g. Nightly dependency check" bind:value={name} />
      <label class="mt-3 block text-xs font-medium" for="sc-brief">The brief (what each mission should do)</label>
      <textarea id="sc-brief" class={field} rows="5" placeholder="Check the project for outdated dependencies and write a short report of what to update first." bind:value={brief}></textarea>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="text-xs font-medium">Who writes the plan
          <select class={field} bind:value={planner}>{#each workers as a (a.id)}<option value={a.id}>{a.name} ({a.id})</option>{/each}</select>
        </label>
        <fieldset>
          <legend class="text-xs font-medium">Who looks for gaps</legend>
          {#each reviewerChoices as a (a.id)}
            <label class="mt-1 mr-4 inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={!skipped[a.id]} onchange={(e) => (skipped[a.id] = !e.currentTarget.checked)} /> {a.name}</label>
          {:else}<p class="mt-1 text-sm text-stone-500">Nobody else is connected, so the plan comes straight to you.</p>{/each}
        </fieldset>
      </div>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="text-xs font-medium">When
          <select class={field} bind:value={whenKind}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="every_hours">Every few hours</option>
            <option value="cron">Custom (cron expression)</option>
            <option value="mission_done">When a mission finishes</option>
          </select>
        </label>
        <div class="flex flex-wrap items-end gap-2">
          {#if whenKind === 'weekly'}
            <label class="text-xs font-medium">On<select class={field} bind:value={weekday}>{#each DAYS as d, i (d)}<option value={i}>{d}</option>{/each}</select></label>
          {/if}
          {#if whenKind === 'daily' || whenKind === 'weekly'}
            <label class="text-xs font-medium">At<input type="time" class={field} bind:value={time} /></label>
          {:else if whenKind === 'every_hours'}
            <label class="text-xs font-medium">Every (hours, 1 to 168)<input type="number" min="1" max="168" class={field} bind:value={hours} /></label>
          {:else if whenKind === 'cron'}
            <label class="grow text-xs font-medium">Minute hour day-of-month month day-of-week<input class={[field, 'font-mono']} bind:value={cron} /></label>
          {:else}
            <label class="text-xs font-medium">Watch
              <select class={field} bind:value={watch}>
                <option value="any">any mission</option>
                {#each schedules.items.filter((s) => s.id !== editing) as s (s.id)}<option value={s.id}>missions started by {s.id} ({s.name})</option>{/each}
              </select>
            </label>
          {/if}
        </div>
      </div>
      {#if whenKind === 'mission_done'}<p class="mt-2 text-xs text-stone-500">A follow-up started this way never starts another by itself, so there are no endless chains.</p>{/if}

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" class={primary} disabled={busy || !name.trim() || brief.trim().length < 10 || !planner}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" class={button} onclick={() => (editing = null)}>Cancel</button>
        {#if editing}<span class="text-xs text-stone-500">Saving restarts its timer from now.</span>{/if}
      </div>
      {#if error}<p role="alert" class="mt-2 text-sm text-red-600">{error}</p>{/if}
    </form>
  {/if}

  {#if schedules.items.length === 0 && editing === null}
    <p class="mt-4 text-sm text-stone-500">No schedules yet.</p>
  {:else}
    <ul class="mt-4 grid gap-3">
      {#each schedules.items as s (s.id)}
        <li class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="font-semibold"><span class="mr-2 font-mono text-xs text-stone-500">{s.id}</span>{s.name}</h3>
            <span class={[badge, s.disabledReason ? 'border-red-500 text-red-700 dark:text-red-400' : s.enabled ? 'border-green-600 text-green-700 dark:text-green-400' : 'border-stone-400 text-stone-500']}>{s.disabledReason ? 'Switched off: failing' : s.enabled ? 'On' : 'Off'}</span>
          </div>
          <p class="mt-1 text-sm">{s.when}. {nameOf(s.plannerAgentId)} plans{s.reviewerAgentIds.length ? `, ${s.reviewerAgentIds.map(nameOf).join(' and ')} review` : ', no reviewers'}.</p>
          {#if !s.plannerConnected}<p class="mt-1 text-sm text-red-700 dark:text-red-400">{nameOf(s.plannerAgentId)} is not connected, so this cannot start. Edit it to choose another planner.</p>{/if}
          {#if s.disabledReason}<p class="mt-1 text-sm text-red-700 dark:text-red-400">{s.disabledReason}</p>{/if}
          <p class="mt-1 text-xs text-stone-500">{s.briefPreview}</p>
          <dl class="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt class="inline text-stone-500">Next: </dt><dd class="inline">{s.nextRunAt ? when(s.nextRunAt) : s.kind === 'mission_done' && s.enabled ? 'when a mission finishes' : '—'}</dd></div>
            <div>
              <dt class="inline text-stone-500">Last: </dt>
              <dd class="inline">
                {#if s.lastRun}
                  <span class={tone(s.lastRun.outcome)}>{outcomeLabel(s.lastRun.outcome)}</span>{s.lastRun.missionId ? ` ${s.lastRun.missionId}` : ''}{s.lastRun.repeat > 1 ? ` (${s.lastRun.repeat} times)` : ''}, {ago(s.lastRun.at)}
                  {#if s.lastRun.detail}<span class="block text-xs text-stone-500">{s.lastRun.detail}</span>{/if}
                {:else}never{/if}
              </dd>
            </div>
          </dl>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button class={button} disabled={rowBusy[s.id]} onclick={() => runNow(s)}>Run now</button>
            <button class={button} disabled={rowBusy[s.id]} onclick={() => toggle(s)}>{s.enabled ? 'Switch off' : 'Switch on'}</button>
            <button class={button} disabled={editing !== null} onclick={() => edit(s)}>Edit</button>
            <button class="text-sm text-red-700 underline dark:text-red-400" disabled={rowBusy[s.id]} onclick={() => remove(s)}>Delete</button>
          </div>
          {#if rowMessage[s.id]}<p class="mt-2 text-sm text-stone-700 dark:text-stone-300" aria-live="polite">{rowMessage[s.id]}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if schedules.runs.length}
    <h3 class="mt-6 text-sm font-semibold">Recent firings</h3>
    <ul class="mt-2 grid gap-1 text-sm">
      {#each schedules.runs as r (r.id)}
        <li class="flex flex-wrap items-baseline gap-x-3"><span class="font-mono text-xs text-stone-500">{r.scheduleId}</span><span class={tone(r.outcome)}>{outcomeLabel(r.outcome)}</span>{#if r.missionId}<span class="font-mono text-xs">{r.missionId}</span>{/if}{#if r.repeat > 1}<span class="text-xs text-stone-500">{r.repeat} times</span>{/if}<span class="text-xs text-stone-500">{r.trigger === 'manual' ? 'run now' : r.trigger === 'late' ? 'late' : r.trigger === 'event' ? 'after a mission finished' : 'on time'} · {ago(r.at)}</span>{#if r.detail}<span class="text-xs text-stone-500">{r.detail}</span>{/if}</li>
      {/each}
    </ul>
  {/if}
</section>
