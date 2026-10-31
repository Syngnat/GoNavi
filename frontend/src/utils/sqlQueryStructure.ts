import { isSqlDashLineCommentStart, supportsSqlHashLineComment } from './sqlStatementSelection';

const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
// `#` 只在「井号不是注释」的方言（达梦/Oracle）里算词字符：
// 那里 sequence# 是标识符，col#limit 不能把 limit 切出来当关键词；
// MySQL 系与 ClickHouse 的 `#` 是行注释，词必须在井号处断开
// （否则 LIMIT#注释 漏识别、SELECT#注释 的 leading keyword 变成 select#）。
const isWord = (ch: string, dbType = '') => /[A-Za-z0-9_]/.test(ch)
  || (ch === '#' && !supportsSqlHashLineComment(dbType));

export const getLeadingKeyword = (sql: string, dbType = ''): string => {
  const text = (sql || '').replace(/\r\n/g, '\n');
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    const next2 = i + 2 < text.length ? text[i + 2] : '';

    if (!inSingle && !inDouble && !inBacktick) {
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        i++;
        inBlockComment = true;
        continue;
      }
      if (ch === '#' && supportsSqlHashLineComment(dbType)) {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, next2)) {
        i++;
        inLineComment = true;
        continue;
      }
      if (dollarTag) {
        if (text.startsWith(dollarTag, i)) {
          i += dollarTag.length - 1;
          dollarTag = null;
        }
        continue;
      }
      if (ch === '$') {
        const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
        if (m && m[0]) {
          dollarTag = m[0];
          i += dollarTag.length - 1;
          continue;
        }
      }
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if ((inSingle || inDouble) && ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick || dollarTag) continue;
    if (isWS(ch)) continue;
    if (isWord(ch, dbType)) {
      let j = i;
      while (j < text.length && isWord(text[j], dbType)) j++;
      return text.slice(i, j).toLowerCase();
    }
    return '';
  }
  return '';
};

export const splitSqlTail = (sql: string, dbType = ''): { main: string; tail: string } => {
  const text = (sql || '').replace(/\r\n/g, '\n');
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  let lastMeaningful = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    const next2 = i + 2 < text.length ? text[i + 2] : '';

    if (!inSingle && !inDouble && !inBacktick) {
      if (dollarTag) {
        if (text.startsWith(dollarTag, i)) {
          lastMeaningful = i + dollarTag.length - 1;
          i += dollarTag.length - 1;
          dollarTag = null;
        } else if (!isWS(ch)) {
          lastMeaningful = i;
        }
        continue;
      }
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        i++;
        inBlockComment = true;
        continue;
      }
      if (ch === '#' && supportsSqlHashLineComment(dbType)) {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, next2)) {
        i++;
        inLineComment = true;
        continue;
      }
      if (ch === '$') {
        const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
        if (m && m[0]) {
          dollarTag = m[0];
          lastMeaningful = i + dollarTag.length - 1;
          i += dollarTag.length - 1;
          continue;
        }
      }
    }

    if (escaped) {
      escaped = false;
    } else if ((inSingle || inDouble) && ch === '\\') {
      escaped = true;
    } else {
      if (!inDouble && !inBacktick && ch === "'") inSingle = !inSingle;
      else if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble;
      else if (!inSingle && !inDouble && ch === '`') inBacktick = !inBacktick;
    }

    if (!inLineComment && !inBlockComment && !isWS(ch)) {
      lastMeaningful = i;
    }
  }

  if (lastMeaningful < 0) return { main: '', tail: text };
  let mainEnd = lastMeaningful + 1;
  while (mainEnd > 0 && (isWS(text[mainEnd - 1]) || text[mainEnd - 1] === ';' || text[mainEnd - 1] === '；')) {
    mainEnd--;
  }
  return { main: text.slice(0, mainEnd), tail: text.slice(mainEnd) };
};

