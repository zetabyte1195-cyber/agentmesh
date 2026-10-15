<script lang="ts">
  // Updates: which version is running, and (only if you switch it on) a daily look at GitHub for a newer one.
  import { post } from './api';
  import type { UpdateInfo as Info, UpdateState } from './types';

  let { version, update, onChanged }: { version: string | null; update: UpdateState; onChanged: () => void } = $props();

  let busy = $state(false);
  let error = $state('');
  let found = $state<Info | null>(null);
  const info = $derived(found ?? update.info);

  async function setEnabled(on: boolean): Promise<void> {
    error = '';
    try {
      await post('/api/settings', { updateCheck: on });
      onChanged();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function checkNow(): Promise<void> {
    busy = true;
    error = '';
    try {
      found = await post<Info>('/api/update/check');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
</script>

<section aria-label="Updates" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="text-base font-semibold">Updates</h2>
  <p class="mt-1 text-sm">You are running AgentMesh <strong>{version ?? 'unknown version'}</strong>.</p>
  {#if info?.newer}
    <p class="mt-2 rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm dark:bg-amber-950">
      <strong>Version {info.latest} is available.</strong> Stop AgentMesh, run <code class="font-mono">agentmesh update</code> in a terminal, then start it again.
      <a class="underline" href={info.url} target="_blank" rel="noreferrer">What is new</a>
    </p>
  {:else if info}
    <p class="mt-2 text-sm text-green-700">You have the newest version ({info.latest}).</p>
  {/if}
  <div class="mt-3 flex flex-wrap items-center gap-3">
    <button class={button} disabled={busy} onclick={checkNow}>{busy ? 'Looking…' : 'Check now'}</button>
    <label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={update.enabled} onchange={(e) => setEnabled(e.currentTarget.checked)} /> Check once a day</label>
  </div>
  <p class="mt-2 text-xs text-stone-500">Checking asks github.com whether a newer release exists, and nothing else is sent. By default AgentMesh contacts nobody; this only happens when you press the button or switch the daily check on.</p>
  {#if error || update.error}<p role="alert" class="mt-2 text-sm text-red-600">{error || update.error}</p>{/if}
</section>
