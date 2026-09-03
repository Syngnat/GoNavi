import {
  splitQualifiedNameLast,
  splitQualifiedNameSegmentsDetailed,
  stripIdentifierQuotes,
} from '../utils/qualifiedName';
import { isOracleLikeDialect, isSqlServerDialect, resolveSqlDialect } from '../utils/sqlDialect';

const supportsRequestedSchemaSelection = (dbType: string): boolean => {
  const dialect = resolveSqlDialect(dbType);
  return dialect === 'postgres' || dialect === 'kingbase';
};

interface ResolveTableDesignerTableInfoInput {
  dbType: string;
  dbName: string;
  tableName: string;
  selectedSchema?: string;
}

interface ResolveTableDesignerEditTargetInput extends ResolveTableDesignerTableInfoInput {
  schemaSelectionOverride: boolean;
}

export const TABLE_DESIGNER_CURRENT_SCHEMA_SQL = 'SELECT current_schema() AS schema_name';

export const extractTableDesignerCurrentSchema = (rows: unknown): string => {
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0] || typeof rows[0] !== 'object') return '';
  const row = rows[0] as Record<string, unknown>;
  return String(row.schema_name ?? row.current_schema ?? Object.values(row)[0] ?? '').trim();
};

export const supportsTableDesignerSchemaSelection = supportsRequestedSchemaSelection;

export const resolveTableDesignerSchema = (
  tableName: string,
  selectedSchema: string,
  dbType: string,
): string => {
  if (!supportsRequestedSchemaSelection(dbType)) return '';
  const parsed = splitQualifiedNameLast(tableName);
  return stripIdentifierQuotes(parsed.parentPath || selectedSchema);
};

export const resolveInitialTableDesignerSchema = ({
  explicitSchema,
  rememberedSchema,
  currentSchema,
  schemaNames,
}: {
  explicitSchema: string;
  rememberedSchema: string;
  currentSchema: string;
  schemaNames: string[];
}): string => {
  const explicit = stripIdentifierQuotes(explicitSchema);
  if (explicit) return explicit;

  const remembered = stripIdentifierQuotes(rememberedSchema);
  const normalizedSchemaNames = schemaNames.map(schema => stripIdentifierQuotes(schema)).filter(Boolean);
  if (
    remembered
    && normalizedSchemaNames.some(schema => schema.toLocaleLowerCase() === remembered.toLocaleLowerCase())
  ) {
    return remembered;
  }
  return stripIdentifierQuotes(currentSchema) || (normalizedSchemaNames.length === 0 ? remembered : '');
};

export const resolveLoadedTableDesignerSchema = ({
  requestSeq,
  currentRequestSeq,
  latestSelectedSchema,
  explicitSchema,
  rememberedSchema,
  currentSchema,
  schemaNames,
}: {
  requestSeq: number;
  currentRequestSeq: number;
  latestSelectedSchema: string;
  explicitSchema: string;
  rememberedSchema: string;
  currentSchema: string;
  schemaNames: string[];
}): { selectedSchema: string; schemaNames: string[] } | null => {
  if (requestSeq !== currentRequestSeq) return null;
  const selectedSchema = stripIdentifierQuotes(latestSelectedSchema) || resolveInitialTableDesignerSchema({
    explicitSchema,
    rememberedSchema,
    currentSchema,
    schemaNames,
  });
  const normalizedSchemaNames = schemaNames.map(schema => stripIdentifierQuotes(schema)).filter(Boolean);
  if (
    selectedSchema
    && !normalizedSchemaNames.some(schema => schema.toLocaleLowerCase() === selectedSchema.toLocaleLowerCase())
  ) {
    normalizedSchemaNames.unshift(selectedSchema);
  }
  return { selectedSchema, schemaNames: normalizedSchemaNames };
};

export const qualifyTableDesignerCreateName = (
  tableName: string,
  selectedSchema: string,
  dbType: string,
): string => {
  const rawTableName = String(tableName || '').trim();
  if (!rawTableName || !supportsRequestedSchemaSelection(dbType)) return rawTableName;
  if (splitQualifiedNameLast(rawTableName, dbType).parentPath) return rawTableName;
  const schema = stripIdentifierQuotes(selectedSchema, dbType);
  return schema ? `${schema}.${rawTableName}` : rawTableName;
};

export const resolveTableDesignerTableInfo = ({
  dbType,
  dbName,
  tableName,
  selectedSchema,
}: ResolveTableDesignerTableInfoInput) => {
  const dialect = resolveSqlDialect(dbType);
  const rawTable = String(tableName || '').trim();
  const rawDb = String(dbName || '').trim();
  const segments = splitQualifiedNameSegmentsDetailed(rawTable, dialect);
  const parsed = splitQualifiedNameLast(rawTable, dialect);
  const table = stripIdentifierQuotes(parsed.objectName || rawTable, dialect);
  let schema = stripIdentifierQuotes(parsed.parentPath || (
    supportsRequestedSchemaSelection(dialect) ? (selectedSchema || '') : ''
  ), dialect);

  if (!schema) {
    if (supportsRequestedSchemaSelection(dialect)) {
      schema = '';
    } else if (isSqlServerDialect(dialect)) {
      schema = 'dbo';
    } else if (isOracleLikeDialect(dialect)) {
      schema = stripIdentifierQuotes(rawDb, dialect);
    } else {
      schema = stripIdentifierQuotes(rawDb, dialect);
    }
  }

  // Keep delimiters from the source path when rebuilding the identifier. A
  // table literally named `order.items` must remain one segment after the
  // schema context is resolved; reconstructing from the unquoted values would
  // turn it back into `schema.order.items`.
  const rawObjectName = String(segments[segments.length - 1]?.raw || rawTable).trim();
  const rawParentPath = segments.slice(0, -1).map((segment) => segment.raw).join('.');
  const qualifiedName = rawParentPath
    ? `${rawParentPath}.${rawObjectName}`
    : (schema ? `${schema}.${rawObjectName}` : rawObjectName);

  return {
    schema,
    table,
    qualifiedName,
  };
};

export const resolveTableDesignerEditTarget = ({
  dbType,
  dbName,
  tableName,
  selectedSchema,
  schemaSelectionOverride,
}: ResolveTableDesignerEditTargetInput) => {
  const dialect = resolveSqlDialect(dbType);
  const sourceTableName = schemaSelectionOverride
    ? (
      splitQualifiedNameSegmentsDetailed(tableName, dialect).slice(-1)[0]?.raw
      || splitQualifiedNameLast(tableName, dialect).objectName
      || tableName
    )
    : tableName;
  return resolveTableDesignerTableInfo({
    dbType,
    dbName,
    tableName: sourceTableName,
    selectedSchema,
  });
};
