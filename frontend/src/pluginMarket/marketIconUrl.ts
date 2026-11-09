const rawHost = 'https://raw.githubusercontent.com';
const githubHosts = new Set(['github.com', 'www.github.com']);
// 只接受包内相对路径：拒绝绝对路径、回溯段、查询串和编码后的分隔符。
function safeIconPath(value: string | undefined): string {
  const path = value?.trim() ?? '';
  if (!path || path.length > 256 || path.startsWith('/') || path.includes('\\') || /[?#%\u0000-\u001f]/.test(path)) return '';
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return encodeURI(path);
}

// 市场目录的来源地址通常是 GitHub 仓库；图标文件只从该仓库的默认分支读取。
function githubRepository(sourceUrl: string | undefined): { owner: string; repo: string } | null {
  try {
    const url = new URL(sourceUrl ?? '');
    if (url.protocol !== 'https:' || !githubHosts.has(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

export interface GithubIconContext {
  official?: boolean;
  pluginId?: string;
  providerId?: string;
}

// 目录名只能是安全路径段，避免未校验的插件 id 改写 raw 地址。
function safeDirectorySegment(value: string | undefined): string {
  const segment = value?.trim() ?? '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) ? segment : '';
}

// 官方插件位于市场仓 plugins/<目录>，目录名通常是 id 后缀或 <供应商 id>-ai-provider。
function monorepoIconPaths(path: string, context: GithubIconContext): string[] {
  if (!context.official) return [];
  const suffix = safeDirectorySegment(context.pluginId?.split('.').filter(Boolean).pop());
  const providerId = safeDirectorySegment(context.providerId);
  const directories = [
    providerId ? `plugins/${providerId}-ai-provider` : '',
    suffix ? `plugins/${suffix}` : '',
  ].filter((directory, index, all) => directory && all.indexOf(directory) === index);
  return directories.map((directory) => `${directory}/${path}`);
}

// 生成候选地址：官方插件先试 plugins/<目录>，再按 manifest 声明原样尝试，最后兼容 frontend/public/。
export function githubIconCandidates(sourceUrl: string | undefined, icon: string | undefined, context: GithubIconContext = {}): string[] {
  const repository = githubRepository(sourceUrl);
  const path = safeIconPath(icon);
  if (!repository || !path) return [];
  const paths = [...monorepoIconPaths(path, context), path];
  if (path.startsWith('frontend/') && !path.startsWith('frontend/public/')) {
    paths.push('frontend/public/' + path.slice('frontend/'.length));
  }
  // raw.githubusercontent.com 的 HEAD 指向仓库默认分支，避免猜测 main/master。
  return paths.map((candidate) => `${rawHost}/${repository.owner}/${repository.repo}/HEAD/${candidate}`);
}

