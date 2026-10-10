import { useStore } from '../../store';
import type { SidebarTableSortPreference } from '../../utils/sidebarTreeOrder';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import {
  buildV2SidebarTableSectionedChildren,
  isSidebarTablePinned,
  sortSidebarTableEntries,
} from './sidebarV2TableSections';

export type SidebarTablePinScope = {
  connectionId: string;
  dbName: string;
};

export type SidebarTablePinSortOptions = {
  pinnedSidebarTables: string[];
  sortBy: SidebarTableSortPreference;
  tableAccessCount?: Record<string, number>;
};

const isTablesGroup = (node: SidebarTreeNode): boolean => (
  node.type === 'object-group' && node.dataRef?.groupKey === 'tables'
);

const matchesDatabase = (node: SidebarTreeNode, scope: SidebarTablePinScope): boolean => {
  const ref = node.dataRef || {};
  return String(ref.id || ref.connectionId || '').trim() === scope.connectionId
    && String(ref.dbName || '').trim() === scope.dbName;
};

const applyTablePinFlag = (
  node: SidebarTreeNode,
  pinnedKeys: string[],
): SidebarTreeNode => {
  const ref = node.dataRef || {};
  const pinned = isSidebarTablePinned(
    pinnedKeys,
    String(ref.id || ''),
    String(ref.dbName || ''),
    String(ref.tableName || ''),
    String(ref.schemaName || ''),
  );
  if (Boolean(ref.pinnedSidebarTable) === pinned) return node;
  const dataRef = { ...ref };
  if (pinned) dataRef.pinnedSidebarTable = true;
  else delete dataRef.pinnedSidebarTable;
  return { ...node, dataRef };
};

/** Returns new group children when a pin flag changed, otherwise null. */
export const rebuildSidebarTableGroupChildren = (
  group: SidebarTreeNode,
  options: SidebarTablePinSortOptions,
): SidebarTreeNode[] | null => {
  const tables = (group.children || []).filter((node) => node.type === 'table');
  const flagged = tables.map((node) => applyTablePinFlag(node, options.pinnedSidebarTables));
  if (flagged.every((node, index) => node === tables[index])) return null;

  const sorted = sortSidebarTableEntries(flagged.map((node) => ({
    node,
    tableName: String(node.dataRef?.tableName || ''),
    schemaName: String(node.dataRef?.schemaName || ''),
    displayName: String(node.title || node.dataRef?.tableName || ''),
  })), {
    connectionId: String(group.dataRef?.id || group.dataRef?.connectionId || ''),
    dbName: String(group.dataRef?.dbName || ''),
    sortBy: options.sortBy,
    tableAccessCount: options.tableAccessCount,
    pinnedSidebarTables: options.pinnedSidebarTables,
  }).map((entry) => entry.node);

  return buildV2SidebarTableSectionedChildren(String(group.key), sorted);
};

export const collectSidebarTablePinUpdates = (
  nodes: SidebarTreeNode[],
  scope: SidebarTablePinScope,
  options: SidebarTablePinSortOptions,
): Array<{ key: string; children: SidebarTreeNode[] }> => {
  const updates: Array<{ key: string; children: SidebarTreeNode[] }> = [];
  const visit = (list: SidebarTreeNode[]) => {
    list.forEach((node) => {
      if (isTablesGroup(node) && matchesDatabase(node, scope)) {
        const children = rebuildSidebarTableGroupChildren(node, options);
        if (children) updates.push({ key: String(node.key), children });
      }
      if (node.children?.length) visit(node.children);
    });
  };
  visit(Array.isArray(nodes) ? nodes : []);
  return updates;
};

const resolveTableSort = (
  connectionId: string,
  dbName: string,
): SidebarTableSortPreference => {
  const preference = useStore.getState().tableSortPreference?.[`${connectionId}-${dbName}`];
  return preference === 'frequency' || preference === 'manual' ? preference : 'name';
};

/**
 * Reorder tables that are already on screen. A database reload on schema-lazy
 * engines replaces each schema with an unloaded placeholder and drops those
 * keys from expandedKeys, so the open table list collapses.
 */
export const syncLoadedSidebarTablePins = (
  nodes: SidebarTreeNode[],
  scope: SidebarTablePinScope,
  replaceTreeNodeChildren: (key: React.Key, children: SidebarTreeNode[]) => void,
): void => {
  const state = useStore.getState();
  const updates = collectSidebarTablePinUpdates(nodes, scope, {
    pinnedSidebarTables: state.pinnedSidebarTables || [],
    sortBy: resolveTableSort(scope.connectionId, scope.dbName),
    tableAccessCount: state.tableAccessCount,
  });
  updates.forEach((update) => replaceTreeNodeChildren(update.key, update.children));
};
