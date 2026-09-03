export interface SqlStatementRange {
  start: number;
  end: number;
  text: string;
}

export type SqlExecutionSelectionSource = 'selection' | 'statement' | 'line' | 'all';

export interface SqlExecutionSelection {
  sql: string;
  source: SqlExecutionSelectionSource;
}

const isWhitespace = (ch: string): boolean => (
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
);

const isHorizontalWhitespace = (ch: string): boolean => (
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f'
);

const isSqlIdentifierStart = (ch: string): boolean => /^[A-Za-z_]$/.test(ch);

const isSqlIdentifierPart = (ch: string): boolean => /^[A-Za-z0-9_$#]$/.test(ch);

const normalizeSqlLexicalDbType = (dbType: string): string => {
  const normalized = String(dbType || '').trim().toLowerCase();
  if (normalized === 'doris') return 'diros';
  if (normalized === 'greatdb' || normalized === 'gdb') return 'goldendb';
  if (normalized === 'mssql' || normalized === 'sql_server' || normalized === 'sql-server') return 'sqlserver';
  return normalized;
};

export const supportsSqlBracketIdentifier = (dbType: string): boolean => (
  ['sqlserver', 'sqlite'].includes(normalizeSqlLexicalDbType(dbType))
);

export const supportsSqlEscapedBracketIdentifier = (dbType: string): boolean => (
  normalizeSqlLexicalDbType(dbType) === 'sqlserver'
);

const MYSQL_DASH_COMMENT_DIALECTS = new Set([
  'mysql', 'mariadb', 'oceanbase', 'diros', 'starrocks', 'goldendb', 'sphinx', 'tidb',
]);

const supportsSqlHashLineComment = (dbType: string): boolean => {
  const normalized = normalizeSqlLexicalDbType(dbType);
  return !normalized || normalized === 'clickhouse' || MYSQL_DASH_COMMENT_DIALECTS.has(normalized);
};

const isSqlDashLineCommentStart = (dbType: string, next2: string): boolean => {
  const normalized = normalizeSqlLexicalDbType(dbType);
  return !MYSQL_DASH_COMMENT_DIALECTS.has(normalized) || !next2 || isWhitespace(next2);
};

const isExecutableSqlBlockComment = (sql: string, index: number, dbType: string): boolean => {
  const isMySqlVersionComment = sql.startsWith('/*!', index);
  const isMariaDbVersionComment = sql.slice(index, index + 4).toLowerCase() === '/*m!';
  if (!isMySqlVersionComment && !isMariaDbVersionComment) {
    return false;
  }
  const normalized = normalizeSqlLexicalDbType(dbType);
  if (!normalized) {
    return true;
  }
  if (isMariaDbVersionComment) {
    return normalized === 'mariadb';
  }
  return MYSQL_DASH_COMMENT_DIALECTS.has(normalized);
};

const hasExecutableSqlStatementContent = (sql: string, dbType = ''): boolean => {
  const text = String(sql || '');
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = index + 1 < text.length ? text[index + 1] : '';
    const next2 = index + 2 < text.length ? text[index + 2] : '';
    if (isWhitespace(ch)) {
      index++;
      continue;
    }
    if ((ch === '#' && supportsSqlHashLineComment(dbType))
      || (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, next2))) {
      const lineEnd = text.indexOf('\n', index + (ch === '#' ? 1 : 2));
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      if (isExecutableSqlBlockComment(text, index, dbType)) {
        return true;
      }
      const blockEnd = text.indexOf('*/', index + 2);
      index = blockEnd < 0 ? text.length : blockEnd + 2;
      continue;
    }
    return true;
  }
  return false;
};

/**
 * Remove only non-executable trivia before a statement keyword. Statement
 * ranges intentionally retain comments for editor navigation, but the SQL
 * sent to the driver should not include detached documentation comments.
 */
