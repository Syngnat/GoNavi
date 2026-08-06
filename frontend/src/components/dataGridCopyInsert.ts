import type { IndexDefinition } from '../types';
import { escapeLiteral, quoteIdentPart, quoteQualifiedIdent } from '../utils/sql';
import { isMysqlFamilyDialect, isOracleLikeDialect } from '../utils/sqlDialect';

type BuildCopyInsertSQLParams = {
  dbType: string;
  tableName?: string;
  orderedCols: string[];
  record: Record<string, any>;
  columnTypesByLowerName?: Record<string, string>;
};

type BuildCopyMutationSQLParams = BuildCopyInsertSQLParams & {
  pkColumns?: string[];
  uniqueKeyGroups?: string[][];
  allTableColumns?: string[];
};

type CopySqlWhereStrategy = 'primary-key' | 'unique-key' | 'all-columns';

export type CopySqlErrorKey =
  | 'data_grid.copy_sql.error.missing_safe_where'
  | 'data_grid.copy_sql.error.missing_table_name'
  | 'data_grid.copy_sql.error.no_copyable_fields';

export type CopySqlStructuredError = {
  key: CopySqlErrorKey;
  params?: Record<string, string>;
};

export type CopySqlError = string | CopySqlStructuredError;

export type CopyMutationSQLResult =
  | { ok: true; sql: string; whereStrategy: CopySqlWhereStrategy }
  | { ok: false; error: CopySqlError };

type CopyMutationWhereClauseResult =
  | { ok: true; clause: string; whereStrategy: CopySqlWhereStrategy }
  | { ok: false; error: CopySqlError };

const looksLikeDateTimeText = (val: string): boolean => {
  if (!val) return false;
  const len = val.length;
  if (len < 19 || len > 64) return false;
  const charCode0 = val.charCodeAt(0);
  if (charCode0 < 48 || charCode0 > 57) return false;
  return (
    val[4] === '-' &&
    val[7] === '-' &&
    (val[10] === ' ' || val[10] === 'T') &&
    val[13] === ':' &&
    val[16] === ':'
  );
};

const normalizeDateTimeString = (val: string): string => {
  if (!looksLikeDateTimeText(val)) {
    return val;
  }

  if (/^0{4}-0{2}-0{2}/.test(val)) {
    return val;
  }

  const match = val.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/
  );
  return match ? `${match[1]} ${match[2]}${match[3] || ''}` : val;
};

const normalizeTimezoneAwareDateTimeString = (val: string): string => {
  if (!looksLikeDateTimeText(val)) {
    return val;
  }

  if (/^0{4}-0{2}-0{2}/.test(val)) {
    return val;
  }

  const match = val.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/
  );
  if (!match) {
    return val;
  }
  const fractional = match[3] || '';
  const suffix = match[4] || '';
  return `${match[1]} ${match[2]}${fractional}${suffix}`;
};

const isTemporalColumnType = (columnType?: string): boolean => {
  const raw = String(columnType || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes('datetime') || raw.includes('timestamp') || raw.includes('timestamptz')) return true;
  const base = raw.split(/[ (]/)[0];
  return base === 'date' || base === 'time' || base === 'timetz' || base === 'year';
};

const isTimezoneAwareColumnType = (columnType?: string): boolean => {
  const raw = String(columnType || '').trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.includes('with time zone') ||
    raw.includes('with timezone') ||
    raw.includes('datetimeoffset') ||
    raw.includes('timestamptz') ||
    raw.includes('timetz')
  );
};

export const normalizeTemporalLiteralText = (
  value: string,
  columnType?: string,
  normalizeWhenTypeMissing = false,
): string => {
  const rawType = String(columnType || '').trim();
  if (!rawType) {
    return normalizeWhenTypeMissing ? normalizeDateTimeString(value) : value;
  }
  if (!isTemporalColumnType(rawType)) {
    return value;
  }
  return isTimezoneAwareColumnType(rawType)
    ? normalizeTimezoneAwareDateTimeString(value)
    : normalizeDateTimeString(value);
};

