import React, { useCallback, useEffect } from 'react';
import {
  type SidebarTreeNode as TreeNode,
  replaceSidebarTreeNodeChildren,
  resolveSidebarDatabaseTreePruneKeys,
} from '../sidebarV2Utils';
import * as sidebarTreeDrag from './sidebarTreeDragOrder';
import { SIDEBAR_CACHED_DATABASE_TREE_LIMIT } from './sidebarRootHelpers';
import { type ExternalSQLTreeNode, buildExternalSQLRootNode } from '../../utils/externalSqlTree';
import { GnFolderOpenIcon, GnFolderIcon, GnSqlDocIcon } from '../icons/gnIcons';
import { WarningOutlined, HddOutlined } from '@ant-design/icons';
import { ExternalSQLDirectory, ExternalSQLTreeEntry } from '../../types';
import { t } from '../../i18n';
import { ListSQLDirectory } from '../../../wailsjs/go/app/App';
import { message } from 'antd';
import {
  type BuildDataImportWorkbenchTabInput,
  DATA_IMPORT_WORKBENCH_TAB_ID,
  resolveDataImportWorkbenchLaunchTab,
} from '../../utils/dataImportTab';
import { useSidebarExternalSqlWorkflow } from './SidebarExternalSqlWorkflow';
import { useStore } from '../../store';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarProps } from '../Sidebar';

