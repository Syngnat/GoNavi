import { useCallback, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';

import { t } from '../../i18n';
import type { SavedConnection } from '../../types';
import { resolveSidebarNodeConnectionId, shouldRunV2CommandSearchEnter, type SidebarTreeNode as TreeNode, type V2CommandSearchItem } from '../sidebarV2Utils';
import { resolveSidebarTitlebarObjectName } from './sidebarHelpers';

type UseSidebarCommandSearchRunnerArgs = {
  activeContext: any;
  activeTab: any;
  addTab: (tab: any) => void;
  clearStaleHostStateOnSelection: (node: any) => void;
  closeV2CommandSearch: () => void;
  commandSearchFlatItems: V2CommandSearchItem[];
  connectionIds: string[];
  queryCapableConnectionIds: ReadonlySet<string>;
  findTreeNodeByKeyRef: MutableRefObject<(nodes: TreeNode[], targetKey: React.Key) => TreeNode | null>;
  locateObjectInSidebar: (detail: unknown) => Promise<void>;
  loadDatabases: (node: any) => Promise<void>;
  mergeExpandedTreeKeys: (requiredKeys: React.Key[]) => void;
  onDoubleClick: (event: any, node: any) => void;
  publishTitlebarSelectionForNode?: (node: any) => void;
  revealCommandSearchNode: (node: TreeNode) => void;
  scrollSidebarTreeToKey: (key: React.Key, scrollBlock?: 'nearest' | 'center') => void;
  selectedNodesRef: MutableRefObject<any[]>;
  setActiveContext: (context: { connectionId: string; dbName: string; schemaName?: string; tableName?: string } | null) => void;
  setSelectedKeys: Dispatch<SetStateAction<React.Key[]>>;
  setV2CommandActiveIndex: Dispatch<SetStateAction<number>>;
  treeDataRef: MutableRefObject<TreeNode[]>;
  v2CommandActiveIndex: number;
};

// 按优先级从最近 SQL 的候选连接中选出第一个支持查询编辑器的连接，
// 避免把最近 SQL 绑定到 Nacos/JVM 等无查询工作流的活动连接。
export const resolveRecentQueryConnectionId = ({
  itemConnectionId,
  activeContextConnectionId,
  activeTabConnectionId,
  queryCapableConnectionIds,
}: {
  itemConnectionId?: unknown;
  activeContextConnectionId?: unknown;
  activeTabConnectionId?: unknown;
  queryCapableConnectionIds: ReadonlySet<string>;
}): string => {
  const candidate = [
    itemConnectionId,
    activeContextConnectionId,
    activeTabConnectionId,
  ].find((id): id is string => typeof id === 'string' && id !== '' && queryCapableConnectionIds.has(id));
  return candidate || '';
};

export const useSidebarCommandSearchRunner = ({
  activeContext,
  activeTab,
  addTab,
  clearStaleHostStateOnSelection,
  closeV2CommandSearch,
  commandSearchFlatItems,
  connectionIds,
  queryCapableConnectionIds,
  findTreeNodeByKeyRef,
  locateObjectInSidebar,
  loadDatabases,
  mergeExpandedTreeKeys,
  onDoubleClick,
  publishTitlebarSelectionForNode,
  revealCommandSearchNode,
  scrollSidebarTreeToKey,
  selectedNodesRef,
  setActiveContext,
  setSelectedKeys,
  setV2CommandActiveIndex,
  treeDataRef,
  v2CommandActiveIndex,
}: UseSidebarCommandSearchRunnerArgs) => {
  const selectConnectionFromRail = useCallback((conn: SavedConnection): Promise<void> => {
    const key = conn.id;
    const connectionNode = findTreeNodeByKeyRef.current(treeDataRef.current, key);
    clearStaleHostStateOnSelection(connectionNode || {
      key,
      dataRef: conn,
      type: 'connection',
    });
    setSelectedKeys([key]);
    setActiveContext({ connectionId: key, dbName: '' });
    mergeExpandedTreeKeys([key]);
    const targetNode = connectionNode || {
      key,
      dataRef: conn,
      type: 'connection',
    };
    // Keep a synthetic rail selection available until the Host row is loaded
    // into treeData; otherwise the titlebar effect would briefly publish null
    // and hide the newly selected Host.
    selectedNodesRef.current = [targetNode];
    publishTitlebarSelectionForNode?.(targetNode);
    return loadDatabases(targetNode);
  }, [clearStaleHostStateOnSelection, findTreeNodeByKeyRef, loadDatabases, mergeExpandedTreeKeys, publishTitlebarSelectionForNode, selectedNodesRef, setActiveContext, setSelectedKeys, treeDataRef]);

  const runCommandSearchItem = useCallback((item?: V2CommandSearchItem) => {
    if (!item) return;
    closeV2CommandSearch();
    if (item.kind === 'action') {
      item.onRun();
      return;
    }
    if (item.kind === 'recent') {
      // 只继承支持查询编辑器的连接，避免把最近 SQL 绑定到
      // Nacos/JVM 等无查询工作流的活动连接。
      const recentConnectionId = resolveRecentQueryConnectionId({
        itemConnectionId: item.connectionId,
        activeContextConnectionId: activeContext?.connectionId,
        activeTabConnectionId: activeTab?.connectionId,
        queryCapableConnectionIds,
      });
      addTab({
        id: `query-${Date.now()}`,
        title: t('sidebar.tab.recent_query'),
        type: 'query',
        connectionId: recentConnectionId,
        dbName: item.dbName || activeContext?.dbName || activeTab?.dbName || '',
        schemaName: activeContext?.schemaName || activeTab?.schemaName || undefined,
        query: item.sql,
      });
      return;
    }

    const node = item.node;
    const dataRef = node.dataRef || {};
    revealCommandSearchNode(node);
    if (node.type === 'connection') {
      void selectConnectionFromRail(dataRef as SavedConnection);
      return;
    }
    if (node.type === 'database') {
      publishTitlebarSelectionForNode?.(node);
      setActiveContext({ connectionId: resolveSidebarNodeConnectionId(node, connectionIds) || dataRef.id, dbName: dataRef.dbName });
      mergeExpandedTreeKeys([dataRef.id, node.key]);
      setSelectedKeys([node.key]);
      selectedNodesRef.current = [node];
      scrollSidebarTreeToKey(node.key, 'center');
      return;
    }
    if (node.type === 'object-group' && dataRef.groupKey === 'schema') {
      publishTitlebarSelectionForNode?.(node);
      setActiveContext({
        connectionId: resolveSidebarNodeConnectionId(node, connectionIds) || dataRef.id,
        dbName: dataRef.dbName,
        ...(String(dataRef.schemaName || '').trim()
          ? { schemaName: String(dataRef.schemaName).trim() }
          : {}),
      });
      mergeExpandedTreeKeys([dataRef.id, node.key]);
      setSelectedKeys([node.key]);
      selectedNodesRef.current = [node];
      scrollSidebarTreeToKey(node.key, 'center');
      return;
    }
    if (node.type === 'table' || node.type === 'view' || node.type === 'materialized-view') {
      publishTitlebarSelectionForNode?.(node);
      void locateObjectInSidebar({
        tabId: String(node.key || ''),
        connectionId: dataRef.id,
        dbName: dataRef.dbName,
        tableName: dataRef.tableName || dataRef.viewName,
        schemaName: dataRef.schemaName,
        objectGroup: node.type === 'table' ? 'tables' : (node.type === 'materialized-view' ? 'materializedViews' : 'views'),
      });
      onDoubleClick(null, node);
      return;
    }
    if (node.type === 'db-trigger' || node.type === 'db-event' || node.type === 'routine' || node.type === 'sequence' || node.type === 'package') {
      publishTitlebarSelectionForNode?.(node);
      setActiveContext({
        connectionId: resolveSidebarNodeConnectionId(node, connectionIds) || dataRef.id,
        dbName: dataRef.dbName,
        tableName: resolveSidebarTitlebarObjectName(node),
        ...(String(dataRef.schemaName || '').trim()
          ? { schemaName: String(dataRef.schemaName).trim() }
          : {}),
      });
      setSelectedKeys([node.key]);
      selectedNodesRef.current = [node];
      scrollSidebarTreeToKey(node.key, 'center');
      if (node.type !== 'sequence' && node.type !== 'package') {
        onDoubleClick(null, node);
      }
    }
  }, [
    activeContext,
    activeTab,
    addTab,
    closeV2CommandSearch,
    connectionIds,
    queryCapableConnectionIds,
    mergeExpandedTreeKeys,
    locateObjectInSidebar,
    onDoubleClick,
    publishTitlebarSelectionForNode,
    revealCommandSearchNode,
    scrollSidebarTreeToKey,
    selectConnectionFromRail,
    selectedNodesRef,
    setActiveContext,
    setSelectedKeys,
  ]);

  const handleV2CommandSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setV2CommandActiveIndex((prev) => {
        if (commandSearchFlatItems.length === 0) return 0;
        return Math.min(prev + 1, commandSearchFlatItems.length - 1);
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setV2CommandActiveIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      if (!shouldRunV2CommandSearchEnter({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        activeItemCount: commandSearchFlatItems.length,
      })) {
        return;
      }
      event.preventDefault();
      runCommandSearchItem(commandSearchFlatItems[v2CommandActiveIndex]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeV2CommandSearch();
    }
  };

  return {
    selectConnectionFromRail,
    runCommandSearchItem,
    handleV2CommandSearchKeyDown,
  };
};
