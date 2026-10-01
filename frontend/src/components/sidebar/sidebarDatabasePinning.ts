import { buildSidebarDatabasePinKey } from '../../utils/sidebarTreeOrder';
import type { SidebarTreeNode } from '../sidebarV2Utils';

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
    if (node.type !== 'database' && node.type !== 'nacos-namespace') {
      regularNodes.push({ node, order: index, index });
      return;
    }
    const dbName = node.type === 'nacos-namespace'
      ? String(node.dataRef?.nacosNamespaceId || 'public').trim()
      : String(node.dataRef?.dbName || node.title || '').trim();
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
