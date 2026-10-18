<script lang="ts">
  // What each agent runs on: its model (a name typed, or chosen from the list the tool gives when asked) and, for Claude Code, whether it
  // may start sub-agents. A change applies from the agent's next run; a run going now is not touched.
  import { post } from './api';
  import type { AgentSetting } from './types';

  let { agents, onChanged }: { agents: AgentSetting[]; onChanged: () => void } = $props();

  type Choices = { models: { id: string; label: string }[]; note: string };
  // What is typed or ticked and not saved yet, by agent; an agent not in here shows what is saved.
  let typed = $state<Record<string, string>>({});
  let ticked = $state<Record<string, boolean>>({});
  let choices = $state<Record<string, Choices>>({});
  let asked: Record<string, boolean> = {};
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let said = $state<Record<string, string>>({});

  const model = (a: AgentSetting) => typed[a.id] ?? a.model ?? '';
  const subAgents = (a: AgentSetting) => ticked[a.id] ?? a.subAgents;
  const changed = (a: AgentSetting) => model(a).trim() !== (a.model ?? '') || (a.canUseSubAgents && subAgents(a) !== a.subAgents);

  // The list is asked for when the person goes to choose (not when Setup opens): for Antigravity it starts the tool to ask it.
  async function load(a: AgentSetting): Promise<void> {
    if (asked[a.platform]) return;
    asked[a.platform] = true;
    try {
      const r = await post<Choices>('/api/models', { platform: a.platform });
      for (const other of agents.filter((x) => x.platform === a.platform)) choices[other.id] = r;
    } catch (e) {
      asked[a.platform] = false;
      errors[a.id] = (e as Error).message;
    }
  }

  async function save(a: AgentSetting): Promise<void> {
    busy[a.id] = true;
    errors[a.id] = '';
    said[a.id] = '';
    try {
      const m = model(a).trim();
      await post('/api/agents/settings', { agentId: a.id, ...(m !== (a.model ?? '') ? { model: m === '' ? null : m } : {}), ...(a.canUseSubAgents && subAgents(a) !== a.subAgents ? { subAgents: subAgents(a) } : {}) });
      delete typed[a.id];
      delete ticked[a.id];
      said[a.id] = 'Saved. It applies from its next run.';
      onChanged();
    } catch (e) {
      errors[a.id] = (e as Error).message;
    } finally {
      busy[a.id] = false;
    }
  }

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
</script>

<section aria-label="What each agent runs on" class="mb-6">
  <h2 class="text-base font-semibold">What each agent runs on</h2>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">Choose the model an agent uses, or leave it on its tool's own default. A change applies from the agent's next run.</p>
  <div class="mt-3 grid gap-3 lg:grid-cols-2">
    {#each agents as a (a.id)}
      <div role="group" aria-label={a.id} class="rounded-xl border border-stone-200 bg-white p-4 text-sm dark:border-stone-800 dark:bg-stone-900">
        <h3 class="font-semibold">{a.id} <span class="font-normal text-stone-500">({a.platform === 'CLAUDE_CODE' ? 'Claude Code' : a.platform === 'ANTIGRAVITY' ? 'Antigravity' : a.platform})</span></h3>
        {#if a.canChooseModel}
          <label class="mt-2 block text-xs font-medium" for={`model-${a.id}`}>Model</label>
          <input
            id={`model-${a.id}`}
            class={field}
            value={model(a)}
            placeholder="the tool's own default"
            list={`models-${a.id}`}
            autocomplete="off"
            spellcheck="false"
            onfocus={() => void load(a)}
            oninput={(e) => (typed[a.id] = e.currentTarget.value)}
          />
          {#if choices[a.id]}
            <datalist id={`models-${a.id}`}>{#each choices[a.id]!.models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}</datalist>
            <p class="mt-1 text-xs text-stone-500">{choices[a.id]!.note}</p>
          {/if}
        {:else}
          <p class="mt-2 text-xs text-stone-500">This tool takes its model from its own definition (its arguments), so it is not chosen here.</p>
        {/if}
        {#if a.canUseSubAgents}
          <label class="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" class="mt-1" checked={subAgents(a)} onchange={(e) => (ticked[a.id] = e.currentTarget.checked)} /><span>Allow sub-agents</span></label>
          <p class="ml-6 text-xs text-stone-500">Claude Code may start helper agents for parts of a task. They work in the same folder under the same rules, and use tokens of their own, so a task can cost more. Off unless you switch it on.</p>
        {:else if a.canChooseModel}
          <p class="mt-3 text-xs text-stone-500">Antigravity decides for itself whether to use sub-agents; AgentMesh does not switch it.</p>
        {/if}
        {#if a.canChooseModel}
          <div class="mt-3 flex items-center gap-3">
            <button class={button} disabled={busy[a.id] || !changed(a)} onclick={() => void save(a)}>{busy[a.id] ? 'Saving…' : 'Save'}</button>
            {#if said[a.id]}<span class="text-xs text-green-700 dark:text-green-400">{said[a.id]}</span>{/if}
          </div>
        {/if}
        {#if errors[a.id]}<p role="alert" class="mt-2 text-xs text-red-600 dark:text-red-400">{errors[a.id]}</p>{/if}
      </div>
    {/each}
  </div>
</section>
