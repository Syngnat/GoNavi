import { isOracleLikeDialect, resolveSqlDialect } from './sqlDialect';
import {
  isSqlStatementStartBoundary,
  NEEDS_BODY_HEADS,
  QUERY_BODY_TOKENS,
  QUERY_SOURCE_HEADS,
  BLOCKING_HEADS,
  STANDALONE_STATEMENT_HEADS,
  STATEMENT_TERMINAL_TOKENS,
} from './sqlStatementBoundary';

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

const DELETE_RETURNING_OK = new Set(['delete', 'update', 'merge']);

const isWhitespace = (ch: string): boolean => (
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
);

const isHorizontalWhitespace = (ch: string): boolean => (
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f'
);

const isDelimiterFollowupOffset = (text: string, offset: number): boolean => {
  if (offset <= 0 || (text[offset - 1] !== ';' && text[offset - 1] !== '；')) {
    return false;
  }
  if (offset >= text.length || isWhitespace(text[offset])) {
    return true;
  }
  return (text[offset] === '-' && text[offset + 1] === '-')
    || (text[offset] === '/' && text[offset + 1] === '*');
};

const findStatementBeforeDelimiter = (
  text: string,
  ranges: SqlStatementRange[],
  delimiterIndex: number,
): SqlStatementRange | null => [...ranges]
  .reverse()
  .find((range) => (
    range.start <= delimiterIndex
    && range.end <= delimiterIndex
    && text.slice(range.end, delimiterIndex).trim() === ''
  )) || null;

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

export const supportsSqlHashLineComment = (dbType: string): boolean => {
  const normalized = normalizeSqlLexicalDbType(dbType);
  return !normalized || normalized === 'clickhouse' || MYSQL_DASH_COMMENT_DIALECTS.has(normalized);
};

