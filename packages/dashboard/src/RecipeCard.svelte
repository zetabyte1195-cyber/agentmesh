<script lang="ts">
  // One ready-made tool definition, with the notes to read first and, where the tool needs a choice (which model, where
  // Ollama listens), the boxes for it. For a local model the cockpit asks Ollama on this computer which models it has and
  // offers those names; nothing is asked of any other machine.
  import { onMount } from 'svelte';
  import { isThisComputer, looksLikeCloudModel } from './address';
  import { post } from './api';
  import type { RecipeInfo } from './types';

  // 'add' offers a recipe that is not added yet; 'change' shows the choices of one that is, so a wrong model can be corrected
  // or another one tried without editing a file.
  let { recipe, mode = 'add', busy = false, error = '', message = '', onAdd }: { recipe: RecipeInfo; mode?: 'add' | 'change'; busy?: boolean; error?: string; message?: string; onAdd: (values: Record<string, string>) => void } = $props();

  type Models = { checked: boolean; reachable: boolean | null; models: { name: string; sizeGb: number | null; cloud: boolean }[]; note?: string };

  // What was typed wins; then what is set (when changing); then what Ollama offered; then the default. A suggestion is kept apart
  // from what was typed, so looking again at another address can replace it, and a typed choice is never replaced.
  let typed = $state<Record<string, string>>({});
  let suggested = $state<Record<string, string>>({});
  let found = $state<Models | null>(null);
  let looking = $state(false);

  const defaultOf = (id: string) => recipe.fields.find((f) => f.id === id)?.default ?? '';
  const value = (id: string) => typed[id] ?? recipe.current?.[id] ?? suggested[id] ?? defaultOf(id);
  const suggestsField = $derived(recipe.fields.find((f) => f.suggest === 'ollama-models')?.id);
  const suggests = $derived(suggestsField !== undefined);

  // Where the text of the project goes: said as soon as it is not this computer, whatever the card promised above.
  const addressChosen = $derived(recipe.fields.some((f) => f.id === 'address') ? value('address').trim() || defaultOf('address') : '');
  const elsewhere = $derived(addressChosen !== '' && !isThisComputer(addressChosen));
  const modelChosen = $derived(recipe.fields.some((f) => f.id === 'model') ? value('model').trim() : '');
  const inCloud = $derived(modelChosen !== '' && (looksLikeCloudModel(modelChosen) || Boolean(found?.models.some((m) => m.name === modelChosen && m.cloud))));
  const missing = $derived(recipe.fields.filter((f) => f.default === '' && !value(f.id).trim()));

  async function look(): Promise<void> {
    looking = true;
    try {
      found = await post<Models>('/api/platforms/ollama-models', { address: value('address').trim() || undefined });
      // With exactly one model on this computer, offer it as the choice (the person can still change it). With none or several there
      // is nothing to offer, and an earlier offer, made for another address, is withdrawn.
      const mine = found.models.filter((m) => !m.cloud);
      if (suggestsField) {
        if (mine.length === 1) suggested[suggestsField] = mine[0]!.name;
        else delete suggested[suggestsField];
      }
    } catch (e) {
      found = { checked: true, reachable: false, models: [], note: (e as Error).message };
    } finally {
      looking = false;
    }
  }
  onMount(() => {
    if (suggests) void look();
  });

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
</script>

<article class="rounded-xl border border-stone-200 bg-white p-4 text-sm dark:border-stone-800 dark:bg-stone-900" aria-label={mode === 'change' ? `Change: ${recipe.title}` : recipe.title}>
  <h4 class="font-semibold">{mode === 'change' ? `Change: ${recipe.title}` : recipe.title}</h4>
  {#if mode === 'change'}
    <p class="mt-1 text-stone-600 dark:text-stone-300">The next run uses the new choices. Press Test on the tool above to check them.</p>
  {:else}
    <p class="mt-1 text-stone-600 dark:text-stone-300">{recipe.summary}</p>
  {/if}
  <details class="mt-2">
    <summary class="cursor-pointer text-xs font-medium">{mode === 'change' ? 'Notes about this tool' : 'Read before adding'} ({recipe.caveats.length} note{recipe.caveats.length === 1 ? '' : 's'})</summary>
    <ul class="mt-1 list-disc space-y-1 pl-5 text-xs text-stone-600 dark:text-stone-300">{#each recipe.caveats as c (c)}<li>{c}</li>{/each}</ul>
    <p class="mt-2 text-xs"><strong>Get it:</strong> <code class="font-mono">{recipe.install}</code></p>
    <p class="mt-1 text-xs"><strong>Then:</strong> {recipe.signIn}</p>
    <p class="mt-1 text-xs">Documentation: {#each recipe.docs as d, i (d)}<a class="underline" href={d} target="_blank" rel="noreferrer">link {i + 1}</a>{i < recipe.docs.length - 1 ? ', ' : ''}{/each}</p>
  </details>

  {#each recipe.fields as f (f.id)}
    <label class="mt-3 block text-xs font-medium" for={`${recipe.id}-${f.id}`}>{f.label}</label>
    <input
      id={`${recipe.id}-${f.id}`}
      class={field}
      value={value(f.id)}
      placeholder={f.default || undefined}
      list={f.suggest ? `${recipe.id}-${f.id}-list` : undefined}
      autocomplete="off"
      spellcheck="false"
      oninput={(e) => (typed[f.id] = e.currentTarget.value)}
    />
    {#if f.suggest && found?.models.length}
      <datalist id={`${recipe.id}-${f.id}-list`}>
        {#each found.models as m (m.name)}<option value={m.name}>{m.cloud ? 'runs in the cloud, not on your computer' : m.sizeGb ? `${m.sizeGb} GB` : ''}</option>{/each}
      </datalist>
    {/if}
    <p class="mt-1 text-xs text-stone-500">{f.hint}</p>
  {/each}

  {#if suggests}
    <p class="mt-2 text-xs" aria-live="polite">
      {#if looking}Asking Ollama which models it has…
      {:else if found?.reachable}Ollama answered: {found.models.length} model{found.models.length === 1 ? '' : 's'}{found.models.some((m) => m.cloud) ? ' (a model marked cloud runs on Ollama\'s servers, not on your computer)' : ''}.
      {:else if found}{found.note ?? 'Ollama did not answer.'}
      {/if}
      <button class="ml-1 underline" disabled={looking} onclick={look}>Look again</button>
    </p>
  {/if}

  {#if elsewhere || inCloud}
    <div role="note" class="mt-3 space-y-1 rounded-lg border border-amber-500 bg-amber-50 p-3 text-xs dark:bg-amber-950">
      {#if elsewhere}<p><strong>{addressChosen} is not this computer.</strong> Claude Code will send what it reads in your project (files, plans and reviews) to that address, and the promise above that nothing leaves your machine does not apply.</p>{/if}
      {#if inCloud}<p><strong>{modelChosen} runs on Ollama's servers, not on your computer.</strong> What Claude Code reads in your project is sent there.</p>{/if}
    </div>
  {/if}

  <button class={['mt-3', button]} disabled={busy || missing.length > 0} title={missing.length ? `Fill in: ${missing.map((f) => f.label).join(', ')}` : undefined} onclick={() => onAdd(Object.fromEntries(recipe.fields.map((f) => [f.id, value(f.id).trim()])))}>{mode === 'change' ? 'Save the change' : 'Add as "not verified"'}</button>
  {#if message}<p class="mt-2 text-xs text-green-700 dark:text-green-400">{message}</p>{/if}
  {#if error}<p role="alert" class="mt-2 text-xs text-red-600">{error}</p>{/if}
</article>
