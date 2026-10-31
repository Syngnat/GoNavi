/**
 * 会话列表行的展示纯函数：标题智能截断与项目名提取。
 * 独立于组件，便于 Vitest 单测（参照同目录其他纯函数的放置方式）。
 */

/** 列表标题的最大展示长度（按字符计，CJK 场景即汉字数）。 */
export const SESSION_ASSETS_TITLE_MAX_RUNES = 24;
/** 句末截断点允许的最小位置：太靠前的符号不成句，跳过继续找。 */
export const SESSION_ASSETS_TITLE_MIN_CUT = 8;
/** 句末符号集合：在这些字符处收尾视为一句完整话。 */
const TITLE_SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';']);
/** 最后用户输入预览的最大展示长度。 */
export const SESSION_ASSETS_PREVIEW_MAX_RUNES = 40;

/** 空白折叠后按限长硬截，超长追加省略号；空输入返回空串。 */
const truncateWithEllipsis = (text: string, max: number): string => {
  const runes = Array.from(text);
  if (runes.length <= max) return text;
  return `${runes.slice(0, max).join('')}…`;
};

const normalizeSingleLine = (raw: string): string =>
  String(raw || '').replace(/\s+/g, ' ').trim();

/**
 * 标题截断：固定限长内遇到第一个句末符号就在该处收尾（句子完整、
 * 不带省略号，且收尾位置不能太靠前）；限长内没有就硬截并追加省略号。
 * 空输入返回空串。
 */
export const shortenSessionTitle = (raw: string, max: number = SESSION_ASSETS_TITLE_MAX_RUNES): string => {
  const text = normalizeSingleLine(raw);
  if (!text) return '';
  const runes = Array.from(text);
  if (runes.length <= max) return text;
  for (let index = SESSION_ASSETS_TITLE_MIN_CUT - 1; index < max; index += 1) {
    if (TITLE_SENTENCE_ENDINGS.has(runes[index])) {
      return runes.slice(0, index + 1).join('');
    }
  }
  return truncateWithEllipsis(text, max);
};

/** 最后用户输入预览：固定限长硬截；空输入返回空串。 */
export const shortenSessionPreview = (raw: string, max: number = SESSION_ASSETS_PREVIEW_MAX_RUNES): string =>
  truncateWithEllipsis(normalizeSingleLine(raw), max);

/**
 * 项目目录只展示末段项目名：兼容 Windows 与 POSIX 分隔符，忽略结尾
 * 分隔符；无法取段时回落原值，空输入返回空串。
 */
export const projectDisplayName = (projectDir: string): string => {
  const normalized = String(projectDir || '').trim();
  if (!normalized) return '';
  const segments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};
