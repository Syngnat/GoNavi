import type { Key, ReactNode } from 'react';

import {
  resolveConnectionTagChildOrder,
  buildSidebarDatabasePinKey,
  buildSidebarRootConnectionToken,
  buildSidebarRootTagToken,
  buildSidebarTablePinKey,
  resolveSidebarRootOrderTokens,
} from '../store';
import type { ConnectionTag, SavedConnection, TabData } from '../types';
import type { SidebarTableMetadataField } from '../utils/sidebarTableMetadata';
import { readTableAccessCount } from '../utils/tableAccessCount';
import { t } from '../i18n';
import { t as catalogTranslate } from '../i18n/catalog';
import {
  buildSidebarTableMetadataDisplayItems,
  buildSidebarTableMetadataSnapshot,
} from './sidebar/sidebarHelpers';

type SidebarV2Translate = (key: string) => string;

const translateSidebarV2Current: SidebarV2Translate = (key) => t(key);
const translateSidebarV2ZhCN: SidebarV2Translate = (key) => catalogTranslate('zh-CN', key);

export type SidebarConnectionState = 'loading' | 'success' | 'error';

export type SidebarTreeNodeType =
  | 'connection'
  | 'database'
  | 'table'
  | 'view'
  | 'materialized-view'
  | 'db-trigger'
  | 'db-event'
  | 'routine'
  | 'sequence'
  | 'package'
  | 'object-group'
  | 'v2-database-section'
  | 'v2-table-section'
  | 'queries-folder'
  | 'saved-query'
  | 'all-saved-queries'
  | 'saved-query-group'
  | 'saved-query-manual-group'
  | 'unmatched-saved-queries'
  | 'external-sql-root'
  | 'external-sql-directory'
  | 'external-sql-folder'
  | 'external-sql-file'
  | 'folder-columns'
  | 'folder-indexes'
  | 'folder-fks'
  | 'folder-triggers'
  | 'redis-db'
  | 'nacos-namespace'
  | 'nacos-config-entry'
  | 'nacos-config-group'
  | 'nacos-services-entry'
  | 'nacos-service-group'
  | 'tag'
  | 'jvm-mode'
  | 'jvm-resource'
  | 'jvm-diagnostic'
  | 'jvm-monitoring';

export interface SidebarTreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  selectable?: boolean;
  children?: SidebarTreeNode[];
  icon?: ReactNode;
  dataRef?: any;
  type?: SidebarTreeNodeType;
}

export const hasSidebarLazyChildren = (children: unknown): boolean => {
  return Array.isArray(children) && children.length > 0;
};

export const shouldLoadSidebarNodeOnExpand = (
  node: Pick<SidebarTreeNode, 'type' | 'children' | 'isLeaf'> | null | undefined,
): boolean => {
  if (!node || node.isLeaf === true || hasSidebarLazyChildren(node.children)) return false;
  return node.type === 'connection'
    || node.type === 'database'
    || node.type === 'external-sql-root'
    || node.type === 'table'
    || node.type === 'jvm-mode'
    || node.type === 'jvm-resource'
    || node.type === 'nacos-config-entry'
    || node.type === 'nacos-services-entry';
};

type NacosServicesTabDataRef = {
  id?: unknown;
  nacosNamespaceId?: unknown;
  nacosNamespaceName?: unknown;
  nacosGroup?: unknown;
};

export type NacosNamespaceDiscoveryMode = 'listed' | 'configured';

export const resolveNacosNamespaceDiscoveryModeFromTreeNode = (
  node: Partial<SidebarTreeNode> | null | undefined,
): NacosNamespaceDiscoveryMode | undefined => {
  if (!node) return undefined;
  const pending = [node];
  let foundListedMode = false;
  while (pending.length > 0) {
    const current = pending.pop();
    const mode = current?.dataRef?.nacosNamespaceDiscoveryMode;
    if (mode === 'configured') return 'configured';
    if (mode === 'listed') foundListedMode = true;
    if (Array.isArray(current?.children)) {
      pending.push(...current.children);
    }
  }
  return foundListedMode ? 'listed' : undefined;
};

const encodeNacosServicesTabIdPart = (value: string): string =>
  encodeURIComponent(value)
    .split('-ns-').join('%2Dns%2D')
    .split('-g-').join('%2Dg%2D');

export const buildNacosServicesTabData = (dataRef: NacosServicesTabDataRef): TabData => {
  const connectionId = String(dataRef?.id || '').trim();
  const namespaceId = String(dataRef?.nacosNamespaceId || '').trim();
  const namespaceName = String(dataRef?.nacosNamespaceName || namespaceId || 'public').trim();
  const groupName = String(dataRef?.nacosGroup || '').trim();
  const namespaceKey = namespaceId || 'public';
  const connectionTabKey = encodeNacosServicesTabIdPart(connectionId);
  const namespaceTabKey = encodeNacosServicesTabIdPart(namespaceKey);
  const groupTabKey = encodeNacosServicesTabIdPart(groupName);

  return {
    id: `nacos-services-${connectionTabKey}-ns-${namespaceTabKey}${groupName ? `-g-${groupTabKey}` : ''}`,
    title: groupName
      ? `${namespaceName} · ${groupName}`
      : `${namespaceName} · ${t('nacos_service.title.service_explorer')}`,
    type: 'nacos-services',
    connectionId,
    nacosNamespaceId: namespaceId,
    nacosNamespaceName: namespaceName,
    ...(groupName ? { nacosGroup: groupName } : {}),
  };
};

export type NacosServicesDoubleClickAction =
  | { kind: 'expand' }
  | { kind: 'open'; tab: TabData }
  | null;