export const formatLocalDateTimeLiteral = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  const second = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

const getColumnType = (columnTypesByLowerName: Record<string, string>, columnName: string): string | undefined => (
  columnTypesByLowerName[String(columnName || '').toLowerCase()]
);

const getRecordValue = (
  record: Record<string, any>,
  columnName: string,
): { exists: boolean; value: any } => {
  if (Object.prototype.hasOwnProperty.call(record || {}, columnName)) {
    return { exists: true, value: record?.[columnName] };
  }
  const loweredColumnName = String(columnName || '').toLowerCase();
  const matchedKey = Object.keys(record || {}).find((key) => key.toLowerCase() === loweredColumnName);
  if (!matchedKey) {
    return { exists: false, value: undefined };
  }
  return { exists: true, value: record?.[matchedKey] };
};

const normalizeColumnList = (columns: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  (columns || []).forEach((column) => {
    const normalized = String(column || '').trim();
    if (!normalized) return;
    const lowered = normalized.toLowerCase();
    if (seen.has(lowered)) return;
    seen.add(lowered);
    result.push(normalized);
  });
  return result;
};

const toNormalizedLiteralText = (value: any, columnType?: string): string => {
  if (typeof value === 'string') {
    return normalizeTemporalLiteralText(value, columnType, true);
  }
  if (value instanceof Date) {
    return formatLocalDateTimeLiteral(value);
  }
  return String(value);
};

const hasFractionalSeconds = (value: string): boolean => /\d{2}:\d{2}:\d{2}\.\d+/.test(value);

const stripFractionalSeconds = (value: string): string => (
  value.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1')
);

const formatOracleTemporalLiteral = (value: any, columnType?: string): string | null => {
  if (!isTemporalColumnType(columnType)) {
    return null;
  }
  const normalized = toNormalizedLiteralText(value, columnType);
  const rawType = String(columnType || '').toLowerCase();
  const isTimestamp = rawType.includes('timestamp');
  const oracleValue = isTimestamp ? normalized : stripFractionalSeconds(normalized);
  const escaped = escapeLiteral(oracleValue);
  if (/^\d{4}-\d{2}-\d{2}$/.test(oracleValue)) {
    return `TO_DATE('${escaped}', 'YYYY-MM-DD')`;
  }
  if (isTimezoneAwareColumnType(columnType) && /[+-]\d{2}:?\d{2}$/.test(oracleValue)) {
    const compactOffset = oracleValue.replace(/([+-]\d{2}):(\d{2})$/, '$1:$2');
    const temporalFormat = hasFractionalSeconds(oracleValue)
      ? 'YYYY-MM-DD HH24:MI:SS.FFTZH:TZM'
      : 'YYYY-MM-DD HH24:MI:SSTZH:TZM';
    return `TO_TIMESTAMP_TZ('${escapeLiteral(compactOffset)}', '${temporalFormat}')`;
  }
  if (isTimestamp) {
    const temporalFormat = hasFractionalSeconds(oracleValue)
      ? 'YYYY-MM-DD HH24:MI:SS.FF'
      : 'YYYY-MM-DD HH24:MI:SS';
    return `TO_TIMESTAMP('${escaped}', '${temporalFormat}')`;
  }
  return `TO_DATE('${escaped}', 'YYYY-MM-DD HH24:MI:SS')`;
};

const isMySQLBitColumnType = (columnType?: string): boolean => {
  const normalized = String(columnType || '').trim().toLowerCase();
  return /^bit(?:\s*\(\s*\d+\s*\))?$/.test(normalized);
};

