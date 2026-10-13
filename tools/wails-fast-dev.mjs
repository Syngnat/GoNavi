#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const frontendDir = path.join(projectRoot, 'frontend');
const wailsConfigPath = path.join(projectRoot, 'wails.json');
const nodeCommand = process.execPath;
const wailsCommand = process.platform === 'win32' ? 'wails.exe' : 'wails';

const usage = `Usage:
  node tools/wails-fast-dev.mjs [--refresh-bindings] [--no-install] [--dry-run] [wails dev flags...]

Fast path:
  - skips npm install when frontend dependencies are unchanged
  - runs wails dev with -m -s -nosyncgomod -skipembedcreate
  - skips Wails binding generation unless --refresh-bindings is passed

Use --refresh-bindings after changing exported Go method signatures.`;

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

const readWailsConfig = () => {
  try {
    return JSON.parse(readFileSync(wailsConfigPath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read wails.json: ${error.message}`);
    process.exit(1);
  }
};

const runFrontendInstall = () => {
  const result = spawnSync(nodeCommand, ['scripts/wails-frontend-install.mjs'], {
    cwd: frontendDir,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const hasFlag = (args, names) =>
  args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));

const wailsConfig = readWailsConfig();
const dryRun = rawArgs.includes('--dry-run');
const refreshBindings = rawArgs.includes('--refresh-bindings') || process.env.GONAVI_REFRESH_WAILS_BINDINGS === '1';
const skipInstall = rawArgs.includes('--no-install') || process.env.GONAVI_FAST_DEV_SKIP_INSTALL === '1';
const passThroughArgs = rawArgs.filter((arg) => arg !== '--refresh-bindings' && arg !== '--no-install' && arg !== '--dry-run');
const devServerUrl = process.env.GONAVI_FRONTEND_DEV_SERVER_URL || wailsConfig['frontend:dev:serverUrl'] || 'http://localhost:5173';
const wailsjsRoot = path.resolve(projectRoot, wailsConfig.wailsjsdir || './frontend', 'wailsjs');
const skipBindings = !refreshBindings && existsSync(wailsjsRoot);
const fastArgs = ['dev'];

if (!skipInstall && !dryRun) {
  runFrontendInstall();
}

if (!hasFlag(passThroughArgs, ['-m'])) {
  fastArgs.push('-m');
}
if (!hasFlag(passThroughArgs, ['-s'])) {
  fastArgs.push('-s');
}
if (!hasFlag(passThroughArgs, ['-nosyncgomod'])) {
  fastArgs.push('-nosyncgomod');
}
if (!hasFlag(passThroughArgs, ['-skipembedcreate'])) {
  fastArgs.push('-skipembedcreate');
}
if (skipBindings && !hasFlag(passThroughArgs, ['-skipbindings'])) {
  fastArgs.push('-skipbindings');
}
if (!hasFlag(passThroughArgs, ['-frontenddevserverurl'])) {
  fastArgs.push('-frontenddevserverurl', devServerUrl);
}

if (!skipBindings && !refreshBindings) {
  console.warn('frontend/wailsjs not found; generating Wails bindings this run.');
}

if (dryRun) {
  const quoteArg = (arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg);
  console.log(`Would run: ${[wailsCommand, ...fastArgs, ...passThroughArgs].map(quoteArg).join(' ')}`);
  process.exit(0);
}

const child = spawn(wailsCommand, [...fastArgs, ...passThroughArgs], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
});

// 后台预热 dev server 的模块图：避免 WKWebView 首载并发拉模块时撞上
// vite 冷转换期的瞬时 502（「Importing a module script failed」）。
if (!dryRun && !process.env.GONAVI_FAST_DEV_SKIP_WARMUP) {
  const { warmupWailsDevServer } = await import('./wailsDevWarmup.mjs');
  void warmupWailsDevServer(devServerUrl.startsWith('http') ? devServerUrl : 'http://localhost:34115');
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`Failed to start Wails CLI: ${error.message}`);
  process.exit(1);
});