export const resolveNacosServicesDoubleClickAction = (
  node: Pick<SidebarTreeNode, 'type' | 'dataRef'> | null | undefined,
): NacosServicesDoubleClickAction => {
  if (node?.type === 'nacos-services-entry') return { kind: 'expand' };
  if (node?.type === 'nacos-service-group') {
    return { kind: 'open', tab: buildNacosServicesTabData(node.dataRef || {}) };
  }
  return null;
};

export const resolveSidebarTableNameForCopy = (
  node: Pick<SidebarTreeNode, 'title' | 'dataRef'> | null | undefined,
): string => {
  return String(node?.dataRef?.tableName || node?.dataRef?.viewName || node?.dataRef?.sequenceName || node?.dataRef?.packageName || node?.dataRef?.eventName || node?.title || '').trim();
};

type SidebarTableSortPreference = 'name' | 'frequency';

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

export const isSidebarDatabasePinned = (
  pinnedKeys: string[],
  connectionId: string,
  dbName: string,
): boolean => {
  const key = buildSidebarDatabasePinKey(connectionId, dbName);
  return !!key && pinnedKeys.includes(key);
};

export const applySidebarDatabasePinning = (
  nodes: SidebarTreeNode[],
  options: {
    connectionId: string;
    pinnedSidebarDatabases?: string[];
  },
): SidebarTreeNode[] => {
  const pinnedNodes: Array<{ node: SidebarTreeNode; order: number; index: number }> = [];
  const regularNodes: Array<{ node: SidebarTreeNode; order: number; index: number }> = [];
  const pinnedKeys = options.pinnedSidebarDatabases || [];

  nodes.forEach((node, index) => {
    if (node.type === 'v2-database-section') {
      return;
    }
    if (node.type !== 'database') {
      regularNodes.push({ node, order: index, index });
      return;
    }
    const dbName = String(node.dataRef?.dbName || node.title || '').trim();
    const pinned = isSidebarDatabasePinned(pinnedKeys, options.connectionId, dbName);
    const currentlyPinned = node.dataRef?.pinnedSidebarDatabase === true;
    const savedOrder = Number(node.dataRef?.sidebarDatabaseOrder);
    const order = Number.isSafeInteger(savedOrder) && savedOrder >= 0 ? savedOrder : index;
    let nextNode = node;
    if (currentlyPinned !== pinned || node.dataRef?.sidebarDatabaseOrder !== order) {
      const dataRef = { ...(node.dataRef || {}) };
      dataRef.sidebarDatabaseOrder = order;
      if (pinned) {
        dataRef.pinnedSidebarDatabase = true;
      } else {
        delete dataRef.pinnedSidebarDatabase;
      }
      nextNode = { ...node, dataRef };
    }
    (pinned ? pinnedNodes : regularNodes).push({ node: nextNode, order, index });
  });

  const byOriginalOrder = (
    left: { order: number; index: number },
    right: { order: number; index: number },
  ) => left.order - right.order || left.index - right.index;

  return [
    ...pinnedNodes.sort(byOriginalOrder),
    ...regularNodes.sort(byOriginalOrder),
  ].map(({ node }) => node);
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
  isV2Ui: boolean,
  translate: SidebarV2Translate = translateSidebarV2Current,
): SidebarTreeNode[] => {
  if (!isV2Ui) return tableNodes;
  return buildV2SidebarTableSectionedChildren(parentKey, tableNodes, translate);
};

export const formatSidebarRowCount = (count: number): string => {
  if (!Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(Math.round(count));
};

export interface V2RailConnectionGroup {
  id: string;
  name: string;
  connections: SavedConnection[];
  directConnections?: SavedConnection[];
  children?: V2RailConnectionGroup[];
  isUngrouped?: boolean;
  rootToken: string;
}

export type SidebarConnectionTagTreeItem =
  | {
    kind: 'tag';
    id: string;
    token: string;
    tag: ConnectionTag;
    children: SidebarConnectionTagTreeItem[];
  }
  | {
    kind: 'connection';
    id: string;
    token: string;
    connection: SavedConnection;
  };

const resolveConnectionTagParentId = (tag: ConnectionTag): string =>
  String(tag.parentTagId || '').trim();

/**
 * Returns true when candidateChildTagId is below ancestorTagId. The guard also
 * makes a malformed persisted loop harmless while the store normalizes it.
 */
export const isConnectionTagDescendant = (
  ancestorTagId: string,
  candidateChildTagId: string | null | undefined,
  connectionTags: ConnectionTag[],
): boolean => {
  const ancestorId = String(ancestorTagId || '').trim();
  let currentId = String(candidateChildTagId || '').trim();
  if (!ancestorId || !currentId) return false;

  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    if (currentId === ancestorId) return true;
    seen.add(currentId);
    const currentTag = tagById.get(currentId);
    if (!currentTag) break;
    currentId = resolveConnectionTagParentId(currentTag);
  }
  return false;
};

/**
 * Builds the host-group hierarchy from flat persisted records. `childOrder`
 * owns the mixed sibling order while `parentTagId` owns group containment.
 */
