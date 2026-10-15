<script lang="ts">
  // Project context: a note from you that is added to every plan, review and build prompt.
  import { post } from './api';

  let { context, max, onChanged }: { context: string; max: number; onChanged: () => void } = $props();

  let draft = $state<string | null>(null);
  const value = $derived(draft ?? context);
  const dirty = $derived(draft !== null && draft.trim() !== context.trim());
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);

  async function save(): Promise<void> {
    busy = true;
    error = '';
    saved = false;
    try {
      await post('/api/settings', { projectContext: value.trim() || null });
      draft = null;
      saved = true;
      onChanged();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<section aria-label="About this project" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="text-base font-semibold">About this project</h2>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
    Anything every agent should know: the stack, the style you want, things to avoid. It is added to each agent's instructions for every plan, review and task, so keep it short and true. You can change it any time; the next run uses the new text.
  </p>
  <label class="sr-only" for="project-context">About this project</label>
  <textarea id="project-context" class={field} rows="5" maxlength={max} placeholder="e.g. Plain JavaScript, no frameworks. Keep it a single static page. Never add a database. Write tests with node --test." bind:value={() => value, (v) => (draft = v)}></textarea>
  <div class="mt-2 flex flex-wrap items-center gap-3">
    <button class={primary} disabled={busy || !dirty} onclick={save}>{busy ? 'Saving…' : 'Save'}</button>
    <span class="text-xs text-stone-500">{value.length} of {max} characters</span>
    {#if saved && !dirty}<span class="text-sm text-green-700" aria-live="polite">Saved. The next run uses it.</span>{/if}
    {#if error}<span role="alert" class="text-sm text-red-600">{error}</span>{/if}
  </div>
</section>
