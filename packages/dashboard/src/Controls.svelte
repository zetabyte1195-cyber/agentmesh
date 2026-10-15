<script lang="ts">
  // Human-in-the-loop controls (P3.3): answer questions, review submitted tasks (diff + daemon-run
  // checks + an EXPLICIT test result, per the Human decision on P1.8), and message an agent.
  // All calls are same-origin POSTs with the session cookie; the daemon checks Origin (CSRF).
  import DiffView from './DiffView.svelte';

  type Task = { id: string; title: string; status: string; assigned_agent_id: string | null };
  type Stuck = { agentId: string; subject: string; tries: number; lastStatus: string; lastDetail: string | null };
  type Question = { id: string; text: string; from_agent_id: string; to_role: string; task_id: string | null };
  type Agent = { id: string; name: string; platform: string };
  type Diff = { diffHash: string; changedPaths: string[]; diff: string; truncated: boolean };
  type Verify = { ok: boolean; exitCode: number | null; output: string; command: string; timedOut?: boolean };

  let { tasks, questions, agents, stuck = [], onChanged }: { tasks: Task[]; questions: Question[]; agents: Agent[]; stuck?: Stuck[]; onChanged: () => void } = $props();

  let answers = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let open = $state<string | null>(null);
  let diffs = $state<Record<string, Diff>>({});
  let checks = $state<Record<string, Verify>>({});
  let testResult = $state<Record<string, 'passed' | 'not-passed' | undefined>>({});
  let notes = $state<Record<string, string>>({});
  let msg = $state({ toAgentId: '', taskId: '', message: '', sent: '' });

  const forHuman = $derived(questions.filter((q) => q.to_role === 'Human'));
  const reviewable = $derived(tasks.filter((t) => t.status === 'READY_FOR_REVIEW' || t.status === 'AUDITING'));
  const blocked = $derived(tasks.filter((t) => t.status === 'BLOCKED'));
  const agentList = $derived(agents.filter((a) => a.platform !== 'HUMAN'));

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
    return data;
  }

  async function run(key: string, fn: () => Promise<void>): Promise<void> {
    busy[key] = true;
    errors[key] = '';
    try {
      await fn();
    } catch (e) {
      errors[key] = (e as Error).message;
    } finally {
      busy[key] = false;
    }
  }

  const answer = (q: Question) =>
    run(q.id, async () => {
      await post('/api/answer', { questionId: q.id, answer: (answers[q.id] ?? '').trim() });
      answers[q.id] = '';
      onChanged();
    });

  const toggleReview = (t: Task) =>
    run(`diff-${t.id}`, async () => {
      open = open === t.id ? null : t.id;
      if (open && !diffs[t.id]) diffs[t.id] = await post<Diff>('/api/diff', { taskId: t.id });
    });

  const runChecks = (t: Task) =>
    run(`verify-${t.id}`, async () => {
      checks[t.id] = await post<Verify>('/api/verify', { taskId: t.id });
    });

  const audit = (t: Task, verdict: 'PASSED' | 'GAP_FOUND') =>
    run(`audit-${t.id}`, async () => {
      const result = testResult[t.id];
      if (!result) throw new Error('Choose whether the tests ran and passed.');
      if (verdict === 'PASSED' && result !== 'passed') throw new Error('Passing a task requires tests that ran and passed.');
      if (!(notes[t.id] ?? '').trim()) throw new Error('Write a note: what you checked and why.');
      await post('/api/audit', { taskId: t.id, verdict, diffHash: diffs[t.id]!.diffHash, testRunSuccess: result === 'passed', notes: notes[t.id]!.trim() });
      open = null;
      onChanged();
    });

  const tryAgain = (s: Stuck) =>
    run(`retry-${s.agentId}-${s.subject}`, async () => {
      await post('/api/retry', { agentId: s.agentId, subject: s.subject });
      onChanged();
    });
  const subjectLabel = (subject: string) => (subject.startsWith('mission:') ? `mission ${subject.slice(8)}` : `task ${subject}`);

  const send = () =>
    run('message', async () => {
      await post('/api/message', { toAgentId: msg.toAgentId, taskId: msg.taskId, message: msg.message.trim() });
      msg.sent = `Sent to ${msg.toAgentId}. It will see it the next time it reads the board.`;
      msg.message = '';
      onChanged();
    });

  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<section aria-label="Needs you" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="mb-2 font-display text-lg font-semibold">Needs you</h2>

  {#each forHuman as q (q.id)}
    <div class="border-t border-stone-200 py-3 text-sm first:border-t-0 dark:border-stone-800">
      <strong>{q.from_agent_id}</strong> asks{q.task_id ? ` on ${q.task_id}` : ''}:
      <p class="whitespace-pre-wrap">{q.text}</p>
      <label class="sr-only" for={`answer-${q.id}`}>Your answer</label>
      <textarea id={`answer-${q.id}`} class={field} rows="2" placeholder="Your answer" bind:value={answers[q.id]}></textarea>
      <button class={['mt-2', primary]} disabled={busy[q.id] || !(answers[q.id] ?? '').trim()} onclick={() => answer(q)}>Answer</button>
      {#if errors[q.id]}<p role="alert" class="mt-1 text-xs text-red-600">{errors[q.id]}</p>{/if}
    </div>
  {/each}

  {#each reviewable as t (t.id)}
    <div class="border-t border-stone-200 py-3 text-sm first:border-t-0 dark:border-stone-800">
      <div class="flex items-baseline justify-between gap-2">
        <span><span class="font-mono text-xs text-stone-500">{t.id}</span> {t.title}</span>
        <button class={button} aria-expanded={open === t.id} onclick={() => toggleReview(t)}>{open === t.id ? 'Close' : 'Review'}</button>
      </div>
      <p class="text-xs text-stone-500">By {t.assigned_agent_id}. The other platform reviews by default; you can review it yourself.</p>
      {#if errors[`diff-${t.id}`]}<p role="alert" class="mt-1 text-xs text-red-600">{errors[`diff-${t.id}`]}</p>{/if}

      {#if open === t.id && diffs[t.id]}
        {@const d = diffs[t.id]!}
        <p class="mt-2 text-xs text-stone-500">Changed: {d.changedPaths.join(', ')}{d.truncated ? ' (diff truncated)' : ''}</p>
        <DiffView diff={d.diff} />

        <button class={['mt-2', button]} disabled={busy[`verify-${t.id}`]} onclick={() => runChecks(t)}>{busy[`verify-${t.id}`] ? 'Running checks…' : 'Run checks'}</button>
        {#if checks[t.id]}
          <p class={['mt-1 text-xs font-semibold', checks[t.id]!.ok ? 'text-green-700' : 'text-red-600']}>
            {checks[t.id]!.ok ? 'Checks passed' : `Checks failed (exit ${checks[t.id]!.exitCode ?? '?'}${checks[t.id]!.timedOut ? ', timed out' : ''})`} · {checks[t.id]!.command}
          </p>
          <pre class="mt-1 max-h-40 overflow-auto rounded-lg bg-stone-100 p-2 font-mono text-xs dark:bg-stone-950">{checks[t.id]!.output}</pre>
        {/if}

        <fieldset class="mt-2">
          <legend class="text-xs font-medium">Tests (required: no default)</legend>
          <label class="mr-4 text-sm"><input type="radio" name={`tests-${t.id}`} value="passed" bind:group={testResult[t.id]} /> Ran and passed</label>
          <label class="text-sm"><input type="radio" name={`tests-${t.id}`} value="not-passed" bind:group={testResult[t.id]} /> Not run, or failed</label>
        </fieldset>
        <label class="mt-2 block text-xs font-medium" for={`notes-${t.id}`}>Notes (what you checked)</label>
        <textarea id={`notes-${t.id}`} class={field} rows="2" bind:value={notes[t.id]}></textarea>
        <div class="mt-2 flex gap-2">
          <button class={primary} disabled={busy[`audit-${t.id}`]} onclick={() => audit(t, 'PASSED')}>Pass</button>
          <button class={button} disabled={busy[`audit-${t.id}`]} onclick={() => audit(t, 'GAP_FOUND')}>Send back</button>
        </div>
        {#if errors[`audit-${t.id}`]}<p role="alert" class="mt-1 text-xs text-red-600">{errors[`audit-${t.id}`]}</p>{/if}
      {/if}
    </div>
  {/each}

  {#each stuck as s (`${s.agentId}-${s.subject}`)}
    <div class="border-t border-stone-200 py-3 text-sm first:border-t-0 dark:border-stone-800">
      <p><strong>{s.agentId}</strong> gave up on {subjectLabel(s.subject)} after {s.tries} tries{s.lastStatus === 'SUCCEEDED' ? ' (each run ended without moving it forward)' : ''}.</p>
      {#if s.lastDetail}<details class="mt-1"><summary class="cursor-pointer text-xs text-stone-500">Last reason</summary><pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-2 font-mono text-xs dark:bg-stone-950">{s.lastDetail}</pre></details>{/if}
      <p class="mt-1 text-xs text-stone-500">Fix what it needs first (answer it, message it, or change the task), then:</p>
      <button class={['mt-1', button]} disabled={busy[`retry-${s.agentId}-${s.subject}`]} onclick={() => tryAgain(s)}>Try again</button>
      {#if errors[`retry-${s.agentId}-${s.subject}`]}<p role="alert" class="mt-1 text-xs text-red-600">{errors[`retry-${s.agentId}-${s.subject}`]}</p>{/if}
    </div>
  {/each}

  {#each blocked as t (t.id)}
    <p class="border-t border-stone-200 py-2 text-sm first:border-t-0 dark:border-stone-800"><span class="font-mono text-xs">{t.id}</span> is blocked: {t.title}</p>
  {/each}

  {#if !forHuman.length && !reviewable.length && !blocked.length && !stuck.length}
    <p class="text-sm text-stone-500">Nothing waiting on you.</p>
  {/if}
</section>

<section aria-label="Message an agent" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="mb-2 font-display text-lg font-semibold">Message an agent</h2>
  <div class="grid grid-cols-2 gap-2">
    <label class="text-xs font-medium">Agent
      <select class={field} bind:value={msg.toAgentId}>
        <option value="">Choose…</option>
        {#each agentList as a (a.id)}<option value={a.id}>{a.name} ({a.id})</option>{/each}
      </select>
    </label>
    <label class="text-xs font-medium">About task
      <select class={field} bind:value={msg.taskId}>
        <option value="">Choose…</option>
        {#each tasks as t (t.id)}<option value={t.id}>{t.id}</option>{/each}
      </select>
    </label>
  </div>
  <label class="sr-only" for="message-text">Message</label>
  <textarea id="message-text" class={['mt-2', field]} rows="2" placeholder="Instruction or correction" bind:value={msg.message}></textarea>
  <button class={['mt-2', primary]} disabled={busy.message || !msg.toAgentId || !msg.taskId || !msg.message.trim()} onclick={send}>Send</button>
  {#if errors.message}<p role="alert" class="mt-1 text-xs text-red-600">{errors.message}</p>{/if}
  {#if msg.sent}<p class="mt-1 text-xs text-stone-500">{msg.sent}</p>{/if}
</section>
