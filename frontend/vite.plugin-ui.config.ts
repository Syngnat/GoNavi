import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The plugin UI SDK is loaded by plugin windows (and, in a later slice, plugin
// pages) from the host origin. It deliberately has no import of the main App,
// the Zustand store or the generated Wails bindings: plugins receive data only
// through host capabilities.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/plugin-window/ui',
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      // Monaco is a separate entry: windows that do not need it never download it.
      entry: {
        index: fileURLToPath(new URL('./src/ui-kit/index.ts', import.meta.url)),
        monaco: fileURLToPath(new URL('./src/ui-kit/monacoEntry.ts', import.meta.url)),
        chart: fileURLToPath(new URL('./src/ui-kit/chartEntry.ts', import.meta.url)),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => (asset.names?.some((name) => name.endsWith('.css')) ? 'style.css' : 'assets/[name][extname]'),
      },
    },
  },
});
