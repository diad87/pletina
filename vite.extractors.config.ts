import { defineConfig } from 'vite'

// El extractor youtubei.js como módulo aparte, para publicarlo y que la app lo cambie sin sacar
// otra versión (ver scripts/extractors.mjs y src-tauri/src/extractors.rs). Un solo archivo, sin
// nada de la app dentro.
export default defineConfig({
  build: {
    target: 'es2022',
    minify: true,
    outDir: 'dist-extractors/build',
    emptyOutDir: true,
    lib: {
      entry: 'src/lib/extractor/youtubei.ts',
      formats: ['es'],
      fileName: () => 'youtubei.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true, minify: true } },
  },
})
