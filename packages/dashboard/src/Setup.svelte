<script lang="ts">
  // Setup: connect the agents you have, prove each one works, and tell AgentMesh how to check your project.
  import { onMount } from 'svelte';
  import { get, post } from './api';
  import ContainerMode from './ContainerMode.svelte';
  import Notifications from './Notifications.svelte';
  import Playbooks from './Playbooks.svelte';
  import ProjectContext from './ProjectContext.svelte';
  import AgentSettings from './AgentSettings.svelte';
  import RecipeCard from './RecipeCard.svelte';
  import type { AgentSetting, NotificationsState, PlaybooksState, RecipeInfo, SandboxState, UpdateState } from './types';
  import Updates from './Updates.svelte';

  type Diagnosis = { level: string; title: string; detail: string; fix?: string };
  type Detected = { id: string; label: string; verified: boolean; installed: boolean; version: string | null; problem: string | null; needsFix: boolean; diagnoses: Diagnosis[] };
  type PlatformInfo = { id: string; label: string; friendlyName: string; verified: boolean; loopProtection: boolean; summary: string; agents: string[] };
  type Project = { name: string; verifyCommand: string | null; landWithoutVerify: boolean; suggestedVerifyCommand: string | null; landing: boolean; context: string; maxContext: number };
  type TestResult = { ok: boolean; seconds: number; detail: string; said?: string };

  let { platforms, agentSettings = [], project, notifications, update, version, playbooks, recipes, sandbox, onChanged }: { platforms: PlatformInfo[]; agentSettings?: AgentSetting[]; project: Project; playbooks: PlaybooksState | null; recipes: RecipeInfo[]; sandbox: SandboxState | null; notifications: NotificationsState; update: UpdateState; version: string | null; onChanged: () => void } = $props();

  let detected = $state<Record<string, Detected>>({});
  let scanning = $state(false);
  let scanError = $state('');
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let results = $state<Record<string, TestResult>>({});
  let messages = $state<Record<string, string>>({});
  let command = $state('');

  async function scan(): Promise<void> {
    scanning = true;
    scanError = '';
    try {
      const list = await get<Detected[]>('/api/platforms');
      detected = Object.fromEntries(list.map((d) => [d.id, d]));
    } catch (e) {
      scanError = (e as Error).message;
    } finally {
      scanning = false;
    }
  }
  onMount(() => void scan());

  async function run(key: string, fn: () => Promise<void>): Promise<void> {
    busy[key] = true;
    errors[key] = '';
    messages[key] = '';
    try {
      await fn();
    } catch (e) {
      errors[key] = (e as Error).message;
    } finally {
      busy[key] = false;
    }
  }

  const connect = (p: PlatformInfo) =>
    run(`${p.id}-connect`, async () => {
      const r = await post<{ agent: { id: string }; warnings: string[] }>('/api/agents', { platform: p.id });
      messages[`${p.id}-connect`] = `Connected as ${r.agent.id}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`;
      onChanged();
    });
  const test = (p: PlatformInfo) =>
    run(`${p.id}-test`, async () => {
      results[p.id] = await post<TestResult>('/api/platforms/test', { platform: p.id });
    });
  const fix = (p: PlatformInfo) =>
    run(`${p.id}-fix`, async () => {
      await post('/api/platforms/fix', { platform: p.id });
      await scan();
    });
  const addRecipe = (r: RecipeInfo, values: Record<string, string>) =>
    run(`recipe-${r.id}`, async () => {
      await post('/api/platforms/recipe', { id: r.id, values });
      messages[`recipe-${r.id}`] = r.added ? `${r.title} changed. Press Test on it above to check the new choices.` : `${r.title} added. Install it and sign in if you have not, then Connect it above and press Test.`;
      await scan();
      onChanged();
    });
  const saveSettings = (body: Record<string, unknown>) =>
    run('project', async () => {
      await post('/api/settings', body);
      command = '';
      onChanged();
    });

  const badge = 'rounded-full border px-2 py-0.5 text-xs font-medium';
  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<section aria-label="Agents" class="mb-6">
  <div class="flex items-baseline justify-between gap-2">
    <h2 class="text-base font-semibold">Your agents</h2>
    <button class={button} disabled={scanning} onclick={scan}>{scanning ? 'Looking…' : 'Look again'}</button>
  </div>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
    An agent is a coding tool that runs on your computer under your own login and quota. Connect the ones you have. Two or more from different companies can check each other's work.
  </p>
  {#if scanError}<p role="alert" class="mt-2 text-sm text-red-600">{scanError}</p>{/if}

  <div class="mt-3 grid gap-3 lg:grid-cols-2">
    {#each platforms as p (p.id)}
      {@const d = detected[p.id]}
      <article class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900" aria-label={p.label}>
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="font-semibold">{p.label}</h3>
          <span class={[badge, p.verified ? 'border-green-600 text-green-700' : 'border-amber-500 text-amber-700']}>{p.verified ? 'Verified' : 'Your own setup, not verified'}</span>
        </div>
        <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">{p.summary}</p>
        <p class="mt-2 text-sm">
          {#if !d}Checking…
          {:else if !d.installed}<span class="text-red-700 dark:text-red-400">Not installed on this computer.</span>
          {:else if d.problem}<span class="text-red-700 dark:text-red-400">Installed, but not answering: {d.problem}</span>
          {:else}Installed{d.version ? `: ${d.version}` : ''}.{/if}
        </p>
        {#if p.agents.length}<p class="mt-1 text-sm">Connected as <strong>{p.agents.join(', ')}</strong>.</p>{/if}
        <p class="mt-1 text-xs text-stone-500" title="When an agent makes the same tool call with the same result three times in a row, AgentMesh stops the run and says why, instead of letting it use up your quota.">Stuck-loop protection: {p.loopProtection ? 'on' : 'not available for this tool'}.</p>

        {#if d?.needsFix}
          <div class="mt-2 rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm dark:bg-amber-950">
            {#each d.diagnoses.filter((x) => x.level === 'fail') as x (x.title)}<p><strong>{x.title}.</strong> {x.detail}</p>{/each}
            {#if p.id === 'ANTIGRAVITY'}<button class={['mt-2', primary]} disabled={busy[`${p.id}-fix`]} onclick={() => fix(p)}>Allow it (adds one line to your Antigravity settings, with a backup)</button>{/if}
          </div>
        {/if}

        <div class="mt-3 flex flex-wrap items-center gap-2">
          {#if d?.installed && !d.problem && p.agents.length === 0}
            <button class={primary} disabled={busy[`${p.id}-connect`]} onclick={() => connect(p)}>Connect</button>
          {/if}
          {#if p.agents.length}
            <button class={button} disabled={busy[`${p.id}-test`]} onclick={() => test(p)}>{busy[`${p.id}-test`] ? 'Testing, about a minute…' : 'Test that it works'}</button>
          {/if}
        </div>
        {#if messages[`${p.id}-connect`]}<p class="mt-2 text-sm text-green-700">{messages[`${p.id}-connect`]}</p>{/if}
        {#if results[p.id]}
          {@const r = results[p.id]!}
          <p class={['mt-2 text-sm', r.ok ? 'text-green-700' : 'text-red-700 dark:text-red-400']} aria-live="polite">
            {r.ok ? 'It works' : 'It did not work'} ({r.seconds}s). {r.detail}{r.said ? ` It said: ${r.said}` : ''}
          </p>
        {/if}
        {#each ['connect', 'test', 'fix'] as k (k)}{#if errors[`${p.id}-${k}`]}<p role="alert" class="mt-2 text-sm text-red-600">{errors[`${p.id}-${k}`]}</p>{/if}{/each}
      </article>
    {/each}
  </div>
  {#if recipes.some((r) => !r.added)}
    <h3 class="mt-5 text-sm font-semibold">Add another tool</h3>
    <p class="text-xs text-stone-500">Ready-made definitions written from each vendor's documentation. <strong>None has been run by AgentMesh's authors</strong>: every one is added as "not verified" until your own Test passes. Read the notes first.</p>
    <div class="mt-2 grid gap-3 lg:grid-cols-3">
      {#each recipes.filter((r) => !r.added) as r (r.id)}
        <RecipeCard recipe={r} busy={Boolean(busy[`recipe-${r.id}`])} error={errors[`recipe-${r.id}`] ?? ''} onAdd={(values) => addRecipe(r, values)} />
      {/each}
    </div>
  {/if}
  {#if recipes.some((r) => r.added && r.fields.length)}
    <section aria-label="Change a tool you added" class="mt-5">
      <h3 class="text-sm font-semibold">Change a tool you added</h3>
      <p class="text-xs text-stone-500">A wrong model name, or another model to try: change it here. Agents already connected use the new choice from their next run.</p>
      <div class="mt-2 grid gap-3 lg:grid-cols-3">
        {#each recipes.filter((r) => r.added && r.fields.length) as r (r.id)}
          <RecipeCard recipe={r} mode="change" busy={Boolean(busy[`recipe-${r.id}`])} error={errors[`recipe-${r.id}`] ?? ''} message={messages[`recipe-${r.id}`] ?? ''} onAdd={(values) => addRecipe(r, values)} />
        {/each}
      </div>
    </section>
  {/if}
  <p class="mt-3 text-xs text-stone-500">A tool that is not listed? Describe it under "customPlatforms" in .agentmesh/config.json (see the README); it appears above as unverified until you test it.</p>
</section>

{#if agentSettings.length}
  <AgentSettings agents={agentSettings} {onChanged} />
{/if}

<section aria-label="Project check" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="text-base font-semibold">How should we check your project works?</h2>
  {#if project.verifyCommand}
    <p class="mt-1 text-sm">Before anything is added to your main branch, AgentMesh runs <code class="rounded bg-stone-100 px-1 font-mono dark:bg-stone-950">{project.verifyCommand}</code>. If it fails, the work goes back to the agent.</p>
  {:else if project.landWithoutVerify}
    <p class="mt-1 rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm dark:bg-amber-950">
      <strong>New project: work is added after the other agent reviews it, with no automatic test run.</strong> Once your project has tests, set the command below.
    </p>
  {:else}
    <p class="mt-1 rounded-lg border border-red-500 bg-red-50 p-2 text-sm dark:bg-red-950"><strong>Nothing will be added to your main branch</strong> until you set a check command below.</p>
  {/if}

  {#if project.suggestedVerifyCommand && !project.verifyCommand}
    <p class="mt-2 text-sm">Your project looks like it can be tested with <code class="rounded bg-stone-100 px-1 font-mono dark:bg-stone-950">{project.suggestedVerifyCommand}</code>.
      <button class={['ml-2', primary]} disabled={busy.project} onclick={() => saveSettings({ verifyCommand: project.suggestedVerifyCommand })}>Use it</button></p>
  {/if}
  <label class="mt-3 block text-xs font-medium" for="verify">The command (one line, run from the project folder)</label>
  <p class="text-xs text-stone-500">It is run for every task, on every branch, so use one that covers the whole project (<code class="font-mono">npm test</code>, <code class="font-mono">node --test</code>, <code class="font-mono">pytest</code>), not one that names a single file that other tasks will not have.</p>
  <div class="flex flex-wrap gap-2">
    <input id="verify" class={[field, 'max-w-md']} placeholder="e.g. npm test, pytest, go test ./..." bind:value={command} />
    <button class={['mt-1', button]} disabled={busy.project || !command.trim()} onclick={() => saveSettings({ verifyCommand: command.trim() })}>Save</button>
  </div>
  {#if !project.verifyCommand}
    <label class="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={project.landWithoutVerify} disabled={busy.project} onchange={(e) => saveSettings({ landWithoutVerify: e.currentTarget.checked })} /> <span>My project has no tests yet: add reviewed work anyway.</span></label>
  {/if}
  {#if errors.project}<p role="alert" class="mt-2 text-sm text-red-600">{errors.project}</p>{/if}
</section>

<div class="mt-6 grid gap-6">
  {#if sandbox}<ContainerMode {sandbox} />{/if}
  <ProjectContext context={project.context} max={project.maxContext} {onChanged} />
  {#if playbooks}<Playbooks {playbooks} {onChanged} />{/if}
  <Notifications {notifications} {onChanged} />
  <Updates {version} {update} {onChanged} />
</div>
