/** 大于该长度的探针结果不再美化，避免展开时卡住渲染线程。 */
const PRETTY_PRINT_LIMIT = 200_000;

const parseObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

/** 结果是合法 JSON 时缩进展示，否则保持原文。 */
export const formatToolResult = (raw: string): string => {
  if (!raw || raw.length > PRETTY_PRINT_LIMIT) return raw;
  const first = raw.trimStart()[0];
  if (first !== '{' && first !== '[') return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

export interface ToolArgumentsView {
  /** 主体内容：SQL 探针直接给出 SQL 文本，其它探针给出缩进后的参数 JSON。 */
  primary: string;
  /** SQL 探针剩余参数（连接、库名等）的一行摘要，没有则为空串。 */
  meta: string;
}

const formatMetaValue = (value: unknown): string => (
  typeof value === 'string' ? value : JSON.stringify(value)
);

export const describeToolArguments = (raw: string | undefined): ToolArgumentsView => {
  const text = (raw || '').trim();
  if (!text) return { primary: '', meta: '' };
  const parsed = parseObject(text);
  if (!parsed) return { primary: text, meta: '' };
  const { sql, ...rest } = parsed;
  if (typeof sql === 'string' && sql.trim()) {
    const meta = Object.entries(rest)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${formatMetaValue(value)}`)
      .join(' · ');
    return { primary: sql.trim(), meta };
  }
  return Object.keys(parsed).length === 0
    ? { primary: '', meta: '' }
    : { primary: JSON.stringify(parsed, null, 2), meta: '' };
};
