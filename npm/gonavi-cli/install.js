#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

const packageRoot = __dirname;
const packageJSON = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const version = String(process.env.GONAVI_CLI_VERSION || process.env.npm_package_version || packageJSON.version).trim();
const releaseBase = String(
  process.env.GONAVI_CLI_RELEASE_BASE_URL || `https://github.com/Syngnat/GoNavi/releases/download/v${version}`,
).replace(/\/+$/, '');

function fail(message) {
  console.error(`[gonavi-cli] ${message}`);
  process.exitCode = 1;
}

function platformTarget() {
  const platform = process.platform;
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!architecture || !['darwin', 'linux', 'win32'].includes(platform)) {
    throw new Error(`unsupported platform or architecture: ${platform}/${process.arch}`);
  }
  const goos = platform === 'win32' ? 'windows' : platform;
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const binary = platform === 'win32' ? 'gonavi.exe' : 'gonavi';
  return {
    asset: `gonavi-cli_${version}_${goos}_${architecture}.${extension}`,
    binary,
    extension,
  };
}

function requestBuffer(url, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error('too many redirects while downloading a release asset'));
  }
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { headers: { 'User-Agent': '@syngnat/gonavi-cli' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        requestBuffer(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`release asset request returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

function expectedArchiveEntries(binary) {
  return [binary, 'LICENSE', 'NOTICE'].sort();
}

function parseChecksums(text, asset) {
  const matches = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/))
    .filter((match) => match && path.basename(match[2].trim()) === asset);
  if (matches.length !== 1) {
    throw new Error(`checksum file must contain exactly one entry for ${asset}`);
  }
  return matches[0][1].toLowerCase();
}

function assertSha256(data, expected, asset) {
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function archiveEntries(archive, extension, binary) {
  let output;
  if (extension === 'tar.gz') {
    output = run('tar', ['-tzf', archive]);
  } else {
    try {
      output = run('tar', ['-tf', archive]);
    } catch (tarError) {
      if (process.platform !== 'win32') {
        throw tarError;
      }
      const escapePowerShell = (value) => value.replace(/'/g, "''");
      const command = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escapePowerShell(archive)}')`,
        "$zip.Entries | ForEach-Object { $_.FullName }",
        "$zip.Dispose()",
      ].join('; ');
      output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    }
  }
  const entries = output
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, '').trim())
    .filter(Boolean)
    .sort();
  const expected = expectedArchiveEntries(binary);
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error(`archive contents are invalid for ${path.basename(archive)}`);
  }
}

function validateExtractedArchive(destination, binary) {
  const expected = expectedArchiveEntries(binary);
  const entries = fs.readdirSync(destination).sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error(`extracted archive contents are invalid for ${binary}`);
  }
  for (const entry of entries) {
    const stat = fs.lstatSync(path.join(destination, entry));
    // The release contract contains regular top-level files only. lstat is
    // deliberate: stat would follow a malicious symlink before installation.
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`archive entry ${entry} must be a single regular file`);
    }
  }
}

function extractArchive(archive, destination, extension) {
  if (extension === 'tar.gz') {
    run('tar', ['-xzf', archive, '-C', destination]);
    return;
  }
  try {
    run('tar', ['-xf', archive, '-C', destination]);
  } catch (tarError) {
    if (process.platform !== 'win32') {
      throw tarError;
    }
    const escapePowerShell = (value) => value.replace(/'/g, "''");
    const command = `Expand-Archive -LiteralPath '${escapePowerShell(archive)}' -DestinationPath '${escapePowerShell(destination)}' -Force`;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  }
}

function installBinary(extracted, binary) {
  const installDirectory = path.join(packageRoot, 'bin', '.gonavi');
  fs.mkdirSync(installDirectory, { recursive: true });
  const source = path.join(extracted, binary);
  if (!fs.lstatSync(source).isFile()) {
    throw new Error(`archive did not contain ${binary}`);
  }
  const temporary = path.join(installDirectory, `.${binary}.${process.pid}.tmp`);
  fs.rmSync(temporary, { force: true });
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') {
    fs.chmodSync(temporary, 0o755);
  }
  const target = path.join(installDirectory, binary);
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
  fs.writeFileSync(path.join(installDirectory, '.version'), `${version}\n`, { mode: 0o600 });
}

async function main() {
  const target = platformTarget();
  const checksumName = `gonavi-cli_${version}_checksums.txt`;
  const checksumText = await requestBuffer(`${releaseBase}/${checksumName}`);
  const expected = parseChecksums(checksumText.toString('utf8'), target.asset);
  const archive = await requestBuffer(`${releaseBase}/${target.asset}`);
  assertSha256(archive, expected, target.asset);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gonavi-cli-install-'));
  const archivePath = path.join(temporaryRoot, target.asset);
  const extracted = path.join(temporaryRoot, 'extracted');
  try {
    fs.mkdirSync(extracted);
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    archiveEntries(archivePath, target.extension, target.binary);
    extractArchive(archivePath, extracted, target.extension);
    validateExtractedArchive(extracted, target.binary);
    installBinary(extracted, target.binary);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log(`[gonavi-cli] installed ${target.asset} (SHA256 verified)`);
}

if (require.main === module) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}

module.exports = {
  assertSha256,
  validateExtractedArchive,
  parseChecksums,
  platformTarget,
};
