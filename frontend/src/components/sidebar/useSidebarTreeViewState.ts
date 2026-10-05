import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { SidebarTreeScrollRequest } from './sidebarTreeScrollRequest';
import {
  type SidebarTreeNode as TreeNode,
  resolveSidebarSingleDatabaseExpandedKeys,
  shouldCloseV2CommandSearchOnGlobalKey,
  type SidebarConnectionState,
  type SidebarTreeDropPlacement,
} from '../sidebarV2Utils';
import { ExternalSQLTreeEntry, SavedConnection, SavedQuery } from '../../types';
import { createSidebarResizeAwareFrameScheduler } from '../../utils/sidebarResizeLifecycle';
import { SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS } from './sidebarRootHelpers';
import { Form } from 'antd';
import type { DatabaseCharsetOption, DatabaseCollationOption } from '../../utils/databaseCharset';
import type { SidebarMessagePublishTarget } from './useSidebarObjectActions';
import { useSidebarBatchExport } from './useSidebarBatchExport';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';

export interface UseSidebarTreeViewStateInput {
  setExpandedKeysState: SidebarSearchStateApi['setExpandedKeysState'];
  sidebarSingleDatabaseExpansion: SidebarSearchStateApi['sidebarSingleDatabaseExpansion'];
  treeData: SidebarStoreStateApi['treeData'];
  usePersistentSidebarFilter: SidebarSearchStateApi['usePersistentSidebarFilter'];
  openV2CommandSearch: SidebarSearchStateApi['openV2CommandSearch'];
  searchInputRef: SidebarSearchStateApi['searchInputRef'];
  isV2CommandSearchOpen: SidebarSearchStateApi['isV2CommandSearchOpen'];
  commandSearchInputRef: SidebarSearchStateApi['commandSearchInputRef'];
  closeV2CommandSearch: SidebarSearchStateApi['closeV2CommandSearch'];
  connections: SidebarStoreStateApi['connections'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  addTab: SidebarStoreStateApi['addTab'];
  autoFetchVisible: SidebarStoreStateApi['autoFetchVisible'];
  expandedKeys: SidebarSearchStateApi['expandedKeys'];
  findTreeNodeByKey: (nodes: TreeNode[], targetKey: React.Key) => TreeNode | null;
  loadTables: ReturnType<typeof useSidebarTreeLoaders>['loadTables'];
  savedQueries: SidebarStoreStateApi['savedQueries'];
}

export const useSidebarTreeViewState = ({
  setExpandedKeysState, sidebarSingleDatabaseExpansion, treeData, usePersistentSidebarFilter,
  openV2CommandSearch, searchInputRef, isV2CommandSearchOpen, commandSearchInputRef,
  closeV2CommandSearch, connections, selectedNodesRef, addTab, autoFetchVisible, expandedKeys,
  findTreeNodeByKey, loadTables, savedQueries,
}: UseSidebarTreeViewStateInput) => {
  // Virtual Scroll State
  const [treeHeight, setTreeHeight] = useState(500);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const treeScrollIdleTimerRef = useRef<number | null>(null);
  const treeRef = useRef<any>(null);
  const sidebarTreeScrollRequestIdRef = useRef(0);
  const [sidebarTreeScrollRequest, setSidebarTreeScrollRequest] = useState<SidebarTreeScrollRequest | null>(null);
  const treeDataRef = useRef<TreeNode[]>([]);
  const externalSQLDirectoryTreesRef = useRef<Record<string, ExternalSQLTreeEntry[]>>({});
  const findTreeNodeByKeyRef = useRef<(nodes: TreeNode[], targetKey: React.Key) => TreeNode | null>(() => null);
  const expandConnectionFromRailRef = useRef<(connectionId: string) => void>(() => {});
  const setExpandedKeys = useCallback<React.Dispatch<React.SetStateAction<React.Key[]>>>((update) => {
      setExpandedKeysState((previousExpandedKeys) => {
          const nextExpandedKeys = typeof update === 'function'
              ? update(previousExpandedKeys)
              : update;
          if (!sidebarSingleDatabaseExpansion) {
              return nextExpandedKeys;
          }
          return resolveSidebarSingleDatabaseExpandedKeys({
              previousExpandedKeys,
              nextExpandedKeys,
              treeData: treeDataRef.current,
          });
      });
  }, [sidebarSingleDatabaseExpansion]);
  useEffect(() => {
      treeDataRef.current = treeData;
  }, [treeData]);

  useEffect(() => {
      if (!sidebarSingleDatabaseExpansion) return;
      setExpandedKeysState((previousExpandedKeys) => resolveSidebarSingleDatabaseExpandedKeys({
          previousExpandedKeys,
          nextExpandedKeys: previousExpandedKeys,
          treeData: treeDataRef.current,
      }));
  }, [sidebarSingleDatabaseExpansion]);

  useEffect(() => {
      if (!treeContainerRef.current) return;
      const scheduler = createSidebarResizeAwareFrameScheduler(() => {
          const target = treeContainerRef.current;
          if (!target) return;
          const rect = target.getBoundingClientRect();
          setTreeHeight((current) => (Math.abs(current - rect.height) < 1 ? current : rect.height));
      });
      const resizeObserver = new ResizeObserver(() => scheduler.schedule());
      resizeObserver.observe(treeContainerRef.current);
      scheduler.schedule();
      return () => {
          resizeObserver.disconnect();
          scheduler.dispose();
      };
  }, []);

  const markTreeScrollActivity = useCallback(() => {
      treeContainerRef.current?.classList.add('is-vertical-scrolling');
      if (treeScrollIdleTimerRef.current !== null) {
          window.clearTimeout(treeScrollIdleTimerRef.current);
      }
      treeScrollIdleTimerRef.current = window.setTimeout(() => {
          treeScrollIdleTimerRef.current = null;
          treeContainerRef.current?.classList.remove('is-vertical-scrolling');
      }, SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS);
  }, []);

  useEffect(() => () => {
      if (treeScrollIdleTimerRef.current !== null) {
          window.clearTimeout(treeScrollIdleTimerRef.current);
      }
      treeContainerRef.current?.classList.remove('is-vertical-scrolling');
  }, []);

  useEffect(() => {
      const handleFocusSidebarSearch = () => {
          if (!usePersistentSidebarFilter) {
              openV2CommandSearch();
              return;
          }
          const inputEl = searchInputRef.current?.input as HTMLInputElement | undefined;
          if (!inputEl) {
              return;
          }
          inputEl.focus();
          inputEl.select();
      };
      window.addEventListener('gonavi:focus-sidebar-search', handleFocusSidebarSearch as EventListener);
      return () => {
          window.removeEventListener('gonavi:focus-sidebar-search', handleFocusSidebarSearch as EventListener);
      };
  }, [openV2CommandSearch, usePersistentSidebarFilter]);

  useEffect(() => {
      if (!isV2CommandSearchOpen) return;
      const timer = window.setTimeout(() => {
          const inputEl = commandSearchInputRef.current?.input as HTMLInputElement | undefined;
          inputEl?.focus();
          inputEl?.select();
      }, 0);
      return () => window.clearTimeout(timer);
  }, [isV2CommandSearchOpen]);

  useEffect(() => {
      if (!isV2CommandSearchOpen) return;
      const handleV2CommandSearchGlobalKeyDown = (event: KeyboardEvent) => {
          if (!shouldCloseV2CommandSearchOnGlobalKey({ key: event.key, isOpen: isV2CommandSearchOpen })) {
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          closeV2CommandSearch();
      };
      window.addEventListener('keydown', handleV2CommandSearchGlobalKeyDown, true);
      return () => window.removeEventListener('keydown', handleV2CommandSearchGlobalKeyDown, true);
  }, [closeV2CommandSearch, isV2CommandSearchOpen]);

  // Connection Status State: key -> 'loading' | 'success' | 'error'
  const [connectionStates, setConnectionStates] = useState<Record<string, SidebarConnectionState>>({});

  const [isTreeDragging, setIsTreeDragging] = useState(false);
  const [sidebarTreeDragNodeType, setSidebarTreeDragNodeType] = useState<string | null>(null);
  const [sidebarTreeDropPreview, setSidebarTreeDropPreview] = useState<{
      nodeKey: string;
      placement: SidebarTreeDropPlacement;
  } | null>(null);
  const sidebarTreeDragNodeRef = useRef<TreeNode | null>(null);
  const sidebarTreeDropPreviewRef = useRef<typeof sidebarTreeDropPreview>(null);
  const sidebarTreeDragPreviewElementRef = useRef<HTMLElement | null>(null);
  const sidebarGroupHoverExpandTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
      if (sidebarGroupHoverExpandTimerRef.current !== null) {
          window.clearTimeout(sidebarGroupHoverExpandTimerRef.current);
      }
      sidebarTreeDragPreviewElementRef.current?.remove();
  }, []);