export const stripLeadingSqlTrivia = (sql: string, dbType = ''): string => {
  const text = String(sql || '');
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1] || '';
    if (isWhitespace(ch)) {
      index += 1;
      continue;
    }
    if ((ch === '#' && supportsSqlHashLineComment(dbType))
      || (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, text[index + 2] || ''))) {
      const lineEnd = text.indexOf('\n', index + (ch === '#' ? 1 : 2));
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      if (isExecutableSqlBlockComment(text, index, dbType) || text.startsWith('/*+', index)) {
        break;
      }
      const blockEnd = text.indexOf('*/', index + 2);
      index = blockEnd < 0 ? text.length : blockEnd + 2;
      continue;
    }
    break;
  }
  return text.slice(index).replace(/\s+$/, '');
};

const skipSqlWhitespaceAndComments = (text: string, position: number): number => {
  let index = position;
  while (index < text.length) {
    const ch = text[index];
    const next = index + 1 < text.length ? text[index + 1] : '';
    if (isWhitespace(ch)) {
      index += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      if (index + 1 < text.length) index += 2;
      continue;
    }
    break;
  }
  return index;
};

const nextSqlSignificantToken = (text: string, position: number): string => {
  const index = skipSqlWhitespaceAndComments(text, position);
  if (index >= text.length || !isSqlIdentifierStart(text[index])) return '';
  let end = index + 1;
  while (end < text.length && isSqlIdentifierPart(text[end])) end += 1;
  return text.slice(index, end).toLowerCase();
};

const nextSqlSignificantChar = (text: string, position: number): string => {
  const index = skipSqlWhitespaceAndComments(text, position);
  return index >= text.length ? '' : text[index];
};

const resolveStandaloneSqlSlashLineEnd = (text: string, index: number): number | null => {
  if (text[index] !== '/') return null;

  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  for (let pos = lineStart; pos < index; pos++) {
    if (!isHorizontalWhitespace(text[pos])) {
      return null;
    }
  }

  let lineEnd = index + 1;
  let seenOptionalSemicolon = false;
  while (lineEnd < text.length && text[lineEnd] !== '\n') {
    if (text[lineEnd] === ';' && !seenOptionalSemicolon) {
      seenOptionalSemicolon = true;
      lineEnd += 1;
      continue;
    }
    if (text[lineEnd] === '-' && text[lineEnd + 1] === '-') {
      while (lineEnd < text.length && text[lineEnd] !== '\n') {
        lineEnd += 1;
      }
      return lineEnd;
    }
    if (!isHorizontalWhitespace(text[lineEnd])) {
      return null;
    }
    lineEnd += 1;
  }
  return lineEnd;
};

const resolveStandaloneSqlSlashLineAtOffset = (
  text: string,
  offset: number,
): { lineStart: number; lineEnd: number; slashIndex: number } | null => {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf('\n', lineStart);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;

  let slashIndex = lineStart;
  while (slashIndex < lineEnd && isHorizontalWhitespace(text[slashIndex])) {
    slashIndex += 1;
  }
  if (slashIndex >= lineEnd || text[slashIndex] !== '/') {
    return null;
  }

  const resolvedLineEnd = resolveStandaloneSqlSlashLineEnd(text, slashIndex);
  if (resolvedLineEnd === null || resolvedLineEnd !== lineEnd) {
    return null;
  }

  return { lineStart, lineEnd, slashIndex };
};

const findPreviousSqlStatementRange = (
  ranges: SqlStatementRange[],
  offset: number,
): SqlStatementRange | null => (
  [...ranges].reverse().find((range) => range.end <= offset) || null
);

const shouldEnterPlsqlBeginBlock = (text: string, tokenEnd: number): boolean => {
  const nextChar = nextSqlSignificantChar(text, tokenEnd);
  if (!nextChar || nextChar === ';') return false;
  return !['transaction', 'work', 'isolation', 'read', 'write'].includes(nextSqlSignificantToken(text, tokenEnd));
};

