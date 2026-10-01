// Linux 本机构建前置检查：C 编译器、pkg-config、GTK3 与 WebKitGTK 开发包。
//
// wails build 在 Linux 强制 CGO_ENABLED=1，桌面前端通过 #cgo pkg-config 链接
// GTK3 与 WebKitGTK；链接 4.0 还是 4.1 由 wails.json 的 build:tags 决定
// （webkit2_41 → 4.1），命令行 -tags 无法覆盖（wails 做的是 projectTags +
// userTags 合并）。依赖缺失时 go build 要到最后一步才报一屏 cgo 错误，所以在
// preBuildHook 里提前检查，并按本机包管理器给出可以直接执行的安装命令。
//
// 只用 Node 12 能解析的语法：wails-pre-build.mjs 静态 import 本文件，版本过低
// 时也要先能加载，才能走到它的 Node 版本提示。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const WEBKIT_41_TAG = 'webkit2_41';

export const WEBKIT_PKG_CONFIG = {
  '4.1': 'webkit2gtk-4.1',
  '4.0': 'webkit2gtk-4.0',
};

const PACKAGE_MANAGERS = [
  {
    bin: 'apt-get',
    install: 'sudo apt-get install -y',
    packages: {
      compiler: 'build-essential',
      pkgConfig: 'pkg-config',
      gtk: 'libgtk-3-dev',
      '4.1': 'libwebkit2gtk-4.1-dev',
      '4.0': 'libwebkit2gtk-4.0-dev',
    },
  },
  {
    bin: 'dnf',
    install: 'sudo dnf install -y',
    packages: {
      compiler: 'gcc',
      pkgConfig: 'pkgconf-pkg-config',
      gtk: 'gtk3-devel',
      '4.1': 'webkit2gtk4.1-devel',
      '4.0': 'webkit2gtk3-devel',
    },
  },
  {
    bin: 'yum',
    install: 'sudo yum install -y',
    packages: {
      compiler: 'gcc',
      pkgConfig: 'pkgconfig',
      gtk: 'gtk3-devel',
      '4.1': 'webkit2gtk4.1-devel',
      '4.0': 'webkit2gtk3-devel',
    },
  },
  {
    bin: 'pacman',
    install: 'sudo pacman -S --needed',
    packages: {
      compiler: 'base-devel',
      pkgConfig: 'pkgconf',
      gtk: 'gtk3',
      '4.1': 'webkit2gtk-4.1',
      '4.0': 'webkit2gtk',
    },
  },
  {
    bin: 'zypper',
    install: 'sudo zypper install -y',
    packages: {
      compiler: 'gcc',
      pkgConfig: 'pkg-config',
      gtk: 'gtk3-devel',
      '4.1': "'pkgconfig(webkit2gtk-4.1)'",
      '4.0': "'pkgconfig(webkit2gtk-4.0)'",
    },
  },
];

const DEPENDENCY_LABELS = {
  compiler: 'C 编译器',
  pkgConfig: 'pkg-config',
  gtk: 'GTK3 开发包',
  webkit: 'WebKitGTK 开发包',
};