const matchesKeyword = (sql: string, start: number, words: string[], dbType: string): boolean => {
  let pos = start;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (sql.slice(pos, pos + word.length).toLowerCase() !== word) return false;
    pos += word.length;
    if (isWord(sql[pos] || '', dbType)) return false;
    if (i === words.length - 1) return true;
    const gapStart = pos;
    while (pos < sql.length) {
      const trivia = sql.slice(pos).match(/^(?:\s+|\/\*[\s\S]*?\*\/|#[^\r\n]*(?:\r?\n|$))/);
      if (trivia) pos += trivia[0].length;
      else if (sql.startsWith('--', pos) && isSqlDashLineCommentStart(dbType, sql[pos + 2] || '')) {
        const end = sql.indexOf('\n', pos);
        pos = end < 0 ? sql.length : end + 1;
      } else break;
    }
    if (pos === gapStart) return false;
  }
  return false;
};

export const findTopLevelKeyword = (sql: string, keyword: string, dbType = ''): number => {
  const text = sql;
  const words = keyword.toLowerCase().trim().split(/\s+/);
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  let parenDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    const next2 = i + 2 < text.length ? text[i + 2] : '';

    if (!inSingle && !inDouble && !inBacktick) {
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        i++;
        inBlockComment = true;
        continue;
      }
      if (ch === '#' && supportsSqlHashLineComment(dbType)) {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, next2)) {
        i++;
        inLineComment = true;
        continue;
      }
      if (dollarTag) {
        if (text.startsWith(dollarTag, i)) {
          i += dollarTag.length - 1;
          dollarTag = null;
        }
        continue;
      }
      if (ch === '$') {
        const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
        if (m && m[0]) {
          dollarTag = m[0];
          i += dollarTag.length - 1;
          continue;
        }
      }
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if ((inSingle || inDouble) && ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick || dollarTag) continue;
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (parenDepth !== 0) continue;
    if (!isWord(ch, dbType)) continue;
    const before = i - 1 >= 0 ? text[i - 1] : '';
    if (before && isWord(before, dbType)) continue;
    if (matchesKeyword(text, i, words, dbType)) return i;
  }
  return -1;
};

// 返回 WITH ... AS (...) 的主查询起点；非 CTE 语句返回 0。
// CTE 定义体在括号内，只识别深度 0 的语句起始关键字。
// 调用方仍须区分 SELECT 与 INSERT/UPDATE/DELETE，不能给后者注入分页。
const CTE_BODY_KEYWORDS = new Set(['select', 'with', 'values', 'insert', 'update', 'delete', 'merge', 'table']);

export const findCteBodyStart = (sql: string, dbType: string): number => {
  const text = sql;
  if (getLeadingKeyword(text, dbType) !== 'with') return 0;

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  let parenDepth = 0;
  // 首个深度 0 的起始关键字是 `with` 自身，从这里之后才开始找主查询。
  let skippedLeadingWith = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (!inSingle && !inDouble && !inBacktick) {
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        i++;
        inBlockComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, text[i + 2] || '')) {
        i++;
        inLineComment = true;
        continue;
      }
      if (dollarTag) {
        if (text.startsWith(dollarTag, i)) {
          i += dollarTag.length - 1;
          dollarTag = null;
        }
        continue;
      }
      if (ch === '$') {
        const m = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
        if (m && m[0]) {
          dollarTag = m[0];
          i += dollarTag.length - 1;
          continue;
        }
      }
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if ((inSingle || inDouble) && ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick || dollarTag) continue;

    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (parenDepth !== 0) continue;
    if (!isWord(ch, dbType)) continue;

    let wordEnd = i;
    while (wordEnd < text.length && isWord(text[wordEnd], dbType)) wordEnd++;
    const word = text.slice(i, wordEnd).toLowerCase();
    if (!skippedLeadingWith && word === 'with') {
      skippedLeadingWith = true;
      i = wordEnd - 1;
      continue;
    }
    if (CTE_BODY_KEYWORDS.has(word)) return i;
    i = wordEnd - 1;
  }

  return 0;
};
