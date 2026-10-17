<script lang="ts">
  // One mission's spending limit: what it is, how much of it is used, and a way to set, raise or remove it. When the
  // limit has been reached the mission has stopped, and this is where the person lets it carry on.
  import { guarded, post } from './api';
  import { budgetShare, describeBudget, parseLimits, usedPercent } from './budget';
  import type { MissionBudget } from './types';

  let { missionId, budget, onChanged }: { missionId: string; budget: MissionBudget | null; onChanged: () => void } = $props();

  // The two boxes hold what was saved at the moment the form was opened, and then what is typed. They do not follow the saved
  // limit while the form is open: a change made elsewhere must not alter a box the person is not looking at.
  let usd = $state('');
  let tokens = $state('');
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');

  function toggle(): void {
    open = !open;
    error = '';
    if (open) {
      usd = budget?.maxCostUsd != null ? String(budget.maxCostUsd) : '';
      tokens = budget?.maxTokens != null ? String(budget.maxTokens) : '';
    }
  }
  const line = $derived(describeBudget(budget));
  const share = $derived(budgetShare(budget));

  const done = () => {
    open = false;
    onChanged();
  };
  const save = guarded(
    (b) => (busy = b),
    (e) => (error = e),
    async () => {
      const parsed = parseLimits(usd, tokens);
      if (!parsed.ok) throw new Error(parsed.error);
      if (parsed.budgetUsd === null && parsed.budgetTokens === null) throw new Error('Type a dollar amount or a number of tokens, or press "Remove the limit".');
      await post('/api/missions/budget', { missionId, budgetUsd: parsed.budgetUsd, budgetTokens: parsed.budgetTokens });
      done();
    },
  );
  const remove = guarded(
    (b) => (busy = b),
    (e) => (error = e),
    async () => {
      await post('/api/missions/budget', { missionId, budgetUsd: null, budgetTokens: null });
      done();
    },
  );

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<div class="mt-3 text-sm">
  {#if line}
    <p class="text-stone-600 dark:text-stone-300">{line}</p>
    {#if share !== null}
      <div class="mt-1 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800" role="img" aria-label={`${usedPercent(share)} percent of the limit used`}>
        <!-- style:width sets the style through the browser's style object, which the page's strict content security policy allows (checked in Chromium against the real header). -->
        <span class={['block h-full', share >= 1 ? 'bg-red-600' : 'bg-marigold-400']} style:width={`${share * 100}%`}></span>
      </div>
    {/if}
  {/if}

  {#if budget?.reached}
    <div role="alert" class="mt-2 rounded-lg border border-amber-500 bg-amber-50 p-3 dark:bg-amber-950">
      <p class="font-semibold">Stopped at its spending limit</p>
      <p>{budget.reached} No more runs start for this mission. Raise the limit to let it carry on, or cancel it.</p>
    </div>
  {/if}

  <button class="mt-1 text-xs underline" aria-expanded={open} onclick={toggle}>{budget?.reached ? 'Raise the limit' : budget ? 'Change the limit' : 'Set a spending limit'}</button>

  {#if open}
    <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label class="text-xs font-medium" for={`limit-usd-${missionId}`}>Dollars
        <input id={`limit-usd-${missionId}`} class={field} inputmode="decimal" placeholder="no dollar limit" value={usd} oninput={(e) => (usd = e.currentTarget.value)} />
      </label>
      <label class="text-xs font-medium" for={`limit-tokens-${missionId}`}>Tokens
        <input id={`limit-tokens-${missionId}`} class={field} inputmode="numeric" placeholder="no token limit, for example 2m" value={tokens} oninput={(e) => (tokens = e.currentTarget.value)} />
      </label>
    </div>
    <p class="mt-1 text-xs text-stone-500">
      AgentMesh starts no more runs for this mission once it has used about this much. It counts only what the agent tools report (Claude Code reports dollars and tokens, Antigravity tokens only), and a run already going finishes, so the mission can go a little over.
    </p>
    <div class="mt-2 flex flex-wrap gap-2">
      <button class={primary} disabled={busy} onclick={save}>{busy ? 'Saving…' : 'Save the limit'}</button>
      {#if budget}<button class={button} disabled={busy} onclick={remove}>Remove the limit</button>{/if}
    </div>
  {/if}
  {#if error}<p role="alert" class="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
