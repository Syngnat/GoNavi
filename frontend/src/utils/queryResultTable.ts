import { splitQualifiedNameSegmentsDetailed } from './qualifiedName';

export type QueryResultTableRef = {
  tableName: string;
  metadataDbName: string;
  metadataTableName: string;
  /** DBShowCreateTable 的数据库/命名空间参数；与列元数据目标分离。 */
  ddlDbName?: string;
  /** DBShowCreateTable 的表参数；只有能唯一定位单表时才提供。 */
  ddlTableName?: string;
};

const isOracleLikeDialect = (dialect: string): boolean => {
  const normalized = String(dialect || '').trim().toLowerCase();
  return normalized === 'oracle' || normalized === 'dameng' || normalized === 'dm' || normalized === 'dm8';
};

const keepsQualifiedTableNameForMetadata = (dialect: string): boolean => {
  const normalized = String(dialect || '').trim().toLowerCase();
  return normalized === 'duckdb'
    || isSqlServerLikeDialect(normalized)
    || isPostgresLikeDialect(normalized);
};

const isPostgresLikeDialect = (dialect: string): boolean => {
  const normalized = String(dialect || '').trim().toLowerCase();
  return normalized === 'postgres'
    || normalized === 'postgresql'
    || normalized === 'pg'
    || normalized === 'kingbase'
    || normalized === 'kingbase8'
    || normalized === 'kingbasees'
    || normalized === 'kingbasev8'
    || normalized === 'highgo'
    || normalized === 'vastbase'
    || normalized === 'opengauss'
    || normalized === 'open_gauss'
    || normalized === 'open-gauss'
    || normalized === 'gaussdb'
    || normalized === 'gauss_db'
    || normalized === 'gauss-db';
};

const normalizeCurrentDbName = (currentDb: string, dialect: string): string => {
  const value = String(currentDb || '').trim();
  if (!value) return '';
  return isOracleLikeDialect(dialect) ? value.toUpperCase() : value;
};

const isSqlServerLikeDialect = (dialect: string): boolean => {
  const normalized = String(dialect || '').trim().toLowerCase();
  return ['sqlserver', 'mssql', 'sql_server', 'sql-server'].includes(normalized);
};

const normalizeQualifiedNameParts = (raw: string, dialect: string): string[] => (
  splitQualifiedNameSegmentsDetailed(raw)
    .map((segment) => (
      isOracleLikeDialect(dialect) && !segment.quoted
        ? segment.value.toUpperCase()
        : segment.value
    ))
    .filter(Boolean)
);

