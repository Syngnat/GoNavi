import {
  resolveSidebarConnectionRefreshKeys,
  type SidebarTreeNode as TreeNode,
} from '../sidebarV2Utils';
import {
  isConnectionTreeKey,
  resolveNacosServiceGroupsRefreshTarget,
  NACOS_SERVICES_CHANGED_EVENT,
} from './sidebarRootHelpers';
import { useEffect } from 'react';
import {
  normalizeSidebarDatabaseListRefreshRequest,
  SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
} from '../../utils/sidebarDatabaseRefresh';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarJvmAndSavedQueriesApi } from './useSidebarJvmAndSavedQueries';
import type { SidebarTreeEventsApi } from './useSidebarTreeEvents';

export interface UseSidebarConnectionRefreshInput {
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  expandedKeysRef: SidebarSearchStateApi['expandedKeysRef'];
  invalidateConnectionLoads: SidebarJvmAndSavedQueriesApi['invalidateConnectionLoads'];
  loadDatabases: SidebarJvmAndSavedQueriesApi['loadDatabases'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  loadingNodesRef: SidebarSearchStateApi['loadingNodesRef'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  onLoadData: SidebarTreeEventsApi['onLoadData'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  refreshConnectionResourcesRef: SidebarSearchStateApi['refreshConnectionResourcesRef'];
  replaceTreeNodeChildrenRef: SidebarSearchStateApi['replaceTreeNodeChildrenRef'];
  loadNacosServiceGroupsRef: SidebarSearchStateApi['loadNacosServiceGroupsRef'];
}

export const useSidebarConnectionRefresh = ({
  treeDataRef, expandedKeysRef, invalidateConnectionLoads, loadDatabases, setLoadedKeys,
  loadingNodesRef, findTreeNodeByKeyRef, onLoadData, setExpandedKeys, refreshConnectionResourcesRef,
  replaceTreeNodeChildrenRef, loadNacosServiceGroupsRef,
}: UseSidebarConnectionRefreshInput) => {
  // Rehydrate descendants that were open before the connection loader replaces its tree.
  const refreshConnectionResources = async (node: any): Promise<void> => {
      const connectionId = String(node?.key || node?.dataRef?.id || '').trim();
      if (!connectionId) return;

      const expandedKeysToReload = resolveSidebarConnectionRefreshKeys({
          treeData: treeDataRef.current,
          expandedKeys: expandedKeysRef.current,
          connectionId,
      });

      invalidateConnectionLoads(connectionId);
      setLoadedKeys((previous) => previous.filter((key) => !isConnectionTreeKey(key, connectionId)));
      Array.from(loadingNodesRef.current).forEach((loadingKey) => {
          if (loadingKey === `dbs-${connectionId}` || loadingKey.startsWith(`tables-${connectionId}-`)) {
              loadingNodesRef.current.delete(loadingKey);
          }
      });

      await loadDatabases(node);

      const loadedKeysToRestore = new Set<string>();
      const refreshedConnection = findTreeNodeByKeyRef.current(treeDataRef.current, connectionId);
      if (refreshedConnection?.children?.length) {
          loadedKeysToRestore.add(connectionId);
      }

      for (const key of expandedKeysToReload) {
          if (key === connectionId) continue;
          if (!expandedKeysRef.current.some((expandedKey) => String(expandedKey) === key)) {
              continue;
          }
          const currentNode = findTreeNodeByKeyRef.current(treeDataRef.current, key);
          if (!currentNode) continue;

          await onLoadData(currentNode);
          const loadedNode = findTreeNodeByKeyRef.current(treeDataRef.current, key);
          if (loadedNode?.children?.length) {
              loadedKeysToRestore.add(key);
          }
      }

      const availableConnectionKeys = new Set<string>();
      const collectConnectionKeys = (nodes: TreeNode[]) => {
          nodes.forEach((treeNode) => {
              const key = String(treeNode.key || '').trim();
              if (key && isConnectionTreeKey(key, connectionId)) {
                  availableConnectionKeys.add(key);
              }
              if (treeNode.children?.length) collectConnectionKeys(treeNode.children);
          });
      };
      collectConnectionKeys(treeDataRef.current);
      const expandedKeysBeforeRefresh = new Set(expandedKeysToReload);

      setExpandedKeys((previous) => previous.filter((key) => {
          const keyText = String(key);
          return !isConnectionTreeKey(keyText, connectionId)
              || !expandedKeysBeforeRefresh.has(keyText)
              || availableConnectionKeys.has(keyText);
      }));
      setLoadedKeys((previous) => {
          const next = previous.filter((key) => {
              const keyText = String(key);
              return !isConnectionTreeKey(keyText, connectionId) || availableConnectionKeys.has(keyText);
          });
          loadedKeysToRestore.forEach((key) => next.push(key));
          return Array.from(new Set(next));
      });
  };
  refreshConnectionResourcesRef.current = refreshConnectionResources;

  useEffect(() => {
      const handleSidebarDatabaseListRefresh = (event: Event) => {
          const request = normalizeSidebarDatabaseListRefreshRequest((event as CustomEvent).detail);
          if (!request) return;
          const connectionNode = findTreeNodeByKeyRef.current(
              treeDataRef.current,
              request.connectionId,
          );
          if (connectionNode) {
              void refreshConnectionResources(connectionNode);
          }
      };
      window.addEventListener(
          SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
          handleSidebarDatabaseListRefresh as EventListener,
      );
      return () => {
          window.removeEventListener(
              SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
              handleSidebarDatabaseListRefresh as EventListener,
          );
      };
  }, [refreshConnectionResources]);

  useEffect(() => {
      const handleNacosServicesChanged = (event: Event) => {
          const target = resolveNacosServiceGroupsRefreshTarget(
              (event as CustomEvent).detail,
              treeDataRef.current,
              expandedKeysRef.current,
          );
          if (!target) return;

          replaceTreeNodeChildrenRef.current(target.key, undefined);
          setLoadedKeys((prev) => prev.filter((key) => String(key) !== target.key));
          if (!target.shouldReload) return;

          void loadNacosServiceGroupsRef.current(
              { ...target.node, children: undefined },
              { force: true },
          ).then((loaded) => {
              if (!loaded) return;
              setLoadedKeys((prev) => prev.includes(target.key) ? prev : [...prev, target.key]);
          });
      };
      window.addEventListener(NACOS_SERVICES_CHANGED_EVENT, handleNacosServicesChanged as EventListener);
      return () => {
          window.removeEventListener(NACOS_SERVICES_CHANGED_EVENT, handleNacosServicesChanged as EventListener);
      };
  }, []);
  return { refreshConnectionResources };
};

export type SidebarConnectionRefreshApi = ReturnType<typeof useSidebarConnectionRefresh>;