export const buildSidebarConnectionTagTree = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[] = [],
): SidebarConnectionTagTreeItem[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const rawParentById = new Map(
    connectionTags.map((tag) => [tag.id, resolveConnectionTagParentId(tag)]),
  );

  const resolveSafeParentId = (tagId: string): string => {
    const parentId = rawParentById.get(tagId) || '';
    if (!parentId || !tagById.has(parentId) || parentId === tagId) return '';

    const seen = new Set<string>([tagId]);
    let currentId = parentId;
    while (currentId) {
      if (seen.has(currentId)) return '';
      seen.add(currentId);
      const nextId = rawParentById.get(currentId) || '';
      if (!nextId || !tagById.has(nextId)) break;
      currentId = nextId;
    }
    return parentId;
  };

  const parentByTagId = new Map<string, string>();
  const childTagIdsByParentId = new Map<string, string[]>();
  const rootTagIds: string[] = [];
  connectionTags.forEach((tag) => {
    const parentId = resolveSafeParentId(tag.id);
    parentByTagId.set(tag.id, parentId);
    if (!parentId) {
      rootTagIds.push(tag.id);
      return;
    }
    const childIds = childTagIdsByParentId.get(parentId) || [];
    childIds.push(tag.id);
    childTagIdsByParentId.set(parentId, childIds);
  });

  // A connection can only be rendered once, even if an old persisted payload
  // still lists it in more than one group before hydration cleanup runs.
  const connectionOwnerTagId = new Map<string, string>();
  connectionTags.forEach((tag) => {
    tag.connectionIds.forEach((connectionId) => {
      if (!connectionById.has(connectionId) || connectionOwnerTagId.has(connectionId)) return;
      connectionOwnerTagId.set(connectionId, tag.id);
    });
  });

  const directConnectionIdsForTag = (tagId: string): string[] => {
    const tag = tagById.get(tagId);
    if (!tag) return [];
    return tag.connectionIds.filter((connectionId) => (
      connectionOwnerTagId.get(connectionId) === tagId && connectionById.has(connectionId)
    ));
  };

  const resolveOrderedChildTokens = (tagId: string): string[] => {
    const directTagIds = childTagIdsByParentId.get(tagId) || [];
    const directConnectionIds = directConnectionIdsForTag(tagId);
    const allowedTokens = new Set([
      ...directConnectionIds.map(buildSidebarRootConnectionToken),
      ...directTagIds.map(buildSidebarRootTagToken),
    ]);
    const result: string[] = [];
    const append = (token: string) => {
      if (!allowedTokens.has(token) || result.includes(token)) return;
      result.push(token);
    };

    resolveConnectionTagChildOrder(tagId, connectionTags).forEach(append);
    // Legacy groups have no childOrder; keep their old host-first layout and
    // append any new subgroup records in their persisted creation order.
    directConnectionIds.forEach((id) => append(buildSidebarRootConnectionToken(id)));
    directTagIds.forEach((id) => append(buildSidebarRootTagToken(id)));
    return result;
  };

  const rootConnectionIds = connections
    .map((connection) => connection.id)
    .filter((connectionId) => !connectionOwnerTagId.has(connectionId));
  const rootAllowedTokens = new Set([
    ...rootTagIds.map(buildSidebarRootTagToken),
    ...rootConnectionIds.map(buildSidebarRootConnectionToken),
  ]);
  const orderedRootTokens: string[] = [];
  const appendRoot = (token: string) => {
    if (!rootAllowedTokens.has(token) || orderedRootTokens.includes(token)) return;
    orderedRootTokens.push(token);
  };
  resolveSidebarRootOrderTokens(sidebarRootOrder, connectionTags, connections).forEach(appendRoot);
  rootTagIds.forEach((id) => appendRoot(buildSidebarRootTagToken(id)));
  rootConnectionIds.forEach((id) => appendRoot(buildSidebarRootConnectionToken(id)));

  const buildTagItem = (tagId: string, activeTagIds: Set<string>): SidebarConnectionTagTreeItem | null => {
    const tag = tagById.get(tagId);
    if (!tag || activeTagIds.has(tagId)) return null;

    const nextActiveTagIds = new Set(activeTagIds);
    nextActiveTagIds.add(tagId);
    const children: SidebarConnectionTagTreeItem[] = [];
    resolveOrderedChildTokens(tagId).forEach((token) => {
      if (token.startsWith('tag:')) {
        const childTagId = token.slice('tag:'.length);
        if (parentByTagId.get(childTagId) !== tagId) return;
        const child = buildTagItem(childTagId, nextActiveTagIds);
        if (child) children.push(child);
        return;
      }
      if (token.startsWith('connection:')) {
        const connectionId = token.slice('connection:'.length);
        if (connectionOwnerTagId.get(connectionId) !== tagId) return;
        const connection = connectionById.get(connectionId);
        if (!connection) return;
        children.push({
          kind: 'connection',
          id: connectionId,
          token,
          connection,
        });
      }
    });

    return {
      kind: 'tag',
      id: tag.id,
      token: buildSidebarRootTagToken(tag.id),
      tag,
      children,
    };
  };

  const rootItems: SidebarConnectionTagTreeItem[] = [];
  orderedRootTokens.forEach((token) => {
    if (token.startsWith('tag:')) {
      const tagId = token.slice('tag:'.length);
      if (parentByTagId.get(tagId)) return;
      const tag = buildTagItem(tagId, new Set());
      if (tag) rootItems.push(tag);
      return;
    }
    if (token.startsWith('connection:')) {
      const connectionId = token.slice('connection:'.length);
      if (connectionOwnerTagId.has(connectionId)) return;
      const connection = connectionById.get(connectionId);
      if (!connection) return;
      rootItems.push({
        kind: 'connection',
        id: connectionId,
        token,
        connection,
      });
    }
  });

  return rootItems;
};

export const buildV2RailConnectionGroups = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[] = [],
): V2RailConnectionGroup[] => {
  const buildGroup = (item: SidebarConnectionTagTreeItem): V2RailConnectionGroup => {
    if (item.kind === 'connection') {
      return {
        id: item.id,
        name: item.connection.name,
        connections: [item.connection],
        directConnections: [item.connection],
        isUngrouped: true,
        rootToken: item.token,
      };
    }

    const directConnections = item.children
      .filter((child): child is Extract<SidebarConnectionTagTreeItem, { kind: 'connection' }> => child.kind === 'connection')
      .map((child) => child.connection);
    const children = item.children
      .filter((child): child is Extract<SidebarConnectionTagTreeItem, { kind: 'tag' }> => child.kind === 'tag')
      .map(buildGroup);
    return {
      id: item.id,
      name: item.tag.name || t('connection.sidebar.group.untitled'),
      connections: [...directConnections, ...children.flatMap((child) => child.connections)],
      directConnections,
      children,
      rootToken: item.token,
    };
  };

  return buildSidebarConnectionTagTree(connections, connectionTags, sidebarRootOrder).map(buildGroup);
};

