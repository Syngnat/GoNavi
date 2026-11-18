// Builds the macOS development app as bin/GoNavi.app instead of a naked
// executable. A bare Go binary has no CFBundleIdentifier, so WebKit puts its
// localStorage in ~/Library/WebKit/GoNavi, while the packaged app uses
// ~/Library/WebKit/com.wails.GoNavi. Keeping the development build inside an
// app bundle with the production identifier makes both channels read and write
// the same UI settings.
//
// The page origin is handled separately by resolveV3StartURL in
// cmd/wails3app/window.go: the dev window loads the v2 origin rather than the
// Vite port, so the origin half of the localStorage key also matches v2.
//
// Usage: node scripts/build-wails3-dev-app.mjs [bin-dir] [app-name]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('build-wails3-dev-app.mjs only runs on macOS');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = process.argv[2] || 'bin';
const appName = process.argv[3] || 'GoNavi';
const appDir = join(root, binDir, `${appName}.app`);
const contentsDir = join(appDir, 'Contents');
const macOSDir = join(contentsDir, 'MacOS');
const resourcesDir = join(contentsDir, 'Resources');
const executable = join(macOSDir, appName);

rmSync(appDir, { recursive: true, force: true });
mkdirSync(macOSDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

execFileSync(
  'go',
  [
    'build',
    '-tags',
    'wails3',
    '-trimpath',
    '-buildvcs=false',
    '-ldflags',
    '-X GoNavi-Wails/internal/app.AppVersion=dev-local -X main.devBuild=1',
    '-o',
    executable,
    './cmd/wails3app',
  ],
  { cwd: root, stdio: 'inherit' },
);

copyFileSync(join(root, 'build/darwin/icon.icns'), join(resourcesDir, 'iconfile.icns'));

// Strip the Wails template conditionals/loops, then fill the same fields the
// release script fills. The identifier comes from Info.plist and must stay
// com.wails.GoNavi; the development build deliberately keeps the production id.
const template = readFileSync(join(root, 'build/darwin/Info.plist'), 'utf8');
let plist = '';
let depth = 0;
for (const token of template.split(/({{.*?}})/s)) {
  if (token.startsWith('{{if ') || token.startsWith('{{range ')) {
    depth += 1;
    continue;
  }
  if (token === '{{end}}') {
    depth = Math.max(0, depth - 1);
    continue;
  }
  if (depth === 0) {
    plist += token;
  }
}

const version = readFileSync(join(root, 'version/dev-version.txt'), 'utf8').trim() || '0.0.0';
const replacements = {
  '{{.Info.ProductName}}': appName,
  '{{.OutputFilename}}': appName,
  '{{.Name}}': appName,
  '{{.Info.ProductVersion}}': version,
  '{{.Info.Comments}}': 'GoNavi is licensed under the Apache License, Version 2.0.',
  '{{.Info.Copyright}}': 'Copyright 2026 Syngnat',
};
for (const [token, value] of Object.entries(replacements)) {
  plist = plist.split(token).join(value);
}
if (!plist.includes('<string>com.wails.GoNavi</string>')) {
  throw new Error('development Info.plist must use the production bundle identifier com.wails.GoNavi');
}

writeFileSync(join(contentsDir, 'Info.plist'), plist);
console.log(`built ${join(binDir, `${appName}.app`)}`);
