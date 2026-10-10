import type { SavedConnection } from '../../types';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import { getMetadataDialect, getCaseInsensitiveValue, getSidebarTableName, getSidebarTableDisplayName, parseSidebarTableRowCount } from './sidebarMetadataBasics';
import { splitQualifiedNameSegmentsDetailed } from '../../utils/qualifiedName';
import type { SidebarLoadedTableEntry } from './sidebarTreeLoaderHelpers';
import { buildSidebarSchemaNodeKey, encodeSidebarSchemaIdentity } from '../../utils/sidebarLocate';

export const supportsSidebarSchemaLazyLoading = (connection: SavedConnection): boolean => (
  ['postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb', 'sqlserver'].includes(getMetadataDialect(connection))
  && connection.config.type !== 'custom'
);

export const sidebarSchemaNodeKey = buildSidebarSchemaNodeKey;

export const sidebarSchemaLoadKey = (connectionId: string, dbName: string, schemaName: string): string => (
  `tables-${connectionId}-${dbName}-schema-${encodeSidebarSchemaIdentity(schemaName)}`
);

export const findSidebarSchemaTreeNode = (nodes: SidebarTreeNode[], key: string): SidebarTreeNode | undefined => {
  for (const node of nodes) {
    if (String(node.key) === key) return node;
    const child = findSidebarSchemaTreeNode(node.children || [], key);
    if (child) return child;
  }
};

/** Object/statistics refills must not discard columns or indexes already expanded by the user. */
export const preserveSidebarSchemaObjectChildren = (next: SidebarTreeNode[], previous: SidebarTreeNode[]): SidebarTreeNode[] => {
  const byKey = new Map<string, SidebarTreeNode>();
  const collect = (nodes: SidebarTreeNode[]) => nodes.forEach((node) => { byKey.set(String(node.key), node); collect(node.children || []); });
  collect(previous);
  const merge = (nodes: SidebarTreeNode[]): SidebarTreeNode[] => nodes.map((node) => {
    const old = byKey.get(String(node.key));
    const children = node.children ? merge(node.children) : old?.children;
    return children ? { ...node, children, ...(children.length ? { isLeaf: false } : {}) } : node;
  });
  return merge(next);
};

/** Merge status by exact qualified identity: equally named tables in another schema never share statistics. */
export const buildSidebarSchemaTableEntries = (
  connection: SavedConnection,
  schemaName: string,
  tableRows: Record<string, unknown>[],
  statusRows: Record<string, unknown>[],
): SidebarLoadedTableEntry[] => {
  const dialect = getMetadataDialect(connection);
  const identity = (tableName: string, schema: string, object?: string): string => {
    // Catalog fields are literal names; a qualified transport name must be decoded once.
    if (object) return JSON.stringify([schema, object]);
    const parts = splitQualifiedNameSegmentsDetailed(tableName, dialect);
    return JSON.stringify([parts.length > 1 ? parts.slice(0, -1).map((part) => part.value).join('.') : schema, parts[parts.length - 1]?.value || tableName]);
  };
  const metadata = new Map<string, Record<string, unknown>>();
  for (const row of statusRows) {
    const schema = getCaseInsensitiveValue(row, ['schema_name']) || schemaName;
    const object = getCaseInsensitiveValue(row, ['object_name']);
    const tableName = getCaseInsensitiveValue(row, ['table_name', 'Name']);
    if (tableName || object) metadata.set(identity(tableName, schema, object), row);
  }
  const number = (value: string): number | undefined => value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
  return tableRows.map((row) => {
    const tableName = getSidebarTableName(row);
    const parts = splitQualifiedNameSegmentsDetailed(tableName, dialect);
    const tableSchema = parts.length > 1 ? parts.slice(0, -1).map((part) => part.value).join('.') : schemaName;
    const status = metadata.get(identity(tableName, schemaName)) || {};
    const value = (keys: string[]) => getCaseInsensitiveValue(status, keys) || getCaseInsensitiveValue(row, keys);
    return {
      tableName, schemaName: tableSchema, displayName: getSidebarTableDisplayName(connection, tableName),
      rowCount: parseSidebarTableRowCount(status, connection) ?? parseSidebarTableRowCount(row, connection),
      tableSize: number(value(['table_size', 'Data_length'])),
      tableComment: value(['table_comment', 'Comment']),
      createdAt: value(['create_time', 'created_at']) || undefined,
      updatedAt: value(['update_time', 'updated_at']) || undefined,
      partitionParentTableName: value(['partition_parent_table']) || undefined,
    };
  }).filter((entry) => entry.tableName !== '');
};
