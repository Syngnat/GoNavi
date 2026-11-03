/**
 * 轻量 SQL 分词：只区分「需要着色的四类片段」与普通文本。
 *
 * 不追求完整语法，只覆盖修复 SQL 会用到的形状（ALTER/CREATE/DROP + 反引号标识符
 * + 字符串 + 数字 + 行注释）。返回的 token 顺序拼接后必须严格等于输入——
 * 任何字符都不能丢，否则用户复制出去的内容会和看到的不一致。
 */
export type SqlTokenKind = 'keyword' | 'ident' | 'string' | 'number' | 'comment' | 'plain';

export type SqlToken = { kind: SqlTokenKind; text: string };

const KEYWORDS = new Set([
  'ALTER', 'TABLE', 'CREATE', 'DROP', 'MODIFY', 'COLUMN', 'ADD', 'CHANGE',
  'INDEX', 'PRIMARY', 'KEY', 'UNIQUE', 'NOT', 'NULL', 'DEFAULT', 'COMMENT',
  'AFTER', 'FIRST', 'RENAME', 'TO', 'IF', 'EXISTS', 'CONSTRAINT', 'USING',
  'BTREE', 'HASH', 'REFERENCES', 'ON', 'DELETE', 'UPDATE', 'CASCADE', 'RESTRICT',
  'AUTO_INCREMENT', 'CHARACTER', 'SET', 'COLLATE', 'UNSIGNED', 'ZEROFILL',
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'VARCHAR', 'CHAR',
  'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'DATETIME', 'TIMESTAMP', 'DATE',
  'TIME', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'JSON', 'BLOB', 'BOOLEAN',
]);

// 词法单元按优先级排列：注释与字符串必须先于标识符，否则会把内容拆开。
const TOKEN_PATTERN = new RegExp(
  [
    '(--[^\\n]*)',                    // 行注释
    "('(?:[^'\\\\]|\\\\.|'')*')",     // 单引号字符串（含 '' 转义）
    '(`(?:[^`]|``)+`)',               // 反引号标识符
    '("(?:[^"\\\\]|\\\\.|"")*")',     // 双引号标识符
    '\\b(\\d+(?:\\.\\d+)?)\\b',        // 数字
    '([A-Za-z_][A-Za-z0-9_]*)',       // 裸词（可能是关键字）
  ].join('|'),
  'g',
);

/**
 * 把 SQL 切成 token 列表。拼接所有 text 必须还原输入原文。
 *
 * 这是纯函数、不碰 DOM：着色由调用方用 createElement/createTextNode 组装，
 * 表名与注释来自数据库，属于不可信内容，绝不能用 innerHTML 拼接。
 */
export const tokenizeSql = (sql: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let cursor = 0;
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(sql)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'plain', text: sql.slice(cursor, match.index) });
    }
    const [text, comment, str, backtick, quoted, number, word] = match;
    if (comment !== undefined) {
      tokens.push({ kind: 'comment', text });
    } else if (str !== undefined || quoted !== undefined) {
      tokens.push({ kind: 'string', text });
    } else if (backtick !== undefined) {
      tokens.push({ kind: 'ident', text });
    } else if (number !== undefined) {
      tokens.push({ kind: 'number', text });
    } else if (word !== undefined) {
      tokens.push({
        kind: KEYWORDS.has(word.toUpperCase()) ? 'keyword' : 'plain',
        text,
      });
    } else {
      tokens.push({ kind: 'plain', text });
    }
    cursor = match.index + text.length;
  }
  if (cursor < sql.length) {
    tokens.push({ kind: 'plain', text: sql.slice(cursor) });
  }
  return tokens;
};

/** 拼接 token 文本，用于测试与剪贴板一致性校验。 */
export const joinSqlTokens = (tokens: SqlToken[]): string =>
  tokens.map((token) => token.text).join('');