const QUERY_RESULT_IDENTIFIER_PART_PATTERN = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|[A-Za-z_][A-Za-z0-9_$#]*)';
const QUERY_RESULT_TABLE_REFERENCE_REGEX = new RegExp(
  `^\\s*(${QUERY_RESULT_IDENTIFIER_PART_PATTERN}(?:\\s*\\.\\s*${QUERY_RESULT_IDENTIFIER_PART_PATTERN}){0,2})\\s*(?:$|[\\s;])`,
  'i',
);

/**
 * 宽松解析专用：与严格版的差别只在**终止符**——把 `,` / `)` / `]` 也算结束，
 * 否则 `FROM t1, t2`、`(SELECT * FROM a)`、`IN (SELECT ... FROM t)` 里的表都会匹配失败。
 * 严格版继续用上面那条（它的边界决定可写回定位，不能放宽）。
 */
const QUERY_RESULT_LOOSE_TABLE_REFERENCE_REGEX = new RegExp(
  `^\\s*(${QUERY_RESULT_IDENTIFIER_PART_PATTERN}(?:\\s*\\.\\s*${QUERY_RESULT_IDENTIFIER_PART_PATTERN}){0,2})(?=$|[\\s;,)\\]])`,
  'i',
);

const HASH_COMMENT_DIALECTS = new Set([
  'mysql', 'mariadb', 'oceanbase', 'starrocks', 'tidb', 'diros', 'goldendb', 'sphinx', 'clickhouse',
]);

const skipSqlTrivia = (text: string, position: number, dialect: string): number => {
  const normalizedDialect = String(dialect || '').trim().toLowerCase();
  let index = Math.max(0, position);
  while (index < text.length) {
    if (/\s/.test(text[index] || '')) {
      index += 1;
      continue;
    }
    if (text.startsWith('--', index)) {
      const lineEnd = text.indexOf('\n', index + 2);
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (HASH_COMMENT_DIALECTS.has(normalizedDialect) && text[index] === '#') {
      const lineEnd = text.indexOf('\n', index + 1);
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const blockEnd = text.indexOf('*/', index + 2);
      index = blockEnd < 0 ? text.length : blockEnd + 2;
      continue;
    }
    break;
  }
  return index;
};

const maskNestedAndQuotedSql = (raw: string, dialect = '', maskNested = true): string => {
  const text = String(raw || '');
  const output: string[] = [];
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  const normalizedDialect = String(dialect || '').trim().toLowerCase();
  const supportsHashComment = !normalizedDialect || HASH_COMMENT_DIALECTS.has(normalizedDialect);

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || '';

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output.push(char);
      } else {
        output.push(' ');
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        output.push(' ', ' ');
        index += 1;
      } else {
        output.push(' ');
      }
      continue;
    }
    if (quote) {
      output.push(' ');
      if (quote === '[') {
        if (char === ']' && next === ']') {
          output.push(' ');
          index += 1;
        } else if (char === ']') {
          quote = '';
        }
      } else if (char === quote) {
        if (next === quote) {
          output.push(' ');
          index += 1;
        } else {
          quote = '';
        }
      } else if (char === '\\' && next) {
        output.push(' ');
        index += 1;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      output.push(' ', ' ');
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      output.push(' ', ' ');
      index += 1;
      continue;
    }
    if (supportsHashComment && char === '#') {
      lineComment = true;
      output.push(' ');
      continue;
    }
    if (char === '\'' || char === '"' || char === '`' || char === '[') {
      quote = char;
      output.push(' ');
      continue;
    }
    if (char === '(') {
      depth += 1;
      output.push(maskNested ? ' ' : char);
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      output.push(maskNested ? ' ' : char);
      continue;
    }
    output.push(!maskNested || depth === 0 ? char : ' ');
  }

  return output.join('');
};

const resolveDdlTarget = (
  parts: string[],
  dialect: string,
  currentDb: string,
  metadataDbName: string,
  metadataTableName: string,
): Pick<QueryResultTableRef, 'ddlDbName' | 'ddlTableName'> => {
  const normalizedDialect = String(dialect || '').trim().toLowerCase();
  const currentNamespace = normalizeCurrentDbName(currentDb, dialect);
  const table = parts[parts.length - 1] || '';
  if (!table) return {};

  if (isSqlServerLikeDialect(normalizedDialect)) {
    if (parts.length > 3) return {};
    const schema = parts.length >= 2 ? parts[parts.length - 2] : '';
    const database = parts.length === 3 ? parts[0] : currentNamespace;
    return {
      ddlDbName: database,
      ddlTableName: schema ? `${schema}.${table}` : table,
    };
  }

  if (normalizedDialect === 'trino') {
    if (parts.length > 3) return {};
    if (parts.length === 3) {
      return {
        ddlDbName: `${parts[0]}.${parts[1]}`,
        ddlTableName: table,
      };
    }
    const currentParts = normalizeQualifiedNameParts(currentNamespace, dialect);
    if (currentParts.length < 2) return {};
    return {
      ddlDbName: `${currentParts[0]}.${parts.length === 2 ? parts[0] : currentParts[1]}`,
      ddlTableName: table,
    };
  }

  if (normalizedDialect === 'duckdb') {
    return {
      ddlDbName: currentNamespace,
      ddlTableName: parts.join('.'),
    };
  }

  if (normalizedDialect === 'iris' || normalizedDialect === 'intersystems') {
    if (parts.length > 2) return {};
    return {
      ddlDbName: currentNamespace,
      ddlTableName: parts.join('.'),
    };
  }

  if (isPostgresLikeDialect(normalizedDialect)) {
    // PostgreSQL-like dialects do not support a cross-database three-part table target.
    if (parts.length > 2) return {};
    return {
      ddlDbName: currentNamespace,
      ddlTableName: metadataTableName,
    };
  }

  if (isOracleLikeDialect(normalizedDialect)) {
    if (parts.length > 2) return {};
    return {
      ddlDbName: metadataDbName,
      ddlTableName: table,
    };
  }

  // MySQL/SQLite/ClickHouse 等两段名称均按 database.table 解析。
  if (parts.length > 2) return {};
  return {
    ddlDbName: parts.length === 2 ? parts[0] : currentNamespace || metadataDbName,
    ddlTableName: table,
  };
};

