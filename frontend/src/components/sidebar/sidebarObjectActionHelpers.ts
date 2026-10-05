import { splitQualifiedName } from './sidebarMetadataLoaders';
import { buildSidebarSchemaNodeKey } from '../../utils/sidebarLocate';

export const resolveNodeSchemaName = (node: any): string | undefined => {
  const schemaName = String(node?.dataRef?.schemaName ?? '').trim();
  return schemaName || undefined;
};

const quoteMySqlIdentifier = (raw: string): string => `\`${String(raw || '').replace(/`/g, '``')}\``;

export const buildMySqlEventReference = (eventName: string, schemaName?: string): string => {
  const parsed = splitQualifiedName(eventName);
  const name = parsed.objectName || eventName;
  const schema = parsed.schemaName || String(schemaName || '').trim();
  return [schema, name]
    .filter(Boolean)
    .map(quoteMySqlIdentifier)
    .join('.');
};

export const ensureSidebarObjectEditSqlTerminator = (sql: string): string => {
  const normalized = String(sql || '').trim();
  if (!normalized) return '';
  return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

export const getSidebarSchemaTreeKeyPrefixes = (
  connectionId: unknown,
  dbName: unknown,
  schemaName: unknown,
): string[] => {
  const databaseKey = `${String(connectionId || '').trim()}-${String(dbName || '').trim()}`;
  const schema = String(schemaName || '').trim();
  return Array.from(new Set([
    buildSidebarSchemaNodeKey(databaseKey, schema),
    // Keep cleanup compatible with trees created before schema identities were
    // encoded; those keys can remain in expanded/loaded state during refresh.
    `${databaseKey}-schema-${schema || 'default'}`,
  ]));
};

export const isSidebarSchemaTreeKey = (key: unknown, prefixes: readonly string[]): boolean => {
  const value = String(key || '');
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}-`));
};

export const extractMySqlEventCreateSql = (rows: any[]): string => {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  for (const row of rows) {
    const keys = Object.keys(row || {});
    const sqlKey = keys.find(key => key.toLowerCase().includes('create event'));
    if (!sqlKey) continue;
    const definition = row[sqlKey];
    if (definition !== undefined && definition !== null && String(definition).trim()) {
      return String(definition);
    }
  }
  return '';
};
