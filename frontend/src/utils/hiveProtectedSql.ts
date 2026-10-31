// Preserve quoted function names, but remove string payloads and comments.
const executableHiveTokens = (sql: string): string => {
  let output = '';
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end + 1;
      output += ' ';
    } else if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
      output += ' ';
    } else if (sql[index] === "'" || sql[index] === '"' || sql.charCodeAt(index) === 96) {
      const quote = sql[index++];
      let identifier = '';
      while (index < sql.length) {
        const char = sql[index++];
        if (char === '\\' && quote !== '\x60') { index++; continue; }
        if (char === quote) {
          if (sql[index] === quote) { identifier += char; index++; continue; }
          break;
        }
        identifier += char;
      }
      output += quote === '\x60' ? ' ' + identifier + ' ' : ' ? ';
    } else output += sql[index++];
  }
  return output;
};

export const isHiveReadOnlySet = (sql: string): boolean =>
  /^\s*set(?:\s+(?:-v|(?:hiveconf:|hivevar:)?[a-z_][a-z0-9_.:-]*))?\s*;?\s*$/i.test(executableHiveTokens(sql));

export const hasUnsafeHiveReadOnlyOperation = (sql: string): boolean => {
  if (sql.includes('${')) return true;
  const executable = executableHiveTokens(String(sql || ''));
  return /\b(?:reflect|reflect2|java_method)\s*\(/i.test(executable)
    || /\b(?:transform|map|reduce)\b[\s\S]*\busing\b/i.test(executable);
};
