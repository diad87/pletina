import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('web-port'),
  base: './',
  plugins: [svelte()],
  resolve: {
    alias: [
      { find: /^(?:\.\.\/lib\/extractor\/engine\.svelte|\.\/lib\/extractor\/engine\.svelte)$/, replacement: resolve('web-port/engine.svelte.ts') },
      { find: './extractor/capture', replacement: resolve('web-port/capture.ts') },
      { find: /^(?:\.\/|\.\.\/lib\/)player-android\.svelte$/, replacement: resolve('web-port/android.ts') },
    ],
  },
  build: {
    rolldownOptions: { input: { index: resolve('web-port/index.html'), p1check: resolve('web-port/p1-check.html') } },
    target: 'es2022',
    outDir: resolve('dist-web-port'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
})
