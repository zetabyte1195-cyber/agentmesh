<script lang="ts">
  // Agent interaction timeline (P3.2; spec v1.1 §11 R10 / AC-7).
  // Threaded per task and filterable per agent. Every handoff, audit, finding,
  // question, answer and decision between agents is rendered so a reviewer can
  // reconstruct a task's full back-and-forth from the timeline alone.
  // Strict CSP: Tailwind CSS classes only, no inline style attributes, no inline scripts.

  export interface MeshEvent {
    id: string;
    taskId: string | null;
    agentId: string | null;
    kind: string;
    text: string;
    createdAt: string;
  }

  export interface Task {
    id: string;
    title: string;
    status: string;
    assigned_agent_id?: string | null;
    suggested_owner?: string | null;
  }

  export interface Agent {
    id: string;
    name: string;
    platform: string;
    status?: string;
    currentTaskId?: string | null;
    doing?: string | null;
  }

  let {
    events = [],
    tasks = [],
    agents = [],
  } = $props<{
    events?: MeshEvent[];
    tasks?: Task[];
    agents?: Agent[];
  }>();

  let selectedAgent = $state<string>('all');
  let selectedTask = $state<string>('all');
  let selectedKind = $state<string>('all');
  let searchQuery = $state<string>('');
  let viewMode = $state<'threaded' | 'flat'>('threaded');
  let sortOrder = $state<'asc' | 'desc'>('asc');
  let isMaximized = $state(false);
  let collapsedThreads = $state<Record<string, boolean>>({});

  function formatTime(iso: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDateTime(iso: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  function agentBadgeClasses(agentId: string | null): string {
    const id = (agentId ?? '').toLowerCase();
    if (id.includes('claude')) {
      return 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800';
    }
    if (id.includes('gemini') || id.includes('antigravity')) {
      return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800';
    }
    if (id.includes('human')) {
      return 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800';
    }
    return 'bg-stone-100 text-stone-700 border-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-700';
  }

  function kindBadgeClasses(kind: string, text: string): string {
    switch (kind) {
      case 'handoff':
        return 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800';
      case 'audit':
        if (text.includes('PASSED')) {
          return 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800';
        }
        if (text.includes('GAP_FOUND') || text.includes('REJECTED')) {
          return 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800';
        }
        return 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800';
      case 'finding':
        if (text.includes('[BUG]') || text.includes('[SECURITY]')) {
          return 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800';
        }
        if (text.includes('[SPEC_CORRECTION]')) {
          return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800';
        }
        return 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800';
      case 'question':
        return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800';
      case 'answer':
        return 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800';
      case 'decision':
        return 'bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-950 dark:text-cyan-300 dark:border-cyan-800';
      case 'claim':
        return 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800';
      case 'task-added':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800';
      default:
        return 'bg-stone-100 text-stone-700 border-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-700';
    }
  }

  function kindBorderClasses(kind: string, text: string): string {
    switch (kind) {
      case 'handoff':
        return 'border-l-4 border-l-blue-500';
      case 'audit':
        if (text.includes('PASSED')) return 'border-l-4 border-l-emerald-500';
        if (text.includes('GAP_FOUND') || text.includes('REJECTED')) return 'border-l-4 border-l-rose-500';
        return 'border-l-4 border-l-teal-500';
      case 'finding':
        if (text.includes('[BUG]') || text.includes('[SECURITY]')) return 'border-l-4 border-l-rose-500';
        if (text.includes('[SPEC_CORRECTION]')) return 'border-l-4 border-l-amber-500';
        return 'border-l-4 border-l-purple-500';
      case 'question':
        return 'border-l-4 border-l-amber-500';
      case 'answer':
        return 'border-l-4 border-l-teal-500';
      case 'decision':
        return 'border-l-4 border-l-cyan-500';
      case 'claim':
        return 'border-l-4 border-l-indigo-500';
      case 'task-added':
        return 'border-l-4 border-l-emerald-400';
      default:
        return 'border-l-4 border-l-stone-300 dark:border-l-stone-700';
    }
  }

  function kindLabel(kind: string, text: string): string {
    switch (kind) {
      case 'handoff':
        return 'Handoff →';
      case 'audit':
        if (text.includes('PASSED')) return 'Audit: PASSED';
        if (text.includes('GAP_FOUND')) return 'Audit: GAP FOUND';
        return 'Audit';
      case 'finding':
        if (text.includes('[BUG]')) return 'Bug Finding';
        if (text.includes('[SECURITY]')) return 'Security Finding';
        if (text.includes('[SPEC_CORRECTION]')) return 'Spec Correction';
        return 'Finding';
      case 'question':
        return 'Question ?';
      case 'answer':
        return 'Answer ✓';
      case 'decision':
        return 'Decision';
      case 'claim':
        return 'Claimed';
      case 'status-change':
        return 'Status Change';
      case 'status':
        return 'Status';
      case 'task-added':
        return 'Task Added';
      default:
        return kind;
    }
  }

  function statusBadgeClasses(status: string | null): string {
    switch (status) {
      case 'PASSED':
      case 'COMMITTED':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800';
      case 'IN_PROGRESS':
      case 'AUDITING':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border border-blue-200 dark:border-blue-800';
      case 'READY_FOR_REVIEW':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border border-purple-200 dark:border-purple-800';
      case 'BLOCKED':
      case 'REJECTED':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-200 dark:border-rose-800';
      default:
        return 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300 border border-stone-200 dark:border-stone-700';
    }
  }

  const knownAgents = $derived.by(() => {
    const set = new Set<string>();
    for (const a of agents) if (a.name) set.add(a.name);
    for (const e of events) if (e.agentId) set.add(e.agentId);
    return Array.from(set).sort();
  });

  const knownTasks = $derived.by(() => {
    const map = new Map<string, string>();
    for (const t of tasks) map.set(t.id, t.title);
    for (const e of events) {
      if (e.taskId && !map.has(e.taskId)) {
        map.set(e.taskId, `Task ${e.taskId}`);
      }
    }
    return Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  });

  const taskMap = $derived.by(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  });

  const filteredEvents = $derived.by(() => {
    return events.filter((e) => {
      if (selectedAgent !== 'all' && e.agentId !== selectedAgent) return false;
      if (selectedTask !== 'all') {
        if (selectedTask === 'general' && e.taskId !== null) return false;
        if (selectedTask !== 'general' && e.taskId !== selectedTask) return false;
      }
      if (selectedKind !== 'all') {
        if (selectedKind === 'handoff' && e.kind !== 'handoff') return false;
        if (selectedKind === 'audit' && e.kind !== 'audit') return false;
        if (selectedKind === 'finding' && e.kind !== 'finding') return false;
        if (selectedKind === 'qa' && e.kind !== 'question' && e.kind !== 'answer') return false;
        if (selectedKind === 'decision' && e.kind !== 'decision') return false;
        if (selectedKind === 'claim' && e.kind !== 'claim') return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const textMatch = e.text.toLowerCase().includes(q);
        const taskMatch = (e.taskId ?? '').toLowerCase().includes(q);
        const agentMatch = (e.agentId ?? '').toLowerCase().includes(q);
        const kindMatch = e.kind.toLowerCase().includes(q);
        if (!textMatch && !taskMatch && !agentMatch && !kindMatch) return false;
      }
      return true;
    });
  });

  interface TaskThread {
    taskId: string;
    title: string;
    status: string | null;
    events: MeshEvent[];
    latestAt: string;
    participants: string[];
  }

  const threads = $derived.by(() => {
    const map = new Map<string, MeshEvent[]>();

    for (const e of filteredEvents) {
      const key = e.taskId ?? 'general';
      const arr = map.get(key);
      if (arr) {
        arr.push(e);
      } else {
        map.set(key, [e]);
      }
    }

    const res: TaskThread[] = [];
    for (const [key, evts] of map.entries()) {
      const sorted = [...evts].sort((a, b) => {
        const timeA = new Date(a.createdAt.includes('T') ? a.createdAt : `${a.createdAt.replace(' ', 'T')}Z`).getTime();
        const timeB = new Date(b.createdAt.includes('T') ? b.createdAt : `${b.createdAt.replace(' ', 'T')}Z`).getTime();
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
      });

      const latest = evts.reduce((acc, cur) => (cur.createdAt > acc ? cur.createdAt : acc), evts[0]!.createdAt);
      const taskObj = taskMap.get(key);
      const title = key === 'general' ? 'General / System Activity' : (taskObj?.title ?? `Task ${key}`);
      const status = taskObj?.status ?? null;
      const participants = Array.from(new Set(evts.map((e) => e.agentId).filter((id): id is string => Boolean(id))));

      res.push({
        taskId: key,
        title,
        status,
        events: sorted,
        latestAt: latest,
        participants,
      });
    }

    // Sort threads: latest activity first
    res.sort((a, b) => (b.latestAt > a.latestAt ? 1 : b.latestAt < a.latestAt ? -1 : 0));
    return res;
  });

  function isCollapsed(taskId: string): boolean {
    return Boolean(collapsedThreads[taskId]);
  }

  function toggleThread(taskId: string): void {
    collapsedThreads = { ...collapsedThreads, [taskId]: !collapsedThreads[taskId] };
  }

  function expandAll(): void {
    collapsedThreads = {};
  }

  function collapseAll(): void {
    const next: Record<string, boolean> = {};
    for (const th of threads) {
      next[th.taskId] = true;
    }
    collapsedThreads = next;
  }
</script>

<section
  aria-label="Agent interaction timeline"
  class={[
    'bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 transition-all',
    isMaximized
      ? 'fixed inset-3 z-50 rounded-2xl shadow-2xl p-5 flex flex-col overflow-hidden sm:inset-6'
      : 'rounded-xl p-4 flex flex-col'
  ]}
>
  <!-- Header with title, live counters, view mode & maximize toggles -->
  <header class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-3 dark:border-stone-800">
    <div class="flex items-center gap-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">Interaction Timeline</h2>
      <span class="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
        {filteredEvents.length} {filteredEvents.length === 1 ? 'event' : 'events'}
      </span>
      {#if viewMode === 'threaded'}
        <span class="text-xs text-stone-400 dark:text-stone-500">
          · {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-1.5 text-xs">
      <div class="inline-flex rounded-lg border border-stone-200 p-0.5 dark:border-stone-800">
        <button
          type="button"
          class={[
            'rounded px-2 py-1 font-medium transition-colors',
            viewMode === 'threaded'
              ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
              : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100'
          ]}
          onclick={() => (viewMode = 'threaded')}
          title="Threaded per task"
        >
          Threaded
        </button>
        <button
          type="button"
          class={[
            'rounded px-2 py-1 font-medium transition-colors',
            viewMode === 'flat'
              ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
              : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100'
          ]}
          onclick={() => (viewMode = 'flat')}
          title="Flat chronological stream"
        >
          Stream
        </button>
      </div>

      <button
        type="button"
        class="rounded-lg border border-stone-200 px-2 py-1 font-medium text-stone-600 hover:bg-stone-50 hover:text-stone-900 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
        onclick={() => (sortOrder = sortOrder === 'asc' ? 'desc' : 'asc')}
        title={sortOrder === 'asc' ? 'Order: Oldest first (chronological)' : 'Order: Newest first'}
      >
        {sortOrder === 'asc' ? 'Oldest first' : 'Newest first'}
      </button>

      <button
        type="button"
        class="rounded-lg border border-stone-200 px-2 py-1 font-medium text-stone-600 hover:bg-stone-50 hover:text-stone-900 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
        onclick={() => (isMaximized = !isMaximized)}
        title={isMaximized ? 'Restore sidebar view' : 'Expand full screen'}
      >
        {isMaximized ? 'Minimize' : 'Expand'}
      </button>
    </div>
  </header>

  <!-- Filter & Search Controls -->
  <!-- Two columns: the timeline lives in a 380 px sidebar, where 4 columns clipped the selects (P3.2 audit follow-up) -->
  <div class="mb-4 grid grid-cols-2 gap-2">
    <!-- Filter per Agent -->
    <div>
      <label for="timeline-agent-filter" class="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">Agent</label>
      <select
        id="timeline-agent-filter"
        class="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200"
        value={selectedAgent}
        onchange={(e) => (selectedAgent = (e.target as HTMLSelectElement).value)}
      >
        <option value="all">All Agents ({knownAgents.length})</option>
        {#each knownAgents as ag (ag)}
          <option value={ag}>{ag}</option>
        {/each}
      </select>
    </div>

    <!-- Filter per Task -->
    <div>
      <label for="timeline-task-filter" class="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">Task</label>
      <select
        id="timeline-task-filter"
        class="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200"
        value={selectedTask}
        onchange={(e) => (selectedTask = (e.target as HTMLSelectElement).value)}
      >
        <option value="all">All Tasks</option>
        {#each knownTasks as t (t.id)}
          <option value={t.id}>{t.id} · {t.title.slice(0, 30)}{t.title.length > 30 ? '…' : ''}</option>
        {/each}
        <option value="general">General / System</option>
      </select>
    </div>

    <!-- Filter per Kind -->
    <div>
      <label for="timeline-kind-filter" class="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">Kind</label>
      <select
        id="timeline-kind-filter"
        class="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200"
        value={selectedKind}
        onchange={(e) => (selectedKind = (e.target as HTMLSelectElement).value)}
      >
        <option value="all">All Kinds</option>
        <option value="handoff">Handoffs (batons)</option>
        <option value="audit">Audits (pass / fail)</option>
        <option value="finding">Findings (probes / bugs)</option>
        <option value="qa">Questions & Answers</option>
        <option value="decision">Decisions</option>
        <option value="claim">Claims</option>
      </select>
    </div>

    <!-- Search input -->
    <div>
      <label for="timeline-search-filter" class="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">Search</label>
      <div class="relative">
        <input
          id="timeline-search-filter"
          type="search"
          placeholder="Filter text, probes, files…"
          class="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 placeholder-stone-400 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200 dark:placeholder-stone-500"
          value={searchQuery}
          oninput={(e) => (searchQuery = (e.target as HTMLInputElement).value)}
        />
        {#if searchQuery}
          <button
            type="button"
            class="absolute right-2 top-1.5 text-xs text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
            onclick={() => (searchQuery = '')}
            title="Clear search"
          >
            ×
          </button>
        {/if}
      </div>
    </div>
  </div>

  <!-- Thread Controls (Expand All / Collapse All) -->
  {#if viewMode === 'threaded' && threads.length > 0}
    <div class="mb-2 flex items-center justify-between text-xs text-stone-500">
      <span>{threads.length} task {threads.length === 1 ? 'thread' : 'threads'}</span>
      <div class="space-x-2">
        <button
          type="button"
          class="text-xs hover:underline hover:text-stone-800 dark:hover:text-stone-200"
          onclick={expandAll}
        >
          Expand all
        </button>
        <span>·</span>
        <button
          type="button"
          class="text-xs hover:underline hover:text-stone-800 dark:hover:text-stone-200"
          onclick={collapseAll}
        >
          Collapse all
        </button>
      </div>
    </div>
  {/if}

  <!-- Event Content Area -->
  <div class={['overflow-y-auto pr-1', isMaximized ? 'flex-1' : 'max-h-[34rem]']}>
    {#if filteredEvents.length === 0}
      <div class="rounded-lg border border-dashed border-stone-200 p-6 text-center text-sm text-stone-500 dark:border-stone-800">
        No interaction events match the selected filters.
      </div>
    {:else if viewMode === 'threaded'}
      <!-- THREADED VIEW: Threads per task -->
      <div class="space-y-4">
        {#each threads as thread (thread.taskId)}
          {@const collapsed = isCollapsed(thread.taskId)}
          <article class="rounded-xl border border-stone-200 bg-stone-50/50 transition-colors dark:border-stone-800 dark:bg-stone-900/50">
            <!-- Thread header button -->
            <button
              type="button"
              class="flex w-full items-start justify-between gap-3 p-3 text-left transition hover:bg-stone-100/75 dark:hover:bg-stone-800/50"
              onclick={() => toggleThread(thread.taskId)}
              aria-expanded={!collapsed}
            >
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="rounded bg-stone-200 px-1.5 py-0.5 font-mono text-xs font-semibold text-stone-800 dark:bg-stone-800 dark:text-stone-200">
                    {thread.taskId === 'general' ? 'General' : thread.taskId}
                  </span>
                  {#if thread.status}
                    <span class={['rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider', statusBadgeClasses(thread.status)]}>
                      {thread.status}
                    </span>
                  {/if}
                  <span class="truncate text-xs font-medium text-stone-700 dark:text-stone-300">
                    {thread.title}
                  </span>
                </div>

                <!-- Participants & latest activity -->
                <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                  <span class="font-medium text-stone-600 dark:text-stone-400">
                    {thread.events.length} {thread.events.length === 1 ? 'event' : 'events'}
                  </span>
                  <span>·</span>
                  <span>Last: {formatTime(thread.latestAt)}</span>
                  {#if thread.participants.length > 0}
                    <span>·</span>
                    <div class="flex items-center gap-1">
                      {#each thread.participants as p (p)}
                        <span class={['rounded border px-1 py-0.2 text-xs', agentBadgeClasses(p)]}>
                          {p}
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>

              <!-- Accordion indicator -->
              <span class="mt-1 text-xs text-stone-400">
                {collapsed ? '▶' : '▼'}
              </span>
            </button>

            <!-- Thread events list -->
            {#if !collapsed}
              <div class="border-t border-stone-200 p-3 pt-2 dark:border-stone-800">
                <div class="relative ml-2 space-y-3 border-l-2 border-stone-200 pl-4 dark:border-stone-800">
                  {#each thread.events as e (e.id)}
                    <div class={['rounded-lg border border-stone-200 bg-white p-2.5 text-xs shadow-xs dark:border-stone-800 dark:bg-stone-900', kindBorderClasses(e.kind, e.text)]}>
                      <!-- Event metadata bar -->
                      <div class="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <!-- Agent badge -->
                          <span class={['rounded border px-1.5 py-0.5 text-xs font-semibold', agentBadgeClasses(e.agentId)]}>
                            {e.agentId ?? 'system'}
                          </span>

                          <!-- Kind badge -->
                          <span class={['rounded border px-1.5 py-0.5 text-xs font-medium', kindBadgeClasses(e.kind, e.text)]}>
                            {kindLabel(e.kind, e.text)}
                          </span>
                        </div>

                        <!-- Timestamp -->
                        <span class="text-xs text-stone-400 dark:text-stone-500" title={e.createdAt}>
                          {formatDateTime(e.createdAt)}
                        </span>
                      </div>

                      <!-- Event body text -->
                      <div class="whitespace-pre-wrap break-words font-sans text-xs text-stone-800 dark:text-stone-200">
                        {e.text}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {:else}
      <!-- FLAT STREAM VIEW: Sequential chronological event stream -->
      <div class="relative ml-2 space-y-3 border-l-2 border-stone-200 pl-4 dark:border-stone-800">
        {#each (sortOrder === 'asc' ? [...filteredEvents].reverse() : filteredEvents) as e (e.id)}
          <div class={['rounded-lg border border-stone-200 bg-white p-2.5 text-xs shadow-xs dark:border-stone-800 dark:bg-stone-900', kindBorderClasses(e.kind, e.text)]}>
            <!-- Event metadata bar -->
            <div class="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
              <div class="flex flex-wrap items-center gap-1.5">
                <!-- Agent badge -->
                <span class={['rounded border px-1.5 py-0.5 text-xs font-semibold', agentBadgeClasses(e.agentId)]}>
                  {e.agentId ?? 'system'}
                </span>

                <!-- Task tag -->
                {#if e.taskId}
                  <span class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                    {e.taskId}
                  </span>
                {/if}

                <!-- Kind badge -->
                <span class={['rounded border px-1.5 py-0.5 text-xs font-medium', kindBadgeClasses(e.kind, e.text)]}>
                  {kindLabel(e.kind, e.text)}
                </span>
              </div>

              <!-- Timestamp -->
              <span class="text-xs text-stone-400 dark:text-stone-500" title={e.createdAt}>
                {formatDateTime(e.createdAt)}
              </span>
            </div>

            <!-- Event body text -->
            <div class="whitespace-pre-wrap break-words font-sans text-xs text-stone-800 dark:text-stone-200">
              {e.text}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
