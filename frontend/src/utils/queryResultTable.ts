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

const maskNestedAndQuotedSql = (raw: string, dialect = ''): string => {
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
      output.push(' ');
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      output.push(' ');
      continue;
    }
    output.push(depth === 0 ? char : ' ');
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

  const parts = normalizeQualifiedNameParts(tableMatch[1], dialect);
  if (parts.length === 0) return undefined;
  const metadataTableName = parts[parts.length - 1] || '';
  if (!metadataTableName) return undefined;

  const owner = parts.length >= 2 ? parts[parts.length - 2] : '';
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
