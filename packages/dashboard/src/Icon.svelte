<script lang="ts" module>
export type IconName = 'home' | 'missions' | 'board' | 'runs' | 'schedules' | 'setup' | 'plus' | 'sun' | 'moon' | 'auto' | 'pause' | 'play' | 'alert' | 'check' | 'question' | 'stop' | 'plan' | 'clock';
</script>

<script lang="ts">
  // A small set of line icons, drawn here so nothing is downloaded. Decorative: the text next to each one says what it is.

  const PATHS: Record<IconName, string> = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    missions: 'M5 21V4m0 0h11l-2.5 4L16 12H5',
    board: 'M4 4h6v16H4zM14 4h6v10h-6z',
    runs: 'M3 12h4l3-8 4 16 3-8h4',
    schedules: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    setup: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M7 14v6',
    plus: 'M12 5v14M5 12h14',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    auto: 'M12 3a9 9 0 1 0 0 18V3z',
    pause: 'M8 5v14M16 5v14',
    play: 'M7 4l13 8-13 8z',
    alert: 'M12 3l10 18H2zM12 10v5M12 18v.01',
    check: 'M5 12.5l4.5 4.5L19 7',
    question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.8 2.1c-.9.5-1.3 1-1.3 2M12 17v.01',
    stop: 'M6 6h12v12H6z',
    plan: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  };

  let { name, size = 18, class: className = '' }: { name: IconName; size?: number; class?: string } = $props();
</script>

<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class={['shrink-0', className]}>
  <path d={PATHS[name]} />
</svg>