const shouldEnterPlsqlDeclareBlock = (text: string, tokenEnd: number): boolean => Boolean(nextSqlSignificantToken(text, tokenEnd));

const nextSqlSignificantTokenSpan = (text: string, position: number): { token: string; end: number } => {
  const index = skipSqlWhitespaceAndComments(text, position);
  if (index >= text.length || !isSqlIdentifierStart(text[index])) {
    return { token: '', end: index };
  }
  let end = index + 1;
  while (end < text.length && isSqlIdentifierPart(text[end])) end += 1;
  return { token: text.slice(index, end).toLowerCase(), end };
};

const isCreateRoutineHeaderPrefix = (text: string): boolean => {
  let current = nextSqlSignificantTokenSpan(text, 0);
  if (current.token !== 'create') return false;

  current = nextSqlSignificantTokenSpan(text, current.end);
  if (current.token === 'or') {
    current = nextSqlSignificantTokenSpan(text, current.end);
    if (current.token !== 'replace') return false;
    current = nextSqlSignificantTokenSpan(text, current.end);
  }

  while (['editionable', 'noneditionable'].includes(current.token)) {
    current = nextSqlSignificantTokenSpan(text, current.end);
  }

  if (current.token === 'procedure' || current.token === 'function') {
    return true;
  }
  if (current.token !== 'package') {
    return false;
  }
  current = nextSqlSignificantTokenSpan(text, current.end);
  return current.token === '' || current.token === 'body' || isSqlIdentifierStart(current.token[0] || '');
};

const isCreatePackageHeaderPrefix = (text: string): boolean => {
  let current = nextSqlSignificantTokenSpan(text, 0);
  if (current.token !== 'create') return false;

  current = nextSqlSignificantTokenSpan(text, current.end);
  if (current.token === 'or') {
    current = nextSqlSignificantTokenSpan(text, current.end);
    if (current.token !== 'replace') return false;
    current = nextSqlSignificantTokenSpan(text, current.end);
  }

  while (['editionable', 'noneditionable'].includes(current.token)) {
    current = nextSqlSignificantTokenSpan(text, current.end);
  }

  return current.token === 'package';
};

const shouldEnterPlsqlCreateRoutineBlock = (
  text: string,
  statementStart: number,
  token: string,
  tokenEnd: number,
): boolean => {
  if (token !== 'is' && token !== 'as') return false;
  const nextChar = nextSqlSignificantChar(text, tokenEnd);
  if (!nextChar) return false;
  if (token === 'as' && (nextChar === '$' || nextChar === "'" || nextChar === '"')) {
    return false;
  }
  return isCreateRoutineHeaderPrefix(text.slice(statementStart, tokenEnd - token.length));
};

const isPlsqlControlEnd = (text: string, tokenEnd: number): boolean => (
  ['if', 'loop', 'case'].includes(nextSqlSignificantToken(text, tokenEnd))
);

const trimStatementRange = (sql: string, start: number, end: number, dbType = ''): SqlStatementRange | null => {
  let nextStart = Math.max(0, start);
  let nextEnd = Math.min(sql.length, Math.max(start, end));

  while (nextStart < nextEnd && isWhitespace(sql[nextStart])) {
    nextStart++;
  }
  while (nextEnd > nextStart && isWhitespace(sql[nextEnd - 1])) {
    nextEnd--;
  }

  if (nextStart >= nextEnd) {
    return null;
  }

  if (!hasExecutableSqlStatementContent(sql.slice(nextStart, nextEnd), dbType)) {
    return null;
  }

  return {
    start: nextStart,
    end: nextEnd,
    text: sql.slice(nextStart, nextEnd),
  };
};

