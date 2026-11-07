// Builds the Wails v3 desktop artifact through the same platform helper the
// release workflow uses, so a local build matches the shipped layout:
//   Windows -> build/bin/GoNavi.exe
//   macOS   -> build/bin/GoNavi.app
//   Linux   -> build/bin/GoNavi
//
// Usage: node scripts/build-wails3.mjs [--skip-frontend] [--dev]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');
const skipFrontend = process.argv.includes('--skip-frontend');
const devBuild = process.argv.includes('--dev');

const run = (command, args, cwd = root) => {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
};

if (!skipFrontend) {
  if (!existsSync(join(frontend, 'node_modules'))) {
    run('npm', ['ci'], frontend);
  }
  run('npm', ['run', 'build'], frontend);
}

const goos = ({ win32: 'windows', darwin: 'darwin', linux: 'linux' })[process.platform] || process.platform;
const goarch = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' })[process.arch] || process.arch;
const platform = `${goos}/${goarch}`;
const version = devBuild
  ? 'dev-local'
  : readFileSync(join(root, 'version', 'dev-version.txt'), 'utf8').trim();
run('bash', ['scripts/ci-build-wails3-release.sh', platform, 'GoNavi', version]);

const output = process.platform === 'win32'
  ? 'build/bin/GoNavi.exe'
  : process.platform === 'darwin'
    ? 'build/bin/GoNavi.app'
    : 'build/bin/GoNavi';
console.log(`built ${output}`);
