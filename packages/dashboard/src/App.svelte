<script lang="ts">
  // AgentMesh cockpit shell (P3.1). Snapshot from GET /api/state, then live board events over the
  // authenticated WebSocket (no polling). The timeline view is P3.2; Human controls are P3.3.
  import { type ComponentProps, onMount } from 'svelte';
  import { formatUsage, type UsageTotals } from './api';
  import Controls from './Controls.svelte';
  import Missions from './Missions.svelte';
  import Setup from './Setup.svelte';
  import Timeline from './Timeline.svelte';

  let controlError = $state('');
  /** Header/agent-card controls (P3.3): same-origin POST with the session cookie. */
  async function control(path: string, body: unknown): Promise<void> {
    controlError = '';
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) controlError = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`;
    void load();
  }

  type Agent = { id: string; name: string; platform: string; status: string; currentTaskId: string | null; doing: string | null };
  type Task = { id: string; title: string; status: string; assigned_agent_id: string | null; suggested_owner: string | null };
  type Question = { id: string; text: string; from_agent_id: string; to_role: string; task_id: string | null };
  type MeshEvent = { id: string; taskId: string | null; agentId: string | null; kind: string; text: string; createdAt: string };
  type Snapshot = {
    missions: ComponentProps<typeof Missions>['missions'];
    setup: { project: ComponentProps<typeof Setup>['project']; platforms: ComponentProps<typeof Setup>['platforms'] };
    agents: Agent[];
    tasks: Task[];
    openQuestions: Question[];
    events: MeshEvent[];
    leases: { id: string; taskId: string; agentId: string; path: string; type: string }[];
    usage: { byAgent: ({ agentId: string } & UsageTotals)[]; byMission: ({ missionId: string } & UsageTotals)[] };
    dispatch: { paused: boolean; backoffs: { platform: string; until: string; reason: string }[]; stuck: NonNullable<ComponentProps<typeof Controls>['stuck']> } | null;
  };

  const COLUMNS = ['TODO', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AUDITING', 'PASSED', 'BLOCKED', 'REJECTED', 'COMMITTED'];

  let snapshot = $state<Snapshot | null>(null);
  type View = 'missions' | 'board' | 'setup';
  let chosen = $state<View | null>(null);
  // With no agent connected the only useful place is Setup; otherwise start where the work is described.
  const view = $derived<View>(chosen ?? ((snapshot?.agents ?? []).some((a) => a.platform !== 'HUMAN') ? 'missions' : 'setup'));
  const needsYou = $derived({
    missions: (snapshot?.missions ?? []).filter((m) => m.status === 'PLAN_READY').length,
    board: (snapshot?.openQuestions ?? []).filter((q) => q.to_role === 'Human').length + (snapshot?.dispatch?.stuck?.length ?? 0),
  });
  const TABS: { id: View; label: string }[] = [
    { id: 'missions', label: 'Missions' },
    { id: 'board', label: 'Board' },
    { id: 'setup', label: 'Setup' },
  ];
  let auth = $state<'checking' | 'ok' | 'login'>('checking');
  let live = $state(false);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const agentsHuman = $derived((snapshot?.agents ?? []).filter((a) => a.platform !== 'HUMAN'));
  const byStatus = $derived(
    Object.fromEntries(COLUMNS.map((c) => [c, (snapshot?.tasks ?? []).filter((t) => t.status === c)])) as Record<string, Task[]>,
  );

  async function load(): Promise<void> {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      auth = 'login';
      return;
    }
    snapshot = (await res.json()) as Snapshot;
    auth = 'ok';
  }

  // Events arrive live; the snapshot is refreshed shortly after a burst so tasks/agents stay exact.
  function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void load(), 150);
  }

  function connect(): void {
    const ws = new WebSocket(`ws://${location.host}/ws/cockpit`);
    ws.onopen = () => (live = true);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; payload: MeshEvent };
      if (msg.type === 'EVENT' && snapshot) snapshot.events = [msg.payload, ...snapshot.events].slice(0, 200);
      scheduleRefresh();
    };
    ws.onclose = () => {
      live = false;
      if (auth === 'ok') setTimeout(connect, 2000);
    };
  }

  const time = (iso: string) => new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const platformTone = (p: string) =>
    p === 'CLAUDE_CODE' ? 'border-orange-600 text-orange-700 dark:text-orange-400' : p === 'ANTIGRAVITY' ? 'border-violet-600 text-violet-700 dark:text-violet-400' : 'border-teal-600 text-teal-700 dark:text-teal-400';

  const usedBy = (agentId: string) => snapshot?.usage?.byAgent.find((u) => u.agentId === agentId);
  const locksOf = (taskId: string) => (snapshot?.leases ?? []).filter((l) => l.taskId === taskId);
  function releaseLocks(taskId: string): void {
    const n = locksOf(taskId).length;
    if (confirm(`Release the ${n} file lock${n === 1 ? '' : 's'} held for ${taskId}? The agent has to take them again before it can commit.`)) void control('/api/leases/release', { taskId });
  }

  onMount(() => {
    void load().then(() => {
      if (auth === 'ok') connect();
    });
  });
</script>

