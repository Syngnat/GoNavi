import { resolveSqlDialect } from './sqlDialect';
import { buildPaginatedSelectSQL } from './sql';

const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

export const getLeadingKeyword = (sql: string): string => {
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
    const prev = i > 0 ? text[i - 1] : '';
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
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
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
    if (isWord(ch)) {
      let j = i;
      while (j < text.length && isWord(text[j])) j++;
      return text.slice(i, j).toLowerCase();
    }
    return '';
  }
  return '';
};

export const splitSqlTail = (sql: string): { main: string; tail: string } => {
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
    const prev = i > 0 ? text[i - 1] : '';
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
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
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

export const findTopLevelKeyword = (sql: string, keyword: string): number => {
  const text = sql;
  const kw = keyword.toLowerCase();
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
    const prev = i > 0 ? text[i - 1] : '';
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
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && (i === 0 || isWS(prev)) && (next2 === '' || isWS(next2))) {
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
    if (!isWord(ch)) continue;
    if (text.slice(i, i + kw.length).toLowerCase() !== kw) continue;
    const before = i - 1 >= 0 ? text[i - 1] : '';
    const after = i + kw.length < text.length ? text[i + kw.length] : '';
    if ((before && isWord(before)) || (after && isWord(after))) continue;
    return i;
  }
  return -1;
};

const hasOracleSequencePseudoColumn = (sql: string): boolean => {
  const text = sql || '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

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
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-') {
        i++;
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        i++;
        inBlockComment = true;
        continue;
      }
    }

    if (!inDouble && !inBacktick && ch === "'") {
      if (inSingle && next === "'") {
        i++;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      if (inDouble && next === '"') {
        i++;
      } else {
        inDouble = !inDouble;
      }
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick || ch !== '.') continue;

    let tokenStart = i + 1;
    while (tokenStart < text.length && isWS(text[tokenStart])) tokenStart++;
    let tokenEnd = tokenStart;
    while (tokenEnd < text.length && isWord(text[tokenEnd])) tokenEnd++;
    const token = text.slice(tokenStart, tokenEnd).toLowerCase();
    if (token === 'nextval' || token === 'currval') return true;
  }

  return false;
};

export const applyQueryAutoLimit = (
  sql: string,
  dbType: string,
  maxRows: number,
  driver = '',
  oceanBaseOracle = false,
): { sql: string; applied: boolean; maxRows: number } => {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return { sql, applied: false, maxRows };
  const normalizedType = String(resolveSqlDialect(dbType || 'mysql', driver)).toLowerCase();
  const keyword = getLeadingKeyword(sql);
  if (keyword !== 'select') return { sql, applied: false, maxRows };

  const { main, tail } = splitSqlTail(sql);
  if (!main.trim()) return { sql, applied: false, maxRows };

  const fromPos = findTopLevelKeyword(main, 'from');
  const limitPos = findTopLevelKeyword(main, 'limit');
  if (limitPos >= 0 && (fromPos < 0 || limitPos > fromPos)) return { sql, applied: false, maxRows };
  const fetchPos = findTopLevelKeyword(main, 'fetch');
  if (fetchPos >= 0 && (fromPos < 0 || fetchPos > fromPos)) return { sql, applied: false, maxRows };

  if (normalizedType === 'sqlserver' || normalizedType === 'mssql') {
    const topPos = findTopLevelKeyword(main, 'top');
    if (topPos >= 0) return { sql, applied: false, maxRows };
    const selectPos = findTopLevelKeyword(main, 'select');
    if (selectPos < 0) return { sql, applied: false, maxRows };
    const afterSelect = selectPos + 'SELECT'.length;
    const restAfterSelect = main.slice(afterSelect);
    const distinctMatch = restAfterSelect.match(/^(\s+DISTINCT\b)/i);
    const insertOffset = distinctMatch ? afterSelect + distinctMatch[1].length : afterSelect;
    const nextMain = main.slice(0, insertOffset) + ` TOP ${maxRows}` + main.slice(insertOffset);
    return { sql: nextMain + tail, applied: true, maxRows };
  }

  if (normalizedType === 'oracle' || normalizedType === 'dameng') {
    const rownumPos = findTopLevelKeyword(main, 'rownum');
    if (rownumPos >= 0) return { sql, applied: false, maxRows };
    const offsetPos = findTopLevelKeyword(main, 'offset');
    if (offsetPos >= 0 && (fromPos < 0 || offsetPos > fromPos)) return { sql, applied: false, maxRows };
    const forPos = findTopLevelKeyword(main, 'for');
    if (forPos >= 0 && (fromPos < 0 || forPos > fromPos)) return { sql, applied: false, maxRows };
    // Oracle-compatible databases reject NEXTVAL/CURRVAL when the ROWNUM cap
    // moves the original SELECT into a subquery.
    if (hasOracleSequencePseudoColumn(main)) return { sql, applied: false, maxRows };
    // OceanBase Oracle 模式支持 FETCH FIRST，优化器可做谓词下推避免全表扫描
    if (oceanBaseOracle) {
      return { sql: `${main.trimEnd()} FETCH FIRST ${maxRows} ROWS ONLY${tail}`, applied: true, maxRows };
    }
    return { sql: `${buildPaginatedSelectSQL(normalizedType, main, '', maxRows, 0)}${tail}`, applied: true, maxRows };
  }

  const offsetPos = findTopLevelKeyword(main, 'offset');
  const forPos = findTopLevelKeyword(main, 'for');
  const lockPos = findTopLevelKeyword(main, 'lock');
  const candidates = [offsetPos, forPos, lockPos]
    .filter(pos => pos >= 0 && (fromPos < 0 || pos > fromPos));
  const insertAt = candidates.length > 0 ? Math.min(...candidates) : main.length;
  const before = main.slice(0, insertAt).trimEnd();
  const after = main.slice(insertAt).trimStart();
  const nextMain = [before, `LIMIT ${maxRows}`, after].filter(Boolean).join(' ').trim();
  return { sql: nextMain + tail, applied: true, maxRows };
};
