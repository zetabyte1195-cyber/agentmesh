import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Built into dist/ and served by the daemon (P2.6 staticDir) under a strict CSP:
// no inline scripts, no inline styles, same-origin API and WebSocket only.
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