export const resolveV2ConnectionGroup = (
  node: Pick<SidebarTreeNode, 'type' | 'dataRef'> | null | undefined,
  groups: V2RailConnectionGroup[],
): V2RailConnectionGroup | null => {
  if (node?.type !== 'tag') return null;
  const groupId = String(node.dataRef?.id || '').trim();
  if (!groupId) return null;

  const findGroup = (items: V2RailConnectionGroup[]): V2RailConnectionGroup | null => {
    for (const group of items) {
      if (group.id === groupId) return group;
      const childMatch = findGroup(group.children || []);
      if (childMatch) return childMatch;
    }
    return null;
  };

  return findGroup(groups);
};

export const getV2RailConnectionGroupBadgeText = (name: unknown, fallback = t('connection.sidebar.group.badge')): string => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return fallback;
  const cjkParts = trimmed.match(/[\u4e00-\u9fa5]/g);
  if (cjkParts && cjkParts.length > 0) {
    return cjkParts.slice(0, 1).join('');
  }
  const latinTokens = trimmed.match(/[a-z0-9]+/gi) || [];
  if (latinTokens.length >= 2) {
    const firstToken = latinTokens[0] || '';
    const secondToken = latinTokens[1] || '';
    return `${firstToken[0] || ''}${secondToken[0] || ''}`.toUpperCase();
  }
  if (latinTokens.length === 1) {
    const token = latinTokens[0] || '';
    const alphaPrefix = token.match(/^[a-z]+/i)?.[0] || '';
    if (alphaPrefix) {
      return alphaPrefix.slice(0, 2).toUpperCase();
    }
    const trailingDigits = token.match(/(\d{2,})$/)?.[1];
    if (trailingDigits) {
      return trailingDigits.slice(-2).toUpperCase();
    }
    return token.slice(0, 2).toUpperCase();
  }
  return trimmed.slice(0, 2);
};

export type V2ExplorerFilter = 'all' | 'tables' | 'views' | 'sequences' | 'routines' | 'packages' | 'events';

export const buildV2ExplorerFilterOptions = (
  translate: SidebarV2Translate = translateSidebarV2Current,
): Array<{ key: V2ExplorerFilter; label: string }> => [
  { key: 'all', label: translate('sidebar.command_search.object_kind.all') },
  { key: 'tables', label: translate('sidebar.command_search.object_kind.tables') },
  { key: 'views', label: translate('sidebar.command_search.object_kind.views') },
  { key: 'sequences', label: translate('sidebar.command_search.object_kind.sequences') },
  { key: 'routines', label: translate('sidebar.command_search.object_kind.routines') },
  { key: 'packages', label: translate('sidebar.command_search.object_kind.packages') },
  { key: 'events', label: translate('sidebar.command_search.object_kind.events') },
];

export const V2_EXPLORER_FILTER_OPTIONS: Array<{ key: V2ExplorerFilter; label: string }> = buildV2ExplorerFilterOptions(translateSidebarV2ZhCN);

const V2_EXPLORER_FILTER_GROUP_KEYS: Record<Exclude<V2ExplorerFilter, 'all'>, string[]> = {
  tables: ['tables'],
  views: ['views', 'materializedViews'],
  sequences: ['sequences'],
  routines: ['routines'],
  packages: ['packages'],
  events: ['events'],
};

const V2_TREE_HORIZONTAL_SCROLL_MAX_WIDTH = 2600;
const V2_TREE_HORIZONTAL_SCROLL_BASE_WIDTH = 88;
const V2_TREE_HORIZONTAL_SCROLL_INDENT_WIDTH = 24;
const V2_TREE_HORIZONTAL_SCROLL_AVG_CHAR_WIDTH = 8;
const V2_TREE_HORIZONTAL_SCROLL_ITEM_GAP_WIDTH = 5;
const V2_TREE_HORIZONTAL_SCROLL_COMMENT_MAX_CHARS = 32;
const V2_TREE_HORIZONTAL_SCROLL_VIEWPORT_BUFFER = 48;
export const V2_TREE_HORIZONTAL_SCROLL_BOTTOM_RESERVE = 32;

export const estimateV2TreeHorizontalScrollWidth = (
  nodes: SidebarTreeNode[],
  viewportWidth: number,
  sidebarTableMetadataFields: SidebarTableMetadataField[] = [],
): number | undefined => {
  const safeViewportWidth = Math.max(0, Math.ceil(viewportWidth || 0));
  let estimatedContentWidth = safeViewportWidth;

  const visit = (items: SidebarTreeNode[], depth: number) => {
    items.forEach((node) => {
      const title = String(node?.title || '');
      const tableMetadataItems = node?.type === 'table'
        ? buildSidebarTableMetadataDisplayItems(
            sidebarTableMetadataFields,
            buildSidebarTableMetadataSnapshot(node?.dataRef),
          )
        : [];
      const metaText = tableMetadataItems.length > 0
        ? tableMetadataItems
          .map((item) => item.key === 'comment'
            ? item.text.slice(0, V2_TREE_HORIZONTAL_SCROLL_COMMENT_MAX_CHARS)
            : item.text)
          .join('')
        : node?.dataRef?.groupKey === 'tables' && Array.isArray(node.children)
          ? String(node.children.length)
          : '';
      const metaItemCount = tableMetadataItems.length > 0
        ? tableMetadataItems.length
        : metaText
          ? 1
          : 0;
      const nodeWidth = V2_TREE_HORIZONTAL_SCROLL_BASE_WIDTH
        + (depth * V2_TREE_HORIZONTAL_SCROLL_INDENT_WIDTH)
        + ((title.length + metaText.length) * V2_TREE_HORIZONTAL_SCROLL_AVG_CHAR_WIDTH)
        + (metaItemCount * V2_TREE_HORIZONTAL_SCROLL_ITEM_GAP_WIDTH);
      estimatedContentWidth = Math.max(estimatedContentWidth, nodeWidth);
      if (node.children?.length) {
        visit(node.children, depth + 1);
      }
    });
  };
  visit(nodes, 0);

  if (estimatedContentWidth <= safeViewportWidth + 8) {
    return undefined;
  }
  const scrollWidth = Math.min(
    V2_TREE_HORIZONTAL_SCROLL_MAX_WIDTH,
    Math.max(safeViewportWidth + V2_TREE_HORIZONTAL_SCROLL_VIEWPORT_BUFFER, Math.ceil(estimatedContentWidth)),
  );
  return scrollWidth;
};

