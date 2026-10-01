#!/usr/bin/env node
// Entry point of `npm run build`: tsc type check -> vite build -> dist.zip.
// tsc and vite run with an explicit V8 heap limit; see frontend-build-heap.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOW_MEMORY_WARNING_MB,
  currentHeapLimitMB,
  detectMemoryMB,
  isOutOfMemoryExit,
  resolveBuildHeapLimitMB,
} from './frontend-build-heap.mjs';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releasesUrl = 'https://github.com/Syngnat/GoNavi/releases';

const memoryMB = detectMemoryMB();
const defaultHeapMB = currentHeapLimitMB();
const heapLimitMB = resolveBuildHeapLimitMB({ memoryMB, currentLimitMB: defaultHeapMB });
const heapArgs = heapLimitMB === null ? [] : [`--max-old-space-size=${heapLimitMB}`];
const formatGB = (mb) => `${(mb / 1024).toFixed(1)} GB`;

const fail = (message) => {
  console.error(`\n[GoNavi] ${message}\n`);
  process.exit(1);
};

const resolvePackageBin = (packageName, binName) => {
  const manifestPath = path.join(frontendDir, 'node_modules', packageName, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binName];
  return path.join(path.dirname(manifestPath), bin);
};

const outOfMemoryMessage = (label) => [
  `前端编译（${label}）因内存不足中止。`,
  `本机可用内存约 ${formatGB(memoryMB)}，Node.js 堆上限 ${heapLimitMB === null ? defaultHeapMB : heapLimitMB} MB；前端编译峰值约需 3 GB 内存。`,
  '可以：',
  '  1. 关闭占用内存较多的程序后重新构建；',
  '  2. 为系统增加 swap 后重试；',
  `  3. 直接下载发布版安装包：${releasesUrl}`,
].join('\n');

const run = (label, args) => {
  const result = spawnSync(process.execPath, args, { cwd: frontendDir, stdio: 'inherit' });
  if (result.error) {
    fail(`${label} 无法启动：${result.error.message}`);
  }
  if (result.status === 0) {
    return;
  }
  if (isOutOfMemoryExit(result)) {
    fail(outOfMemoryMessage(label));
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
};

if (memoryMB < LOW_MEMORY_WARNING_MB) {
  console.warn(`[GoNavi] 本机可用内存约 ${formatGB(memoryMB)}，低于前端编译建议的 4 GB，可能因内存不足失败。`);
}

run('tsc', [...heapArgs, resolvePackageBin('typescript', 'tsc')]);
run('vite build', [...heapArgs, resolvePackageBin('vite', 'vite'), 'build']);
run('zip-dist', [path.join(frontendDir, 'scripts', 'zip-dist.mjs')]);
