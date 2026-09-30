<script lang="ts">
  // A unified diff with added lines green and removed lines red (G10).
  import { diffLineKind } from './markdown';

  let { diff }: { diff: string } = $props();
  const lines = $derived(diff.replace(/\r\n?/g, '\n').split('\n'));
  const TONE = {
    add: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
    del: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
    hunk: 'text-sky-700 dark:text-sky-400',
    file: 'font-semibold text-stone-600 dark:text-stone-300',
    plain: '',
  } as const;
</script>

<pre class="mt-1 max-h-96 overflow-auto rounded-lg bg-stone-100 py-2 font-mono text-xs dark:bg-stone-950"><code>{#each lines as l, i (i)}<span class={['block px-2', TONE[diffLineKind(l)]]}>{l || ' '}</span>{/each}</code></pre>
