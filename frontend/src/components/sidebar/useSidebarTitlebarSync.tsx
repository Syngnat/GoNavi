import React, { useEffect, useCallback, useRef } from 'react';
import {
  buildConnectionReloadSignature,
  isConnectionTreeKey,
  useSidebarLayoutEffect,
} from './sidebarRootHelpers';
import {
  type SidebarTreeNode as TreeNode,
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
  buildSidebarConnectionTagTree,
  resolveSidebarNodeConnectionId,
  type SidebarConnectionState,
} from '../sidebarV2Utils';
import { SavedConnection } from '../../types';
import {
  resolveConnectionIconType,
  resolveConnectionAccentColor,
} from '../../utils/connectionVisual';
import { getDbIcon } from '../DatabaseIcons';
import { GnFolderIcon } from '../icons/gnIcons';
import { message } from 'antd';
import { t } from '../../i18n';
import {
  type TitlebarSelectionContext,
  type TitlebarSidebarSnapshot,
  mergeTitlebarSidebarSnapshot,
} from '../../utils/titlebarContext';
import {
  resolveSidebarTitlebarObjectName,
  shouldDeferSidebarTitlebarSelection,
} from './sidebarHelpers';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarProps } from '../Sidebar';

export interface UseSidebarTitlebarSyncInput {
  connectionReloadSignaturesRef: SidebarSearchStateApi['connectionReloadSignaturesRef'];
  connections: SidebarStoreStateApi['connections'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  setConnectionStates: SidebarTreeViewStateApi['setConnectionStates'];
  invalidateConnectionLoadsRef: SidebarSearchStateApi['invalidateConnectionLoadsRef'];
  loadingNodesRef: SidebarSearchStateApi['loadingNodesRef'];
  setTreeData: SidebarStoreStateApi['setTreeData'];
  connectionTags: SidebarStoreStateApi['connectionTags'];
  sidebarRootOrder: SidebarStoreStateApi['sidebarRootOrder'];
  rootSortMode: SidebarStoreStateApi['rootSortMode'];
  rootConnectionSortMode: SidebarStoreStateApi['rootConnectionSortMode'];
  allSavedQueriesNode: SidebarSearchStateApi['allSavedQueriesNode'];
  addConnection: SidebarStoreStateApi['addConnection'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  connectionIds: SidebarSearchStateApi['connectionIds'];
  onTitlebarSnapshotChange: SidebarProps['onTitlebarSnapshotChange'];
  selectedSidebarKeyRef: SidebarSearchStateApi['selectedSidebarKeyRef'];
  selectedKeys: SidebarSearchStateApi['selectedKeys'];
  treeData: SidebarStoreStateApi['treeData'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  connectionStates: SidebarTreeViewStateApi['connectionStates'];
}

export const useSidebarTitlebarSync = ({
  connectionReloadSignaturesRef, connections, setLoadedKeys, setExpandedKeys, setConnectionStates,
  invalidateConnectionLoadsRef, loadingNodesRef, setTreeData, connectionTags, sidebarRootOrder,
  rootSortMode, rootConnectionSortMode, allSavedQueriesNode, addConnection, findTreeNodeByKeyRef,
  connectionIds, onTitlebarSnapshotChange, selectedSidebarKeyRef, selectedKeys, treeData,
  selectedNodesRef, connectionStates,
}: UseSidebarTitlebarSyncInput) => {
  useEffect(() => {
    const previousSignatures = connectionReloadSignaturesRef.current;
    const nextSignatures: Record<string, string> = {};
    const staleConnectionIds = new Set<string>();

    connections.forEach((conn) => {
      const signature = buildConnectionReloadSignature(conn);
      nextSignatures[conn.id] = signature;
      if (previousSignatures[conn.id] && previousSignatures[conn.id] !== signature) {
        staleConnectionIds.add(conn.id);
      }
    });
    connectionReloadSignaturesRef.current = nextSignatures;

    if (staleConnectionIds.size > 0) {
      const staleIds = Array.from(staleConnectionIds);
      setLoadedKeys((prev) =>
        prev.filter((key) => !staleIds.some((id) => isConnectionTreeKey(key, id))),
      );
      setExpandedKeys((prev) =>
        prev.filter((key) => !staleIds.some((id) => isConnectionTreeKey(key, id))),
      );
      setConnectionStates((prev) => {
        const next = { ...prev };
        staleIds.forEach((id) => {
          Object.keys(next).forEach((key) => {
            if (isConnectionTreeKey(key, id)) {
              delete next[key];
            }
          });
        });
        return next;
      });
      staleIds.forEach((id) => {
        invalidateConnectionLoadsRef.current(id);
        Array.from(loadingNodesRef.current).forEach((key) => {
          if (key === `dbs-${id}` || key.startsWith(`tables-${id}-`)) {
            loadingNodesRef.current.delete(key);
          }
        });
      });
    }

    setTreeData((prev) => {
      const prevMap = new Map<string, TreeNode>();

      // We need to recursively extract connections from old tag structures
      // so if a user expands a connection that was tagged, the state remains
      const recurseCollect = (nodes: TreeNode[]) => {
          nodes.forEach((node) => {
            if (node.type === 'tag') {
               if (node.children) recurseCollect(node.children);
            } else if (node.type === 'connection') {
               prevMap.set(String(node.key), node);
            }
          });
      };
      recurseCollect(prev);

      const buildConnectionNode = (conn: SavedConnection): TreeNode => {
        const existing = prevMap.get(conn.id);
        const iconType = resolveConnectionIconType(conn);
        const iconColor = resolveConnectionAccentColor(conn);
        const preserveChildren = existing && !staleConnectionIds.has(conn.id);
        const nacosNamespaceDiscoveryMode =
          preserveChildren && conn.config.type === 'nacos'
            ? resolveNacosNamespaceDiscoveryModeFromTreeNode(existing)
            : undefined;
        return {
          title: conn.name,
          key: conn.id,
          icon: getDbIcon(iconType, iconColor, 20),
          type: 'connection',
          'data-sidebar-node-key': conn.id,
          'data-sidebar-node-type': 'connection',
          dataRef: nacosNamespaceDiscoveryMode
            ? { ...conn, nacosNamespaceDiscoveryMode }
            : conn,
          isLeaf: false,
          children: preserveChildren ? existing.children : undefined,
        } as TreeNode;
      };

      const buildTreeNode = (item: ReturnType<typeof buildSidebarConnectionTagTree>[number]): TreeNode => {
        if (item.kind === 'connection') {
          return buildConnectionNode(item.connection);
        }
        return {
          title: item.tag.name,
          key: `tag-${item.tag.id}`,
          icon: (
            <span
              className="gn-v2-tree-folder-icon"
              data-sidebar-tree-folder-icon="true"
            >
              <GnFolderIcon />
            </span>
          ),
          type: 'tag',
          'data-sidebar-node-key': `tag-${item.tag.id}`,
          'data-sidebar-node-type': 'tag',
          dataRef: item.tag,
          isLeaf: false,
          children: item.children.map(buildTreeNode),
        } as TreeNode;
      };

      const orderedNodes = buildSidebarConnectionTagTree(
        connections,
        connectionTags,
        sidebarRootOrder,
        rootSortMode,
        rootConnectionSortMode,
      ).map(buildTreeNode);
      if (allSavedQueriesNode) {
        orderedNodes.push(allSavedQueriesNode);
      }
      const externalSQLRootNode = prev.find((node) => node.type === 'external-sql-root');
      return externalSQLRootNode ? [...orderedNodes, externalSQLRootNode] : orderedNodes;
    });
  }, [connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode, allSavedQueriesNode]);

  const handleDuplicateConnection = async (conn: SavedConnection) => {
    if (!conn?.id) return;

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.DuplicateConnection !== 'function') {
      message.error(t('connection.sidebar.duplicate.backendUnavailable'));
      return;
    }

    try {
      const duplicatedConnection = await backendApp.DuplicateConnection(conn.id);
      if (!duplicatedConnection) {
        throw new Error(t('connection.sidebar.duplicate.noResult'));
      }
      addConnection(duplicatedConnection);
      message.success(t('connection.sidebar.duplicate.success', {
        name: duplicatedConnection.name,
      }));
    } catch (error: any) {
      message.error(error?.message || t('connection.sidebar.duplicate.failureFallback'));
    }
  };
  const findTreeNodeByKey = (nodes: TreeNode[], targetKey: React.Key): TreeNode | null => {
    for (const node of nodes) {
      if (node.key === targetKey) {
        return node;
      }
      if (node.children) {
        const child = findTreeNodeByKey(node.children, targetKey);
        if (child) {
          return child;
        }
      }
    }
    return null;
  };

  findTreeNodeByKeyRef.current = findTreeNodeByKey;

  const resolveSidebarSelectionContext = useCallback((node: any): TitlebarSelectionContext | null => {
      if (!node) return null;
      const type = String(node.type || '');
      const dataRef = node.dataRef || {};
      const connectionId = type === 'connection'
          ? String(node.key || dataRef.id || '').trim()
          : String(
              resolveSidebarNodeConnectionId(node, connectionIds)
              || dataRef.id
              || dataRef.connectionId
              || '',
          ).trim();
      if (!connectionId) return null;

      // The state map is keyed by the Host connection id. Keep this key
      // stable when a database/table row is selected so the title bar follows
      // the same Host marker as the tree instead of a child-row spinner.
      const sidebarStateKey = connectionId;

      if (type === 'connection') {
          return { connectionId, dbName: '', sidebarStateKey };
      }

      let dbName = String(dataRef.dbName || '').trim();
      if (type === 'redis-db') {
          dbName = `db${dataRef.redisDB}`;
      } else if (
          type === 'nacos-namespace'
          || type === 'nacos-config-entry'
          || type === 'nacos-config-group'
          || type === 'nacos-services-entry'
          || type === 'nacos-service-group'
      ) {
          dbName = String(
              dataRef.nacosNamespaceName
              || dataRef.nacosNamespaceId
              || 'public',
          ).trim();
      }

      const tableName = resolveSidebarTitlebarObjectName(node);
      return tableName
          ? { connectionId, dbName, tableName, sidebarStateKey }
          : { connectionId, dbName, sidebarStateKey };
  }, [connectionIds]);

  const titlebarSnapshotRevisionRef = useRef(0);
  const publishTitlebarSnapshotUpdate = useCallback((
      update: (snapshot: TitlebarSidebarSnapshot) => TitlebarSidebarSnapshot,
      expectedSelectedKey?: unknown,
  ) => {
      const revision = ++titlebarSnapshotRevisionRef.current;
      const expectedKey = expectedSelectedKey === undefined
          ? undefined
          : String(expectedSelectedKey ?? '').trim();
      onTitlebarSnapshotChange?.((current) => {
          // A queued effect can outlive the selection that produced it. Do
          // not let that older tree key repaint the title bar after the user
          // has already selected another row.
          if (
              expectedKey !== undefined
              && selectedSidebarKeyRef.current !== expectedKey
          ) {
              return current;
          }
          const next = update(current);
          return mergeTitlebarSidebarSnapshot(current, {
              ...next,
              revision,
          });
      });
  }, [onTitlebarSnapshotChange]);

  const publishTitlebarSelection = useCallback((
      selection: TitlebarSelectionContext | null,
      expectedSelectedKey?: unknown,
  ) => {
      // `sidebarStateKey` identifies the Host marker; the stale-update guard
      // must use the actual rc-tree row key (which may be a database/table).
      const expectedKey = expectedSelectedKey === undefined
          ? selectedSidebarKeyRef.current
          : expectedSelectedKey;
      publishTitlebarSnapshotUpdate((snapshot) => ({
          ...snapshot,
          selection,
      }), expectedKey);
  }, [publishTitlebarSnapshotUpdate]);

  const publishTitlebarSelectionForNode = useCallback((node: any) => {
      const selection = resolveSidebarSelectionContext(node);
      const selectedKey = String(node?.key ?? '').trim();
      if (selectedKey) {
          selectedSidebarKeyRef.current = selectedKey;
      }
      publishTitlebarSnapshotUpdate((snapshot) => ({
          ...snapshot,
          selection,
      }), selectedKey || selection?.sidebarStateKey || '');
  }, [publishTitlebarSnapshotUpdate, resolveSidebarSelectionContext]);

  // Keep the title bar tied to the row selected in this tree, even when a
  // different workbench tab is active.
  const lastPublishedSidebarSnapshotRef = useRef<{
      selectionSignature: string;
      connectionStates: Record<string, SidebarConnectionState>;
  } | null>(null);
  useSidebarLayoutEffect(() => {
      const selectedKey = selectedKeys[0];
      const selectedNode = selectedKey == null
          ? null
          : findTreeNodeByKey(treeData, selectedKey)
              || selectedNodesRef.current.find((node) => String(node?.key) === String(selectedKey));
      if (shouldDeferSidebarTitlebarSelection({
          selectedKey,
          selectedNode,
          connectionIds,
      })) {
          return;
      }
      const context = resolveSidebarSelectionContext(selectedNode);
      const selectionSignature = context
          ? [context.connectionId, context.dbName, context.tableName || '', context.sidebarStateKey || ''].join('\u0000')
          : '';
      const previous = lastPublishedSidebarSnapshotRef.current;
      if (
          previous
          && previous.selectionSignature === selectionSignature
          && previous.connectionStates === connectionStates
      ) {
          return;
      }
      lastPublishedSidebarSnapshotRef.current = {
          selectionSignature,
          connectionStates,
      };
      publishTitlebarSnapshotUpdate(() => ({
          selection: context,
          connectionStates,
      }), selectedKey == null ? '' : selectedKey);
  }, [connectionIds, connectionStates, publishTitlebarSnapshotUpdate, resolveSidebarSelectionContext, selectedKeys, treeData]);
  return {
    handleDuplicateConnection, findTreeNodeByKey, resolveSidebarSelectionContext,
    publishTitlebarSnapshotUpdate, publishTitlebarSelection, publishTitlebarSelectionForNode,
  };
};

export type SidebarTitlebarSyncApi = ReturnType<typeof useSidebarTitlebarSync>;
