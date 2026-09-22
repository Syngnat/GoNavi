import {
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
  resolveSqlDialect,
} from './sqlDialect';

/**
 * Statement boundary detection for scripts that omit the `;` delimiter.
 *
 * `findSqlStatementRanges` owns delimiter based splitting; this module only
 * answers whether a dialect keyword sitting at the start of a line opens a new
 * statement. A wrong split produces broken SQL, so every rule below prefers
 * leaving statements merged when the context is ambiguous.
 */

const words = (value: string): string[] => value.trim().split(/\s+/).filter(Boolean);

const COMMON_START_KEYWORDS = words(`
  select with values table
  insert update delete merge truncate
  create alter drop rename
  grant revoke
  call explain analyze
  set commit rollback savepoint
  show describe desc use unlock
`);

const MYSQL_START_KEYWORDS = words(`
  replace load flush kill optimize repair check reset handler
  prepare execute deallocate
`);

const PG_START_KEYWORDS = words(`
  comment copy vacuum reindex refresh cluster
  do listen notify unlisten discard reset abort close
  prepare execute deallocate
  start
`);

const ORACLE_START_KEYWORDS = words(`
  comment purge flashback exec audit noaudit
  start
`);

const SQLSERVER_START_KEYWORDS = words(`
  exec execute print waitfor backup restore throw
`);

const SQLITE_START_KEYWORDS = words(`
  pragma attach detach vacuum reindex replace
`);

const DUCKDB_START_KEYWORDS = words(`
  pragma attach detach install load copy export import checkpoint summarize reset
`);

const CLICKHOUSE_START_KEYWORDS = words(`
  system optimize attach detach kill exchange watch
`);

/**
 * Heads that make a following query body part of the current statement, such as
 * `INSERT INTO t (a)\nSELECT ...`, `WITH cte AS (...)\nSELECT ...`,
 * `DELETE ... RETURNING ...\nINSERT ...`, `MERGE ...\nSELECT ...`.
 * These are the heads that absorb a following SELECT/WITH/VALUES/TABLE keyword.
 */
export const QUERY_SOURCE_HEADS = new Set(words(`
  insert replace merge upsert create with explain declare prepare
  select delete update
  copy refresh do cache export import summarize describe analyze grant call
`));

/** Same as QUERY_SOURCE_HEADS but excludes self — used for heads that should
 *  still split when followed by an identical head (`UPDATE t\nUPDATE t2`). */
const QUERY_SOURCE_HEADS_EXCLUDING_SELF = (head: string): ReadonlySet<string> => {
  const result = new Set<string>(QUERY_SOURCE_HEADS);
  result.delete(head);
  return result;
};

/** Tokens that end a completed statement and allow any start keyword to open a new one. */
export const STATEMENT_TERMINAL_TOKENS = new Set(words('commit rollback'));

/** Standalone heads whose body is intrinsically complete once the head token is
 *  seen (USE/SHOW/CALL/etc. don't require a body clause). They start a fresh
 *  statement and immediately leave the body-complete flag set. */
export const STANDALONE_STATEMENT_HEADS = new Set(words(`
  commit rollback savepoint release
  set reset
  show describe desc explain use lock unlock
  grant revoke
  call
`));

/** Tokens that act as a query body.  When the previous pending statement's body
 *  is complete (e.g. `INSERT INTO t VALUES (1)`), seeing one of these at the
 *  start of the next line must open a new statement instead of being absorbed
 *  by the previous head. */
export const QUERY_BODY_TOKENS = new Set(words('select with values table'));

/** DML heads that should keep a following ALTER/DROP/DDL attached — these
 *  DDL commands share a transaction scope and should not be split when the
 *  prior UPDATE/DELETE body is complete. */
const DDL_BLOCKED_HEADS = new Set(words('update delete'));

/** Keywords that signal the end of a SELECT statement body, making a following
 * line-leading SELECT a brand new statement. */
