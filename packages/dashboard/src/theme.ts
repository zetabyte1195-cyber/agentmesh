// Light, dark, or follow the system. The choice is kept in this browser only.
export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'agentmesh.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** The theme actually shown for a choice. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  return choice === 'auto' ? (systemDark ? 'dark' : 'light') : choice;
}

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice, systemDark());
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // private window: it still applies until the page is closed
  }
  applyTheme(choice);
}

/** Call once at start: applies the stored choice and keeps Auto in step with the system. */
export function initTheme(): void {
  applyTheme(storedTheme());
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (storedTheme() === 'auto') applyTheme('auto');
    });
  }
}
