<script lang="ts">
  // AgentMesh cockpit shell. Snapshot from GET /api/state, then live board events over the authenticated
  // WebSocket (no polling). Navigation is a sidebar; Home is the first screen, Board is the detailed view.
  import { type ComponentProps, onMount, tick } from 'svelte';
  import type { AgentInfo } from './AgentCard.svelte';
  import { type ActivityState, applyChange, mergeEntries } from './activity';
  import { type UsageTotals } from './api';
  import Board from './Board.svelte';
  import Controls from './Controls.svelte';
  import Home from './Home.svelte';
  import Missions from './Missions.svelte';
  import { announce, freshNotices, titleFor } from './notify';
  import Runs from './Runs.svelte';
  import Schedules from './Schedules.svelte';
  import Setup from './Setup.svelte';
  import Sidebar from './Sidebar.svelte';
  import { setTheme, storedTheme, type ThemeChoice } from './theme';
  import Timeline from './Timeline.svelte';
  import TitleBlock from './TitleBlock.svelte';
  import type { ActivityChange, AgentSetting, BoardTask, LiveRun, Notice, NotificationsState, PlaybooksState, RecipeInfo, Run, SandboxState, SchedulesState, UpdateState } from './types';
  import type { View } from './views';

  let controlError = $state('');
  /** Header/agent-card controls: same-origin POST with the session cookie. */
  async function control(path: string, body: unknown): Promise<void> {
    controlError = '';
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) controlError = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`;
    void load();
  }

  type Question = { id: string; text: string; from_agent_id: string; to_role: string; task_id: string | null };
  type MeshEvent = { id: string; taskId: string | null; agentId: string | null; kind: string; text: string; createdAt: string };
  type Snapshot = {
    missions: ComponentProps<typeof Missions>['missions'];
    setup: { project: ComponentProps<typeof Setup>['project']; platforms: ComponentProps<typeof Setup>['platforms']; notifications: NotificationsState; update: UpdateState; recipes: RecipeInfo[]; agentSettings: AgentSetting[] };
    version: string | null;
    notices: Notice[];
    playbooks: PlaybooksState | null;
    schedules: SchedulesState | null;
    sandbox: SandboxState | null;
    agents: AgentInfo[];
    tasks: BoardTask[];
    openQuestions: Question[];
    events: MeshEvent[];
    leases: { id: string; taskId: string; agentId: string; path: string; type: string }[];
    /** The run each working agent is on, with its latest steps. */
    live: Record<string, LiveRun>;
    usage: { byAgent: ({ agentId: string } & UsageTotals)[]; byMission: ({ missionId: string } & UsageTotals)[] };
    dispatch: { paused: boolean; backoffs: { platform: string; until: string; reason: string }[]; stuck: NonNullable<ComponentProps<typeof Controls>['stuck']>; recentRuns: Run[] } | null;
  };

  let snapshot = $state<Snapshot | null>(null);
  let chosen = $state<View | null>(null);
  let theme = $state<ThemeChoice>(storedTheme());
  // With no agent connected the only useful place is Setup; otherwise start on Home.
  const view = $derived<View>(chosen ?? ((snapshot?.agents ?? []).some((a) => a.platform !== 'HUMAN') ? 'home' : 'setup'));
  const badges = $derived<Partial<Record<View, number>>>({
    missions: (snapshot?.notices ?? []).filter((n) => n.kind === 'plan' || n.kind === 'budget').length,
    board: (snapshot?.notices ?? []).filter((n) => n.kind === 'question' || n.kind === 'stuck').length,
    schedules: (snapshot?.schedules?.items ?? []).filter((s) => s.disabledReason).length,
  });
  let auth = $state<'checking' | 'ok' | 'login'>('checking');
  // Not yet opened is not the same as lost: the first connection is made just after the first snapshot arrives.
  let link = $state<'connecting' | 'live' | 'lost'>('connecting');
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const workers = $derived((snapshot?.agents ?? []).filter((a) => a.platform !== 'HUMAN'));
  // What each agent is doing, kept up to date from what the daemon pushes. The snapshot says what is going on when the page loads.
  let activity = $state<ActivityState>({ live: {}, byRun: {} });

  async function load(): Promise<void> {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      auth = 'login';
      return;
    }
    snapshot = (await res.json()) as Snapshot;
    const live = snapshot.live ?? {};
    const byRun = { ...activity.byRun };
    for (const l of Object.values(live)) byRun[l.runId] = mergeEntries(byRun[l.runId] ?? [], l.entries);
    activity = { live, byRun };
    auth = 'ok';
    handleNotices();
  }

  // New things that need you: a desktop notification (if you switched them on) and a count in the tab title.
  let seenNotices: Set<string> | null = null;
  function handleNotices(): void {
    const notices = snapshot?.notices ?? [];
    const r = freshNotices(seenNotices, notices);
    seenNotices = r.seen;
    for (const n of r.fresh) announce(n);
    document.title = titleFor(notices);
  }

  // Events arrive live; the snapshot is refreshed shortly after a burst so tasks/agents stay exact.
  function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void load(), 150);
  }

  // Reading the page again first catches up on what was missed, and finds out if the session ended (AgentMesh was restarted):
  // then the sign-in screen is shown, instead of reconnecting for ever without being allowed in.
  async function reconnect(): Promise<void> {
    try {
      await load();
    } catch {
      // AgentMesh is still not answering: try the live connection again anyway.
    }
    if (auth === 'ok') connect();
  }

  function connect(): void {
    const ws = new WebSocket(`ws://${location.host}/ws/cockpit`);
    ws.onopen = () => (link = 'live');
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; payload: MeshEvent & ActivityChange };
      if (msg.type === 'ACTIVITY') {
        // A step is not a reason to load everything again; the end of a run is (the card and the board change).
        activity = applyChange(activity, msg.payload);
        if (!msg.payload.running) scheduleRefresh();
        return;
      }
      if (msg.type === 'EVENT' && snapshot) snapshot.events = [msg.payload, ...snapshot.events].slice(0, 200);
      scheduleRefresh();
    };
    ws.onclose = () => {
      link = 'lost';
      if (auth === 'ok') setTimeout(() => void reconnect(), 2000);
    };
  }

  const locksOf = (taskId: string) => (snapshot?.leases ?? []).filter((l) => l.taskId === taskId);
  function releaseLocks(taskId: string): void {
    const n = locksOf(taskId).length;
    if (confirm(`Release the ${n} file lock${n === 1 ? '' : 's'} held for ${taskId}? The agent has to take them again before it can commit.`)) void control('/api/leases/release', { taskId });
  }

  /** Go to a screen, and optionally land on one element of it (for example one mission's card). */
  async function navigate(v: View, focus?: string): Promise<void> {
    chosen = v;
    window.scrollTo({ top: 0 });
    if (!focus) return;
    await tick();
    const el = document.getElementById(focus);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }
  /** "New mission" is a shortcut to the form at the top of Missions. */
  async function newMission(): Promise<void> {
    await navigate('missions');
    await tick();
    document.getElementById('m-title')?.focus();
  }
  function pickTheme(t: ThemeChoice): void {
    theme = t;
    setTheme(t);
  }
  const togglePause = () => control('/api/dispatch', { paused: !snapshot?.dispatch?.paused });

  onMount(() => {
    void load().then(() => {
      if (auth === 'ok') connect();
    });
  });
