import type { Key } from 'react';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import {
  SIDEBAR_COLLAPSE_UNLOAD_SUBTREE_LIMIT,
  resolveSidebarConnectionIdFromKey,
} from './sidebarV2TreeDrop';

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
        && (node.type === 'database' || node.type === 'message-namespace' || node.type === 'redis-db')
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
      if (
        (node.type === 'database' || node.type === 'message-namespace')
        && Array.isArray(node.children)
        && node.children.length > 0
      ) {
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