export const filterV2ExplorerTreeByKind = (
  nodes: SidebarTreeNode[],
  filter: V2ExplorerFilter,
): SidebarTreeNode[] => {
  if (filter === 'all') return nodes;
  const allowedGroupKeys = new Set(V2_EXPLORER_FILTER_GROUP_KEYS[filter]);
  const objectTypeMatches = (node: SidebarTreeNode): boolean => {
    if (filter === 'tables') return node.type === 'table';
    if (filter === 'views') return node.type === 'view' || node.type === 'materialized-view';
    if (filter === 'sequences') return node.type === 'sequence';
    if (filter === 'routines') return node.type === 'routine';
    if (filter === 'packages') return node.type === 'package';
    if (filter === 'events') return node.type === 'db-event';
    return false;
  };

  const visit = (node: SidebarTreeNode): SidebarTreeNode | null => {
    if (node.type === 'external-sql-root') {
      return null;
    }
    const groupKey = String(node?.dataRef?.groupKey || '');
    if (node.type === 'object-group') {
      if (allowedGroupKeys.has(groupKey)) {
        return node;
      }
      if (groupKey === 'schema') {
        const schemaChildren = (node.children || []).map(visit).filter(Boolean) as SidebarTreeNode[];
        return schemaChildren.length > 0 ? { ...node, children: schemaChildren, isLeaf: false } : null;
      }
      return null;
    }
    if (objectTypeMatches(node)) {
      return node;
    }
    if (node.type === 'database') {
      const filteredChildren = (node.children || []).map(visit).filter(Boolean) as SidebarTreeNode[];
      return filteredChildren.length > 0 ? { ...node, children: filteredChildren, isLeaf: false } : null;
    }
    return null;
  };

  return nodes.map(visit).filter(Boolean) as SidebarTreeNode[];
};

export type V2CommandSearchItem =
  | {
      key: string;
      kind: 'node';
      title: string;
      meta: string;
      icon: ReactNode;
      node: SidebarTreeNode;
    }
  | {
      key: string;
      kind: 'action';
      title: string;
      meta: string;
      shortcut?: string;
      icon: ReactNode;
      onRun: () => void;
    }
  | {
      key: string;
      kind: 'recent';
      title: string;
      meta: string;
      icon: ReactNode;
      logId: string;
      sql: string;
      connectionId?: string;
      dbName?: string;
    };

export interface V2CommandSearchTreeIndexEntry {
  item: Extract<V2CommandSearchItem, { kind: 'node' }>;
  normalizedSearchText: string;
  normalizedObjectText: string;
  objectNode: boolean;
}

export type V2CommandSearchMode = 'default' | 'object' | 'ai';

export interface V2CommandSearchQuery {
  mode: V2CommandSearchMode;
  rawValue: string;
  keyword: string;
  normalizedKeyword: string;
  aiPrompt: string;
}

export const parseV2CommandSearchQuery = (value: unknown): V2CommandSearchQuery => {
  const rawValue = String(value ?? '');
  const trimmedValue = rawValue.trim();
  const firstChar = trimmedValue.charAt(0);

  if (firstChar === '@' || firstChar === '＠') {
    const keyword = trimmedValue.slice(1).trim();
    return {
      mode: 'object',
      rawValue,
      keyword,
      normalizedKeyword: keyword.toLowerCase(),
      aiPrompt: '',
    };
  }

  if (firstChar === '?' || firstChar === '？') {
    const aiPrompt = trimmedValue.slice(1).trim();
    return {
      mode: 'ai',
      rawValue,
      keyword: aiPrompt,
      normalizedKeyword: aiPrompt.toLowerCase(),
      aiPrompt,
    };
  }

  return {
    mode: 'default',
    rawValue,
    keyword: trimmedValue,
    normalizedKeyword: trimmedValue.toLowerCase(),
    aiPrompt: '',
  };
};

const isV2CommandSearchObjectNode = (node: SidebarTreeNode): boolean => {
  return node.type === 'table'
    || node.type === 'view'
    || node.type === 'materialized-view'
    || node.type === 'sequence'
    || node.type === 'package';
};

export const V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT = 24;
export const V2_COMMAND_SEARCH_MAX_TREE_RESULTS = 120;

export const buildV2CommandSearchTreeIndex = (
  items: V2CommandSearchItem[],
): V2CommandSearchTreeIndexEntry[] => {
  return items.flatMap((item) => {
    if (item.kind !== 'node') {
      return [];
    }
    const dataRef = item.node.dataRef || {};
    const normalizedTitle = String(item.title || '').toLowerCase();
    const normalizedPrimaryObjectText = String(
      dataRef.tableName || dataRef.viewName || dataRef.sequenceName || dataRef.packageName || item.title || '',
    ).toLowerCase();

    return [{
      item,
      normalizedSearchText: [
        item.title,
        item.meta,
        dataRef.tableName,
        dataRef.viewName,
        dataRef.sequenceName,
        dataRef.packageName,
        dataRef.dbName,
        dataRef.name,
        dataRef.config?.host,
      ].filter(Boolean).join(' ').toLowerCase(),
      normalizedObjectText: `${normalizedPrimaryObjectText} ${normalizedTitle}`.trim(),
      objectNode: isV2CommandSearchObjectNode(item.node),
    }];
  });
};

