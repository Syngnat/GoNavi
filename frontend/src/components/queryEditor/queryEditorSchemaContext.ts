import type { ConnectionConfig } from '../../types';
import { isPostgresSchemaDialect } from '../../utils/connectionDriverType';

export const QUERY_EDITOR_CURRENT_SCHEMA_SQL = 'SELECT current_schema() AS schema_name';

const normalizeSchemaName = (value: unknown): string => String(value ?? '').trim();

export const supportsQueryEditorSchemaSelection = (dbType: string): boolean => (
  isPostgresSchemaDialect(dbType)
);

export const shouldIncludeQueryEditorSchemaObject = (
  selectedSchema: string,
  objectSchema: string,
): boolean => {
  const selected = normalizeSchemaName(selectedSchema);
  const object = normalizeSchemaName(objectSchema);
  return !selected || !object || selected === object;
};

export const extractQueryEditorCurrentSchema = (rows: unknown): string => {
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0] || typeof rows[0] !== 'object') return '';
  const row = rows[0] as Record<string, unknown>;
  return normalizeSchemaName(row.schema_name ?? row.current_schema ?? Object.values(row)[0]);
};

export const resolveLoadedQueryEditorSchema = ({
  requestSeq,
  currentRequestSeq,
  latestSelectedSchema,
  rememberedSchema,
  currentSchema,
  schemaNames,
}: {
  requestSeq: number;
  currentRequestSeq: number;
  latestSelectedSchema: string;
  rememberedSchema: string;
  currentSchema: string;
  schemaNames: string[];
}): { selectedSchema: string; schemaNames: string[] } | null => {
  if (requestSeq !== currentRequestSeq) return null;

  const normalizedSchemaNames = Array.from(new Set(
    schemaNames.map(normalizeSchemaName).filter(Boolean),
  ));
  const latest = normalizeSchemaName(latestSelectedSchema);
  const remembered = normalizeSchemaName(rememberedSchema);
  const databaseDefault = normalizeSchemaName(currentSchema);
  const selectedSchema = latest
    || (normalizedSchemaNames.includes(remembered) ? remembered : '')
    || databaseDefault
    || (normalizedSchemaNames.includes('public') ? 'public' : '')
    || normalizedSchemaNames[0]
    || remembered;

  if (selectedSchema && !normalizedSchemaNames.includes(selectedSchema)) {
    normalizedSchemaNames.unshift(selectedSchema);
  }
  return { selectedSchema, schemaNames: normalizedSchemaNames };
};

export const quotePostgresSearchPathIdentifier = (schemaName: string): string => {
  const normalized = normalizeSchemaName(schemaName);
  return normalized ? `"${normalized.replace(/"/g, '""')}"` : '';
};

export const applyQueryEditorSchemaSearchPath = <T extends Pick<ConnectionConfig, 'connectionParams'>>(
  config: T,
  schemaName: string,
): T => {
  const normalizedSchemaName = normalizeSchemaName(schemaName);
  const selectedSearchPath = quotePostgresSearchPathIdentifier(normalizedSchemaName);
  if (!selectedSearchPath) return config;

  const searchPath = normalizedSchemaName === 'public'
    ? selectedSearchPath
    : `${selectedSearchPath},"public"`;

  const params = new URLSearchParams(String(config.connectionParams || ''));
  params.set('search_path', searchPath);
  return {
    ...config,
    connectionParams: params.toString(),
  };
};
