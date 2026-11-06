import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Page-side UI Kit bundle: one IIFE file exposing `window.GoNaviUI` with React and
// the shared components. Served to sandboxed pages from the host origin.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist/plugin-page/ui',
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL('./src/ui-kit/pageUiEntry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'GoNaviUI',
      fileName: () => 'page-ui.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => (asset.names?.some((name) => name.endsWith('.css')) ? 'style.css' : 'assets/[name][extname]'),
      },
    },
  },
});