export const filterV2CommandSearchTreeItems = (
  items: V2CommandSearchItem[] | V2CommandSearchTreeIndexEntry[],
  query: V2CommandSearchQuery,
): V2CommandSearchItem[] => {
  if (query.mode === 'ai') return [];
  const index = items.length > 0 && 'item' in items[0]
    ? items as V2CommandSearchTreeIndexEntry[]
    : buildV2CommandSearchTreeIndex(items as V2CommandSearchItem[]);
  const normalizedKeyword = query.normalizedKeyword;
  const objectMode = query.mode === 'object';
  const result: V2CommandSearchItem[] = [];
  const maxResults = normalizedKeyword
    ? V2_COMMAND_SEARCH_MAX_TREE_RESULTS
    : V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT;

  for (const entry of index) {
    if (objectMode && !entry.objectNode) {
      continue;
    }
    if (!normalizedKeyword) {
      result.push(entry.item);
    } else if (objectMode ? entry.normalizedObjectText.includes(normalizedKeyword) : entry.normalizedSearchText.includes(normalizedKeyword)) {
      result.push(entry.item);
    }
    if (result.length >= maxResults) {
      break;
    }
  }

  return result;
};

export interface V2CommandSearchEnterState {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  activeItemCount: number;
}

export const shouldRunV2CommandSearchEnter = ({
  key,
  isComposing,
  keyCode,
  activeItemCount,
}: V2CommandSearchEnterState): boolean => {
  if (key !== 'Enter') return false;
  if (isComposing || keyCode === 229) return false;
  return activeItemCount > 0;
};

export interface V2CommandSearchPersistentFilterState {
  commandSearchValue: string;
  persistedFilter: string;
  enabled: boolean;
  isOpen: boolean;
}

export const resolveV2CommandSearchPersistentFilter = ({
  commandSearchValue,
  persistedFilter,
  enabled,
  isOpen,
}: V2CommandSearchPersistentFilterState): string => {
  if (!enabled) return '';
  if (!isOpen) return String(persistedFilter ?? '').trim();
  return String(commandSearchValue ?? '').trim();
};

export interface V2CommandSearchGlobalKeyState {
  key: string;
  isOpen: boolean;
}

export const shouldCloseV2CommandSearchOnGlobalKey = ({
  key,
  isOpen,
}: V2CommandSearchGlobalKeyState): boolean => {
  if (!isOpen) return false;
  const normalizedKey = String(key || '').toLowerCase();
  return normalizedKey === 'escape' || normalizedKey === 'esc';
};

export const resolveSidebarConnectionIdFromKey = (
  key: unknown,
  connectionIds: string[],
): string => {
  const keyText = String(key ?? '').trim();
  if (!keyText) return '';

  const sortedIds = Array.from(new Set(connectionIds.filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  return sortedIds.find((id) => keyText === id || keyText.startsWith(`${id}-`)) || '';
};

export const resolveSidebarConnectionRefreshKeys = ({
  treeData,
  expandedKeys,
  connectionId,
}: {
  treeData: SidebarTreeNode[];
  expandedKeys: Key[];
  connectionId: string;
}): string[] => {
  const normalizedConnectionId = String(connectionId || '').trim();
  if (!normalizedConnectionId) return [];

  const expandedKeySet = new Set(
    expandedKeys
      .map((key) => String(key || '').trim())
      .filter((key) => key === normalizedConnectionId || key.startsWith(`${normalizedConnectionId}-`)),
  );
  if (expandedKeySet.size === 0) return [];

  const depthByKey = new Map<string, number>();
  const collectDepths = (nodes: SidebarTreeNode[], depth: number) => {
    nodes.forEach((node) => {
      const key = String(node.key || '').trim();
      if (key) depthByKey.set(key, depth);
      if (node.children?.length) collectDepths(node.children, depth + 1);
    });
  };
  collectDepths(treeData, 0);

  return Array.from(expandedKeySet)
    .filter((key) => depthByKey.has(key))
    .sort((left, right) => {
      const depthDifference = (depthByKey.get(left) || 0) - (depthByKey.get(right) || 0);
      return depthDifference || left.localeCompare(right);
    });
};

export const resolveSidebarNodeConnectionId = (
  node: { key?: unknown; dataRef?: Record<string, unknown> } | null | undefined,
  connectionIds: string[],
): string => {
  const directId = String(node?.dataRef?.id || node?.dataRef?.connectionId || '').trim();
  if (directId && connectionIds.includes(directId)) return directId;
  return resolveSidebarConnectionIdFromKey(node?.key, connectionIds);
};

export const normalizeSidebarTreeRelativeDropPosition = (
  absoluteDropPosition: number,
  nodePos: unknown,
): number => {
  const segments = String(nodePos || '').split('-');
  const tailIndex = Number(segments[segments.length - 1] || 0);
  return absoluteDropPosition - tailIndex;
};

export const resolveSidebarDropInsertBefore = (
  relativeDropPosition: number,
  metrics?: {
    clientY?: number;
    top?: number;
    height?: number;
  } | null,
): boolean => {
  if (relativeDropPosition < 0) return true;
  if (relativeDropPosition > 0) return false;
  const clientY = metrics?.clientY;
  const top = metrics?.top;
  const height = metrics?.height;
  if (
    typeof clientY !== 'number'
    || typeof top !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(clientY)
    || !Number.isFinite(top)
    || !Number.isFinite(height)
    || height <= 0
  ) {
    return false;
  }
  return clientY < (top + height / 2);
};

const resolveSidebarDropBaseElementFromDomEvent = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): Element | null => {
  if (typeof document === 'undefined') return null;
  const fallbackTarget = event?.target && typeof (event.target as any).closest === 'function'
    ? (event.target as unknown as Element)
    : null;
  const pointTarget = (
    typeof event?.clientX === 'number'
    && typeof event?.clientY === 'number'
  )
    ? document.elementFromPoint(event.clientX, event.clientY)
    : null;
  const baseElement = pointTarget || fallbackTarget;
  if (!baseElement || typeof baseElement.closest !== 'function') return null;
  return baseElement;
};

export const resolveSidebarDropNodeFromDomEvent = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): { key: string; type: string } | null => {
  const baseElement = resolveSidebarDropBaseElementFromDomEvent(event);
  if (!baseElement) return null;
  const marker = baseElement.closest('[data-sidebar-node-key]') as HTMLElement | null;
  if (!marker) return null;
  const key = String(marker.getAttribute('data-sidebar-node-key') || '').trim();
  const type = String(marker.getAttribute('data-sidebar-node-type') || '').trim();
  if (!key || !type) return null;
  return { key, type };
};

