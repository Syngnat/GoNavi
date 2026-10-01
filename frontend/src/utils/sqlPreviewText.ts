const DEFAULT_MAX_CHARS = 900

/** 列表预览用 SQL：去掉空行与公共缩进并截断，保留换行结构。 */
export const buildSqlPreviewText = (sqlText: string, maxChars = DEFAULT_MAX_CHARS): string => {
  const lines = String(sqlText || '')
    .replace(/\t/g, '  ')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  if (lines.length === 0) return ''
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length))
  const text = lines.map((line) => line.slice(indent).trimEnd()).join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}