const formatMySQLBitLiteral = (value: any): string | null => {
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value).toString(10);
  }

  if (typeof value === 'bigint') {
    if (value < 0n) return null;
    return value.toString(10);
  }

  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const binaryLiteral = raw.match(/^[bB]['"]([01]+)['"]$/);
  if (binaryLiteral) {
    try {
      return BigInt(`0b${binaryLiteral[1]}`).toString(10);
    } catch {
      return null;
    }
  }

  let numericText = raw;
  let radix = 10;
  if (/^0[bB][01]+$/.test(raw)) {
    numericText = raw.slice(2);
    radix = 2;
  } else if (/^0x[0-9a-f]+$/i.test(raw)) {
    numericText = raw.slice(2);
    radix = 16;
  } else if (!/^\d+$/.test(raw)) {
    if (/^(true|false)$/i.test(raw)) {
      return raw.toLowerCase() === 'true' ? '1' : '0';
    }
    return null;
  }

  try {
    return BigInt(radix === 10 ? raw : `${radix === 2 ? '0b' : '0x'}${numericText}`).toString(10);
  } catch {
    return null;
  }
};

const formatCopySqlLiteral = (value: any, columnType?: string, dbType = ''): string => {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (isMysqlFamilyDialect(dbType) && isMySQLBitColumnType(columnType)) {
    const mysqlBitLiteral = formatMySQLBitLiteral(value);
    if (mysqlBitLiteral) {
      return mysqlBitLiteral;
    }
  }
  if (isOracleLikeDialect(dbType)) {
    const oracleTemporalLiteral = formatOracleTemporalLiteral(value, columnType);
    if (oracleTemporalLiteral) {
      return oracleTemporalLiteral;
    }
  }
  return `'${escapeLiteral(toNormalizedLiteralText(value, columnType))}'`;
};

const doesResultCoverAllTableColumns = (orderedCols: string[], allTableColumns: string[]): boolean => {
  const normalizedOrderedCols = normalizeColumnList(orderedCols);
  const normalizedAllTableColumns = normalizeColumnList(allTableColumns);
  if (normalizedOrderedCols.length === 0 || normalizedOrderedCols.length !== normalizedAllTableColumns.length) {
    return false;
  }
  const orderedSet = new Set(normalizedOrderedCols.map((column) => column.toLowerCase()));
  return normalizedAllTableColumns.every((column) => orderedSet.has(column.toLowerCase()));
};

const buildWhereClauseForColumns = ({
  dbType,
  columns,
  record,
  columnTypesByLowerName,
  requireNonNullValues,
}: {
  dbType: string;
  columns: string[];
  record: Record<string, any>;
  columnTypesByLowerName: Record<string, string>;
  requireNonNullValues: boolean;
}): string | null => {
  const predicates: string[] = [];
  for (const columnName of columns) {
    const { exists, value } = getRecordValue(record, columnName);
    if (!exists) {
      return null;
    }
    const quotedColumn = quoteIdentPart(dbType, columnName);
    if (value === null || value === undefined) {
      if (requireNonNullValues) {
        return null;
      }
      predicates.push(`${quotedColumn} IS NULL`);
      continue;
    }
    predicates.push(`${quotedColumn} = ${formatCopySqlLiteral(value, getColumnType(columnTypesByLowerName, columnName), dbType)}`);
  }
  if (predicates.length === 0) {
    return null;
  }
  return `(${predicates.join(' AND ')})`;
};

const resolveMutationWhereClause = ({
  dbType,
  orderedCols,
  record,
  pkColumns = [],
  uniqueKeyGroups = [],
  allTableColumns = [],
  columnTypesByLowerName = {},
}: BuildCopyMutationSQLParams): CopyMutationWhereClauseResult => {
  const normalizedPkColumns = normalizeColumnList(pkColumns);
  const pkWhereClause = buildWhereClauseForColumns({
    dbType,
    columns: normalizedPkColumns,
    record,
    columnTypesByLowerName,
    requireNonNullValues: true,
  });
  if (pkWhereClause) {
    return { ok: true, clause: pkWhereClause, whereStrategy: 'primary-key' };
  }

  const normalizedUniqueKeyGroups = (uniqueKeyGroups || [])
    .map((group) => normalizeColumnList(group))
    .filter((group) => group.length > 0);
  for (const group of normalizedUniqueKeyGroups) {
    const uniqueWhereClause = buildWhereClauseForColumns({
      dbType,
      columns: group,
      record,
      columnTypesByLowerName,
      requireNonNullValues: true,
    });
    if (uniqueWhereClause) {
      return { ok: true, clause: uniqueWhereClause, whereStrategy: 'unique-key' };
    }
  }

  if (doesResultCoverAllTableColumns(orderedCols, allTableColumns)) {
    const fullRowWhereClause = buildWhereClauseForColumns({
      dbType,
      columns: orderedCols,
      record,
      columnTypesByLowerName,
      requireNonNullValues: false,
    });
    if (fullRowWhereClause) {
      return { ok: true, clause: fullRowWhereClause, whereStrategy: 'all-columns' };
    }
  }

  return {
    ok: false,
    error: {
      key: 'data_grid.copy_sql.error.missing_safe_where',
    },
  };
};

export const buildCopyInsertSQL = ({
  dbType,
  tableName,
  orderedCols,
  record,
  columnTypesByLowerName = {},
}: BuildCopyInsertSQLParams): string => {
  const targetTable = quoteQualifiedIdent(dbType, tableName || 'table');
  const quotedCols = orderedCols.map((col) => quoteIdentPart(dbType, col));
  const values = orderedCols.map((col) => {
    const { value } = getRecordValue(record, col);
    return formatCopySqlLiteral(value, getColumnType(columnTypesByLowerName, col), dbType);
  });

  return `INSERT INTO ${targetTable} (${quotedCols.join(', ')}) VALUES (${values.join(', ')});`;
};

const buildCopyMutationSQL = (
  mode: 'update' | 'delete',
  {
    dbType,
    tableName,
    orderedCols,
    record,
    pkColumns = [],
    uniqueKeyGroups = [],
    allTableColumns = [],
    columnTypesByLowerName = {},
  }: BuildCopyMutationSQLParams,
): CopyMutationSQLResult => {
  const normalizedTableName = String(tableName || '').trim();
  const normalizedOrderedCols = normalizeColumnList(orderedCols);
  if (!normalizedTableName) {
    return {
      ok: false,
      error: {
        key: 'data_grid.copy_sql.error.missing_table_name',
        params: {
          mode: mode.toUpperCase(),
        },
      },
    };
  }
  if (normalizedOrderedCols.length === 0) {
    return {
      ok: false,
      error: {
        key: 'data_grid.copy_sql.error.no_copyable_fields',
      },
    };
  }

  const whereClause = resolveMutationWhereClause({
    dbType,
    orderedCols: normalizedOrderedCols,
    record,
    pkColumns,
    uniqueKeyGroups,
    allTableColumns,
    columnTypesByLowerName,
  });
  if (whereClause.ok === false) {
    return { ok: false, error: whereClause.error };
  }

  const targetTable = quoteQualifiedIdent(dbType, normalizedTableName);
  if (mode === 'delete') {
    return {
      ok: true,
      sql: `DELETE FROM ${targetTable} WHERE ${whereClause.clause};`,
      whereStrategy: whereClause.whereStrategy,
    };
  }

  const assignments = normalizedOrderedCols.map((columnName) => {
    const { value } = getRecordValue(record, columnName);
    return `${quoteIdentPart(dbType, columnName)} = ${formatCopySqlLiteral(value, getColumnType(columnTypesByLowerName, columnName), dbType)}`;
  });

  return {
    ok: true,
    sql: `UPDATE ${targetTable} SET ${assignments.join(', ')} WHERE ${whereClause.clause};`,
    whereStrategy: whereClause.whereStrategy,
  };
};

export const buildCopyUpdateSQL = (params: BuildCopyMutationSQLParams): CopyMutationSQLResult => (
  buildCopyMutationSQL('update', params)
);

export const buildCopyDeleteSQL = (params: BuildCopyMutationSQLParams): CopyMutationSQLResult => (
  buildCopyMutationSQL('delete', params)
);

export const resolveUniqueKeyGroupsFromIndexes = (indexes: IndexDefinition[] | undefined): string[][] => {
  type IndexBucket = {
    order: number;
    columns: Array<{ columnName: string; seqInIndex: number; order: number }>;
  };

  const readIndexProp = (index: unknown, keys: string[]): unknown => {
    const source = index as Record<string, unknown> | null | undefined;
    if (!source || typeof source !== 'object') return undefined;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    for (const [sourceKey, raw] of Object.entries(source)) {
      if (keys.some((key) => sourceKey.toLowerCase() === key.toLowerCase())) {
        return raw;
      }
    }
    return undefined;
  };

  const readIndexText = (index: unknown, keys: string[]): string => {
    const raw = readIndexProp(index, keys);
    return raw === undefined || raw === null ? '' : String(raw).trim();
  };

  const readIndexBool = (index: unknown, keys: string[]): boolean | undefined => {
    const raw = readIndexProp(index, keys);
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    const text = String(raw).trim().toLowerCase();
    if (['1', 't', 'true', 'y', 'yes', 'unique'].includes(text)) return true;
    if (['0', 'f', 'false', 'n', 'no', 'nonunique', 'non-unique'].includes(text)) return false;
    return undefined;
  };

  const isUniqueIndex = (index: unknown): boolean => {
    const nonUniqueRaw = readIndexProp(index, ['nonUnique', 'NonUnique', 'non_unique', 'NON_UNIQUE', 'Non_unique']);
    if (nonUniqueRaw !== undefined && nonUniqueRaw !== null) {
      if (typeof nonUniqueRaw === 'number') return nonUniqueRaw === 0;
      const text = String(nonUniqueRaw).trim().toLowerCase();
      if (['0', 'false', 'f', 'no', 'n'].includes(text)) return true;
      if (['1', 'true', 't', 'yes', 'y'].includes(text)) return false;
    }
    const unique = readIndexBool(index, ['isUnique', 'is_unique', 'IS_UNIQUE', 'unique', 'UNIQUE']);
    if (unique !== undefined) return unique;
    const uniqueness = readIndexText(index, ['uniqueness', 'UNIQUENESS']);
    if (uniqueness.toLowerCase() === 'unique') return true;
    const indexType = readIndexText(index, ['indexType', 'IndexType', 'index_type', 'INDEX_TYPE']);
    return indexType.toLowerCase() === 'unique';
  };

  const buckets = new Map<string, IndexBucket>();
  (indexes || []).forEach((index, order) => {
    if (!isUniqueIndex(index)) {
      return;
    }
    const name = readIndexText(index, ['name', 'Name', 'indexName', 'index_name', 'INDEX_NAME']);
    const columnName = readIndexText(index, ['columnName', 'ColumnName', 'column_name', 'COLUMN_NAME']);
    if (!name || !columnName) {
      return;
    }
    if (!buckets.has(name)) {
      buckets.set(name, { order, columns: [] });
    }
    const bucket = buckets.get(name);
    if (!bucket) {
      return;
    }
    bucket.columns.push({
      columnName,
      seqInIndex: Number.isFinite(Number(readIndexProp(index, ['seqInIndex', 'SeqInIndex', 'seq_in_index', 'SEQ_IN_INDEX', 'columnPosition', 'column_position'])))
        ? Number(readIndexProp(index, ['seqInIndex', 'SeqInIndex', 'seq_in_index', 'SEQ_IN_INDEX', 'columnPosition', 'column_position']))
        : 0,
      order,
    });
  });

  return Array.from(buckets.values())
    .sort((left, right) => left.order - right.order)
    .map((bucket) => {
      const seen = new Set<string>();
      return bucket.columns
        .slice()
        .sort((left, right) => {
          const leftSeq = left.seqInIndex > 0 ? left.seqInIndex : Number.MAX_SAFE_INTEGER;
          const rightSeq = right.seqInIndex > 0 ? right.seqInIndex : Number.MAX_SAFE_INTEGER;
          if (leftSeq !== rightSeq) {
            return leftSeq - rightSeq;
          }
          return left.order - right.order;
        })
        .map((item) => item.columnName)
        .filter((columnName) => {
          const lowered = columnName.toLowerCase();
          if (seen.has(lowered)) {
            return false;
          }
          seen.add(lowered);
          return true;
        });
    })
    .filter((group) => group.length > 0);
};
