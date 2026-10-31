// 把安装输入框的文本分类为本地路径或远程来源（github:/npm）。
// 这里只做「路由决策」：github: 前缀的合法性由后端权威校验，
// npm 名则用与后端 internal/pluginfetch 相同的规则，避免明显的路径误判。
export type PluginInstallSpec =
  | { kind: 'local'; raw: string }
  | { kind: 'github'; owner: string; repo: string; tag?: string; raw: string }
  | { kind: 'npm'; name: string; version?: string; raw: string };

const GITHUB_PREFIX = /^github:/i;
// 粘贴的仓库链接（含无协议、www、http 形态）也走远程解析，具体合法性由后端判定。
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;
const NPM_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION = /^[A-Za-z0-9.+-]{1,64}$/;
// 明显是本地包文件的输入（含扩展名）不再尝试 npm 解析。
const LOCAL_PACKAGE_FILE = /\.(zip|tgz|tar\.gz|json)$/i;

export function parsePluginInstallSpec(input: string): PluginInstallSpec {
  const raw = input.trim();
  if (GITHUB_PREFIX.test(raw)) {
    const rest = raw.slice(raw.indexOf(':') + 1).trim();
    const at = rest.indexOf('@');
    const tag = at >= 0 ? rest.slice(at + 1).trim() : '';
    const repoPart = at >= 0 ? rest.slice(0, at) : rest;
    const slash = repoPart.indexOf('/');
    return {
      kind: 'github',
      owner: slash > 0 ? repoPart.slice(0, slash) : repoPart,
      repo: slash > 0 ? repoPart.slice(slash + 1) : '',
      ...(tag !== '' ? { tag } : {}),
      raw,
    };
  }
  if (GITHUB_URL.test(raw)) {
    return { kind: 'github', owner: '', repo: '', raw };
  }
  if (raw === '' || /[\\: ]/.test(raw) || LOCAL_PACKAGE_FILE.test(raw)) {
    return { kind: 'local', raw };
  }
  const parsed = parseNPMSpec(raw);
  return parsed ?? { kind: 'local', raw };
}

function parseNPMSpec(raw: string): Extract<PluginInstallSpec, { kind: 'npm' }> | null {
  let name = raw;
  let version = '';
  if (raw.startsWith('@')) {
    const slash = raw.indexOf('/');
    if (slash < 0) return null;
    const rest = raw.slice(slash + 1);
    const at = rest.indexOf('@');
    if (at >= 0) {
      name = raw.slice(0, slash + 1 + at);
      version = rest.slice(at + 1).trim();
    }
  } else {
    const at = raw.indexOf('@');
    if (at >= 0) {
      name = raw.slice(0, at);
      version = raw.slice(at + 1).trim();
    }
  }
  if (version !== '' && !NPM_VERSION.test(version)) return null;
  if (name === '' || name.length > 214) return null;
  const scoped = name.startsWith('@');
  const segments = name.replace(/^@/, '').split('/');
  const shapeOk = scoped ? segments.length === 2 : segments.length === 1;
  if (!shapeOk || !segments.every((segment) => NPM_SEGMENT.test(segment))) return null;
  return { kind: 'npm', name, ...(version !== '' ? { version } : {}), raw };
}