export const resolveSidebarDropTargetMetricsFromDomEvent = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): { top: number; height: number } | null => {
  const baseElement = resolveSidebarDropBaseElementFromDomEvent(event);
  if (!baseElement) return null;
  const treeNode = baseElement.closest('.ant-tree-treenode') as HTMLElement | null;
  if (!treeNode || typeof treeNode.getBoundingClientRect !== 'function') return null;
  const rect = treeNode.getBoundingClientRect();
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) {
    return null;
  }
  return {
    top: rect.top,
    height: rect.height,
  };
};

export const resolveSidebarTagDropInsertBefore = (options: {
  currentTagOrder: string[];
  dragTagId: string;
  dropTagId: string;
  relativeDropPosition: number;
  fallbackInsertBefore: boolean;
  metrics?: {
    clientY?: number;
    top?: number;
    height?: number;
  } | null;
}): boolean => {
  const {
    currentTagOrder,
    dragTagId,
    dropTagId,
    relativeDropPosition,
    fallbackInsertBefore,
    metrics,
  } = options;

  if (relativeDropPosition !== 0) {
    return fallbackInsertBefore;
  }

  const clientY = metrics?.clientY;
  const top = metrics?.top;
  const height = metrics?.height;
  if (
    typeof clientY !== 'number'
    || typeof top !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(clientY)
    || !Number.isFinite(top)
    || !Number.isFinite(height)
    || height <= 0
  ) {
    return fallbackInsertBefore;
  }

  const ratio = (clientY - top) / height;
  if (ratio < 0.35) return true;
  if (ratio > 0.65) return false;

  const dragIndex = currentTagOrder.indexOf(dragTagId);
  const dropIndex = currentTagOrder.indexOf(dropTagId);
  if (dragIndex === -1 || dropIndex === -1 || dragIndex === dropIndex) {
    return fallbackInsertBefore;
  }
  return dragIndex > dropIndex;
};

export const shouldSkipSidebarSelectWhileDragging = (
  isTreeDragging: boolean,
  info: { selected?: boolean } | null | undefined,
): boolean => isTreeDragging || !info?.selected;

export const shouldSkipSidebarLoadOnExpandWhileDragging = (
  isTreeDragging: boolean,
  info: { expanded?: boolean; node?: Pick<SidebarTreeNode, 'type' | 'children' | 'isLeaf'> | null } | null | undefined,
): boolean => {
  if (isTreeDragging) return true;
  if (!info?.expanded) return true;
  return !shouldLoadSidebarNodeOnExpand(info.node);
};

const SIDEBAR_COLLAPSE_UNLOAD_SUBTREE_LIMIT = 160;

export const collectSidebarSubtreeKeys = (
  node: Pick<SidebarTreeNode, 'children'> | null | undefined,
): string[] => {
  const keys: string[] = [];
  const visit = (nodes: SidebarTreeNode[] | undefined) => {
    nodes?.forEach((child) => {
      const key = String(child.key || '').trim();
      if (key) {
        keys.push(key);
      }
      if (child.children?.length) {
        visit(child.children);
      }
    });
  };
  visit(node?.children);
  return keys;
};

export const shouldClearSidebarNodeChildrenOnCollapse = (
  node: Pick<SidebarTreeNode, 'type' | 'children' | 'isLeaf'> | null | undefined,
): boolean => {
  if (!node || node.isLeaf === true || !node.children?.length) {
    return false;
  }
  if (node.type !== 'connection') {
    return false;
  }
  return collectSidebarSubtreeKeys(node).length >= SIDEBAR_COLLAPSE_UNLOAD_SUBTREE_LIMIT;
};

type SidebarDatabaseExpansionNode = {
  key: string;
  groupKey: string;
  subtreeKeys: string[];
};

