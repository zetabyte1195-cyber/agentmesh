<script lang="ts">
  // Renders agent-written Markdown as text nodes only (see markdown.ts): no HTML from an agent reaches the page.
  import { type Inline, parseMarkdown } from './markdown';

  let { source }: { source: string } = $props();
  const blocks = $derived(parseMarkdown(source));
  const headingClass = (level: number) => (level <= 1 ? 'mt-3 text-base font-semibold' : level === 2 ? 'mt-3 text-sm font-semibold' : 'mt-2 text-sm font-semibold text-stone-700 dark:text-stone-300');
</script>

{#snippet line(parts: Inline[])}
  {#each parts as p, i (i)}
    {#if p.kind === 'bold'}<strong>{p.text}</strong>{:else if p.kind === 'italic'}<em>{p.text}</em>{:else if p.kind === 'code'}<code class="rounded bg-stone-200 px-1 font-mono text-xs dark:bg-stone-800">{p.text}</code>{:else}{p.text}{/if}
  {/each}
{/snippet}

<div class="text-sm leading-relaxed">
  {#each blocks as b, i (i)}
    {#if b.kind === 'heading'}
      <p class={headingClass(b.level)} role="heading" aria-level={Math.min(b.level + 2, 6)}>{@render line(b.content)}</p>
    {:else if b.kind === 'paragraph'}
      <p class="mt-2">{@render line(b.content)}</p>
    {:else if b.kind === 'list'}
      {#if b.ordered}
        <ol class="mt-2 list-decimal space-y-1 pl-5">{#each b.items as item, j (j)}<li>{@render line(item)}</li>{/each}</ol>
      {:else}
        <ul class="mt-2 list-disc space-y-1 pl-5">{#each b.items as item, j (j)}<li>{@render line(item)}</li>{/each}</ul>
      {/if}
    {:else if b.kind === 'code'}
      <pre class="mt-2 overflow-auto rounded-lg bg-stone-200 p-2 font-mono text-xs dark:bg-stone-800">{b.text}</pre>
    {:else if b.kind === 'quote'}
      <blockquote class="mt-2 border-l-4 border-stone-300 pl-3 text-stone-600 dark:border-stone-700 dark:text-stone-300">{@render line(b.content)}</blockquote>
    {:else}
      <hr class="my-3 border-stone-300 dark:border-stone-700" />
    {/if}
  {/each}
</div>
