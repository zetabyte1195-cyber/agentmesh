// Desktop notifications from the cockpit page (task 1). They work while the page is open somewhere
// (another tab, another window). For notifications with the page closed, the daemon's webhook is used.
export type Notice = { key: string; kind: string; urgent: boolean; title: string; text: string; missionId?: string; taskId?: string };

const STORE = 'agentmesh.desktopNotifications';

export const supported = (): boolean => typeof Notification !== 'undefined';

/** On only when the browser allowed it AND the person switched it on here. */
export function enabled(): boolean {
  try {
    return supported() && Notification.permission === 'granted' && localStorage.getItem(STORE) === '1';
  } catch {
    return false;
  }
}

export async function enable(): Promise<'enabled' | 'denied' | 'unsupported'> {
  if (!supported()) return 'unsupported';
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  try {
    localStorage.setItem(STORE, '1');
  } catch {
    // private window: it works until the page is closed
  }
  return 'enabled';
}

export function disable(): void {
  try {
    localStorage.removeItem(STORE);
  } catch {
    // nothing stored
  }
}

/**
 * Which notices are new since last time. The first call only learns what is already there, so opening the
 * cockpit does not announce things you can see on the screen.
 */
export function freshNotices(seen: Set<string> | null, notices: readonly Notice[]): { seen: Set<string>; fresh: Notice[] } {
  const now = new Set(notices.map((n) => n.key));
  if (!seen) return { seen: now, fresh: [] };
  return { seen: now, fresh: notices.filter((n) => !seen.has(n.key)) };
}

/** "(2) AgentMesh Cockpit": how many things need you, visible in the tab title. */
export function titleFor(notices: readonly Notice[]): string {
  const n = notices.filter((x) => x.urgent).length;
  return n ? `(${n}) AgentMesh Cockpit` : 'AgentMesh Cockpit';
}

/** Shows a notification when the page is in the background (a visible page already shows the change). */
export function announce(notice: Notice): void {
  if (!enabled() || (typeof document !== 'undefined' && document.visibilityState === 'visible')) return;
  try {
    new Notification(notice.title, { body: notice.text, tag: notice.key });
  } catch {
    // some browsers refuse outside a user gesture; the badge in the tab title still shows it
  }
}
