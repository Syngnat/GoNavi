import React, { useState, useDeferredValue, useRef, useMemo, useCallback, useEffect } from 'react';
import type { SearchScope } from '../sidebarCoreUtils';
import type { V2ExplorerFilter } from './sidebarHelpers';
import { useStore } from '../../store';
import {
  selectSidebarCommandSearchSqlLogs,
  selectRecentSidebarSqlLogs,
} from './sidebarSqlLogSelector';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { isSavedQueryUnmatchedForConnectionIds } from './sidebarRootHelpers';
import * as sidebarTreeDrag from './sidebarTreeDragOrder';
import { buildAllSavedQueriesTreeNode } from './sidebarSavedQueriesTreeNode';
import { filterSidebarTreeByHiddenObjectGroups } from '../../utils/sidebarObjectVisibility';
import { useSidebarFilterPersistence } from './useSidebarFilterPersistence';
import { message } from 'antd';
import { t } from '../../i18n';
import type { SidebarStoreStateApi } from './useSidebarStoreState';

export interface UseSidebarSearchStateInput {
  appearance: SidebarStoreStateApi['appearance'];
  connections: SidebarStoreStateApi['connections'];
  savedQueries: SidebarStoreStateApi['savedQueries'];
  savedQueryGroups: SidebarStoreStateApi['savedQueryGroups'];
  sidebarTreeOrders: SidebarStoreStateApi['sidebarTreeOrders'];
  tableSortPreference: SidebarStoreStateApi['tableSortPreference'];
  treeData: SidebarStoreStateApi['treeData'];
  activeContext: SidebarStoreStateApi['activeContext'];
  setActiveContext: SidebarStoreStateApi['setActiveContext'];
  setAppearance: SidebarStoreStateApi['setAppearance'];
}

