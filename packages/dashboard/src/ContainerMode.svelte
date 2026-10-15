<script lang="ts">
  // Container mode (experimental): agents run inside containers. This is only a status card: the settings are
  // edited by hand in .agentmesh/config.json because they decide what gets executed on this computer.
  import type { SandboxState } from './types';

  let { sandbox }: { sandbox: SandboxState } = $props();
</script>

<section aria-label="Container mode" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-base font-semibold">Container mode</h2>
    <span class="rounded-full border border-amber-500 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Experimental</span>
  </div>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">
    {sandbox.agents ? `${sandbox.agents.join(', ')} run` : 'Every agent runs'} inside a container made from <code class="font-mono">{sandbox.image}</code>, so it can only touch its own task workspace. It does not limit the container's network.
  </p>
  {#if sandbox.blockedReason}
    <p role="alert" class="mt-2 rounded-lg border border-red-500 bg-red-50 p-2 text-sm dark:bg-red-950"><strong>Agents are waiting.</strong> {sandbox.blockedReason}</p>
  {:else}
    <p class="mt-2 text-sm text-green-700 dark:text-green-400">The container engine answers. {sandbox.listener ? `Containers reach AgentMesh through its own listener on port ${sandbox.listener.port}.` : ''}</p>
  {/if}
  {#if sandbox.checks === 'container'}
    <p class="mt-1 text-sm">Your project's check runs in the container too, so code an agent writes cannot run on this computer. The image needs your project's tools (node, python, ...).</p>
  {:else}
    <p role="alert" class="mt-2 rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm dark:bg-amber-950"><strong>Your project's check runs on this computer.</strong> Code an agent writes into its workspace (a test, a package.json script) runs here, with your permissions, when the check runs. That undoes the container. Set <code class="font-mono">"checks": "container"</code> to run it in the container.</p>
  {/if}
  {#each sandbox.warnings.filter((x) => !x.startsWith('The project check runs')) as w (w)}<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">Warning: {w}</p>{/each}
  <p class="mt-2 text-xs text-stone-500">Change it in the <code class="font-mono">sandbox</code> section of <code class="font-mono">.agentmesh/config.json</code>, then restart. Run <code class="font-mono">agentmesh doctor</code> to test the connection from inside a container. See the README for the example wrapper and what is not covered.</p>
</section>
