<script lang="ts">
  // Playbooks: reusable instructions you write once ("how we write release notes"). Agents are told only each
  // one's name and one-line description, and read the full text only when it fits their job.
  import { post } from './api';
  import type { PlaybooksState } from './types';

  let { playbooks, onChanged }: { playbooks: PlaybooksState; onChanged: () => void } = $props();

  let editing = $state<string | null>(null); // the name being edited, or '' for a new one
  let name = $state('');
  let description = $state('');
  let body = $state('');
  let busy = $state(false);
  let error = $state('');

  const bytes = $derived(new TextEncoder().encode(body).length);
  const nameOk = $derived(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 40);

  function startNew(): void {
    editing = '';
    name = '';
    description = '';
    body = '';
    error = '';
  }
  async function edit(n: string): Promise<void> {
    error = '';
    try {
      const p = await post<{ name: string; description: string; body: string }>('/api/playbooks/get', { name: n });
      editing = p.name;
      name = p.name;
      description = p.description;
      body = p.body;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function save(): Promise<void> {
    busy = true;
    error = '';
    try {
      await post('/api/playbooks/save', { name, description, body });
      editing = null;
      onChanged();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function remove(n: string): Promise<void> {
    if (!confirm(`Delete the playbook "${n}"? Agents will no longer see it.`)) return;
    error = '';
    try {
      await post('/api/playbooks/delete', { name: n });
      if (editing === n) editing = null;
      onChanged();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<section aria-label="Playbooks" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-base font-semibold">Playbooks</h2>
    <button class={button} disabled={editing !== null || playbooks.items.length >= playbooks.max} onclick={startNew}>New playbook</button>
  </div>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
    Instructions you want followed whenever they apply: how to write release notes, your API style, how to name things. Every agent is told each playbook's name and one-line description, and reads the full text only when it fits the job, so a long playbook costs nothing until it is needed.
  </p>

  {#if playbooks.items.length === 0 && editing === null}
    <p class="mt-3 text-sm text-stone-500">No playbooks yet.</p>
  {:else}
    <ul class="mt-3 grid gap-2">
      {#each playbooks.items as p (p.name)}
        <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 p-2 text-sm dark:border-stone-800">
          <span><strong class="font-mono text-xs">{p.name}</strong> <span class="text-stone-600 dark:text-stone-300">{p.description}</span> <span class="text-xs text-stone-500">({Math.max(1, Math.round(p.bytes / 100) / 10)} KB)</span></span>
          <span class="flex gap-3 text-xs">
            <button class="underline" disabled={editing !== null} onclick={() => edit(p.name)}>Edit</button>
            <button class="text-red-700 underline dark:text-red-400" onclick={() => remove(p.name)}>Delete</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  {#each playbooks.invalid as i (i.file)}
    <p class="mt-2 rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm dark:bg-amber-950"><strong class="font-mono text-xs">{i.file}</strong> cannot be used: {i.error}. Agents do not see it. Fix or delete the file in the playbooks folder.</p>
  {/each}
  {#if playbooks.overflow > 0}<p class="mt-2 text-sm text-amber-700">{playbooks.overflow} more playbook file{playbooks.overflow === 1 ? '' : 's'} than the limit of {playbooks.max}: the extra ones are ignored.</p>{/if}

  {#if editing !== null}
    <form class="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <label class="block text-xs font-medium" for="pb-name">Name (lower-case letters, digits and dashes)</label>
      <input id="pb-name" class={[field, 'max-w-sm font-mono']} placeholder="release-notes" disabled={editing !== ''} bind:value={name} />
      {#if name && !nameOk}<p class="mt-1 text-xs text-red-600">Use lower-case letters, digits and single dashes, up to 40 characters.</p>{/if}
      <label class="mt-3 block text-xs font-medium" for="pb-desc">When should an agent use it? (one line)</label>
      <input id="pb-desc" class={field} maxlength="160" placeholder="When writing release notes or a changelog entry" bind:value={description} />
      <label class="mt-3 block text-xs font-medium" for="pb-body">The instructions</label>
      <textarea id="pb-body" class={[field, 'font-mono text-xs']} rows="10" bind:value={body}></textarea>
      <p class="text-xs text-stone-500">{bytes} of {playbooks.maxBytes} bytes</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button type="submit" class={primary} disabled={busy || !nameOk || !description.trim() || !body.trim() || bytes > playbooks.maxBytes}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" class={button} onclick={() => (editing = null)}>Cancel</button>
      </div>
    </form>
  {/if}
  {#if error}<p role="alert" class="mt-2 text-sm text-red-600">{error}</p>{/if}
  <p class="mt-3 text-xs text-stone-500">Playbooks are files in this project's <code class="font-mono">.agentmesh/playbooks</code> folder: they stay on this computer (not in git), and you can also edit them by hand. A playbook never overrides an agent's own rules.</p>
</section>
