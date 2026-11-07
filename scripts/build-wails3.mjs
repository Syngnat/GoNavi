// Builds the Wails v3 desktop entry point.
//
// The default v2 build stays the shipping path until the migration completes;
// this script produces the parallel v3 binary from the same module.
//
// Usage: node scripts/build-wails3.mjs [--skip-frontend]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');
const skipFrontend = process.argv.includes('--skip-frontend');

const run = (command, args, cwd) => {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
};

if (!skipFrontend) {
  if (!existsSync(join(frontend, 'node_modules'))) {
    run('npm', ['ci'], frontend);
  }
  run('npm', ['run', 'build'], frontend);
}

const binDir = join(root, 'bin');
mkdirSync(binDir, { recursive: true });
const output = join(binDir, process.platform === 'win32' ? 'GoNavi-wails3.exe' : 'GoNavi-wails3');
const ldflags = process.platform === 'win32' ? '-w -s -H windowsgui' : '-w -s';
run('go', [
  'build',
  '-tags',
  'wails3',
  '-trimpath',
  '-buildvcs=false',
  '-ldflags',
  ldflags,
  '-o',
  output,
  './cmd/wails3app',
], root);
console.log(`built ${output}`);
