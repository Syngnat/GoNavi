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
  set commit rollback savepoint start
  show describe desc use lock unlock
`);

const MYSQL_START_KEYWORDS = words(`
  replace load flush kill optimize repair check reset handler
  prepare execute deallocate
`);

const PG_START_KEYWORDS = words(`
  comment copy vacuum reindex refresh cluster
  do listen notify unlisten discard reset abort close
  prepare execute deallocate
`);

const ORACLE_START_KEYWORDS = words(`
  comment purge flashback exec audit noaudit
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
 * Tokens that cannot be the last word of a finished statement. Seeing one right
 * before a candidate keyword means the keyword continues the current statement
 * (`... UNION\nSELECT`, `CREATE VIEW v AS\nSELECT`, `SELECT ... FOR\nUPDATE`).
 */
const CONTINUATION_TOKENS = new Set(words(`
  union all any some distinct except intersect minus
  as from into by on using
  then else elsif elseif when case
  and or not in exists like ilike rlike regexp similar between is
  where having group order limit offset fetch
  join inner left right full cross outer natural lateral apply
  for to of over partition window filter within returning
  escape collate interval separator without owner default
  add modify change column constraint primary foreign references unique key
  begin declare loop if at
`));

/** Start keywords that also form a complete statement on their own. */
const TERMINAL_START_KEYWORDS = new Set(words('commit rollback'));

/**
 * Heads that make a following query body part of the current statement, such as
 * `INSERT INTO t (a)\nSELECT ...` or `WITH cte AS (...)\nSELECT ...`.
 */
const QUERY_SOURCE_HEADS = new Set(words(`
  insert replace merge upsert create with explain declare prepare
  copy refresh do cache export import summarize describe analyze grant call
`));

/** Heads where a leading `DESC` is an ordering clause instead of a statement. */
const ORDERING_HEADS = new Set(words(`
  select with values table insert replace update delete merge create explain
`));

/** Heads where a leading `SET` is an assignment clause instead of a statement. */
const ASSIGNMENT_HEADS = new Set(words('update merge insert alter create declare grant'));

const BLOCKING_HEADS: Record<string, ReadonlySet<string>> = {
  select: QUERY_SOURCE_HEADS,
  with: QUERY_SOURCE_HEADS,
  values: QUERY_SOURCE_HEADS,
  table: QUERY_SOURCE_HEADS,
  desc: ORDERING_HEADS,
  set: ASSIGNMENT_HEADS,
  // MySQL puts a table level COMMENT clause after the column list.
  comment: new Set(words('create alter')),
};

const STATEMENT_END_CHAR = /[A-Za-z0-9_$#)'"`\]]/;

export const resolveSqlStatementStartKeywords = (dbType: string): ReadonlySet<string> => {
  const dialect = resolveSqlDialect(dbType);
  const extras: string[] = [];
  if (isMysqlFamilyDialect(dialect) || dialect === 'starrocks') extras.push(...MYSQL_START_KEYWORDS);
  if (isPgLikeDialect(dialect)) extras.push(...PG_START_KEYWORDS);
  if (isOracleLikeDialect(dialect)) extras.push(...ORACLE_START_KEYWORDS);
  if (dialect === 'sqlserver') extras.push(...SQLSERVER_START_KEYWORDS);
  if (dialect === 'sqlite') extras.push(...SQLITE_START_KEYWORDS);
  if (dialect === 'duckdb') extras.push(...DUCKDB_START_KEYWORDS);
  if (dialect === 'clickhouse') extras.push(...CLICKHOUSE_START_KEYWORDS);
  return new Set([...COMMON_START_KEYWORDS, ...extras]);
};

const canPrecedingTextEndStatement = (
  previousToken: string,
  previousChar: string,
  startKeywords: ReadonlySet<string>,
): boolean => {
  if (!previousChar || !STATEMENT_END_CHAR.test(previousChar)) {
    return false;
  }
  if (!previousToken) {
    return true;
  }
  if (CONTINUATION_TOKENS.has(previousToken)) {
    return false;
  }
  if (TERMINAL_START_KEYWORDS.has(previousToken)) {
    return true;
  }
  return !startKeywords.has(previousToken);
};

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
}

export const isSqlStatementStartBoundary = ({
  token,
  dbType,
  atLineStart,
  parenDepth,
  previousToken,
  previousChar,
  pendingHeadToken,
}: SqlStatementBoundaryInput): boolean => {
  if (!atLineStart || parenDepth > 0) {
    return false;
  }
  const startKeywords = resolveSqlStatementStartKeywords(dbType);
  if (!startKeywords.has(token)) {
    return false;
  }
  if (!canPrecedingTextEndStatement(previousToken, previousChar, startKeywords)) {
    return false;
  }
  return !BLOCKING_HEADS[token]?.has(pendingHeadToken);
};