  // Create Database Modal
  const [isCreateDbModalOpen, setIsCreateDbModalOpen] = useState(false);
  const [createDbForm] = Form.useForm();
  const [targetConnection, setTargetConnection] = useState<any>(null);
  const [createDbCharsets, setCreateDbCharsets] = useState<DatabaseCharsetOption[]>([]);
  const [createDbCollations, setCreateDbCollations] = useState<DatabaseCollationOption[]>([]);
  const [loadingCreateDbOptions, setLoadingCreateDbOptions] = useState(false);
  const [isCreateSchemaModalOpen, setIsCreateSchemaModalOpen] = useState(false);
  const [createSchemaForm] = Form.useForm();
  const [createSchemaTarget, setCreateSchemaTarget] = useState<any>(null);
  const [isRenameSchemaModalOpen, setIsRenameSchemaModalOpen] = useState(false);
  const [renameSchemaForm] = Form.useForm();
  const [renameSchemaTarget, setRenameSchemaTarget] = useState<any>(null);
  const [connectionVisibilityTarget, setConnectionVisibilityTarget] = useState<{
      connection: SavedConnection;
      initialDatabase?: string;
  } | null>(null);
  const [isSavingConnectionVisibility, setIsSavingConnectionVisibility] = useState(false);
  const [isRenameDbModalOpen, setIsRenameDbModalOpen] = useState(false);
  const [renameDbForm] = Form.useForm();
  const [renameDbTarget, setRenameDbTarget] = useState<any>(null);
  const [isRenameTableModalOpen, setIsRenameTableModalOpen] = useState(false);
  const [renameTableForm] = Form.useForm();
  const [renameTableTarget, setRenameTableTarget] = useState<any>(null);
  const [messagePublishTarget, setMessagePublishTarget] = useState<SidebarMessagePublishTarget | null>(null);
  const [isRenameViewModalOpen, setIsRenameViewModalOpen] = useState(false);
  const [renameViewForm] = Form.useForm();
  const [renameViewTarget, setRenameViewTarget] = useState<any>(null);
  const [isRenameSavedQueryModalOpen, setIsRenameSavedQueryModalOpen] = useState(false);
  const [renameSavedQueryForm] = Form.useForm();
  const [renameSavedQueryTarget, setRenameSavedQueryTarget] = useState<SavedQuery | null>(null);
  const [isSavedQueryGroupModalOpen, setIsSavedQueryGroupModalOpen] = useState(false);
  const [savedQueryGroupTargetId, setSavedQueryGroupTargetId] = useState<string | null>(null);
  const [savedQueryGroupInitialParentId, setSavedQueryGroupInitialParentId] = useState<string | null>(null);
  // Connection Tag Modals
  const [isCreateTagModalOpen, setIsCreateTagModalOpen] = useState(false);
  const [createTagForm] = Form.useForm();

