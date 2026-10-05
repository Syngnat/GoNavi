import { buildSidebarTablePinKey } from '../../store';
import { readTableAccessCount } from '../../utils/tableAccessCount';
import type { SidebarTableSortPreference } from '../../utils/sidebarTreeOrder';
import {
  type SidebarTreeNode,
  type SidebarV2Translate,
  translateSidebarV2Current,
} from './sidebarV2TreeNodes';

export const resolveSidebarTableNameForCopy = (
  node: Pick<SidebarTreeNode, 'title' | 'dataRef'> | null | undefined,
): string => {
  return String(
    node?.dataRef?.messageObjectName
    || node?.dataRef?.topicName
    || node?.dataRef?.queueName
    || node?.dataRef?.exchangeName
    || node?.dataRef?.tableName
    || node?.dataRef?.viewName
    || node?.dataRef?.sequenceName
    || node?.dataRef?.packageName
    || node?.dataRef?.eventName
    || node?.title
    || '',
  ).trim();
};

type SidebarTableEntryForSort = {
  tableName: string;
  schemaName?: string;
  displayName: string;
  rowCount?: number;
};

export const isSidebarTablePinned = (
  pinnedKeys: string[],
  connectionId: string,
  dbName: string,
  tableName: string,
  schemaName = '',
): boolean => {
  const key = buildSidebarTablePinKey(connectionId, dbName, tableName, schemaName);
  return !!key && pinnedKeys.includes(key);
};

export const buildV2SidebarDatabaseSectionedChildren = (
  parentKey: string,
  databaseNodes: SidebarTreeNode[],
  translate: SidebarV2Translate = translateSidebarV2Current,
): SidebarTreeNode[] => {
  const nodesWithoutSections = databaseNodes.some((node) => node.type === 'v2-database-section')
    ? databaseNodes.filter((node) => node.type !== 'v2-database-section')
    : databaseNodes;
  const pinnedDatabases = nodesWithoutSections.filter((node) => node?.dataRef?.pinnedSidebarDatabase);
  if (pinnedDatabases.length === 0) return nodesWithoutSections;

  const regularDatabases = nodesWithoutSections.filter((node) => !node?.dataRef?.pinnedSidebarDatabase);
  const buildSectionNode = (kind: 'pinned' | 'all', title: string): SidebarTreeNode => ({
    title,
    key: `${parentKey}-v2-${kind}-databases-section`,
    type: 'v2-database-section',
    isLeaf: true,
    selectable: false,
    dataRef: {
      sectionKind: kind,
    },
  });

  return [
    buildSectionNode('pinned', translate('table_overview.section.pinned')),
    ...pinnedDatabases,
    buildSectionNode('all', translate('table_overview.section.all')),
    ...regularDatabases,
  ];
};

export const sortSidebarTableEntries = <T extends SidebarTableEntryForSort>(
  entries: T[],
  options: {
    connectionId: string;
    dbName: string;
    sortBy: SidebarTableSortPreference;
    tableAccessCount?: Record<string, number>;
    pinnedSidebarTables?: string[];
  },
): T[] => {
  const pinnedKeys = options.pinnedSidebarTables || [];
  const accessCount = options.tableAccessCount || {};
  const compareByName = (a: T, b: T) => a.displayName.localeCompare(
    b.displayName,
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
  const compareWithinPinnedGroup = (a: T, b: T) => {
    if (options.sortBy === 'frequency') {
      const countA = readTableAccessCount(
        accessCount,
        options.connectionId,
        options.dbName,
        a.tableName,
      );
      const countB = readTableAccessCount(
        accessCount,
        options.connectionId,
        options.dbName,
        b.tableName,
      );
      if (countA !== countB) {
        return countB - countA;
      }
    }
    return compareByName(a, b);
  };

  return [...entries].sort((a, b) => {
    const pinnedA = isSidebarTablePinned(pinnedKeys, options.connectionId, options.dbName, a.tableName, a.schemaName || '');
    const pinnedB = isSidebarTablePinned(pinnedKeys, options.connectionId, options.dbName, b.tableName, b.schemaName || '');
    if (pinnedA !== pinnedB) {
      return pinnedA ? -1 : 1;
    }
    return compareWithinPinnedGroup(a, b);
  });
};

export const buildV2SidebarTableSectionedChildren = (
  parentKey: string,
  tableNodes: SidebarTreeNode[],
  translate: SidebarV2Translate = translateSidebarV2Current,
): SidebarTreeNode[] => {
  const pinnedTables = tableNodes.filter((node) => node?.dataRef?.pinnedSidebarTable);
  if (pinnedTables.length === 0) return tableNodes;

  const regularTables = tableNodes.filter((node) => !node?.dataRef?.pinnedSidebarTable);
  const buildSectionNode = (kind: 'pinned' | 'all', title: string): SidebarTreeNode => ({
    title,
    key: `${parentKey}-v2-${kind}-tables-section`,
    type: 'v2-table-section',
    isLeaf: true,
    selectable: false,
    dataRef: {
      sectionKind: kind,
    },
  });

  return [
    buildSectionNode('pinned', translate('table_overview.section.pinned')),
    ...pinnedTables,
    buildSectionNode('all', translate('table_overview.section.all')),
    ...regularTables,
  ];
};

export const buildSidebarTableChildrenForUi = (
  parentKey: string,
  tableNodes: SidebarTreeNode[],
  translate: SidebarV2Translate = translateSidebarV2Current,
): SidebarTreeNode[] => {

  return buildV2SidebarTableSectionedChildren(parentKey, tableNodes, translate);
};

export const formatSidebarRowCount = (count: number): string => {
  if (!Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(Math.round(count));
};