</script>

{#if auth === 'login'}
  <main class="mx-auto max-w-xl px-4 py-16">
    <h1 class="font-display text-3xl font-semibold">AgentMesh</h1>
    <section class="mt-6 rounded-lg border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
      <h2 class="font-semibold">Sign in</h2>
      <p class="mt-2 text-sm text-stone-600 dark:text-stone-300">
        Open the one-time login link printed in the terminal where you ran <code class="font-mono">agentmesh start</code>. Each link works once.
      </p>
    </section>
  </main>
{:else if snapshot}
  <div class="min-h-screen lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
    <Sidebar
      {view}
      {badges}
      onNavigate={navigate}
      onNewMission={newMission}
      projectName={snapshot.setup.project.name}
      agentCount={workers.length}
      version={snapshot.version}
      {link}
      paused={snapshot.dispatch ? snapshot.dispatch.paused : null}
      onTogglePause={togglePause}
      {theme}
      onTheme={pickTheme}
      error={controlError}
    />

    <main class="min-w-0 px-4 py-6 sm:px-8 lg:py-8">
      <div class="mx-auto max-w-6xl">
        {#if snapshot.setup.update.info?.newer}
          <p class="mb-4 rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm dark:bg-amber-950">AgentMesh {snapshot.setup.update.info.latest} is available (you have {snapshot.setup.update.info.current}). <button class="underline" onclick={() => navigate('setup')}>How to update</button>.</p>
        {/if}
        {#if !snapshot.setup.project.landing}
          <p class="mb-4 rounded-lg border border-red-500 bg-red-50 p-2 text-sm dark:bg-red-950">Nothing will be added to your main branch yet: tell AgentMesh how to check your project in <button class="underline" onclick={() => navigate('setup')}>Setup</button>.</p>
        {/if}

        {#if view === 'home'}
          <Home
            connected={link !== 'lost'}
            agents={snapshot.agents}
            tasks={snapshot.tasks}
            missions={snapshot.missions}
            notices={snapshot.notices}
            questions={snapshot.openQuestions}
            schedules={snapshot.schedules}
            usage={snapshot.usage?.byAgent ?? []}
            runs={snapshot.dispatch?.recentRuns ?? []}
            backoffs={snapshot.dispatch?.backoffs ?? []}
            paused={Boolean(snapshot.dispatch?.paused)}
            landing={snapshot.setup.project.landing}
            live={activity.live}
            onNavigate={navigate}
            onStop={(agentId) => void control('/api/stop-run', { agentId })}
            onChanged={() => void load()}
          />
        {:else if view === 'missions'}
          <Missions missions={snapshot.missions} agents={snapshot.agents} usage={snapshot.usage?.byMission ?? []} onChanged={() => void load()} />
        {:else if view === 'runs'}
          <Runs runs={snapshot.dispatch?.recentRuns ?? []} byRun={activity.byRun} />
        {:else if view === 'schedules' && snapshot.schedules}
          <Schedules schedules={snapshot.schedules} agents={snapshot.agents} onChanged={() => void load()} />
        {:else if view === 'setup'}
          <Setup platforms={snapshot.setup.platforms} agentSettings={snapshot.setup.agentSettings ?? []} project={snapshot.setup.project} notifications={snapshot.setup.notifications} update={snapshot.setup.update} version={snapshot.version} playbooks={snapshot.playbooks} recipes={snapshot.setup.recipes} sandbox={snapshot.sandbox} onChanged={() => void load()} />
        {:else}
          <h1 class="mb-4 font-display text-2xl font-semibold">Board</h1>
          <Board
            tasks={snapshot.tasks}
            agents={snapshot.agents}
            leases={snapshot.leases}
            live={activity.live}
            byRun={activity.byRun}
            runs={snapshot.dispatch?.recentRuns ?? []}
            onReleaseLocks={releaseLocks}
          />
          <div class="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Controls tasks={snapshot.tasks} questions={snapshot.openQuestions} agents={snapshot.agents} stuck={snapshot.dispatch?.stuck ?? []} onChanged={() => void load()} />
            <Timeline events={snapshot.events} tasks={snapshot.tasks} agents={snapshot.agents} />
          </div>
        {/if}

        <div class="mt-10 lg:hidden">
          <TitleBlock projectName={snapshot.setup.project.name} agentCount={workers.length} version={snapshot.version} {link} paused={snapshot.dispatch ? snapshot.dispatch.paused : null} onTogglePause={togglePause} {theme} onTheme={pickTheme} error={controlError} />
        </div>
      </div>
    </main>
  </div>
{:else}
  <p class="p-8 text-sm text-stone-500">Loading…</p>
{/if}