const SELECT_COMPLETE_KEYWORDS = new Set(words('from where group having order limit union intersect except all distinct'));

/** Heads whose body clause is required: DML/SELECT/WITH/CTE need SELECT/VALUES
 *  clauses to be complete; until they appear the body is "open".  EXPLAIN/SHOW/
 *  USE/CALL/GRANT/CREATE/ALTER/RENAME/TRUNCATE are excluded — they're complete
 *  once their clause tokens appear (or once their column list paren closes
 *  for CREATE TABLE/ALTER TABLE/etc., handled separately by paren tracking). */
export const NEEDS_BODY_HEADS = new Set(words(`
  select with values table
  insert update delete merge
  alter create drop rename truncate
  explain
`));

/** Heads where a leading `DESC` is an ordering clause instead of a statement. */
const ORDERING_HEADS = new Set(words(`
  select with values table insert replace update delete merge create explain
`));

/** Heads where a leading `SET` is an assignment clause instead of a statement. */
const ASSIGNMENT_HEADS = new Set(words('update merge insert replace alter create declare grant'));

/** SQL clause trailers that may precede the last keyword of a statement but
 * which do NOT end it.  Seeing one of these before a candidate start keyword
 * means the previous line is not a complete statement yet. */
const CLAUSE_TRAILER_TOKENS = new Set(words(`
  union all any some distinct except intersect minus
  as from into by on using
  then else elsif elseif when case
  and or not in exists like ilike rlike regexp similar between is
  where having group order limit offset fetch
  join inner left right full cross outer natural lateral apply
  for to of over partition window filter within returning
  escape collate interval separator without owner default
  desc asc
  add modify change column constraint primary foreign references unique key
  begin declare loop if at
  nothing update insert delete
  do
  rename
`));

export const BLOCKING_HEADS: Record<string, ReadonlySet<string>> = {
  // SELECT blocks other DML heads (DELETE/UPDATE/INSERT/MERGE/CREATE/...) and
  // SQL Server table hints (WITH). `SELECT ... SELECT` should split, so `select`
  // is excluded from this set.
  select: new Set([
    'with', 'insert', 'replace', 'merge', 'upsert', 'create',
    'declare', 'prepare', 'copy', 'refresh', 'do', 'cache', 'export', 'import',
    'summarize', 'delete', 'update', 'savepoint', 'release',
  ]),
  // DML bodies (`INSERT/REPLACE/MERGE/UPDATE/DELETE` followed by CTE-style
  // `WITH del AS (...)\nINSERT ...` or `DELETE FROM t RETURNING ...\nINSERT ...`)
  // must absorb a following query-source head.
  insert: new Set(['select', 'with', 'values', 'table', 'on']),
  replace: new Set(['select', 'with', 'values', 'table']),
  merge: new Set(['select', 'with', 'values', 'table']),
  upsert: new Set(['select', 'with', 'values', 'table']),
  with: QUERY_SOURCE_HEADS_EXCLUDING_SELF('with'),
  values: QUERY_SOURCE_HEADS,
  table: QUERY_SOURCE_HEADS,
  delete: QUERY_SOURCE_HEADS_EXCLUDING_SELF('delete'),
  update: QUERY_SOURCE_HEADS_EXCLUDING_SELF('update'),
  desc: ORDERING_HEADS,
  set: ASSIGNMENT_HEADS,
  // ON CONFLICT in PG opens a clause of the INSERT statement; DO UPDATE/NOTHING
  // is its body, never a fresh statement.
  on: new Set(['conflict', 'duplicate']),
  // `DO ... UPDATE/NOTHING` is the body of `INSERT ... ON CONFLICT`.
  do: new Set(['update', 'nothing', 'select', 'set', 'insert']),
  // SAVEPOINT / RELEASE SAVEPOINT bodies can be followed by another SELECT.
  // Handled by pendingBodyComplete in isSqlStatementStartBoundary rather than
  // blanket BLOCKING_HEADS entries — when the SAVEPOINT's identifier closes
  // the statement (body complete), a following SELECT splits.
  savepoint: new Set([]),
  release: new Set([]),
  // Oracle hierarchical query: `SELECT e FROM emp\nSTART WITH mgr IS NULL\nCONNECT BY ...`
  // keeps the entire query together — START WITH and CONNECT BY are sub-clauses.
  // We do NOT add 'select' here so a leading `start` after a SELECT can split
  // (the generic boundary rule). Oracle keeps START WITH together by checking
  // that `CONNECT BY` follows within the same statement (handled in
  // isSqlStatementStartBoundary as a special case).
  start: new Set([]),
  connect: new Set(['by', 'select']),
  // MySQL puts a table level COMMENT clause after the column list.
  comment: new Set(words('create alter')),
  // DDL heads mutually absorb each other across newlines: `ALTER TABLE users\n
  // RENAME COLUMN ...`, `CREATE TABLE t (id INT)\nCREATE INDEX ...`, etc.
  // These DDL spans stay merged; use `;` for explicit splits.
  alter: new Set(words('drop rename column add modify change')),
  drop: new Set(words('rename column')),
  rename: new Set(words('column to')),
  create: new Set(words('drop alter rename column index trigger function procedure view')),
};

