<script lang="ts">
  // One thing that needs the person, with the means to deal with it where it is shown. A question is answered here and
  // a run that gave up is retried here. A plan is only opened: reading it before approving is the point, so that
  // button goes to the plan itself instead of approving from a summary.
  import { guarded, post } from './api';
  import { noticeAction } from './home';
  import Icon, { type IconName } from './Icon.svelte';
  import type { Notice } from './types';
  import type { View } from './views';

  let { notice, question = null, onNavigate, onChanged }: { notice: Notice; question?: string | null; onNavigate: (v: View, focus?: string) => void; onChanged: () => void } = $props();

  const ICON: Record<Notice['kind'], IconName> = { plan: 'plan', question: 'question', stuck: 'alert', done: 'check', budget: 'alert' };
  const act = $derived(noticeAction(notice));
  const canAnswer = $derived(notice.kind === 'question' && Boolean(notice.questionId));
  const canRetry = $derived(notice.kind === 'stuck' && Boolean(notice.agentId) && Boolean(notice.subject));

  let answer = $state('');
  let busy = $state(false);
  let error = $state('');

  const send = guarded(
    (b) => (busy = b),
    (e) => (error = e),
    async () => {
      await post('/api/answer', { questionId: notice.questionId, answer: answer.trim() });
      answer = '';
      onChanged();
    },
  );
  const retry = guarded(
    (b) => (busy = b),
    (e) => (error = e),
    async () => {
      await post('/api/retry', { agentId: notice.agentId, subject: notice.subject });
      onChanged();
    },
  );

  const primary = 'shrink-0 rounded-md bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
  const secondary = 'shrink-0 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-semibold hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800';
</script>

<article
  aria-label={notice.title}
  class={['rounded-lg border border-l-[3px] border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900', notice.urgent ? 'border-l-marigold-400 dark:border-l-marigold-400' : 'border-l-stone-300 dark:border-l-stone-700']}
>
  <div class="flex items-center gap-3">
    <Icon name={ICON[notice.kind]} class={notice.urgent ? 'text-marigold-500' : 'text-stone-500'} />
    <div class="min-w-0 flex-1">
      <h2 class="truncate text-sm font-semibold">{notice.title}</h2>
      {#if canAnswer}
        <p class="whitespace-pre-wrap text-sm text-stone-600 dark:text-stone-300">{question ?? notice.text}</p>
      {:else}
        <p class="line-clamp-2 text-sm text-stone-600 dark:text-stone-300">{notice.text}</p>
      {/if}
    </div>
    {#if canRetry}
      <button class={secondary} onclick={() => onNavigate(act.view, act.focus)}>{act.label}</button>
      <button class={primary} disabled={busy} onclick={retry}>{busy ? 'Trying…' : 'Try again'}</button>
    {:else if !canAnswer}
      <button class={act.primary ? primary : secondary} onclick={() => onNavigate(act.view, act.focus)}>{act.label}</button>
    {/if}
  </div>

  {#if canAnswer}
    <div class="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <label class="sr-only" for={`answer-${notice.key}`}>Your answer</label>
      <textarea
        id={`answer-${notice.key}`}
        rows="2"
        placeholder="Your answer"
        class="w-full rounded-md border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950"
        bind:value={answer}
      ></textarea>
      <button class={primary} disabled={busy || !answer.trim()} onclick={send}>{busy ? 'Sending…' : 'Answer'}</button>
    </div>
  {/if}
  {#if error}<p role="alert" class="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>{/if}
</article>
