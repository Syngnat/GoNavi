import {
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
  isSqlServerDialect,
  quoteSqlIdentifierPart,
} from '../utils/sqlDialect';
import { t as catalogTranslate } from '../i18n/catalog';
import { isElasticsearchFamilyType } from '../utils/elasticsearchFamily';

export type TableDesignerIndexKind = 'NORMAL' | 'UNIQUE' | 'PRIMARY' | 'FULLTEXT' | 'SPATIAL';
type TableDesignerIndexMessageParams = Record<string, string | number | boolean | null | undefined>;
type TableDesignerIndexTranslate = (key: string, params?: TableDesignerIndexMessageParams) => string;

export interface BuildIndexCreateSqlInput {
  dbType: string;
  tableRef: string;
  name: string;
  columnNames: string[];
  kind: TableDesignerIndexKind;
  indexType?: string;
  translate?: TableDesignerIndexTranslate;
}

export interface BuildIndexCreateSqlResult {
  sql: string | null;
  message?: string;
  severity?: 'error' | 'warning';
}

const isNonRelationalDialect = (dbType: string): boolean => dbType === 'redis' || dbType === 'mongodb' || isElasticsearchFamilyType(dbType);

const formatTableDesignerIndexMessage = (
  translate: TableDesignerIndexTranslate | undefined,
  key: string,
  params?: TableDesignerIndexMessageParams,
): string => {
  if (translate) {
    return translate(key, params);
  }
  return catalogTranslate('zh-CN', key, params);
};

export const buildIndexCreateSqlPreview = (input: BuildIndexCreateSqlInput): BuildIndexCreateSqlResult => {
  const dbType = input.dbType;
  const translate = input.translate;
  const kind = input.kind || 'NORMAL';
  const indexName = String(input.name || '').trim();
  const cleanedCols = input.columnNames.map(col => String(col || '').trim()).filter(Boolean);
  if (cleanedCols.length === 0) {
    return {
      sql: null,
      message: formatTableDesignerIndexMessage(translate, 'table_designer.message.select_at_least_one_column'),
      severity: 'error',
    };
  }
  const colSql = cleanedCols
    .map(col => quoteSqlIdentifierPart(dbType, col))
    .join(', ');

  if (isMysqlFamilyDialect(dbType)) {
    if (kind === 'PRIMARY') {
      return { sql: `ALTER TABLE ${input.tableRef}\nADD PRIMARY KEY (${colSql});` };
    }

    if (!indexName) {
      return {
        sql: null,
        message: formatTableDesignerIndexMessage(translate, 'table_designer.message.index_name_required'),
        severity: 'error',
      };
    }

    const indexRef = quoteSqlIdentifierPart(dbType, indexName);
    if (kind === 'FULLTEXT') {
      return { sql: `ALTER TABLE ${input.tableRef}\nADD FULLTEXT INDEX ${indexRef} (${colSql});` };
    }
    if (kind === 'SPATIAL') {
      return { sql: `ALTER TABLE ${input.tableRef}\nADD SPATIAL INDEX ${indexRef} (${colSql});` };
    }

    const normalizedType = String(input.indexType || '').trim().toUpperCase() || 'DEFAULT';
    if (normalizedType === 'FULLTEXT' || normalizedType === 'SPATIAL') {
      return {
        sql: null,
        message: formatTableDesignerIndexMessage(translate, 'table_designer.message.switch_index_kind', { kind: normalizedType }),
        severity: 'error',
      };
    }
    const usingSql = normalizedType !== 'DEFAULT' ? ` USING ${normalizedType}` : '';
    const prefix = kind === 'UNIQUE' ? 'ADD UNIQUE INDEX' : 'ADD INDEX';
    return { sql: `ALTER TABLE ${input.tableRef}\n${prefix} ${indexRef}${usingSql} (${colSql});` };
  }

  if (kind === 'PRIMARY' || kind === 'FULLTEXT' || kind === 'SPATIAL') {
    return {
      sql: null,
      message: formatTableDesignerIndexMessage(translate, 'table_designer.message.only_normal_unique_index_supported'),
      severity: 'warning',
    };
  }
  if (!indexName) {
    return {
      sql: null,
      message: formatTableDesignerIndexMessage(translate, 'table_designer.message.index_name_required'),
      severity: 'error',
    };
  }

  const indexRef = quoteSqlIdentifierPart(dbType, indexName);
  const normalizedType = String(input.indexType || '').trim().toUpperCase() || 'DEFAULT';
  const uniquePrefix = kind === 'UNIQUE' ? 'UNIQUE ' : '';

  if (isPgLikeDialect(dbType)) {
    const usingSql = normalizedType !== 'DEFAULT' ? ` USING ${normalizedType}` : '';
    return { sql: `CREATE ${uniquePrefix}INDEX ${indexRef} ON ${input.tableRef}${usingSql} (${colSql});` };
  }

  if (isSqlServerDialect(dbType)) {
    const methodSql = normalizedType === 'CLUSTERED' || normalizedType === 'NONCLUSTERED'
      ? `${normalizedType} `
      : '';
    return { sql: `CREATE ${uniquePrefix}${methodSql}INDEX ${indexRef} ON ${input.tableRef} (${colSql});` };
  }

  if (isOracleLikeDialect(dbType) || dbType === 'sqlite') {
    return { sql: `CREATE ${uniquePrefix}INDEX ${indexRef} ON ${input.tableRef} (${colSql});` };
  }

  if (isNonRelationalDialect(dbType)) {
    return {
      sql: null,
      message: formatTableDesignerIndexMessage(translate, 'table_designer.message.relational_index_unsupported'),
      severity: 'warning',
    };
  }
  return { sql: `CREATE ${uniquePrefix}INDEX ${indexRef} ON ${input.tableRef} (${colSql});` };
};

export interface BuildCreateTableIndexStatementInput {
  name: string;
  columnNames: string[];
  kind: TableDesignerIndexKind;
  indexType?: string;
}

export const buildCreateTableIndexStatements = (input: {
  dbType: string;
  tableRef: string;
  indexes?: BuildCreateTableIndexStatementInput[];
  translate?: TableDesignerIndexTranslate;
}): string => (
  (Array.isArray(input.indexes) ? input.indexes : [])
    .filter((index) => (index.kind || 'NORMAL') !== 'PRIMARY')
    .map((index) => buildIndexCreateSqlPreview({
      dbType: input.dbType,
      tableRef: input.tableRef,
      name: index.name,
      columnNames: index.columnNames,
      kind: index.kind,
      indexType: index.indexType,
      translate: input.translate,
    }).sql)
    .filter((sql): sql is string => Boolean(sql))
    .join('\n')
);