const resolveTableRefFromParts = (
  parts: string[],
  dialect: string,
  currentDb: string,
  defaultSchema: string,
): QueryResultTableRef | undefined => {
  if (parts.length === 0) return undefined;
  const metadataTableName = parts[parts.length - 1] || '';
  if (!metadataTableName) return undefined;

  const explicitOwner = parts.length >= 2 ? parts[parts.length - 2] : '';
  // 未写 schema 时不能把数据库名当成 schema，否则列类型和注释会查空。
  const postgresDefaultSchema = !explicitOwner && isPostgresLikeDialect(dialect)
    ? normalizeCurrentDbName(defaultSchema, dialect)
    : '';
  const owner = explicitOwner || postgresDefaultSchema;
  const defaultOracleSchema = isOracleLikeDialect(dialect)
    ? normalizeCurrentDbName(defaultSchema, dialect)
    : '';
  const fallbackSchema = isOracleLikeDialect(dialect)
    ? defaultOracleSchema || normalizeCurrentDbName(currentDb, dialect)
    : normalizeCurrentDbName(currentDb, dialect);
  const sqlServerLikeDialect = isSqlServerLikeDialect(dialect);
  const metadataDbName = sqlServerLikeDialect
    ? (parts.length === 3 ? parts[0] : fallbackSchema)
    : owner || fallbackSchema;
  const qualifiedTableName = owner ? `${owner}.${metadataTableName}` : metadataTableName;
  const pgLikeQualifiedMetadata = isPostgresLikeDialect(dialect) && owner;
  const resolvedMetadataDbName = pgLikeQualifiedMetadata
    ? normalizeCurrentDbName(currentDb, dialect)
    : metadataDbName;
  const tableName = (isOracleLikeDialect(dialect) && owner) || pgLikeQualifiedMetadata || (sqlServerLikeDialect && owner)
    ? `${owner}.${metadataTableName}`
    : (keepsQualifiedTableNameForMetadata(dialect) && owner ? `${owner}.${metadataTableName}` : metadataTableName);
  const resolvedMetadataTableName = keepsQualifiedTableNameForMetadata(dialect) && owner
    ? qualifiedTableName
    : metadataTableName;
  const resolvedDbName = resolvedMetadataDbName || metadataDbName;
  const ddlTarget = resolveDdlTarget(
    parts,
    dialect,
    currentDb,
    resolvedDbName,
    resolvedMetadataTableName,
  );

  return {
    tableName,
    metadataDbName: resolvedDbName,
    metadataTableName: resolvedMetadataTableName,
    ...ddlTarget,
  };
};

export const extractQueryResultTableRef = (
  sql: string,
  dialect: string,
  currentDb: string,
  defaultSchema = '',
): QueryResultTableRef | undefined => {
  const text = String(sql || '').trim();
  if (!text) return undefined;

  const topLevelSql = maskNestedAndQuotedSql(text, dialect);
  if (/\b(JOIN|UNION|INTERSECT|EXCEPT|MINUS)\b/i.test(topLevelSql)) return undefined;
  if (/^\s*SELECT\s+DISTINCT\b/i.test(topLevelSql)) return undefined;
  if (/\bGROUP\s+BY\b|\bHAVING\b/i.test(topLevelSql)) return undefined;
  const topLevelFromMatch = /\bFROM\b/i.exec(topLevelSql);
  if (topLevelFromMatch?.index === undefined) return undefined;
  const sourceOffset = topLevelFromMatch.index + topLevelFromMatch[0].length;
  const topLevelFromClause = topLevelSql.slice(sourceOffset).match(
    /^([\s\S]*?)(?:\bWHERE\b|\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bFETCH\b|\bFOR\b|;|$)/i,
  )?.[1] || '';
  if (topLevelFromClause.includes(',') || /\bAPPLY\b/i.test(topLevelFromClause)) return undefined;

  const tableStart = skipSqlTrivia(text, sourceOffset, dialect);
  const tableMatch = text.slice(tableStart).match(QUERY_RESULT_TABLE_REFERENCE_REGEX);
  if (!tableMatch) return undefined;

  return resolveTableRefFromParts(normalizeQualifiedNameParts(tableMatch[1], dialect), dialect, currentDb, defaultSchema);
};