export interface UseSidebarTreeDataInput {
  sidebarTreeOrdersRef: SidebarStoreStateApi['sidebarTreeOrdersRef'];
  tableSortPreferenceRef: SidebarStoreStateApi['tableSortPreferenceRef'];
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  setTreeData: SidebarStoreStateApi['setTreeData'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  connectionIds: SidebarSearchStateApi['connectionIds'];
  invalidateConnectionLoadsRef: SidebarSearchStateApi['invalidateConnectionLoadsRef'];
  setConnectionStates: SidebarTreeViewStateApi['setConnectionStates'];
  databaseTreeTouchedAtRef: SidebarSearchStateApi['databaseTreeTouchedAtRef'];
  activeContext: SidebarStoreStateApi['activeContext'];
  expandedKeys: SidebarSearchStateApi['expandedKeys'];
  selectedKeys: SidebarSearchStateApi['selectedKeys'];
  pruneLoadedDatabaseTreesRef: SidebarSearchStateApi['pruneLoadedDatabaseTreesRef'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  setAutoExpandParent: SidebarSearchStateApi['setAutoExpandParent'];
  sidebarTreeScrollRequestIdRef: SidebarTreeViewStateApi['sidebarTreeScrollRequestIdRef'];
  setSidebarTreeScrollRequest: SidebarTreeViewStateApi['setSidebarTreeScrollRequest'];
  externalSQLDirectories: SidebarStoreStateApi['externalSQLDirectories'];
  externalSQLDirectoryTreesRef: SidebarTreeViewStateApi['externalSQLDirectoryTreesRef'];
  tabs: SidebarStoreStateApi['tabs'];
  addTab: SidebarStoreStateApi['addTab'];
  isWebRuntime: Exclude<SidebarProps['isWebRuntime'], undefined>;
  connections: SidebarStoreStateApi['connections'];
  activeTab: SidebarStoreStateApi['activeTab'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  saveExternalSQLDirectory: SidebarStoreStateApi['saveExternalSQLDirectory'];
  deleteExternalSQLDirectory: SidebarStoreStateApi['deleteExternalSQLDirectory'];
  updateRecentSQLFilePath: SidebarStoreStateApi['updateRecentSQLFilePath'];
  removeRecentSQLFilesByPath: SidebarStoreStateApi['removeRecentSQLFilesByPath'];
  moveRecentSQLFilesByDirectory: SidebarStoreStateApi['moveRecentSQLFilesByDirectory'];
  removeRecentSQLFilesByDirectory: SidebarStoreStateApi['removeRecentSQLFilesByDirectory'];
}

export const useSidebarTreeData = ({
  sidebarTreeOrdersRef, tableSortPreferenceRef, treeDataRef, setTreeData, setLoadedKeys,
  connectionIds, invalidateConnectionLoadsRef, setConnectionStates, databaseTreeTouchedAtRef,
  activeContext, expandedKeys, selectedKeys, pruneLoadedDatabaseTreesRef, setExpandedKeys,
  setAutoExpandParent, sidebarTreeScrollRequestIdRef, setSidebarTreeScrollRequest,
  externalSQLDirectories, externalSQLDirectoryTreesRef, tabs, addTab, isWebRuntime, connections,
  activeTab, selectedNodesRef, saveExternalSQLDirectory, deleteExternalSQLDirectory,
  updateRecentSQLFilePath, removeRecentSQLFilesByPath, moveRecentSQLFilesByDirectory,
  removeRecentSQLFilesByDirectory,
}: UseSidebarTreeDataInput) => {
  const replaceTreeNodeChildren = (
    key: React.Key,
    children: TreeNode[] | undefined,
    dataRef?: unknown,
  ): TreeNode[] => {
      const orderedChildren = children
          ? sidebarTreeDrag.applySidebarTreeOrders(
              String(key),
              children,
              sidebarTreeOrdersRef.current,
              tableSortPreferenceRef.current,
          )
          : undefined;
      const nextTreeData = replaceSidebarTreeNodeChildren(treeDataRef.current, key, orderedChildren, dataRef);
      treeDataRef.current = nextTreeData;
      setTreeData(nextTreeData);
      return nextTreeData;
  };

  const clearTreeNodeChildrenByKeys = useCallback((keysToClear: string[]) => {
      const keysToClearSet = new Set(keysToClear.map((key) => String(key || '').trim()).filter(Boolean));
      if (keysToClearSet.size === 0) {
          return;
      }

      const clearChildren = (nodes: TreeNode[]): TreeNode[] => (
          nodes.map((node) => {
              const nodeKey = String(node.key || '').trim();
              if (keysToClearSet.has(nodeKey)) {
                  return { ...node, children: undefined };
              }
              if (node.children?.length) {
                  return { ...node, children: clearChildren(node.children) };
              }
              return node;
          })
      );

      setTreeData((prev) => {
          const nextTreeData = clearChildren(prev);
          treeDataRef.current = nextTreeData;
          return nextTreeData;
      });
      setLoadedKeys((prev) => prev.filter((key) => !keysToClearSet.has(String(key))));
      // Clearing a Host subtree also invalidates its transient load result;
      // otherwise a late metadata response can repaint the unloaded row green.
      const clearedConnectionIds = connectionIds.filter((connectionId) => keysToClearSet.has(connectionId));
      clearedConnectionIds.forEach((connectionId) => invalidateConnectionLoadsRef.current(connectionId));
      setConnectionStates((previous) => {
          let changed = false;
          const next = { ...previous };
          keysToClearSet.forEach((key) => {
              if (Object.prototype.hasOwnProperty.call(next, key)) {
                  delete next[key];
                  changed = true;
              }
          });
          return changed ? next : previous;
      });
      keysToClearSet.forEach((key) => {
          delete databaseTreeTouchedAtRef.current[key];
      });
  }, [connectionIds]);

  const pruneLoadedDatabaseTrees = useCallback(() => {
      const activeDatabaseKey = activeContext?.connectionId && activeContext?.dbName
          ? `${activeContext.connectionId}-${activeContext.dbName}`
          : '';
      const keysToClear = resolveSidebarDatabaseTreePruneKeys({
          treeData: treeDataRef.current,
          expandedKeys,
          selectedKeys,
          activeDatabaseKey,
          touchedAtByDatabaseKey: databaseTreeTouchedAtRef.current,
          maxLoadedDatabases: SIDEBAR_CACHED_DATABASE_TREE_LIMIT,
      });
      if (keysToClear.length === 0) {
          return;
      }
      clearTreeNodeChildrenByKeys(keysToClear);
  }, [activeContext?.connectionId, activeContext?.dbName, clearTreeNodeChildrenByKeys, expandedKeys, selectedKeys]);
  pruneLoadedDatabaseTreesRef.current = pruneLoadedDatabaseTrees;

  const mergeExpandedTreeKeys = useCallback((requiredKeys: React.Key[]) => {
      setExpandedKeys(prev => {
          const merged = [...prev];
          requiredKeys.forEach(key => {
              if (!merged.includes(key)) merged.push(key);
          });
          return merged;
      });
      setAutoExpandParent(true);
  }, []);

  const scrollSidebarTreeToKey = useCallback((
      key: React.Key,
      scrollBlock: 'nearest' | 'center' = 'nearest',
  ) => {
      const id = sidebarTreeScrollRequestIdRef.current + 1;
      sidebarTreeScrollRequestIdRef.current = id;
      setSidebarTreeScrollRequest({ id, key, scrollBlock });
  }, []);

  const decorateExternalSQLTreeNode = (node: ExternalSQLTreeNode): TreeNode => {
    const icon = (() => {
      switch (node.type) {
        case 'external-sql-root':
          return (
            <span className="gn-v2-tree-folder-icon" data-sidebar-tree-folder-icon="true">
              <GnFolderOpenIcon />
            </span>
          );
        case 'external-sql-directory':
          return node.dataRef.directoryStatus === 'missing' ? <WarningOutlined /> : <HddOutlined />;
        case 'external-sql-folder':
          return <GnFolderIcon />;
        default:
          return <GnSqlDocIcon />;
      }
    })();

    return {
      ...node,
      icon,
      children: node.children?.map((child) => decorateExternalSQLTreeNode(child)),
    };
  };

  const buildExternalSQLRootTreeNode = useCallback((
      directories: ExternalSQLDirectory[] = externalSQLDirectories,
      directoryTrees: Record<string, ExternalSQLTreeEntry[]> = externalSQLDirectoryTreesRef.current,
      directoryStatuses: Record<string, 'missing'> = {},
  ): TreeNode => decorateExternalSQLTreeNode(buildExternalSQLRootNode({
      directories,
      directoryTrees,
      directoryStatuses,
      labels: {
          missingDirectory: t('sidebar.message.external_sql_directory_not_found'),
      },
  })), [externalSQLDirectories]);

  const refreshGlobalExternalSQLRootNode = useCallback(async (
      showSuccess = false,
      directoriesOverride?: ExternalSQLDirectory[],
  ) => {
      const targetDirectories = directoriesOverride || externalSQLDirectories;
      const directoryTrees: Record<string, ExternalSQLTreeEntry[]> = {};
      const directoryStatuses: Record<string, 'missing'> = {};
      await Promise.all(targetDirectories.map(async (directory) => {
          const directoryRes = await ListSQLDirectory(directory.path);
          if (!directoryRes.success) {
              const errorCode = String((directoryRes.data as Record<string, unknown> | undefined)?.errorCode || '').trim();
              if (errorCode === 'directory_not_found') {
                  directoryStatuses[directory.id] = 'missing';
              } else {
                  message.warning({
                      key: `external-sql-${directory.id}`,
                      content: t('sidebar.message.external_sql_directory_read_failed', {
                          name: directory.name,
                          error: directoryRes.message,
                      }),
                  });
              }
              directoryTrees[directory.id] = [];
              return;
          }
          directoryTrees[directory.id] = Array.isArray(directoryRes.data)
              ? directoryRes.data as ExternalSQLTreeEntry[]
              : [];
      }));
      externalSQLDirectoryTreesRef.current = directoryTrees;
      const rootNode = buildExternalSQLRootTreeNode(targetDirectories, directoryTrees, directoryStatuses);
      setTreeData((prev) => {
          const withoutExternalRoot = prev.filter((node) => node.type !== 'external-sql-root');
          const nextTreeData = [...withoutExternalRoot, rootNode];
          treeDataRef.current = nextTreeData;
          return nextTreeData;
      });
      if (showSuccess) {
          message.success(t('sidebar.message.external_sql_directory_refreshed'));
      }
  }, [buildExternalSQLRootTreeNode, externalSQLDirectories]);

  useEffect(() => {
      void refreshGlobalExternalSQLRootNode(false);
  }, [refreshGlobalExternalSQLRootNode]);

  const openDataImportWorkbench = useCallback((input: BuildDataImportWorkbenchTabInput) => {
    const existingImportTab = tabs.find((tab) => tab.id === DATA_IMPORT_WORKBENCH_TAB_ID);
    addTab(resolveDataImportWorkbenchLaunchTab(existingImportTab, input));
  }, [addTab, tabs]);

  const {
      handleRunSQLFile,
      handleOpenSQLFileFromToolbar,
      openExternalSQLFile,
      openExternalSQLBindingModal,
      openCreateExternalSQLFileModal,
      openRenameExternalSQLFileModal,
      openCreateExternalSQLDirectoryModal,
      openRenameExternalSQLDirectoryModal,
      handleDeleteExternalSQLFile,
      handleDeleteExternalSQLDirectory,
      handleAddExternalSQLDirectory,
      handleRemoveExternalSQLDirectory,
      handleRefreshExternalSQLDirectory,
      browserSQLFileInputProps,
      externalSQLFileModalProps,
      externalSQLBindingModalProps,
  } = useSidebarExternalSqlWorkflow({
      connections,
      externalSQLDirectories,
      activeTab,
      connectionIds,
      selectedNodesRef,
      addTab,
      openDataImportWorkbench,
      saveExternalSQLDirectory,
      deleteExternalSQLDirectory,
      updateRecentSQLFilePath,
      removeRecentSQLFilesByPath,
      moveRecentSQLFilesByDirectory,
      removeRecentSQLFilesByDirectory,
      refreshGlobalExternalSQLRootNode,
      setExpandedKeys,
      setAutoExpandParent,
      getActiveContext: () => useStore.getState().activeContext,
      isWebRuntime,
  });

  useEffect(() => {
    const handleWorkbenchAddExternalSQLDirectory = () => {
      void handleAddExternalSQLDirectory({ type: 'external-sql-root' });
    };
    window.addEventListener('gonavi:add-external-sql-directory', handleWorkbenchAddExternalSQLDirectory);
    return () => {
      window.removeEventListener('gonavi:add-external-sql-directory', handleWorkbenchAddExternalSQLDirectory);
    };
  }, [handleAddExternalSQLDirectory]);

  const getNodeDatabaseContext = (node: any): { connectionId: string; dbName: string; dbNodeKey: string } | null => {
    if (!node) return null;
    if (node.type === 'database' || node.type === 'message-namespace') {
      return {
        connectionId: String(node?.dataRef?.id || '').trim(),
        dbName: String(node?.dataRef?.dbName || '').trim(),
        dbNodeKey: String(node.key || '').trim(),
      };
    }

    if (
      node.type === 'external-sql-root'
      || node.type === 'external-sql-directory'
      || node.type === 'external-sql-folder'
      || node.type === 'external-sql-file'
    ) {
      return {
        connectionId: String(node?.dataRef?.connectionId || '').trim(),
        dbName: String(node?.dataRef?.dbName || '').trim(),
        dbNodeKey: String(node?.dataRef?.dbNodeKey || '').trim(),
      };
    }

    return null;
  };
  return {
    replaceTreeNodeChildren, clearTreeNodeChildrenByKeys, pruneLoadedDatabaseTrees,
    mergeExpandedTreeKeys, scrollSidebarTreeToKey, refreshGlobalExternalSQLRootNode,
    openDataImportWorkbench, handleRunSQLFile, handleOpenSQLFileFromToolbar, openExternalSQLFile,
    openExternalSQLBindingModal, openCreateExternalSQLFileModal, openRenameExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal, openRenameExternalSQLDirectoryModal,
    handleDeleteExternalSQLFile, handleDeleteExternalSQLDirectory, handleAddExternalSQLDirectory,
    handleRemoveExternalSQLDirectory, handleRefreshExternalSQLDirectory, browserSQLFileInputProps,
    externalSQLFileModalProps, externalSQLBindingModalProps,
  };
};

export type SidebarTreeDataApi = ReturnType<typeof useSidebarTreeData>;