export const useSidebarSearchState = ({
  appearance, connections, savedQueries, savedQueryGroups, sidebarTreeOrders, tableSortPreference,
  treeData, activeContext, setActiveContext, setAppearance,
}: UseSidebarSearchStateInput) => {
  const v2SidebarSearchMode = appearance.v2SidebarSearchMode ?? 'command';
  const usePersistentSidebarFilter = v2SidebarSearchMode === 'filter';
  const v2PersistedSidebarFilter = appearance.v2SidebarPersistedFilter ?? '';
  const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
  const sidebarSingleDatabaseExpansion = appearance.sidebarSingleDatabaseExpansion === true;
  const [searchValue, setSearchValue] = useState(
      usePersistentSidebarFilter ? v2PersistedSidebarFilter : '',
  );
  const deferredSearchValue = useDeferredValue(searchValue);
  const [searchScopes, setSearchScopes] = useState<SearchScope[]>(['smart']);
  const [v2ExplorerFilter, setV2ExplorerFilter] = useState<V2ExplorerFilter>('all');
  const [isSearchScopePopoverOpen, setIsSearchScopePopoverOpen] = useState(false);
  const searchInputRef = useRef<any>(null);
  const commandSearchInputRef = useRef<any>(null);
  const [isV2CommandSearchOpen, setIsV2CommandSearchOpen] = useState(false);
  const commandSearchSqlLogs = useStore(
      state => selectSidebarCommandSearchSqlLogs(state, isV2CommandSearchOpen),
  );
  const recentSqlLogs = useMemo(
      () => selectRecentSidebarSqlLogs(commandSearchSqlLogs),
      [commandSearchSqlLogs],
  );
  const [v2CommandSearchValue, setV2CommandSearchValue] = useState('');
  const deferredV2CommandSearchValue = useDeferredValue(v2CommandSearchValue);
  const [v2CommandActiveIndex, setV2CommandActiveIndex] = useState(0);
  const [expandedKeys, setExpandedKeysState] = useState<React.Key[]>([]);
  const expandedKeysRef = useRef<React.Key[]>([]);
  const [autoExpandParent, setAutoExpandParent] = useState(true);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const selectedSidebarKeyRef = useRef('');
  const setSidebarSelectedKeys = useCallback((
      action: React.SetStateAction<React.Key[]>,
  ) => {
      if (typeof action === 'function') {
          setSelectedKeys((previous) => {
              const next = action(previous);
              selectedSidebarKeyRef.current = String(next[0] ?? '').trim();
              return next;
          });
          return;
      }
      selectedSidebarKeyRef.current = String(action[0] ?? '').trim();
      setSelectedKeys(action);
  }, []);
  const selectedNodesRef = useRef<any[]>([]);
  const loadingNodesRef = useRef<Set<string>>(new Set());
  const databaseTreeTouchedAtRef = useRef<Record<string, number>>({});
  const pruneLoadedDatabaseTreesRef = useRef<() => void>(() => {});
  const refreshConnectionResourcesRef = useRef<(node: any) => Promise<void>>(async () => {});
  const loadNacosServiceGroupsRef = useRef<(
      node: any,
      options?: { force?: boolean },
  ) => Promise<boolean>>(async () => false);
  const replaceTreeNodeChildrenRef = useRef<(
      key: React.Key,
      children: TreeNode[] | undefined,
      dataRef?: unknown,
  ) => TreeNode[]>(() => []);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeDragSelectSuppressUntilRef = useRef(0);
  const treeDragSelectionSnapshotRef = useRef<{
      selectedKeys: React.Key[];
      selectedNodes: any[];
      activeContext: { connectionId: string; dbName: string; schemaName?: string; tableName?: string } | null;
  }>({
      selectedKeys: [],
      selectedNodes: [],
      activeContext: null,
  });
  const connectionReloadSignaturesRef = useRef<Record<string, string>>({});
  const invalidateConnectionLoadsRef = useRef<(connectionId: string) => void>(() => {});
  expandedKeysRef.current = expandedKeys;
  const connectionIds = useMemo(() => connections.map((conn) => conn.id), [connections]);
  const queryCapableConnectionIds = useMemo(
      () => new Set(
          connections
              .filter((conn) => getDataSourceCapabilities(conn.config).supportsQueryEditor)
              .map((conn) => conn.id),
      ),
      [connections],
  );
  const connectionIdSet = useMemo(() => new Set(connectionIds), [connectionIds]);
  const unmatchedSavedQueries = useMemo(
      () => savedQueries.filter((query) => isSavedQueryUnmatchedForConnectionIds(query, connectionIdSet)),
      [connectionIdSet, savedQueries],
  );
  const allSavedQueriesNode = useMemo<TreeNode | null>(() => {
      return sidebarTreeDrag.applySidebarTreeOrdersToNode(
          buildAllSavedQueriesTreeNode(savedQueries, connections, savedQueryGroups),
          sidebarTreeOrders,
          tableSortPreference,
      );
  }, [connections, savedQueries, savedQueryGroups, sidebarTreeOrders, tableSortPreference]);
  const sidebarHiddenObjectGroups = appearance.sidebarHiddenObjectGroups;
  const visibleSidebarTreeData = useMemo(
      () => filterSidebarTreeByHiddenObjectGroups(treeData, sidebarHiddenObjectGroups),
      [sidebarHiddenObjectGroups, treeData],
  );
  const sidebarObjectVisibilitySignature = sidebarHiddenObjectGroups.join('|') || 'all';
  const snapshotTreeSelectionBeforeDrag = useCallback(() => {
      treeDragSelectionSnapshotRef.current = {
          selectedKeys: [...selectedKeys],
          selectedNodes: [...selectedNodesRef.current],
          activeContext: activeContext ? { ...activeContext } : null,
      };
  }, [activeContext, selectedKeys]);

  const restoreTreeSelectionAfterDrag = useCallback(() => {
      const snapshot = treeDragSelectionSnapshotRef.current;
      treeDragSelectSuppressUntilRef.current = Date.now() + 1000;
      setSidebarSelectedKeys(snapshot.selectedKeys);
      selectedNodesRef.current = snapshot.selectedNodes;
      setActiveContext(snapshot.activeContext);
  }, [setActiveContext, setSidebarSelectedKeys]);

  const openV2CommandSearch = useCallback(() => {
      pruneLoadedDatabaseTreesRef.current();
      setIsV2CommandSearchOpen(true);
      setV2CommandActiveIndex(0);
  }, []);

  const closeV2CommandSearch = useCallback(() => {
      setIsV2CommandSearchOpen(false);
      setV2CommandSearchValue('');
      setV2CommandActiveIndex(0);
  }, []);

  useEffect(() => {
      setSearchValue(usePersistentSidebarFilter ? v2PersistedSidebarFilter : '');
  }, [usePersistentSidebarFilter, v2PersistedSidebarFilter]);

  const persistV2SidebarFilter = useCallback((nextFilter: string) => {
      setAppearance({ v2SidebarPersistedFilter: nextFilter });
  }, [setAppearance]);

  useSidebarFilterPersistence({
      enabled: usePersistentSidebarFilter,
      searchValue,
      persistedFilter: v2PersistedSidebarFilter,
      onPersist: persistV2SidebarFilter,
  });

  const handleV2CommandSearchValueChange = useCallback((value: string) => {
      setV2CommandSearchValue(value);
  }, []);

  const resetV2SidebarFilter = useCallback(() => {
      setSearchValue('');
      setAppearance({ v2SidebarPersistedFilter: '' });
      message.success(t('sidebar.message.sidebar_filter_reset'));
  }, [setAppearance]);
  return {
    usePersistentSidebarFilter, tableDoubleClickAction, sidebarSingleDatabaseExpansion, searchValue,
    setSearchValue, deferredSearchValue, searchScopes, setSearchScopes, v2ExplorerFilter,
    setV2ExplorerFilter, searchInputRef, commandSearchInputRef, isV2CommandSearchOpen,
    recentSqlLogs, v2CommandSearchValue, deferredV2CommandSearchValue, v2CommandActiveIndex,
    setV2CommandActiveIndex, expandedKeys, setExpandedKeysState, expandedKeysRef, autoExpandParent,
    setAutoExpandParent, loadedKeys, setLoadedKeys, selectedKeys, selectedSidebarKeyRef,
    setSidebarSelectedKeys, selectedNodesRef, loadingNodesRef, databaseTreeTouchedAtRef,
    pruneLoadedDatabaseTreesRef, refreshConnectionResourcesRef, loadNacosServiceGroupsRef,
    replaceTreeNodeChildrenRef, clickTimerRef, treeDragSelectSuppressUntilRef,
    connectionReloadSignaturesRef, invalidateConnectionLoadsRef, connectionIds,
    queryCapableConnectionIds, connectionIdSet, allSavedQueriesNode, visibleSidebarTreeData,
    sidebarObjectVisibilitySignature, snapshotTreeSelectionBeforeDrag,
    restoreTreeSelectionAfterDrag, openV2CommandSearch, closeV2CommandSearch,
    handleV2CommandSearchValueChange, resetV2SidebarFilter,
  };
};

export type SidebarSearchStateApi = ReturnType<typeof useSidebarSearchState>;
