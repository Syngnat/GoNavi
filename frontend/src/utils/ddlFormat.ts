import { format, type SqlLanguage } from 'sql-formatter';

const normalizeDbType = (dbType: string): string => String(dbType || '').trim().toLowerCase();

const resolveDdlFormatterLanguage = (dbType: string): SqlLanguage => {
  const normalized = normalizeDbType(dbType);
  switch (normalized) {
    case 'duckdb':
      return 'duckdb';
    case 'sqlite':
      return 'sqlite';
    case 'postgres':
    case 'postgresql':
    case 'kingbase':
    case 'highgo':
    case 'opengauss':
    case 'gaussdb':
    case 'vastbase':
      return 'postgresql';
    case 'mariadb':
      return 'mariadb';
    case 'mysql':
    case 'goldendb':
    case 'sphinx':
      return 'mysql';
    case 'sqlserver':
      return 'transactsql';
    case 'oracle':
    case 'dameng':
    case 'oceanbase':
      return 'plsql';
    case 'clickhouse':
      return 'clickhouse';
    default:
      return 'sql';
  }
};

const findOracleViewColumnList = (sql: string): { start: number; end: number } | null => {
  const viewMatch = /^\s*CREATE\b[\s\S]*?\bVIEW\b/i.exec(sql);
  if (!viewMatch) {
    return null;
  }

  let inQuotedIdentifier = false;
  let columnListStart = -1;
  let parenthesisDepth = 0;

  for (let index = viewMatch[0].length; index < sql.length; index += 1) {
    const current = sql[index];
    if (current === '"') {
      if (inQuotedIdentifier && sql[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotedIdentifier = !inQuotedIdentifier;
      continue;
    }
    if (inQuotedIdentifier) {
      continue;
    }

    if (parenthesisDepth === 0) {
      const remaining = sql.slice(index);
      if (/^AS\b/i.test(remaining)) {
        return null;
      }
      if (current === '(') {
        columnListStart = index;
        parenthesisDepth = 1;
      }
      continue;
    }

    if (current === '(') {
      parenthesisDepth += 1;
    } else if (current === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth === 0) {
        return { start: columnListStart, end: index };
      }
    }
  }

  return null;
};

const splitOracleViewColumns = (columnList: string): string[] => {
  const columns: string[] = [];
  let inQuotedIdentifier = false;
  let start = 0;

  for (let index = 0; index < columnList.length; index += 1) {
    const current = columnList[index];
    if (current === '"') {
      if (inQuotedIdentifier && columnList[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotedIdentifier = !inQuotedIdentifier;
    } else if (current === ',' && !inQuotedIdentifier) {
      columns.push(columnList.slice(start, index).trim());
      start = index + 1;
    }
  }

  columns.push(columnList.slice(start).trim());
  return columns.filter(Boolean);
};

const normalizeOracleViewDdlFormatting = (sql: string): string => {
  const columnList = findOracleViewColumnList(sql);
  let normalized = sql;

  if (columnList) {
    const columns = splitOracleViewColumns(sql.slice(columnList.start + 1, columnList.end));
    if (columns.length > 1) {
      normalized = [
        sql.slice(0, columnList.start + 1),
        '\n  ',
        columns.join(',\n  '),
        '\n',
        sql.slice(columnList.end),
      ].join('');
    }
  }

  return normalized.replace(
    /\bWITH[ \t]*\r?\n[ \t]*(READ[ \t]+ONLY|CHECK[ \t]+OPTION)\b/gi,
    'WITH $1',
  );
};

export const formatDdlForDisplay = (ddlText: unknown, dbType: string): string => {
  const raw = String(ddlText ?? '').trim();
  if (!raw) {
    return '';
  }
  const language = resolveDdlFormatterLanguage(dbType);
  try {
    const formatted = format(raw, {
      language,
      keywordCase: 'upper',
      linesBetweenQueries: 1,
    });
    return normalizeDbType(dbType) === 'oracle'
      ? normalizeOracleViewDdlFormatting(formatted)
      : formatted;
  } catch {
    return raw;
  }
};