  useEffect(() => {
    const openTagForm = (event: Event) => {
      const parentTagId = String((event as CustomEvent<{ parentTagId?: string }>).detail?.parentTagId || '').trim();
      setRenameViewTarget(null);
      createTagForm.resetFields();
      if (parentTagId) createTagForm.setFieldsValue({ parentTagId });
      setIsCreateTagModalOpen(true);
    };
    window.addEventListener('gonavi:open-connection-tag-form', openTagForm);
    return () => window.removeEventListener('gonavi:open-connection-tag-form', openTagForm);
  }, [createTagForm]);

  const {
      handleExportDatabaseSQL,
      handleExportSchemaSQL,
      openBatchTableWorkbench,
      openBatchDatabaseWorkbench,
      openBatchConnectionWorkbench,
  } = useSidebarBatchExport({
      connections,
      selectedNodesRef,
      addTab,
  });
  // Find in Database Modal
  const [findInDbContext, setFindInDbContext] = useState<{ open: boolean; connectionId: string; dbName: string }>({ open: false, connectionId: '', dbName: '' });

  useEffect(() => {
      if (!autoFetchVisible) {
          return;
      }

      expandedKeys.forEach(key => {
          const node = findTreeNodeByKey(treeData, key);
          if (node && (node.type === 'database' || node.type === 'message-namespace')) {
              loadTables(node, { ensureFresh: true });
          }
      });
  }, [autoFetchVisible, savedQueries]);
  return {
    treeHeight, treeContainerRef, treeRef, sidebarTreeScrollRequestIdRef, sidebarTreeScrollRequest,
    setSidebarTreeScrollRequest, treeDataRef, externalSQLDirectoryTreesRef, findTreeNodeByKeyRef,
    expandConnectionFromRailRef, setExpandedKeys, markTreeScrollActivity, connectionStates,
    setConnectionStates, isTreeDragging, setIsTreeDragging, sidebarTreeDragNodeType,
    setSidebarTreeDragNodeType, sidebarTreeDropPreview, setSidebarTreeDropPreview,
    sidebarTreeDragNodeRef, sidebarTreeDropPreviewRef, sidebarTreeDragPreviewElementRef,
    sidebarGroupHoverExpandTimerRef, isCreateDbModalOpen, setIsCreateDbModalOpen, createDbForm,
    targetConnection, setTargetConnection, createDbCharsets, setCreateDbCharsets,
    createDbCollations, setCreateDbCollations, loadingCreateDbOptions, setLoadingCreateDbOptions,
    isCreateSchemaModalOpen, setIsCreateSchemaModalOpen, createSchemaForm, createSchemaTarget,
    setCreateSchemaTarget, isRenameSchemaModalOpen, setIsRenameSchemaModalOpen, renameSchemaForm,
    renameSchemaTarget, setRenameSchemaTarget, connectionVisibilityTarget,
    setConnectionVisibilityTarget, isSavingConnectionVisibility, setIsSavingConnectionVisibility,
    isRenameDbModalOpen, setIsRenameDbModalOpen, renameDbForm, renameDbTarget, setRenameDbTarget,
    isRenameTableModalOpen, setIsRenameTableModalOpen, renameTableForm, renameTableTarget,
    setRenameTableTarget, messagePublishTarget, setMessagePublishTarget, isRenameViewModalOpen,
    setIsRenameViewModalOpen, renameViewForm, renameViewTarget, setRenameViewTarget,
    isRenameSavedQueryModalOpen, setIsRenameSavedQueryModalOpen, renameSavedQueryForm,
    renameSavedQueryTarget, setRenameSavedQueryTarget, isSavedQueryGroupModalOpen,
    setIsSavedQueryGroupModalOpen, savedQueryGroupTargetId, setSavedQueryGroupTargetId,
    savedQueryGroupInitialParentId, setSavedQueryGroupInitialParentId, isCreateTagModalOpen,
    setIsCreateTagModalOpen, createTagForm, handleExportDatabaseSQL, handleExportSchemaSQL,
    openBatchTableWorkbench, openBatchDatabaseWorkbench, openBatchConnectionWorkbench,
    findInDbContext, setFindInDbContext,
  };
};

export type SidebarTreeViewStateApi = ReturnType<typeof useSidebarTreeViewState>;
