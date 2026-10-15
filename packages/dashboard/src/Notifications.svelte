<script lang="ts">
  // Notifications: a desktop notification while this page is open somewhere, and an optional webhook
  // (works with the page closed) for a phone, Slack-style chat, or anything that accepts a JSON POST.
  import { post } from './api';
  import { disable, enable, enabled as desktopOn, supported } from './notify';
  import type { NotificationsState as State } from './types';

  let { notifications, onChanged }: { notifications: State; onChanged: () => void } = $props();

  let desktop = $state(desktopOn());
  let desktopMessage = $state('');
  let url = $state<string | null>(null);
  let secret = $state('');
  let busy = $state<Record<string, boolean>>({});
  let error = $state('');
  let testResult = $state<{ ok: boolean; text: string } | null>(null);
  const shownUrl = $derived(url ?? notifications.webhookUrl ?? '');

  async function toggleDesktop(on: boolean): Promise<void> {
    desktopMessage = '';
    if (!on) {
      disable();
      desktop = false;
      return;
    }
    const r = await enable();
    desktop = r === 'enabled';
    desktopMessage = r === 'denied' ? 'The browser did not allow it. Allow notifications for this page in the browser\'s site settings, then try again.' : r === 'unsupported' ? 'This browser does not support desktop notifications.' : '';
  }

  async function run(key: string, fn: () => Promise<void>): Promise<void> {
    busy[key] = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy[key] = false;
    }
  }

  const save = () =>
    run('save', async () => {
      await post('/api/notifications', { webhookUrl: shownUrl.trim() || null, ...(secret.trim() ? { webhookSecret: secret.trim() } : {}) });
      url = null;
      secret = '';
      testResult = null;
      onChanged();
    });
  const remove = () =>
    run('remove', async () => {
      await post('/api/notifications', { webhookUrl: null });
      url = null;
      secret = '';
      testResult = null;
      onChanged();
    });
  const test = () =>
    run('test', async () => {
      const r = await post<{ ok: boolean; status?: number; error?: string }>('/api/notifications/test');
      testResult = { ok: r.ok, text: r.ok ? 'Sent. Check that it arrived.' : (r.error ?? 'It did not work.') };
      onChanged();
    });

  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const field = 'mt-1 w-full rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm dark:border-stone-700 dark:bg-stone-950';
  const button = 'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
  const primary = 'rounded-lg bg-marigold-400 px-3 py-1.5 text-sm font-semibold text-stone-950 hover:bg-marigold-300 disabled:opacity-50';
</script>

<section aria-label="Notifications" class="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
  <h2 class="text-base font-semibold">Tell me when something needs me</h2>
  <p class="mt-1 text-sm text-stone-600 dark:text-stone-300">A plan to approve, a question for you, an agent that gave up, a mission that finished.</p>

  <label class="mt-3 flex items-start gap-2 text-sm">
    <input type="checkbox" checked={desktop} disabled={!supported()} onchange={(e) => toggleDesktop(e.currentTarget.checked)} />
    <span>Desktop notifications from this page. <span class="text-stone-500">They appear while the cockpit is open in a tab or window you are not looking at.</span></span>
  </label>
  {#if desktopMessage}<p role="alert" class="mt-1 text-sm text-red-600">{desktopMessage}</p>{/if}

  <h3 class="mt-4 text-sm font-semibold">Webhook (works with the page closed)</h3>
  <p class="text-xs text-stone-500">AgentMesh sends a small JSON message to this address. Use it with a phone-notification service, a chat tool's incoming webhook, or your own script. It has not been tested against any particular service: use <strong>Send a test</strong>.</p>
  <form onsubmit={(e) => { e.preventDefault(); void save(); }}>
  <label class="mt-2 block text-xs font-medium" for="hook-url">Address</label>
  <input id="hook-url" class={field} placeholder="https://example.com/my-hook" autocomplete="off" bind:value={() => shownUrl, (v) => (url = v)} />
  <label class="mt-2 block text-xs font-medium" for="hook-secret">Secret (optional, signs every message so the receiver can check it)</label>
  <input id="hook-secret" type="password" class={field} placeholder={notifications.hasSecret ? 'A secret is saved. Type to replace it.' : 'e.g. a long random phrase'} autocomplete="off" bind:value={secret} />
  <div class="mt-3 flex flex-wrap items-center gap-2">
    <button type="submit" class={primary} disabled={busy.save || (url === null && !secret.trim())}>Save</button>
    <button type="button" class={button} disabled={busy.test || !notifications.webhookUrl} onclick={test}>{busy.test ? 'Sending…' : 'Send a test'}</button>
    {#if notifications.webhookUrl}<button type="button" class="text-sm text-red-700 underline dark:text-red-400" disabled={busy.remove} onclick={remove}>Remove</button>{/if}
  </div>
  </form>
  {#if testResult}<p class={['mt-2 text-sm', testResult.ok ? 'text-green-700' : 'text-red-700 dark:text-red-400']} aria-live="polite">{testResult.text}</p>{/if}
  {#if notifications.last}
    <p class="mt-2 text-xs text-stone-500">Last message: {notifications.last.event.replaceAll('_', ' ')}, {when(notifications.last.at)}, {notifications.last.ok ? 'delivered' : `failed (${notifications.last.error ?? 'unknown'})`}.</p>
  {/if}
  {#if error}<p role="alert" class="mt-2 text-sm text-red-600">{error}</p>{/if}
  <p class="mt-3 text-xs text-stone-500">Turning this on does not announce what is already waiting, only what comes after. The secret is stored in this project's <code class="font-mono">.agentmesh/config.json</code> (local, ignored by git) and is never shown again.</p>
</section>