export const resolveSidebarSingleDatabaseExpandedKeys = ({
  previousExpandedKeys,
  nextExpandedKeys,
  treeData,
}: {
  previousExpandedKeys: Key[];
  nextExpandedKeys: Key[];
  treeData: SidebarTreeNode[];
}): Key[] => {
  const databaseNodesByKey = new Map<string, SidebarDatabaseExpansionNode>();

  const visit = (nodes: SidebarTreeNode[], inheritedConnectionId = '') => {
    nodes.forEach((node) => {
      const nodeKey = String(node.key || '').trim();
      const directConnectionId = String(
        node.dataRef?.id || node.dataRef?.connectionId || '',
      ).trim();
      const connectionId = node.type === 'connection'
        ? directConnectionId || nodeKey
        : directConnectionId || inheritedConnectionId;

      if (
        nodeKey
        && connectionId
        && (node.type === 'database' || node.type === 'redis-db')
      ) {
        databaseNodesByKey.set(nodeKey, {
          key: nodeKey,
          groupKey: `${connectionId}\u0000${node.type}`,
          subtreeKeys: collectSidebarSubtreeKeys(node),
        });
      }

      if (node.children?.length) {
        visit(node.children, connectionId);
      }
    });
  };
  visit(treeData);

  if (databaseNodesByKey.size === 0) {
    return nextExpandedKeys;
  }

  const previousKeySet = new Set(previousExpandedKeys.map((key) => String(key)));
  const expandedByGroup = new Map<string, SidebarDatabaseExpansionNode[]>();
  nextExpandedKeys.forEach((key) => {
    const databaseNode = databaseNodesByKey.get(String(key));
    if (!databaseNode) return;
    const group = expandedByGroup.get(databaseNode.groupKey) || [];
    group.push(databaseNode);
    expandedByGroup.set(databaseNode.groupKey, group);
  });

  const winnerByGroup = new Map<string, string>();
  expandedByGroup.forEach((nodes, groupKey) => {
    const newlyExpanded = nodes.filter((node) => !previousKeySet.has(node.key));
    const winner = newlyExpanded.length > 0
      ? newlyExpanded[newlyExpanded.length - 1]
      : nodes[nodes.length - 1];
    winnerByGroup.set(groupKey, winner.key);
  });

  const keysToCollapse = new Set<string>();
  databaseNodesByKey.forEach((node) => {
    const winnerKey = winnerByGroup.get(node.groupKey);
    if (!winnerKey || winnerKey === node.key) return;
    keysToCollapse.add(node.key);
    node.subtreeKeys.forEach((key) => keysToCollapse.add(key));
  });

  if (keysToCollapse.size === 0) {
    return nextExpandedKeys;
  }
  return nextExpandedKeys.filter((key) => !keysToCollapse.has(String(key)));
};

export const resolveV2ActiveConnectionId = ({
  activeContextConnectionId,
  activeTabConnectionId,
  selectedKeys,
  connectionIds,
  fallbackConnectionId,
}: {
  activeContextConnectionId?: unknown;
  activeTabConnectionId?: unknown;
  selectedKeys: unknown[];
  connectionIds: string[];
  fallbackConnectionId?: unknown;
}): string => {
  const connectionIdSet = new Set(connectionIds);
  const normalizeDirectId = (value: unknown): string => {
    const text = String(value || '').trim();
    return text && connectionIdSet.has(text) ? text : '';
  };
  const selectedConnectionId = selectedKeys
    .map((key) => resolveSidebarConnectionIdFromKey(key, connectionIds))
    .find(Boolean) || '';

  return normalizeDirectId(activeContextConnectionId)
    || selectedConnectionId
    || normalizeDirectId(fallbackConnectionId)
    || normalizeDirectId(activeTabConnectionId)
    || '';
};

export const resolveV2SelectedDatabaseName = ({
  activeConnectionId,
  activeContextConnectionId,
  activeContextDbName,
}: {
  activeConnectionId?: unknown;
  activeContextConnectionId?: unknown;
  activeContextDbName?: unknown;
}): string => {
  const connectionId = String(activeConnectionId || '').trim();
  const contextConnectionId = String(activeContextConnectionId || '').trim();
  if (!connectionId || connectionId !== contextConnectionId) {
    return '';
  }
  return String(activeContextDbName || '').trim();
};

export const resolveSidebarDatabaseTreePruneKeys = ({
  treeData,
  expandedKeys,
  selectedKeys,
  activeDatabaseKey,
  touchedAtByDatabaseKey,
  maxLoadedDatabases,
}: {
  treeData: SidebarTreeNode[];
  expandedKeys: React.Key[];
  selectedKeys: React.Key[];
  activeDatabaseKey?: string;
  touchedAtByDatabaseKey?: Record<string, number>;
  maxLoadedDatabases: number;
}): string[] => {
  if (!Number.isFinite(maxLoadedDatabases) || maxLoadedDatabases <= 0) {
    return [];
  }

  const loadedDatabaseKeys: string[] = [];
  const visit = (nodes: SidebarTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type === 'database' && Array.isArray(node.children) && node.children.length > 0) {
        loadedDatabaseKeys.push(String(node.key || '').trim());
        return;
      }
      if (node.children?.length) {
        visit(node.children);
      }
    });
  };
  visit(treeData);

  if (loadedDatabaseKeys.length <= maxLoadedDatabases) {
    return [];
  }

  const expandedKeySet = new Set(expandedKeys.map((key) => String(key || '').trim()).filter(Boolean));
  const selectedKeySet = new Set(selectedKeys.map((key) => String(key || '').trim()).filter(Boolean));
  const protectedDatabaseKeys = new Set<string>();
  if (activeDatabaseKey) {
    protectedDatabaseKeys.add(String(activeDatabaseKey).trim());
  }

  const candidates = loadedDatabaseKeys
    .filter((key) => key && !expandedKeySet.has(key) && !selectedKeySet.has(key) && !protectedDatabaseKeys.has(key))
    .sort((left, right) => {
      const leftTouchedAt = Number(touchedAtByDatabaseKey?.[left] || 0);
      const rightTouchedAt = Number(touchedAtByDatabaseKey?.[right] || 0);
      if (leftTouchedAt !== rightTouchedAt) {
        return leftTouchedAt - rightTouchedAt;
      }
      return left.localeCompare(right);
    });

  const pruneCount = loadedDatabaseKeys.length - maxLoadedDatabases;
  return candidates.slice(0, pruneCount);
};

export const shouldClearSidebarActiveContextOnEmptySelect = (isV2Ui: boolean): boolean => !isV2Ui;