/** Tokens that can precede SQL Server table hints (WITH (NOLOCK), etc.). */
const SQLSERVER_TABLE_HINT_PRECEDING_TOKENS = new Set(words('lock share update noupdate holdlock noholdlock read committed dirty nolock readpast serializable index'));

const STATEMENT_END_CHAR = /[A-Za-z0-9_$#)'"`\]]/;
/**
 * Per-dialect start-keyword cache. The output depends only on `dbType`, but
 * `findSqlStatementRanges` calls into this helper at every identifier token;
 * caching avoids rebuilding the same set thousands of times for the same input.
 */
const startKeywordCache = new Map<string, ReadonlySet<string>>();

export const resolveSqlStatementStartKeywords = (dbType: string): ReadonlySet<string> => {
  const cached = startKeywordCache.get(dbType);
  if (cached) {
    return cached;
  }
  const dialect = resolveSqlDialect(dbType);
  const extras: string[] = [];
  if (isMysqlFamilyDialect(dialect)) extras.push(...MYSQL_START_KEYWORDS);
  if (isPgLikeDialect(dialect)) extras.push(...PG_START_KEYWORDS);
  if (isOracleLikeDialect(dialect)) extras.push(...ORACLE_START_KEYWORDS);
  if (dialect === 'sqlserver') extras.push(...SQLSERVER_START_KEYWORDS);
  if (dialect === 'sqlite') extras.push(...SQLITE_START_KEYWORDS);
  if (dialect === 'duckdb') extras.push(...DUCKDB_START_KEYWORDS);
  if (dialect === 'clickhouse') extras.push(...CLICKHOUSE_START_KEYWORDS);
  const result = new Set([...COMMON_START_KEYWORDS, ...extras]);
  startKeywordCache.set(dbType, result);
  return result;
};

/** DDL statement heads that consume clause keywords across line breaks. */
const DDL_HEADS = new Set(['alter', 'create', 'drop', 'rename', 'truncate']);

const canPrecedingTextEndStatement = (
  previousToken: string,
  previousChar: string,
  startKeywords: ReadonlySet<string>,
  pendingHeadToken: string,
  pendingBodyComplete: boolean,
): boolean => {
  // A comma, parenthesis, operator, etc. cannot be the last character of a
  // completed statement. Check before the empty-token shortcut so callers
  // that supply only `previousChar` (e.g. tests for individual cases) still
  // observe the right behaviour.
  if (!previousChar || !STATEMENT_END_CHAR.test(previousChar)) {
    // A newline character is only a valid statement-end delimiter when the
    // pending statement head has already finished its body.  When the body is
    // still open (e.g. `INSERT INTO t (a)\nSELECT ...` — column list is closed
    // but VALUES body hasn't started), a following SELECT/WITH/VALUES is the
    // body and must NOT split the statement.  Same for `ALTER TABLE users\n
    // RENAME COLUMN ...` — DDL body spans multiple lines.
    if (previousChar === '\n' && previousToken && pendingBodyComplete) {
      return true;
    }
    return false;
  }
  // Empty previousToken means we're at the start of the script or after a
  // delimiter — any line-leading keyword opens a fresh statement.
  if (!previousToken) {
    return true;
  }
  if (CLAUSE_TRAILER_TOKENS.has(previousToken)) {
    return false;
  }
  if (STATEMENT_TERMINAL_TOKENS.has(previousToken)) {
    return true;
  }
// A closing parenthesis can always end a statement, unless we are
  // inside a DDL with unconsumed tokens (DDL protection below).
  if (previousToken === ')') {
    return true;
  }
  // DDL protection (审查 #2): when pendingHeadToken is ALTER/CREATE/DROP/
  // RENAME/TRUNCATE, the DDL spans multiple lines. We keep non-keyword
  // identifiers (column names like 'users', data values) attached to the
  // DDL until a top-level keyword (SELECT/INSERT/UPDATE) appears. This is
  // conservative — `ALTER TABLE users ADD COLUMN age INT\nALTER TABLE
  // users DROP COLUMN nick` will NOT split because we cannot reliably
  // tell whether `INT` ends the DDL or is a multi-DDL continuation; the
  // safer choice is to keep them merged. Use `;` for explicit splits.
  if (DDL_HEADS.has(pendingHeadToken) && !startKeywords.has(previousToken)) {
    // A closed `)` immediately before means the DDL body (column list,
    // partition list, ...) is complete.  `CREATE TABLE t (cols)\nINSERT ...`
    // must split even though the previous token is `VARCHAR`/`10`.
    if (previousChar === ')') {
      return true;
    }
    return false;
  }
  return !startKeywords.has(previousToken);
};

/**
 * Lock / sharing mode trailers at the end of a SELECT clause. A line-leading
 * SELECT following them is the next part of the same SELECT (UNION chain or
 * another `LOCK ... MODE` target), not a new statement:
 * `SELECT ... LOCK IN SHARE MODE\nSELECT * FROM t2`.
 */const MYSQL_LOCK_TRAILERS = new Set(words('mode share update noupdate'));

/**
 * SQL Server table hint words that can appear inside `WITH (...)`:
 * `NOLOCK`, `HOLDLOCK`, `UPDLOCK`, `READUNCOMMITTED`, etc.
 */
const SQLSERVER_TABLE_HINT_TOKENS = new Set(words(`
  lock share update noupdate
  holdlock noholdlock nolock readuncommitted repeatableread serializable
  dirty rowlock paglock tablock tablockx xlock readpast readcommitted
`));

/**
 * PG trailing tokens that appear at the end of a CTE statement and which can
 * still be followed by a query body: `SAVEPOINT sp\nSELECT 1` is one statement,
 * because a SAVEPOINT in a script may sit on its own line before the actual
 * query body returns.
 */
const PG_ABSORB_TRAILERS = new Set(words('savepoint release before after instead'));

/**
 * Tokens that close an ON CONFLICT clause in PG:
 * `INSERT ... ON CONFLICT (a)\nDO UPDATE SET a = 2` — `DO` opens a clause.
 */
const PG_ON_CONFLICT_DO = 'do';

export interface SqlStatementBoundaryInput {
  /** Lowercased candidate keyword. */
  token: string;
  dbType: string;
  /** Only horizontal whitespace precedes the token on its line. */
  atLineStart: boolean;
  parenDepth: number;
  /** Lowercased word right before the token, empty when it was not a word. */
  previousToken: string;
  /** Last significant character before the token. */
  previousChar: string;
  /** Lowercased first keyword of the statement being accumulated. */
  pendingHeadToken: string;
  /**
   * True when the pending statement head has finished consuming its required
   * body (e.g. `INSERT INTO t VALUES (...)` has closed its VALUES list). When
   * false, the head is still open and a following `SELECT`/`WITH`/`VALUES`/
   * `TABLE` keyword continues the current statement; when true, the same
   * keyword starts a brand new statement.
   */
  pendingBodyComplete: boolean;
  /**
   * When pendingBodyComplete is true, this records what keyword opened the
   * body paren that was just closed: `values`, `set`, `on`, or `returning`.
   * Used to distinguish `INSERT VALUES (1)\nSELECT` (body paren was VALUES →
   * INSERT is complete, SELECT starts fresh) from `INSERT INTO t (a)\nSELECT`
   * (column list paren, not a body paren → SELECT continues INSERT).
   */
  bodyClosedBy?: string;
  /**
   * True when a set operator (UNION/INTERSECT/EXCEPT/MINUS) was just seen
   * before the current candidate token. A following SELECT/WITH/VALUES/TABLE
   * is the next leg of the chain, not a fresh statement.
   */
  pendingSetOp?: boolean;
}

export const isSqlStatementStartBoundary = ({
  token,
  dbType,
  atLineStart,
  parenDepth,
  previousToken,
  previousChar,
  pendingHeadToken,
  pendingBodyComplete,
  bodyClosedBy = '',
  pendingSetOp = false,
}: SqlStatementBoundaryInput): boolean => {
  if (!atLineStart || parenDepth > 0) {
    return false;
  }
  const startKeywords = resolveSqlStatementStartKeywords(dbType);
  if (!startKeywords.has(token)) {
    return false;
  }
  // Set operator chain: `SELECT ... UNION\nSELECT ...` keeps the trailing
  // SELECT as the next leg of the chain.  This must be checked BEFORE the
  // pendingBodyComplete rules so the trailing SELECT does not split.
  if (pendingSetOp && QUERY_BODY_TOKENS.has(token)) {
    return false;
  }
  // ORDER BY ... DESC / ASC completes a SELECT. A line-leading `select` (or
  // any other starter) after `desc`/`asc` is a brand new statement.
  if (token === 'select' && (previousToken === 'desc' || previousToken === 'asc')) {
    return true;
  }
  // Lock / sharing mode trailers: `LOCK IN SHARE MODE` is part of the SELECT
  // and the following SELECT is its continuation — never a fresh statement.
  // `MODE`/`SHARE`/`UPDATE` (no `mode`) must not split when pendingHeadToken
  // is a SELECT-like head.
  if (token === 'select' && pendingHeadToken === 'select' && MYSQL_LOCK_TRAILERS.has(previousToken)) {
    return false;
  }
  // SQL Server table hints: `SELECT ... WITH (NOLOCK)\nSELECT ...` keeps the
  // trailing SELECT attached, because the table hint opens with `(`. Detect
  // by checking that the previousChar is `)` and previousToken is a known
  // table hint token.
  if (token === 'select' && pendingHeadToken === 'select'
    && previousChar === ')' && SQLSERVER_TABLE_HINT_TOKENS.has(previousToken)) {
    return false;
  }
  // MySQL has no `CREATE SEQUENCE` syntax; the `START` keyword on the next
  // line after a DDL head is a transaction statement, not a sequence clause.
  // Force a boundary for `start` in MySQL after DDL heads.
  if (token === 'start' && isMysqlFamilyDialect(dbType) && DDL_HEADS.has(pendingHeadToken)) {
    return true;
  }
  // When the pending body is complete (`INSERT INTO t VALUES (1)` finished,
  // `SELECT ... ORDER BY id DESC` completed), the following line-leading start
  // keyword starts a new statement — with one exception: query-body tokens
  // (SELECT/WITH/VALUES/TABLE) are still absorbed by the BLOCKING_HEADS entry
  // of the preceding head (so `INSERT INTO t (a)\nSELECT` stays merged while
  // `INSERT INTO t VALUES (1)\nSELECT` splits).
  if (pendingBodyComplete) {
    // DDL absorption: UPDATE/DELETE followed by ALTER/DROP shares a transaction.
    if ((token === 'alter' || token === 'drop') && DDL_BLOCKED_HEADS.has(pendingHeadToken)) {
      return false;
    }
    // The following heads explicitly complete a statement once their clause
    // is closed (CALL name(...), SHOW ..., USE ..., DESCRIBE ... DESC ...).
    // Their following SELECT must split.  GRANT/REVOKE/EXPLAIN absorb a
    // following query body token (handled by BLOCKING_HEADS).
    const COMPLETE_ON_CLAUSE_HEADS = new Set([
      'call', 'show', 'use', 'describe', 'desc',
    ]);
    // Query-body tokens: always apply BLOCKING_HEADS so:
    //   - INSERT/WITH/REPLACE/SAVEPOINT heads keep their following SELECT merged
    //   - GRANT/CALL/EXPLAIN heads let their following SELECT split
    // EXCEPT: when the body was closed by a VALUES/SET/ON paren (tracked in
    // bodyClosedBy) the DML head is complete and the following SELECT splits.
    if (QUERY_BODY_TOKENS.has(token)) {
      if (COMPLETE_ON_CLAUSE_HEADS.has(pendingHeadToken)) {
        return true;
      }
      if (bodyClosedBy !== '' && (token === 'select' || token === 'with' || token === 'values' || token === 'table')) {
        // Body was closed by VALUES/SET/ON.  INSERT/UPDATE/DELETE/MERGE are done;
        // a following SELECT/WITH/VALUES starts a brand-new statement.
        if (pendingHeadToken === 'insert' || pendingHeadToken === 'update'
          || pendingHeadToken === 'delete' || pendingHeadToken === 'merge') {
          return true;
        }
      }
      if (Object.prototype.hasOwnProperty.call(BLOCKING_HEADS, token)) {
        return !BLOCKING_HEADS[token]!.has(pendingHeadToken);
      }
      // ASC/DESC after a SELECT-like head are ordering clauses, not new
      // statements.  `ORDER BY id\nDESC` keeps DESC attached to the SELECT.
      // The same applies to other ordering-trailer clauses like LIMIT/OFFSET.
      if ((token === 'desc' || token === 'asc' || token === 'limit' || token === 'offset'
        || token === 'fetch' || token === 'using') && ORDERING_HEADS.has(pendingHeadToken)) {
        return false;
      }
      return true;
    }
    // Non-query-body tokens always start a fresh statement when body is complete.
    // Exception: ASC/DESC after a SELECT-like head are ordering clauses.
    if ((token === 'desc' || token === 'asc') && ORDERING_HEADS.has(pendingHeadToken)) {
      return false;
    }
    // The pending head absorbs certain non-body tokens as continuation of its
    // current statement (PG `INSERT ... ON CONFLICT ... DO UPDATE`, `INSERT ...
    // ON DUPLICATE KEY UPDATE`).  Without this, a line-leading `do` after
    // `INSERT INTO t (a) VALUES (1)` would split the DO clause off.
    if (Object.prototype.hasOwnProperty.call(BLOCKING_HEADS, token)
      && BLOCKING_HEADS[token]!.has(pendingHeadToken)) {
      return false;
    }
    return true;
  }
  if (!canPrecedingTextEndStatement(previousToken, previousChar, startKeywords, pendingHeadToken, pendingBodyComplete)) {
    return false;
  }
  // BLOCKING_HEADS says "when THIS token appears, treat the current pending head
  // as still open".  A token that is NOT in BLOCKING_HEADS always starts a new
  // statement.
  if (!Object.prototype.hasOwnProperty.call(BLOCKING_HEADS, token)) {
    return true;
  }
  // When the token IS a blocking head, check whether the pending statement head
  // is one of the heads that should absorb this token.
  return !BLOCKING_HEADS[token]!.has(pendingHeadToken);
};