/** 一张真实源表，以及 FROM/JOIN 里给它的别名（没有别名时为空串）。 */
export type QueryResultSourceTable = {
  ref: QueryResultTableRef;
  alias: string;
};

/** 候选表数量上限：JOIN 再多也只查这么多张表的列定义，避免一次执行打出一长串 IPC。 */
export const MAX_QUERY_RESULT_METADATA_TABLE_REFS = 6;

/** 表引用后紧跟的这些词不是别名，遇到就说明表引用段已结束。 */
const QUERY_RESULT_CLAUSE_KEYWORDS = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'for',
  'union', 'intersect', 'except', 'minus', 'on', 'using', 'join', 'left',
  'right', 'inner', 'outer', 'full', 'cross', 'natural', 'straight_join',
  'window', 'qualify', 'into', 'set', 'values', 'returning', 'lateral',
  'apply', 'pivot', 'unpivot', 'tablesample', 'with', 'connect', 'start',
  'partition', 'sample', 'final', 'asof', 'settings',
]);

const QUERY_RESULT_TABLE_ALIAS_REGEX = /^(?:AS\s+)?([A-Za-z_][A-Za-z0-9_$#]*|"(?:[^"]|"")*")(?=[\s,;)]|$)/i;

/**
 * 读取表引用后面的别名。表引用正则已吃掉分隔空白，所以先跳过空白再读别名；
 * 别名位是 SQL 关键字时不算别名。跳词用**原始文本**：`[dbo].[users]`、`"users"` 在遮蔽文本里是空白，
 * 用遮蔽文本跳词会把这类标识符整段跳过。
 */
const readTableAlias = (
  text: string,
  cursor: number,
  dialect: string,
): { alias: string; next: number } | undefined => {
  const aliasStart = skipSqlTrivia(text, cursor, dialect);
  const match = text.slice(aliasStart).match(QUERY_RESULT_TABLE_ALIAS_REGEX);
  if (!match) return undefined;
  const alias = match[1].replace(/"/g, '');
  if (QUERY_RESULT_CLAUSE_KEYWORDS.has(alias.toLowerCase())) return undefined;
  return { alias, next: aliasStart + match[0].length };
};

/** CTE 名不是真实表：`WITH c AS (...) SELECT * FROM c` 里的 c 不该去查列定义。 */
const collectCteNames = (scannedSql: string): Set<string> => {
  const names = new Set<string>();
  const regex = new RegExp(
    `([\\p{L}_][\\p{L}\\p{N}_$#]*)\\s*(?:\\([^()]*\\)\\s*)?AS\\s*\\(`,
    'giu',
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(scannedSql)) !== null) {
    names.add(match[1].toLowerCase());
  }
  return names;
};

const collectQueryResultSourceTables = (
  sql: string,
  dialect: string,
  currentDb: string,
  defaultSchema: string,
): QueryResultSourceTable[] => {
  const text = String(sql || '').trim();
  if (!text) return [];
  // 与严格版不同：这里**保留括号内文本**，派生表/子查询里的 FROM 与 JOIN 也是真实源表。
  // 字符串与注释被遮成空格，所以关键字扫描只用遮蔽文本；读标识符/跳词仍用原始文本。
  const fullScanSql = maskNestedAndQuotedSql(text, dialect, false);
  const keywordRegex = /\b(?:FROM|JOIN)\b/gi;
  if (!keywordRegex.test(fullScanSql)) return [];
  const cteNames = collectCteNames(fullScanSql);

  const tables: QueryResultSourceTable[] = [];
  const seen = new Set<string>();
  const pushTable = (ref: QueryResultTableRef | undefined, alias: string, bareName: string) => {
    if (!ref || tables.length >= MAX_QUERY_RESULT_METADATA_TABLE_REFS) return;
    // CTE 名只在没有 schema 限定时才可能是它：带 schema 的同名对象仍是真实表。
    if (bareName && cteNames.has(bareName.toLowerCase())) return;
    const key = `${ref.metadataDbName}.${ref.metadataTableName}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tables.push({ ref, alias });
  };

  const scan = (scannedSql: string) => {
    let keywordMatch: RegExpExecArray | null;
    keywordRegex.lastIndex = 0;
    while ((keywordMatch = keywordRegex.exec(scannedSql)) !== null) {
      if (tables.length >= MAX_QUERY_RESULT_METADATA_TABLE_REFS) return;
      let cursor = keywordMatch.index + keywordMatch[0].length;
      // `FROM a, b` 这类老式逗号连接：一次 FROM 关键字后面连读多个表引用。
      for (;;) {
        let tableStart = skipSqlTrivia(text, cursor, dialect);
        // `FROM ONLY t` / `JOIN LATERAL (...)`：这些位置词不是表名，跳过再读引用
        const positionWord = /^(?:ONLY|LATERAL)\b/i.exec(text.slice(tableStart));
        if (positionWord) tableStart = skipSqlTrivia(text, tableStart + positionWord[0].length, dialect);
        const tableMatch = text.slice(tableStart).match(QUERY_RESULT_LOOSE_TABLE_REFERENCE_REGEX);
        if (!tableMatch) break;
        const parts = normalizeQualifiedNameParts(tableMatch[1], dialect);
        const ref = resolveTableRefFromParts(parts, dialect, currentDb, defaultSchema);
        const aliasRead = readTableAlias(text, tableStart + tableMatch[0].length, dialect);
        pushTable(ref, aliasRead?.alias || '', parts.length === 1 ? parts[0] : '');
        cursor = aliasRead?.next ?? tableStart + tableMatch[0].length;
        const commaStart = skipSqlTrivia(text, cursor, dialect);
        if (text[commaStart] !== ',') break;
        cursor = commaStart + 1;
      }
    }
  };

  // 先扫顶层（同名列冲突时外层主表优先），再补派生表/子查询里的表。
  scan(maskNestedAndQuotedSql(text, dialect, true));
  scan(fullScanSql);

  return tables;
};

/**
 * 宽松解析：复杂查询（JOIN / GROUP BY / 派生表 / 逗号多表 / 集合运算）无法唯一定位单表，
 * 回写定位必须继续走严格版；但**源表仍然是可知的**，结果页可以按列名把类型和注释对上。
 * 返回语句涉及的全部候选源表（主表在前）及其别名，由调用方按列名/别名匹配回填。
 */
export const extractQueryResultSourceTables = (
  sql: string,
  dialect: string,
  currentDb: string,
  defaultSchema = '',
): QueryResultSourceTable[] => collectQueryResultSourceTables(sql, dialect, currentDb, defaultSchema);

/** 只要表、不要别名的场景（按列名匹配回填）。 */
export const extractQueryResultMetadataTableRefs = (
  sql: string,
  dialect: string,
  currentDb: string,
  defaultSchema = '',
): QueryResultTableRef[] => collectQueryResultSourceTables(sql, dialect, currentDb, defaultSchema)
  .map((table) => table.ref);

/**
 * 供上层做语句结构定位：字符串与注释遮成空格、括号内内容也遮成空格，
 * 长度与原文一致，因此可用它算出的偏移去切原始 SQL。
 */
export const maskQueryResultSqlStructure = (sql: string, dialect = ''): string => (
  maskNestedAndQuotedSql(String(sql || ''), dialect)
);
