import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const aiCodeHighlightDeps = [
  'react-syntax-highlighter/dist/esm/prism-light',
  'react-syntax-highlighter/dist/esm/languages/prism/bash',
  'react-syntax-highlighter/dist/esm/languages/prism/css',
  'react-syntax-highlighter/dist/esm/languages/prism/diff',
  'react-syntax-highlighter/dist/esm/languages/prism/go',
  'react-syntax-highlighter/dist/esm/languages/prism/ini',
  'react-syntax-highlighter/dist/esm/languages/prism/java',
  'react-syntax-highlighter/dist/esm/languages/prism/javascript',
  'react-syntax-highlighter/dist/esm/languages/prism/json',
  'react-syntax-highlighter/dist/esm/languages/prism/jsx',
  'react-syntax-highlighter/dist/esm/languages/prism/markdown',
  'react-syntax-highlighter/dist/esm/languages/prism/markup',
  'react-syntax-highlighter/dist/esm/languages/prism/php',
  'react-syntax-highlighter/dist/esm/languages/prism/python',
  'react-syntax-highlighter/dist/esm/languages/prism/ruby',
  'react-syntax-highlighter/dist/esm/languages/prism/rust',
  'react-syntax-highlighter/dist/esm/languages/prism/sql',
  'react-syntax-highlighter/dist/esm/languages/prism/toml',
  'react-syntax-highlighter/dist/esm/languages/prism/tsx',
  'react-syntax-highlighter/dist/esm/languages/prism/typescript',
  'react-syntax-highlighter/dist/esm/languages/prism/yaml',
  'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus',
  'react-syntax-highlighter/dist/esm/styles/prism/vs',
]

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./src/test/setupI18nCatalogs.ts'],
  },
  optimizeDeps: {
    // Pre-bundle startup locale modules before Wails starts proxying the WebView.
    include: [
      'antd/locale/de_DE',
      'antd/locale/en_US',
      'antd/locale/ja_JP',
      'antd/locale/ru_RU',
      'antd/locale/zh_CN',
      'antd/locale/zh_TW',
      'dayjs/locale/de',
      'dayjs/locale/ja',
      'dayjs/locale/ru',
      'dayjs/locale/zh-cn',
      'dayjs/locale/zh-tw',
      // Keep lazy AI panel imports out of Vite's mid-session dependency discovery.
      // A discovery reload invalidates React.lazy inside Wails and used to leave the panel blank.
      ...aiCodeHighlightDeps,
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist', // Standard Wails output directory
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 拆分大体积三方依赖到独立 chunk，避免主 bundle 过大
        // reactflow + dagre 约 130KB gzipped，单独成 chunk 可按需加载
        // recharts 用于诊断面板统计条，与执行计划图无强依赖，单独 chunk
        manualChunks: {
          reactflow: ['reactflow'],
          dagre: ['dagre'],
          charts: ['recharts'],
        },
      },
    },
  }
})
