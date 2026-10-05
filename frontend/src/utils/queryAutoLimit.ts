import { resolveSqlDialect } from './sqlDialect';
import { buildPaginatedSelectSQL, splitTrailingIsolationClause } from './sql';
import { isSqlDashLineCommentStart } from './sqlStatementSelection';
import { getDataSourceSpec } from './dataSourceRegistry';
import { buildRegistryPaginatedSelectSQL } from './dataSourceRegistry/sqlBehavior';

const isWS = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

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
      if (ch === '#') {
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
    if (isWord(ch)) {
      let j = i;
      while (j < text.length && isWord(text[j])) j++;
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
      if (ch === '#') {
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

export const findTopLevelKeyword = (sql: string, keyword: string, dbType = ''): number => {
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

/**
 * `WITH ... AS (...)` 的 CTE 前缀长度；非 CTE 语句返回 0。
 *
 * 主体判定靠「深度 0 处的语句起始关键字」：CTE 定义体一律在括号内（深度 > 0），
 * 而 CTE 名、`AS`、`RECURSIVE`、`MATERIALIZED` 都不属于该关键字集合，因此
 * 第一个在深度 0 出现的起始关键字必然是主查询（`WITH a AS (...), b AS (...)
 * SELECT ...` 里的 `b` 会被正确跳过）。返回主体起点后由调用方判定关键字是否
 * 可施加行数上限：`WITH ... INSERT/UPDATE/DELETE` 注入 `LIMIT` 会破坏语法。
 */
const CTE_BODY_KEYWORDS = new Set(['select', 'with', 'values', 'insert', 'update', 'delete', 'merge', 'table']);

const findCteBodyStart = (sql: string, dbType: string): number => {
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
    if (!isWord(ch)) continue;

    let wordEnd = i;
    while (wordEnd < text.length && isWord(text[wordEnd])) wordEnd++;
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

// limitOracleCteMainQuery 只限制 CTE 的主查询。
// Oracle 12c 之前不认识 FETCH FIRST，直接追加会得到 ORA-00933。
// 把整个 WITH 塞进 ROWNUM 内联视图也不行：子查询因子化必须留在查询块最外层。
const limitOracleCteMainQuery = (executableMain: string, dbType: string, maxRows: number): string | null => {
  if (getLeadingKeyword(executableMain, dbType) !== 'with') return null;
  const bodyStart = findCteBodyStart(executableMain, dbType);
  if (bodyStart <= 0) return null;
  const mainQuery = executableMain.slice(bodyStart).trim();
  if (!mainQuery || hasOracleSequencePseudoColumn(mainQuery)) return null;
  return `${executableMain.slice(0, bodyStart)}SELECT * FROM (${mainQuery}) WHERE ROWNUM <= ${maxRows}`;
};

/**
 * 语句是否以 SELECT 结果集收尾 —— CTE 语句看其主查询，而不是 literal 的
 * leading keyword。`getLeadingKeyword(x) === 'select'` 会把 `WITH ... SELECT`
 * 判成非查询，导致这类语句拿不到行数上限、分页状态或导出路径。
 *
 * 只放行 SELECT 主体：`WITH ... INSERT/UPDATE/DELETE` 返回 false。
 */
export const isSelectStatement = (sql: string, dbType = ''): boolean => {
  const text = String(sql || '');
  if (!text.trim()) return false;
  const keyword = getLeadingKeyword(text, dbType);
  if (keyword === 'select') return true;
  if (keyword !== 'with') return false;
  const bodyStart = findCteBodyStart(text, dbType);
  if (bodyStart <= 0) return false;
  return getLeadingKeyword(text.slice(bodyStart), dbType) === 'select';
};

export const applyQueryAutoLimit = (
  sql: string,
  dbType: string,
  maxRows: number,
  driver = '',
): { sql: string; applied: boolean; maxRows: number } => {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return { sql, applied: false, maxRows };
  const normalizedType = String(resolveSqlDialect(dbType || 'mysql', driver)).toLowerCase();
  // CTE 语句的 leading keyword 是 `with`，但行数上限真正作用在其后的主查询上。
  // 这里只放行 SELECT 主体：`WITH ... INSERT/UPDATE/DELETE` 注入 LIMIT 会破坏语法，
  // `WITH ... VALUES (...)` 也没有可追加 LIMIT 的位置，一律保持原样。
  const cteBodyStart = getLeadingKeyword(sql, normalizedType) === 'with'
    ? findCteBodyStart(sql, normalizedType)
    : 0;
  if (!isSelectStatement(sql, normalizedType)) return { sql, applied: false, maxRows };

  const { main, tail } = splitSqlTail(sql, normalizedType);
  if (!main.trim()) return { sql, applied: false, maxRows };
  const isolationStatement = normalizedType === 'dameng'
    ? splitTrailingIsolationClause(main)
    : { main, tail: '' };
  const executableMain = isolationStatement.main;
  const executableSql = `${executableMain}${isolationStatement.tail}${tail}`;

  const fromPos = findTopLevelKeyword(executableMain, 'from', normalizedType);
  const limitPos = findTopLevelKeyword(executableMain, 'limit', normalizedType);
  if (limitPos >= 0 && (fromPos < 0 || limitPos > fromPos)) return { sql: executableSql, applied: false, maxRows };
  const fetchPos = findTopLevelKeyword(executableMain, 'fetch', normalizedType);
  if (fetchPos >= 0 && (fromPos < 0 || fetchPos > fromPos)) return { sql: executableSql, applied: false, maxRows };

  if (normalizedType === 'sqlserver' || normalizedType === 'mssql') {
    const topPos = findTopLevelKeyword(executableMain, 'top', normalizedType);
    if (topPos >= 0) return { sql, applied: false, maxRows };
    const selectPos = findTopLevelKeyword(executableMain, 'select', normalizedType);
    if (selectPos < 0) return { sql, applied: false, maxRows };
    const afterSelect = selectPos + 'SELECT'.length;
    const restAfterSelect = executableMain.slice(afterSelect);
    const distinctMatch = restAfterSelect.match(/^(\s+DISTINCT\b)/i);
    const insertOffset = distinctMatch ? afterSelect + distinctMatch[1].length : afterSelect;
    const nextMain = executableMain.slice(0, insertOffset) + ` TOP ${maxRows}` + executableMain.slice(insertOffset);
    return { sql: nextMain + tail, applied: true, maxRows };
  }

  if (normalizedType === 'oracle' || normalizedType === 'dameng') {
    const rownumPos = findTopLevelKeyword(executableMain, 'rownum', normalizedType);
    if (rownumPos >= 0) return { sql: executableSql, applied: false, maxRows };
    const existingFetchPos = findTopLevelKeyword(executableMain, 'fetch', normalizedType);
    if (existingFetchPos >= 0 && (fromPos < 0 || existingFetchPos > fromPos)) {
      return { sql: executableSql, applied: false, maxRows };
    }
    const offsetPos = findTopLevelKeyword(executableMain, 'offset', normalizedType);
    if (offsetPos >= 0 && (fromPos < 0 || offsetPos > fromPos)) return { sql: executableSql, applied: false, maxRows };
    const forPos = findTopLevelKeyword(executableMain, 'for', normalizedType);
    if (forPos >= 0 && (fromPos < 0 || forPos > fromPos)) return { sql: executableSql, applied: false, maxRows };
    if (normalizedType === 'oracle' && cteBodyStart > 0) {
      const limitedCte = limitOracleCteMainQuery(executableMain, normalizedType, maxRows);
      if (!limitedCte) return { sql: executableSql, applied: false, maxRows };
      return { sql: `${limitedCte}${tail}`, applied: true, maxRows };
    }
    // Oracle-compatible databases reject NEXTVAL/CURRVAL when the ROWNUM cap
    // moves the original SELECT into a subquery.
    if (hasOracleSequencePseudoColumn(executableMain)) return { sql: executableSql, applied: false, maxRows };
    return { sql: `${buildPaginatedSelectSQL(normalizedType, main, '', maxRows, 0)}${tail}`, applied: true, maxRows };
  }

  // 描述表声明了非 LIMIT 分页语法的数据源（Firebird 的 ROWS m TO n、GBase 8s 的 SKIP / FIRST）不能追加 LIMIT。
  const registryPagination = getDataSourceSpec(dbType)?.ui?.pagination;
  if (registryPagination === 'rows-to' || registryPagination === 'skip-first') {
    const ownLimit = ['rows', 'first', 'skip'].some((keyword) => findTopLevelKeyword(executableMain, keyword, normalizedType) >= 0);
    const limited = ownLimit || (registryPagination === 'skip-first' && cteBodyStart > 0)
      ? undefined
      : buildRegistryPaginatedSelectSQL(dbType, executableMain, '', maxRows, 0);
    return limited
      ? { sql: `${limited}${isolationStatement.tail}${tail}`, applied: true, maxRows }
      : { sql: executableSql, applied: false, maxRows };
  }

  const offsetPos = findTopLevelKeyword(executableMain, 'offset', normalizedType);
  const forPos = findTopLevelKeyword(executableMain, 'for', normalizedType);
  const lockPos = findTopLevelKeyword(executableMain, 'lock', normalizedType);
  const candidates = [offsetPos, forPos, lockPos]
    .filter(pos => pos >= 0 && (fromPos < 0 || pos > fromPos));
  const insertAt = candidates.length > 0 ? Math.min(...candidates) : executableMain.length;
  const before = executableMain.slice(0, insertAt).trimEnd();
  const after = executableMain.slice(insertAt).trimStart();
  const nextMain = [before, `LIMIT ${maxRows}`, after].filter(Boolean).join(' ').trim();
  return { sql: nextMain + tail, applied: true, maxRows };
};
