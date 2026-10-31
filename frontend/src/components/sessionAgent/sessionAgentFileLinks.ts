/**
 * 会话正文里的本机文件引用：
 * - Codex 的内联标记 :codex-file-citation{path="..." purpose="output"}；
 * - 指向本机路径的 Markdown 链接（如 [文档](/E:/path/doc.md)）。
 *
 * 两者都渲染成文件卡片，而不是当网页链接——正文里的本机路径点开没有
 * 意义，渲染成裸路径又容易被误读成普通文字。
 */

/** Codex 内联文件引用标记。 */
const CITATION_PATTERN = /:codex-file-citation\{([^}]*)\}/g;

/** 引用标记的属性解析（path="..." purpose="..."）。 */
export const parseCitationAttributes = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const pattern = /(\w+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(raw);
  while (match) {
    attrs[match[1]] = match[2];
    match = pattern.exec(raw);
  }
  return attrs;
};

/** 路径末段的文件名。 */
export const fileDisplayName = (path: string): string => {
  const value = (path || '').trim();
  if (!value) return '';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || value;
};

/** 把本机路径统一成 file:// URL。 */
export const localFileHref = (path: string): string => {
  const value = (path || '').trim();
  if (!value) return '';
  if (/^file:\/\//i.test(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:/.test(normalized)) return `file://${normalized}`;
  if (/^[a-zA-Z]:/.test(normalized)) return `file:///${normalized}`;
  return `file:///${normalized.replace(/^\/+/, '')}`;
};

/** 从 href 取回本机路径（file:// URL 还原成盘符路径；markdown 解析出的
 *  链接目标会被百分号编码，需解码）。
 *
 *  Markdown 里的 Windows 绝对路径写作 /E:/path —— 前导斜杠要去掉，否则
 *  Go 的 filepath.IsAbs 不认，后端会当成相对路径拒掉。 */
export const localFilePath = (href: string): string => {
  const value = (href || '').trim();
  if (!value) return '';
  const raw = /^file:\/\//i.test(value)
    ? value.replace(/^file:\/\/\/?/i, '').replace(/\//g, '\\')
    : value.replace(/^\/([a-zA-Z]:)/, '$1');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** href 是否指向本机文件（而不是网页）。 */
export const isLocalFileHref = (href: string): boolean => {
  const value = (href || '').trim();
  if (!value) return false;
  if (/^file:\/\//i.test(value)) return true;
  // Markdown 里的 Windows 绝对路径：/E:/path 与 E:\path
  if (/^\/[a-zA-Z]:[\\/]/.test(value)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
};

/** 受支持的图片扩展名（与后端 sessionagent.localImageMIME 保持一致）。 */
const LOCAL_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];

/** 路径是否指向本机图片文件。 */
export const isLocalImagePath = (path: string): boolean => {
  const value = (path || '').trim();
  if (!value) return false;
  const ext = value.replace(/[?#].*$/, '').split('.').pop()?.toLowerCase() ?? '';
  return LOCAL_IMAGE_EXTENSIONS.includes(ext);
};

/**
 * href 是否指向本机图片。markdown 里的图片语法 ![alt](/E:/path/x.png)
 * 解析出来的 src 是本机路径——webview 加载不了（站点相对路径与 file://
 * 都会被拦掉），必须由后端读成 data URL。
 */
export const isLocalImageHref = (href: string): boolean =>
  isLocalFileHref(href) && isLocalImagePath(localFilePath(href));

/**
 * 把 :codex-file-citation{...} 内联标记改写成指向本机文件的 Markdown
 * 链接，交给渲染器统一按文件卡片处理。
 */
export const rewriteCodexFileCitations = (content: string): string =>
  (content || '').replace(CITATION_PATTERN, (_match, raw: string) => {
    const attrs = parseCitationAttributes(raw);
    const path = (attrs.path || '').trim();
    if (!path) return '';
    return `[${fileDisplayName(path)}](${localFileHref(path)})`;
  });