export function commandExists(command) {
  if (command.indexOf('/') >= 0) {
    return existsSync(command);
  }
  return (process.env.PATH || '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, command)));
}

export function detectPackageManager(exists) {
  const check = exists || commandExists;
  return PACKAGE_MANAGERS.find((manager) => check(manager.bin)) || null;
}

function splitTags(tags) {
  return String(tags || '').split(/[\s,]+/).filter(Boolean);
}

export function webKitApiForTags(tags) {
  return splitTags(tags).indexOf(WEBKIT_41_TAG) >= 0 ? '4.1' : '4.0';
}

export function withWebKitApi(tags, api) {
  const rest = splitTags(tags).filter((tag) => tag !== WEBKIT_41_TAG);
  if (api === '4.1') {
    rest.push(WEBKIT_41_TAG);
  }
  return rest.join(',');
}

// configuredApi 是 wails.json 当前链接的版本；installed 记录本机 pkg-config
// 能找到的版本。只装了另一个版本时切换过去，两个都没有才要求安装。
export function planWebKit(configuredApi, installed) {
  if (installed[configuredApi]) {
    return { action: 'ok' };
  }
  const otherApi = configuredApi === '4.1' ? '4.0' : '4.1';
  if (installed[otherApi]) {
    return { action: 'switch', api: otherApi };
  }
  return { action: 'install' };
}

export function buildInstallHint(manager, missing, webKitApi) {
  const labels = missing.map((key) => DEPENDENCY_LABELS[key]).join('、');
  if (!manager) {
    return `请用系统的包管理器安装：${labels}（WebKitGTK 选 4.1 或 4.0 均可）。`;
  }
  const packages = missing.map((key) => manager.packages[key === 'webkit' ? webKitApi : key]);
  const lines = [`请先安装：\n  ${manager.install} ${packages.join(' ')}`];
  if (missing.indexOf('webkit') >= 0) {
    const otherApi = webKitApi === '4.1' ? '4.0' : '4.1';
    lines.push(
      `若提示找不到 ${manager.packages[webKitApi]}，改装 ${manager.packages[otherApi]}；` +
        '构建会自动识别本机的 WebKitGTK 4.1 或 4.0。',
    );
  }
  return lines.join('\n');
}

function readProjectBuildTags(repoRoot) {
  try {
    const config = JSON.parse(readFileSync(join(repoRoot, 'wails.json'), 'utf8'));
    return config['build:tags'] || '';
  } catch (error) {
    // 配置文件不可读时不阻断构建：真正的解析错误会由 wails 自己报出来。
    return '';
  }
}

function writeProjectBuildTags(repoRoot, tags) {
  const configPath = join(repoRoot, 'wails.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config['build:tags'] = tags;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function resolveCCompiler() {
  const fromEnv = (process.env.CC || '').trim();
  if (fromEnv) {
    return fromEnv.split(/\s+/)[0];
  }
  // 在模块目录外查询，避免 go.mod 要求更高 Go 版本时 go env 自身报错。
  const result = spawnSync('go', ['env', 'CC'], { cwd: tmpdir(), encoding: 'utf8' });
  const fromGo = result.status === 0 ? String(result.stdout || '').trim() : '';
  return fromGo ? fromGo.split(/\s+/)[0] : 'gcc';
}

function switchedNote(switched) {
  return (
    `本机只装了 WebKitGTK ${switched.api} 开发包，已把 wails.json 的 build:tags ` +
    `从 ${JSON.stringify(switched.from)} 改为 ${JSON.stringify(switched.to)}（只影响本机构建，无需提交）。`
  );
}

function missingDependenciesMessage(manager, missing, webKitApi, switched) {
  const lines = ['缺少 Linux 桌面构建依赖。', buildInstallHint(manager, missing, webKitApi)];
  if (switched) {
    lines.push(switchedNote(switched));
  }
  lines.push(
    '装好后重新执行 wails build。',
    '只想运行无界面的 web-server / CLI（不依赖 GTK / WebKitGTK）：',
    '  CGO_ENABLED=0 go build -o gonavi . && ./gonavi web-server --addr 127.0.0.1:34116',
  );
  return lines.join('\n');
}

// 检查通过时直接返回；否则调用 fail(message) 终止构建。
export function checkLinuxBuildPrereqs(repoRoot, fail) {
  const manager = detectPackageManager();
  const tags = readProjectBuildTags(repoRoot);
  const configuredApi = webKitApiForTags(tags);
  const missing = [];

  if (!commandExists(resolveCCompiler())) {
    missing.push('compiler');
  }
  const pkgConfig = (process.env.PKG_CONFIG || '').trim() || 'pkg-config';
  if (!commandExists(pkgConfig)) {
    missing.push('pkgConfig', 'gtk', 'webkit');
    fail(missingDependenciesMessage(manager, missing, configuredApi, null));
    return;
  }

  const hasPackage = (name) => spawnSync(pkgConfig, ['--exists', name], { stdio: 'ignore' }).status === 0;
  if (!hasPackage('gtk+-3.0')) {
    missing.push('gtk');
  }
  const plan = planWebKit(configuredApi, {
    '4.1': hasPackage(WEBKIT_PKG_CONFIG['4.1']),
    '4.0': hasPackage(WEBKIT_PKG_CONFIG['4.0']),
  });
  let switched = null;
  if (plan.action === 'switch') {
    switched = { api: plan.api, from: tags, to: withWebKitApi(tags, plan.api) };
    writeProjectBuildTags(repoRoot, switched.to);
  } else if (plan.action === 'install') {
    missing.push('webkit');
  }

  if (missing.length > 0) {
    fail(missingDependenciesMessage(manager, missing, configuredApi, switched));
    return;
  }
  if (switched) {
    fail(`${switchedNote(switched)}\n本次构建的标签已经固定，请重新执行刚才的 wails build 命令。`);
  }
}