export const findSqlStatementRanges = (sql: string, dbType = ''): SqlStatementRange[] => {
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const ranges: SqlStatementRange[] = [];
  const bracketIdentifiers = supportsSqlBracketIdentifier(dbType);
  const escapedBracketIdentifiers = supportsSqlEscapedBracketIdentifier(dbType);

  let statementStart = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBracket = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  let plsqlDepth = 0;
  let plsqlDeclareBeginSkips = 0;
  let plsqlCaseDepth = 0;
  let skipNextPlsqlCaseEndToken = false;
  let justClosedPLSQLBlock = false;

  const push = (end: number) => {
    const range = trimStatementRange(text, statementStart, end, dbType);
    if (range) {
      ranges.push(range);
    }
  };

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    const next = index + 1 < text.length ? text[index + 1] : '';
    const next2 = index + 2 < text.length ? text[index + 2] : '';

    if (dollarTag) {
      if (text.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        index++;
        inBlockComment = false;
      }
      continue;
    }

    if (inDouble) {
      // SQL delimited identifiers escape a double quote by doubling it.
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"' && next === '"') {
        index++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inBacktick) {
      // MySQL-style identifiers escape a backtick by doubling it.
      if (ch === '`' && next === '`') {
        index++;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (bracketIdentifiers && inBracket) {
      // SQL Server identifiers escape a closing bracket as `]]`.
      if (escapedBracketIdentifiers && ch === ']' && next === ']') {
        index++;
        continue;
      }
      if (ch === ']') inBracket = false;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && !inBracket) {
      if (ch === '/' && next === '*') {
        index++;
        inBlockComment = true;
        continue;
      }
      if ((justClosedPLSQLBlock || !text.slice(statementStart, index).trim()) && ch === '/') {
        const slashLineEnd = resolveStandaloneSqlSlashLineEnd(text, index);
        if (slashLineEnd !== null) {
          push(index);
          statementStart = slashLineEnd < text.length && text[slashLineEnd] === '\n'
            ? slashLineEnd + 1
            : slashLineEnd;
          index = slashLineEnd;
          justClosedPLSQLBlock = false;
          continue;
        }
      }
      if (ch === '#' && supportsSqlHashLineComment(dbType)) {
        inLineComment = true;
        continue;
      }
      if (ch === '-' && next === '-' && isSqlDashLineCommentStart(dbType, next2)) {
        index++;
        inLineComment = true;
        continue;
      }
      if (ch === '$') {
        const match = text.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
        if (match?.[0]) {
          dollarTag = match[0];
          index += dollarTag.length - 1;
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
    if (bracketIdentifiers && !inSingle && !inDouble && !inBacktick && ch === '[') {
      inBracket = true;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && !dollarTag && isSqlIdentifierStart(ch)) {
      let tokenEnd = index + 1;
      while (tokenEnd < text.length && isSqlIdentifierPart(text[tokenEnd])) {
        tokenEnd++;
      }
      const token = text.slice(index, tokenEnd).toLowerCase();
      if (token === 'case' && plsqlDepth > 0) {
        if (skipNextPlsqlCaseEndToken) {
          skipNextPlsqlCaseEndToken = false;
        } else {
          plsqlCaseDepth++;
          justClosedPLSQLBlock = false;
        }
      } else if (token !== 'case') {
        skipNextPlsqlCaseEndToken = false;
      }
      if (token === 'begin' && plsqlDeclareBeginSkips > 0) {
        plsqlDeclareBeginSkips--;
        justClosedPLSQLBlock = false;
      } else if (token === 'begin' && shouldEnterPlsqlBeginBlock(text, tokenEnd)) {
        plsqlDepth++;
        justClosedPLSQLBlock = false;
      } else if (token === 'declare' && shouldEnterPlsqlDeclareBlock(text, tokenEnd)) {
        plsqlDepth++;
        plsqlDeclareBeginSkips++;
        justClosedPLSQLBlock = false;
      } else if (plsqlDepth === 0 && shouldEnterPlsqlCreateRoutineBlock(text, statementStart, token, tokenEnd)) {
        plsqlDepth++;
        if (!isCreatePackageHeaderPrefix(text.slice(statementStart, tokenEnd - token.length))) {
          plsqlDeclareBeginSkips++;
        }
        justClosedPLSQLBlock = false;
      } else if (token === 'end' && plsqlDepth > 0 && plsqlCaseDepth > 0) {
        plsqlCaseDepth--;
        if (nextSqlSignificantToken(text, tokenEnd) === 'case') {
          skipNextPlsqlCaseEndToken = true;
        }
        justClosedPLSQLBlock = false;
      } else if (token === 'end' && plsqlDepth > 0 && !isPlsqlControlEnd(text, tokenEnd)) {
        plsqlDepth--;
        if (plsqlDeclareBeginSkips > plsqlDepth) {
          plsqlDeclareBeginSkips = plsqlDepth;
        }
        if (plsqlCaseDepth > plsqlDepth) {
          plsqlCaseDepth = plsqlDepth;
        }
        justClosedPLSQLBlock = plsqlDepth === 0;
      }
      index = tokenEnd - 1;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && (ch === ';' || ch === '；')) {
      if (plsqlDepth > 0) {
        continue;
      }
      push(justClosedPLSQLBlock ? index + 1 : index);
      statementStart = index + 1;
      justClosedPLSQLBlock = false;
      continue;
    }
  }

  push(text.length);
  return ranges;
};

export const resolveCurrentSqlStatementRange = (sql: string, cursorOffset: number, dbType = ''): SqlStatementRange | null => {
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const offset = Math.max(0, Math.min(text.length, Number.isFinite(cursorOffset) ? cursorOffset : 0));
  const ranges = findSqlStatementRanges(text, dbType);
  if (ranges.length === 0) {
    return null;
  }

  const containingRange = ranges.find((range) => offset >= range.start && offset <= range.end);
  if (containingRange) {
    return containingRange;
  }

  const slashLine = resolveStandaloneSqlSlashLineAtOffset(text, offset);
  if (slashLine) {
    return findPreviousSqlStatementRange(ranges, slashLine.lineStart);
  }

  const nextRange = ranges.find((range) => offset < range.start);
  if (nextRange) {
    return nextRange;
  }

  return ranges[ranges.length - 1];
};

export const resolveExecutableSql = (
  sql: string,
  cursorOffset: number,
  selectedSql = '',
  dbType = '',
): SqlExecutionSelection | null => {
  const selected = String(selectedSql || '').trim();
  if (selected) {
    return { sql: selectedSql, source: 'selection' };
  }

  const text = String(sql || '').replace(/\r\n/g, '\n');
  const offset = Math.max(0, Math.min(text.length, Number.isFinite(cursorOffset) ? cursorOffset : 0));
  const ranges = findSqlStatementRanges(text, dbType);
  if (ranges.length === 0) {
    return null;
  }
  const statement = ranges.find((range) => offset >= range.start && offset <= range.end);
  if (statement?.text.trim()) {
    return { sql: stripLeadingSqlTrivia(statement.text, dbType), source: 'statement' };
  }

  const slashLine = resolveStandaloneSqlSlashLineAtOffset(text, offset);
  if (slashLine) {
    const previousStatement = findPreviousSqlStatementRange(ranges, slashLine.lineStart);
    return previousStatement?.text.trim()
      ? { sql: stripLeadingSqlTrivia(previousStatement.text, dbType), source: 'statement' }
      : null;
  }

  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf('\n', offset);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  const line = text.slice(lineStart, lineEnd).trim();
  if (line) {
    const lineStatement = [...ranges].reverse().find((range) => range.start < lineEnd && range.end >= lineStart);
    if (lineStatement?.text.trim()) {
      return { sql: stripLeadingSqlTrivia(lineStatement.text, dbType), source: 'statement' };
    }
  }
  if (line) {
    return { sql: line, source: 'line' };
  }

  return { sql: String(sql || ''), source: 'all' };
};