<main class="mx-auto max-w-7xl px-4 py-6">
  <header class="mb-6 flex flex-wrap items-baseline justify-between gap-2">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">AgentMesh Cockpit</h1>
      <p class="text-sm text-stone-500 dark:text-stone-400">
        <span class={['mr-1.5 inline-block size-2 rounded-full align-middle', live ? 'bg-green-600' : 'bg-red-600']}></span>
        {live ? 'live' : auth === 'ok' ? 'reconnecting…' : 'not connected'}
        {#if snapshot?.dispatch?.paused}· <strong>dispatch paused</strong>{/if}
      </p>
    </div>
    {#if snapshot?.dispatch}
      <div class="flex items-center gap-2">
        {#if controlError}<span role="alert" class="text-xs text-red-600">{controlError}</span>{/if}
        <button class="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800" onclick={() => control('/api/dispatch', { paused: !snapshot?.dispatch?.paused })}>
          {snapshot.dispatch.paused ? 'Resume dispatching' : 'Pause dispatching'}
        </button>
      </div>
    {/if}
  </header>

  {#if auth === 'login'}
    <section class="rounded-xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
      <h2 class="font-semibold">Sign in</h2>
      <p class="mt-2 text-sm text-stone-600 dark:text-stone-300">
        Open the one-time login link printed in the terminal where you ran <code class="font-mono">agentmesh start</code>. Each link works once.
      </p>
    </section>
  {:else if snapshot}
    <div class="mb-4 flex flex-wrap gap-1 border-b border-stone-200 dark:border-stone-800" role="tablist" aria-label="Views">
      {#each TABS as t (t.id)}
        {@const n = t.id === 'missions' ? needsYou.missions : t.id === 'board' ? needsYou.board : 0}
        <button role="tab" aria-selected={view === t.id} class={['-mb-px rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium', view === t.id ? 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900' : 'border-transparent text-stone-500 hover:text-stone-900 dark:hover:text-stone-100']} onclick={() => (chosen = t.id)}>
          {t.label}{#if n} <span class="ml-1 rounded-full bg-amber-500 px-1.5 text-xs text-white" title="Needs you">{n}</span>{/if}
        </button>
      {/each}
    </div>
    {#if !snapshot.setup.project.landing}
      <p class="mb-4 rounded-lg border border-red-500 bg-red-50 p-2 text-sm dark:bg-red-950">Nothing will be added to your main branch yet: tell AgentMesh how to check your project in <button class="underline" onclick={() => (chosen = 'setup')}>Setup</button>.</p>
    {/if}
    {#if view === 'missions'}
      <Missions missions={snapshot.missions} agents={snapshot.agents} usage={snapshot.usage?.byMission ?? []} onChanged={() => void load()} />
    {:else if view === 'setup'}
      <Setup platforms={snapshot.setup.platforms} project={snapshot.setup.project} onChanged={() => void load()} />
    {:else}
    <section aria-label="Agents now" class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each agentsHuman as agent (agent.id)}
        <article class={['rounded-xl border-l-4 bg-white p-4 dark:bg-stone-900', platformTone(agent.platform)]}>
          <div class="flex items-baseline justify-between gap-2">
            <h2 class="font-semibold">{agent.name}</h2>
            <span class="text-xs uppercase tracking-wide text-stone-500">{agent.status}</span>
          </div>
          <p class="mt-1 text-sm text-stone-800 dark:text-stone-200">{agent.doing ?? 'idle'}</p>
          <p class="mt-1 text-xs text-stone-500">{agent.currentTaskId ? `Task ${agent.currentTaskId}` : 'No active task'}</p>
          {#if usedBy(agent.id)}<p class="mt-1 text-xs text-stone-500" title="What the agent tool reported. Antigravity reports tokens but no cost.">Used: {formatUsage(usedBy(agent.id)!)}</p>{/if}
          {#if agent.status === 'BUSY'}
            <button class="mt-2 rounded-lg border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950" onclick={() => control('/api/stop-run', { agentId: agent.id })}>Stop run</button>
          {/if}
        </article>
      {/each}
      {#each snapshot.dispatch?.backoffs ?? [] as b (b.platform)}
        <article class="rounded-xl border border-amber-500 bg-amber-50 p-4 text-sm dark:bg-amber-950">
          <strong>{b.platform}</strong> unavailable until {time(b.until)}<br /><span class="text-stone-600 dark:text-stone-300">{b.reason}</span>
        </article>
      {/each}
    </section>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section aria-label="Tasks" class="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {#each COLUMNS.filter((c) => byStatus[c]?.length) as column (column)}
          <div class="rounded-xl border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
            <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{column.replaceAll('_', ' ')} · {byStatus[column]?.length}</h2>
            <ul class="grid gap-2">
              {#each byStatus[column] ?? [] as task (task.id)}
                <li class="rounded-lg border border-stone-200 p-2 text-sm dark:border-stone-800">
                  <span class="font-mono text-xs text-stone-500">{task.id}</span>
                  <div>{task.title}</div>
                  <div class="text-xs text-stone-500">{task.assigned_agent_id ?? `suggested: ${task.suggested_owner ?? 'anyone'}`}</div>
                  {#if locksOf(task.id).length}
                    <div class="mt-1 text-xs text-stone-500" title={locksOf(task.id).map((l) => `${l.path} (${l.agentId})`).join('\n')}>
                      {locksOf(task.id).length} file lock{locksOf(task.id).length === 1 ? '' : 's'}
                      <button class="ml-1 underline" onclick={() => releaseLocks(task.id)}>Release</button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="text-sm text-stone-500">No tasks yet.</p>
        {/each}
      </section>

      <aside class="grid content-start gap-6">
        <Controls tasks={snapshot.tasks} questions={snapshot.openQuestions} agents={snapshot.agents} stuck={snapshot.dispatch?.stuck ?? []} onChanged={() => void load()} />

        <Timeline events={snapshot.events} tasks={snapshot.tasks} agents={snapshot.agents} />
      </aside>
    </div>
    {/if}
  {:else}
    <p class="text-sm text-stone-500">Loading…</p>
  {/if}
</main>
