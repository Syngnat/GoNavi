#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const binaryName = process.platform === 'win32' ? 'gonavi.exe' : 'gonavi';
const binaryPath = path.join(__dirname, '.gonavi', binaryName);

if (!fs.existsSync(binaryPath)) {
  console.error('GoNavi CLI is not installed. Re-run npm install so its verified release asset can be downloaded.');
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error(`failed to start GoNavi CLI: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