export const isSqlDashLineCommentStart = (dbType: string, next2: string): boolean => {
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

const isAtSqlLineStart = (text: string, index: number): boolean => {
  for (let pos = index - 1; pos >= 0; pos--) {
    if (text[pos] === '\n') return true;
    if (!isHorizontalWhitespace(text[pos])) return false;
  }
  return true;
};

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
  let parenDepth = 0;
  let lastSignificantToken = '';
  let lastSignificantChar = '';
  let lastSignificantEnd = 0;
  // True when the current pending statement's body is considered closed
  // (e.g. `INSERT INTO t VALUES (...)` finished, `SELECT ... ORDER BY id DESC`
  // completed).  After this point a line-leading start keyword opens a brand
  // new statement — never absorbed.
  let pendingBodyComplete = true;
  // Track the head keyword of the pending statement so the boundary check
  // doesn't have to re-peek `nextSqlSignificantToken` for every candidate.
  let pendingHeadToken = '';
  // Set to `values`/`set`/`on`/`returning` when the body paren that was just
  // closed was opened by that keyword.  Used in isSqlStatementStartBoundary to
  // distinguish `INSERT VALUES (1)\nSELECT` (body paren closed → INSERT is done,
  // SELECT is fresh) from `INSERT INTO t (a)\nSELECT` (column list → SELECT
  // continues INSERT).
  let bodyClosedBy = '';
  // True once the SELECT/WITH head has consumed at least one select-list item
  // (so the bare `SELECT 1\n` shape is recognised as complete on newline).
  let selectListItemSeen = false;
  // Set to true when a UNION/INTERSECT/EXCEPT operator has just been seen.
  // While true, a line-leading SELECT on the next line is the next part of
  // the set chain (not a fresh statement).
  let pendingSetOp = false;
  // Track which keyword each open paren level was opened by. Used to decide
  // whether a closing `)` ends the VALUES body (which closes the statement)
  // or just the column list (which keeps the statement open for SELECT).
  // Each entry is the keyword that triggered the `(`, or '' when none.
  const parenOpeners: string[] = [];
  // When the parser sees `VALUES`/`SET`/`ON` followed by `(`, remember which
  // body keyword we're opening so the matching `)` can mark pendingBodyComplete.
  let bodyOpenerPending = '';
  // True once a SET assignment clause has been seen for the pending DML head.
  // Used to mark the body complete when the assignment ends on a new line
  // (e.g. `UPDATE t SET a = 1\nUPDATE t2 SET b = 2`).
  let setClauseSeen = false;

  const push = (end: number) => {
    const range = trimStatementRange(text, statementStart, end, dbType);
    if (range) {
      ranges.push(range);
    }
  };

  const markSignificant = (ch: string, end: number, token = '') => {
    lastSignificantToken = token;
    lastSignificantChar = ch;
    lastSignificantEnd = end;
  };

  // Initialise pendingBodyComplete from the head of the script.  If the first
  // statement starts with a NEEDS_BODY_HEADS keyword (SELECT/INSERT/...) the
  // body is open until the VALUES list / WHERE clause / etc. closes.  If the
  // first statement is standalone (SAVEPOINT/SET .../CALL/...) the body is
  // already considered complete.
  pendingHeadToken = nextSqlSignificantToken(text, 0);
  pendingBodyComplete = !NEEDS_BODY_HEADS.has(pendingHeadToken);
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    const next = index + 1 < text.length ? text[index + 1] : '';
    const next2 = index + 2 < text.length ? text[index + 2] : '';

    if (dollarTag) {
      if (text.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
        markSignificant('$', index + 1);
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
      if (ch === '"') {
        inDouble = false;
        markSignificant(ch, index + 1);
      }
      continue;
    }

    if (inBacktick) {
      // MySQL-style identifiers escape a backtick by doubling it.
      if (ch === '`' && next === '`') {
        index++;
        continue;
      }
      if (ch === '`') {
        inBacktick = false;
        markSignificant(ch, index + 1);
      }
      continue;
    }

    if (bracketIdentifiers && inBracket) {
      // SQL Server identifiers escape a closing bracket as `]]`.
      if (escapedBracketIdentifiers && ch === ']' && next === ']') {
        index++;
        continue;
      }
      if (ch === ']') {
        inBracket = false;
        markSignificant(ch, index + 1);
      }
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && !inBracket) {
      if (ch === '/' && next === '*') {
        index++;
        inBlockComment = true;
        continue;
      }
      // Oracle PL/SQL uses `/` on its own line to terminate BEGIN...END blocks.
      // Trigger for Oracle when we are inside a PL/SQL block or when the text
      // up to the slash contains BEGIN (indicating a block).
      if (ch === '/' && isOracleLikeDialect(resolveSqlDialect(dbType))) {
        const slashLineEnd = resolveStandaloneSqlSlashLineEnd(text, index);
        if (slashLineEnd !== null) {
          // Only treat as a terminator if we're inside a PL/SQL block OR the
          // statement started with BEGIN (indicating a block).
          if (plsqlDepth > 0 || text.slice(statementStart, index).includes('BEGIN')) {
            push(index);
            statementStart = slashLineEnd < text.length && text[slashLineEnd] === '\n'
              ? slashLineEnd + 1
              : slashLineEnd;
            parenDepth = 0;
            index = slashLineEnd;
            justClosedPLSQLBlock = false;
            continue;
          }
        }
      }
      if ((justClosedPLSQLBlock || !text.slice(statementStart, index).trim()) && ch === '/') {
        const slashLineEnd = resolveStandaloneSqlSlashLineEnd(text, index);
        if (slashLineEnd !== null) {
          push(index);
          statementStart = slashLineEnd < text.length && text[slashLineEnd] === '\n'
            ? slashLineEnd + 1
            : slashLineEnd;
          // The slash itself terminates a statement; any parenthesis opened
          // inside the previous block cannot still be open.
          parenDepth = 0;
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
      markSignificant(ch, index + 1);
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      markSignificant(ch, index + 1);
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      markSignificant(ch, index + 1);
      continue;
    }
    if (bracketIdentifiers && !inSingle && !inDouble && !inBacktick && ch === '[') {
      inBracket = true;
      markSignificant(ch, index + 1);
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && !dollarTag && isSqlIdentifierStart(ch)) {
      let tokenEnd = index + 1;
      while (tokenEnd < text.length && isSqlIdentifierPart(text[tokenEnd])) {
        tokenEnd++;
      }
      const token = text.slice(index, tokenEnd).toLowerCase();
      // Scripts that omit `;` still break into statements at a dialect keyword
      // that can only open a new statement.
      // Oracle hierarchical queries: `SELECT ... START WITH ... CONNECT BY ...`
      // is one statement. When we are in Oracle and the current token is
      // `start` after a SELECT head, peek ahead to see if `CONNECT BY` follows
      // in the remaining script (before any other statement-start keyword),
      // and `start` is followed by `with`. If so, skip the boundary check
      // entirely.
      const lookAheadForConnectBy = (): boolean => {
        if (!isOracleLikeDialect(resolveSqlDialect(dbType))) return false;
        if (token !== 'start') return false;
        if (nextSqlSignificantToken(text, statementStart) !== 'select') return false;
        if (nextSqlSignificantToken(text, tokenEnd) !== 'with') return false;
        // Search the remainder for `connect by` separated by whitespace.
        const rest = text.slice(tokenEnd);
        return /\bconnect\s+by\b/i.test(rest);
      };
      const oracleConnectByAhead = lookAheadForConnectBy();
      const boundaryCheck = !oracleConnectByAhead
        && plsqlDepth === 0 && lastSignificantEnd > statementStart && isSqlStatementStartBoundary({
        token,
        dbType,
        atLineStart: isAtSqlLineStart(text, index),
        parenDepth,
        previousToken: lastSignificantToken,
        previousChar: lastSignificantChar,
        pendingHeadToken,
        pendingBodyComplete,
        bodyClosedBy,
        pendingSetOp,
      });
      if (boundaryCheck) {
        push(lastSignificantEnd);
        statementStart = lastSignificantEnd;
        parenDepth = 0;
        parenOpeners.length = 0;
        pendingHeadToken = token;
        pendingBodyComplete = !NEEDS_BODY_HEADS.has(token);
        bodyOpenerPending = '';
        bodyClosedBy = '';
        selectListItemSeen = false;
        setClauseSeen = false;
        pendingSetOp = false;
        justClosedPLSQLBlock = false;
      } else if (lastSignificantEnd <= statementStart) {
        // Still accumulating the same statement — keep the body state as-is.
      } else if (token === 'union' || token === 'intersect' || token === 'except' || token === 'minus') {
        // Set operators: a following SELECT on the next line is the next part
        // of the chain, not a fresh statement.
        pendingSetOp = true;
        selectListItemSeen = true;
      } else if (pendingHeadToken === 'select' || pendingHeadToken === 'with') {
        // Track that the SELECT/WITH select-list has at least one item.
        selectListItemSeen = true;
        // Set-operator trailers (ALL/DISTINCT) continue the UNION chain — do
        // not reset pendingSetOp.  Anything else resets it.
        if (token !== 'all' && token !== 'distinct') {
          pendingSetOp = false;
        }
      }
      // Track when the pending statement's body completes. For most DML heads the body
      // is closed by a value-list paren after `VALUES`/`SET`/`ON CONFLICT (...)`.
      // We use the per-depth opener stack recorded at the `(` to decide whether
      // the closing `)` was a body-paren close (complete) or a column-list close
      // (still waiting for the body).  DELETE/INSERT/UPDATE RETURNING clauses without
      // parens are handled separately by BLOCKING_HEADS (pendingBodyComplete stays false
      // so the subsequent SELECT can be absorbed by the preceding head).
      if (token === 'set' || token === 'on' || token === 'values') {
        // SET/VALUES opens a body clause only when followed by `(`.  Without
        // `(`, the keyword is just a normal assignment clause; do NOT mark
        // bodyOpenerPending so the statement can still terminate at the next
        // newline.
        // Peek past whitespace/comments for the next significant char.
        const nextCharIdx = skipSqlWhitespaceAndComments(text, tokenEnd);
        const nextChar = nextCharIdx < text.length ? text[nextCharIdx] : '';
        if (nextChar === '(') {
          bodyOpenerPending = token;
        } else if (token === 'set' && (pendingHeadToken === 'update' || pendingHeadToken === 'insert'
          || pendingHeadToken === 'delete' || pendingHeadToken === 'merge')) {
          // Plain `UPDATE t SET a = 1`: the body is an open assignment list
          // until the line ends.  Flag it so the newline handler can mark
          // the body complete.
          setClauseSeen = true;
        }
      }
      // For SELECT/WITH statements, when we see a FROM/WHERE/UNION/etc. keyword,
      // the select-list body is complete.  A following SELECT on the next line
      // should start a new statement — EXCEPT for UNION/INTERSECT/EXCEPT, which
      // are set operators (the next SELECT continues the chain) and must NOT
      // mark the body complete.
      // For SELECT/WITH statements, when we see a FROM/WHERE/ORDER/etc. keyword,
      // the select-list body is complete.  A following SELECT on the next line
      // should start a new statement — EXCEPT for UNION/INTERSECT/EXCEPT, which
      // are set operators (the next SELECT continues the chain) and must NOT
      // mark the body complete.
      if (token === 'from' || token === 'where' || token === 'group' || token === 'having'
        || token === 'order' || token === 'limit' || token === 'offset'
        || token === 'into' || token === 'returning') {
        // Only mark the body complete when we're NOT inside a CTE/subquery
        // paren.  PG data-modifying CTEs (`WITH del AS (DELETE ...)`) and
        // regular subqueries (`SELECT * WHERE id IN (SELECT ...)`) contain
        // their own FROM/RETURNING; they must NOT consume the outer head.
        if (parenDepth > 0) {
          // Skip — we're inside a CTE/subquery.
        } else {
          const head = nextSqlSignificantToken(text, statementStart);
          if (head === 'select' || head === 'with') {
            pendingBodyComplete = true;
          }
        }
      }
      markSignificant(text[tokenEnd - 1], tokenEnd, token);
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
      parenDepth = 0;
      parenOpeners.length = 0;
      bodyOpenerPending = '';
      bodyClosedBy = '';
      pendingBodyComplete = true;
      justClosedPLSQLBlock = false;
      continue;
    }

      if (!inSingle && !inDouble && !inBacktick && !inBracket) {
      if (ch === '(') {
        parenDepth++;
        // Remember whether this paren was opened by a body keyword
        // (`VALUES`/`SET`/`ON`/`RETURNING`) so the matching `)` knows it ends the body.
        // Keywords that open column-lists or other non-body parens do NOT end the body:
        // `INSERT INTO t (a)` — the column-list paren is closed but the VALUES body
        // is still pending; keep pendingBodyComplete=false so a following SELECT
        // can still be absorbed.
        parenOpeners.push(bodyOpenerPending);
        bodyOpenerPending = '';
        // CREATE TABLE/ALTER TABLE: the column-list paren closes the body.  Track
        // the opener so `CREATE TABLE t (id INT, name VARCHAR(10))\nINSERT ...`
        // splits the DDL from the following DML.
        if (lastSignificantToken === 'create' || lastSignificantToken === 'alter') {
          bodyClosedBy = lastSignificantToken;
          pendingBodyComplete = true;
        }
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        const opener = parenOpeners.pop() || '';
        // A paren opened by VALUES/SET/RETURNING ends the body clause.  A paren
        // opened by ON (PG `ON CONFLICT (cols)`) does NOT end the body — the
        // DO UPDATE/SET clause follows and must be absorbed into the same
        // statement.  Column-list parens opened by other keywords (`INSERT INTO
        // t (cols)`, `WITH c AS (subquery)`) also do not end the body because
        // the parent head is still waiting for its body.
        if (opener === 'values' || opener === 'set' || opener === 'returning') {
          pendingBodyComplete = true;
          bodyClosedBy = opener;
        }
        // Preserve the prior token (e.g. `nolock` inside `WITH (NOLOCK)`,
        // `VARCHAR` after `name`) so the boundary check can detect SQL
        // Server table hints and recognise the column-list close.
        markSignificant(ch, index + 1, lastSignificantToken);
      } else if (ch === '\n') {
        // `isHorizontalWhitespace` excludes `\n` so the dedicated newline
        // branch handles line breaks explicitly.  Keep the last significant
        // token so the boundary check still recognises the line as ending
        // the previous statement (e.g. `CREATE TABLE t (...)\nINSERT ...`
        // → previousToken is `10`).  Keep the previous lastSignificantChar
        // (e.g. `)`) so the boundary check's STATEMENT_END_CHAR test matches.
        // Without this, `CREATE TABLE t (...)\nINSERT ...` would not split.
        const prevChar = lastSignificantChar;
        markSignificant(ch, index + 1, lastSignificantToken);
        lastSignificantChar = prevChar;
        // Newline crossing after a balanced-paren, no-in-progress-body state:
        // - If the pending head needs a body clause (INSERT/UPDATE/DELETE/
        //   SELECT/WITH/CREATE/ALTER...), peek at the next significant token.
        //   A line-leading query body (SELECT/WITH/VALUES/TABLE) starts a
        //   fresh statement; a clause keyword (FROM/WHERE/...) keeps the
        //   statement open so the body is absorbed.
        // - If the head is standalone (SAVEPOINT/CALL/...), mark it complete.
        if (parenDepth === 0 && !bodyOpenerPending) {
          const head = nextSqlSignificantToken(text, statementStart);
          if (!NEEDS_BODY_HEADS.has(head)) {
            pendingBodyComplete = true;
          } else if (head === 'select' || head === 'with') {
            // SELECT/WITH heads: the bare select-list (`SELECT 1\nPRAGMA`,
            // `SELECT 1\nSELECT 2`) is a complete statement once at least one
            // item has been seen.  When the body is already complete (the
            // from/where/order rules have fired) we leave it alone; when no
            // clause has appeared yet, the select-list itself is the body and
            // a line-leading query-body token starts a fresh statement.
            // EXCEPTION: if the next token is a query-source head that the
            // current head absorbs (e.g. `WITH ...\nINSERT ...`), the body
            // is NOT complete — the next head is part of the same statement.
            if (pendingBodyComplete) {
              // already complete
            } else if (pendingSetOp) {
              // UNION/INTERSECT/EXCEPT chain: don't complete the body.
            } else if (selectListItemSeen) {
              const nextToken = nextSqlSignificantToken(text, index + 1);
              if (QUERY_SOURCE_HEADS.has(nextToken) && BLOCKING_HEADS[nextToken]?.has(head)) {
                // Next token is a query-source head that the current head
                // absorbs (e.g. WITH→INSERT, SELECT→WITH): don't mark
                // complete — the next head is part of the same statement.
              } else {
                // Next token is not a query-source head (e.g. PRAGMA, EXPLAIN
                // unrelated, standalone SAVEPOINT), OR it is a query-source
                // head that the current head does NOT absorb (e.g. SELECT→SELECT):
                // the body IS complete.
                pendingBodyComplete = true;
              }
            }
          } else if (head === 'explain') {
            // EXPLAIN absorbs a following SELECT/WITH/VALUES/TABLE as its
            // own body (`EXPLAIN\nSELECT 1` is one statement).  Don't mark
            // the body complete just because a query-body token follows.
            // The EXPLAIN body is "complete" only when its select-list has
            // a clause (FROM/WHERE/...) or the parens balance.
          } else {
            // The pending head is a DML head (INSERT/UPDATE/DELETE/MERGE).
            // Look at the token that will follow this newline: a
            // SELECT/WITH/VALUES/TABLE on the next line opens a brand-new
            // statement, so mark the previous statement's body as complete.
            // Likewise, a SET assignment (without parens) that has ended on
            // this line (`UPDATE t SET a = 1\n...`) marks the body complete.
            if (setClauseSeen) {
              pendingBodyComplete = true;
            } else {
              const nextToken = nextSqlSignificantToken(text, index + 1);
              if (QUERY_BODY_TOKENS.has(nextToken)) {
                pendingBodyComplete = true;
              }
            }
          }
        }
      } else if (isHorizontalWhitespace(ch)) {
        // Preserve the last significant character AND token so the boundary
        // check can detect the SQL Server table hint / prior keyword.
        markSignificant(ch, index + 1, lastSignificantToken);
      } else if (!isWhitespace(ch)) {
        // A non-whitespace, non-identifier, non-paren char (digit, operator,
        // string-content boundary, ...) still counts as a select-list item
        // for the SELECT/WITH head.  Numbers and operators alone (`SELECT 1`,
        // `SELECT -1`) are complete statements after a newline.
        if (pendingHeadToken === 'select' || pendingHeadToken === 'with') {
          selectListItemSeen = true;
        }
        // Preserve the last significant token (e.g. `nolock` in
        // `WITH (NOLOCK)`) so the boundary check can detect the SQL Server
        // table hint / prior keyword.
        markSignificant(ch, index + 1, lastSignificantToken);
      }
    }
  }

  push(text.length);
  return ranges;
};

/**
 * Returns the executable statement currently being edited at the end of sql.
 * Unlike cursor navigation, a completed statement followed by only trivia has
 * no active statement and must not inherit the previous statement's context.
 */
export const resolveSqlStatementPrefix = (sql: string, dbType = ''): string => {
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const ranges = findSqlStatementRanges(text, dbType);
  const currentRange = ranges[ranges.length - 1];
  const trimmedEnd = text.trimEnd().length;
  return currentRange && currentRange.end === trimmedEnd ? text.slice(currentRange.start) : '';
};

export const resolveCurrentSqlStatementRange = (sql: string, cursorOffset: number, dbType = ''): SqlStatementRange | null => {
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const offset = Math.max(0, Math.min(text.length, Number.isFinite(cursorOffset) ? cursorOffset : 0));
  const ranges = findSqlStatementRanges(text, dbType);
  if (ranges.length === 0) {
    return null;
  }

  // Monaco may report a caret clicked on a trailing semicolon as the offset
  // immediately after it (for example, on the following newline). Keep that
  // caret attached to the statement whose delimiter was clicked.
  if (isDelimiterFollowupOffset(text, offset)) {
    const delimiterStatement = findStatementBeforeDelimiter(text, ranges, offset - 1);
    if (delimiterStatement) {
      return delimiterStatement;
    }
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

  if (isDelimiterFollowupOffset(text, offset)) {
    const delimiterStatement = findStatementBeforeDelimiter(text, ranges, offset - 1);
    if (delimiterStatement?.text.trim()) {
      return { sql: stripLeadingSqlTrivia(delimiterStatement.text, dbType), source: 'statement' };
    }
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
    const lineStatements = ranges.filter((range) => range.start < lineEnd && range.end >= lineStart);
    // A caret immediately after a semicolon is still attached to the statement
    // on its left. Prefer the nearest completed statement on this line so a
    // toolbar click cannot move execution to the next statement.
    const lineStatement = [...lineStatements]
      .reverse()
      .find((range) => range.end < offset)
      || lineStatements[0];
    if (lineStatement?.text.trim()) {
      return { sql: stripLeadingSqlTrivia(lineStatement.text, dbType), source: 'statement' };
    }
  }
  if (line) {
    return { sql: line, source: 'line' };
  }

  return { sql: String(sql || ''), source: 'all' };
};
