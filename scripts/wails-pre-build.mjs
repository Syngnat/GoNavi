#!/usr/bin/env node
// wails preBuildHook：构建前检查工具链与 Linux 桌面构建依赖，并刷新派生资源。
//
// cwd 由 wails 固定为 build/bin（见 wails v2 pkg/commands/build/build.go 中的
// shell.RunCommand(options.BinDirectory, ...)），因此这里按脚本自身位置反推仓库
// 根目录，不依赖 cwd，也不依赖调用方传入路径。
//
// 只用 Node 12 能解析的语法：发行版软件源里的旧 Node 也要能走到版本提示，
// 而不是报一句看不懂的 SyntaxError。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinuxBuildPrereqs, commandExists } from './linux-build-prereqs.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// wails 会把 ${platform} 替换成 "GOOS/GOARCH"（build.go：options.Platform + "/" + options.Arch）。
const targetPlatform = process.argv[2] || '';

// Vite 5 要求 Node.js 18+，更旧的版本要到编译前端时才会报错。
const MIN_NODE_MAJOR = 18;

assertNodeVersion();

// frontend/dist.zip 占位：沿用原 preBuildHook 行为，本地未构建前端时保证
// wails 能找到 embed 目标。
const stubDistZip = join(repoRoot, 'tools', 'stub-dist.zip');
const frontendDistZip = join(repoRoot, 'frontend', 'dist.zip');
if (!existsSync(frontendDistZip)) {
  copyFileSync(stubDistZip, frontendDistZip);
}

// 只在「目标为 linux 且宿主也是 linux」时校验：跨平台交叉编译不在本机链接
// WebKitGTK，探测本机环境只会误报。
if (targetPlatform.split('/')[0] === 'linux' && process.platform === 'linux') {
  checkLinuxBuildPrereqs(repoRoot, fail);
}

// shared/i18n/catalog.zip 是提交进 git 的派生物，二进制无法参与三方合并。
// 历史上出现过合并后 zip 与 JSON 源文件漂移的事故：Go 侧 T() 取不到键会直接
// 返回裸 key，用户界面显示成 table_designer.message.xxx 这种原文。
// 所有 wails 构建入口在此强制重新生成，使漂移无法进入产物；漂移本身仍由
// shared/i18n 的 TestCatalogZipInSyncWithJSON 在 CI 拦下（该测试刻意不预生成，
// 以保留探测能力）。
regenerateI18nCatalog();

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    return;
  }
  const lines = [
    `当前 Node.js 版本 ${process.version} 过低，前端编译（Vite 5）需要 Node.js ${MIN_NODE_MAJOR} 或更高版本。`,
    '请安装 Node.js LTS：https://nodejs.org/ （也可以用 nvm、fnm 等版本管理器）。',
  ];
  if (process.platform === 'linux' && commandExists('dnf')) {
    lines.push(
      'RHEL / Rocky / AlmaLinux 可直接切换到新版本：',
      '  sudo dnf module reset -y nodejs && sudo dnf module enable -y nodejs:22 && sudo dnf install -y nodejs npm',
    );
  }
  fail(lines.join('\n'));
}

function regenerateI18nCatalog() {
  try {
    execFileSync('go', ['generate', './shared/i18n'], { cwd: repoRoot, stdio: 'inherit' });
  } catch (error) {
    const goVersion = readGoModVersion();
    if (error.code === 'ENOENT') {
      fail(`未找到 go 命令。请安装 Go ${goVersion} 或更高版本：https://go.dev/dl/`);
    }
    fail(
      [
        'go generate ./shared/i18n 执行失败，原因见上方输出。常见原因：',
        `  · Go 版本低于 go.mod 要求的 ${goVersion}：请安装 Go ${goVersion} 或更高版本（https://go.dev/dl/）；`,
        '  · 无法下载 Go 模块或工具链：国内网络可先执行 go env -w GOPROXY=https://goproxy.cn,direct 再重试。',
      ].join('\n'),
    );
  }
}

function readGoModVersion() {
  try {
    const match = /^go\s+(\S+)/m.exec(readFileSync(join(repoRoot, 'go.mod'), 'utf8'));
    return match ? match[1] : '1.25';
  } catch (error) {
    return '1.25';
  }
}

function fail(message) {
  console.error(`\n[GoNavi] ${message}\n`);
  process.exit(1);
}
