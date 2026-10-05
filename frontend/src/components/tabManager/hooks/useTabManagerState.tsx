import React, { useMemo, useRef, useState, useLayoutEffect, useCallback, useEffect } from 'react';
import { useSensors, useSensor, PointerSensor } from '@dnd-kit/core';
import { message, Button } from 'antd';
import { useWorkbenchTabs } from '../../../hooks/useWorkbenchTabs';
import { useStore } from '../../../store';
import { useWorkbenchTabLifecyclePolicy } from '../../queryEditor/useWorkbenchTabLifecyclePolicy';
import { buildConnectionGroupNameIndex } from '../../../utils/tabDisplay';
import {
  V2_WORKBENCH_TAB_MAX_WIDTH,
  resolveV2WorkbenchTabWidth,
  buildTabWorkbenchStyle,
  isMainWindowBoundWorkbenchTab,
  isRunningDataImportWorkbenchTab,
} from '../tabManagerShortcuts';
import type { DetachDragPreviewState } from '../../DetachDragPreview';
import type { NativeDetachTerminalPointer } from '../../../utils/detachedWindow';
import { createSidebarResizeAwareFrameScheduler } from '../../../utils/sidebarResizeLifecycle';
import { t } from '../../../i18n';
import { openNativeWorkbenchTabWindow } from '../../../utils/nativeDetachedWindowHost';
import {
  resolveDockedActiveTabId,
  CLOSE_ACTIVE_WORKSPACE_TAB_EVENT,
} from '../../../utils/closeTabShortcut';
import type { TabData } from '../../../types';
import {
  isSQLFileQueryTab,
  getSQLFileTabPath,
  isSQLFileMissingReadResult,
  hasSQLFileTabUnsavedChanges,
  normalizeSQLFileReadContent,
  isSQLFileMissingErrorMessage,
} from '../../../utils/sqlFileTabDirty';
import {
  clearSQLFileTabDraft,
  getSQLFileTabDraft,
  clearQueryTabDraft,
} from '../../../utils/sqlFileTabDrafts';
import { ReadSQLFile, WriteSQLFile } from '../../../../wailsjs/go/app/App';
import Modal from '../../common/ResizableDraggableModal';
import {
  collectApplicationQuitUnsavedSQLTargets,
  buildApplicationQuitUnsavedSQLLabel,
  saveApplicationQuitUnsavedSQLTargets,
  assertApplicationQuitSavedSQLTargetsUnchanged,
  reconcileApplicationQuitSavedSQLTargets,
} from '../../../utils/sqlEditorApplicationQuit';
import {
  getDirtyWorkbenchTabCloseGuards,
  REQUEST_CLOSE_WORKBENCH_TABS_EVENT,
} from '../../../utils/workbenchTabCloseProtection';
import { closeConfirmedWorkbenchTabs } from '../tabManagerCloseHelpers';

export const useTabManagerState = () => {
  const tabs = useWorkbenchTabs();
  const detachedWorkbenchWindows = useStore(state => state.detachedWorkbenchWindows);
  const connections = useStore(state => state.connections);
  const connectionTags = useStore(state => state.connectionTags);
  const savedQueries = useStore(state => state.savedQueries);
  const externalSQLDirectories = useStore(state => state.externalSQLDirectories);
  const recentConnectionTargets = useStore(state => state.recentConnectionTargets);
  const recentSQLFiles = useStore(state => state.recentSQLFiles);
  const pinnedSidebarTables = useStore(state => state.pinnedSidebarTables);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const languagePreference = useStore(state => state.languagePreference);
  const activeTabId = useStore(state => state.activeTabId);
  const shouldDestroyHiddenTab = useWorkbenchTabLifecyclePolicy();
  const setActiveTab = useStore(state => state.setActiveTab);
  const addTab = useStore(state => state.addTab);
  const closeTab = useStore(state => state.closeTab);
  const moveTab = useStore(state => state.moveTab);
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const detachedTabIdSet = useMemo(
    () => new Set(detachedWorkbenchWindows.map((windowState) => windowState.tabId)),
    [detachedWorkbenchWindows],
  );
  const dockedTabs = useMemo(
    () => tabs.filter((tab) => !detachedTabIdSet.has(tab.id)),
    [detachedTabIdSet, tabs],
  );
  const connectionGroupNameById = useMemo(
    () => buildConnectionGroupNameIndex(connectionTags),
    [connectionTags],
  );
  const tabsNavBorderColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.09)' : 'rgba(0, 0, 0, 0.08)';
  const tabWorkbenchRef = useRef<HTMLDivElement>(null);
  const [v2TabWidth, setV2TabWidth] = useState(V2_WORKBENCH_TAB_MAX_WIDTH);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [detachDragPreview, setDetachDragPreview] = useState<DetachDragPreviewState | null>(null);
  const [openingRecentSQLFileKey, setOpeningRecentSQLFileKey] = useState<string | null>(null);
  const detachDragSessionRef = useRef<{
    tabId: string;
    title: string;
    startX: number;
    startY: number;
    startScreenX: number;
    startScreenY: number;
    pointerId: number | null;
    captureTarget: HTMLElement | null;
    terminalPointer: NativeDetachTerminalPointer | null;
    removeDragGuards: (() => void) | null;
  } | null>(null);
  const suppressClickUntilRef = useRef<number>(0);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const hasTabs = tabs.length > 0;
  const hasDockedTabs = dockedTabs.length > 0;
  useLayoutEffect(() => {
    if (dockedTabs.length === 0) {
      setV2TabWidth(V2_WORKBENCH_TAB_MAX_WIDTH);
      return;
    }

    const target = tabWorkbenchRef.current;
    if (!target) return;

    const updateWidth = (availableWidth: number) => {
      const nextWidth = resolveV2WorkbenchTabWidth(availableWidth, dockedTabs.length);
      setV2TabWidth((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth);
    };
    const measure = () => updateWidth(target.getBoundingClientRect().width);

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const scheduler = createSidebarResizeAwareFrameScheduler(measure);
    const observer = new ResizeObserver(() => scheduler.schedule());
    observer.observe(target);
    return () => {
      observer.disconnect();
      scheduler.dispose();
    };
  }, [dockedTabs.length]);

  const tabWorkbenchStyle = buildTabWorkbenchStyle(
    v2TabWidth,
    appearance.tabEnvironmentAccentThickness,
  );
  const detachTabToWindow = useCallback((tabId: string, preferred?: { x?: number; y?: number; width?: number; height?: number }) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (tab && isMainWindowBoundWorkbenchTab(tab)) {
      void message.warning(t('tab_manager.message.background_task_window_unavailable'));
      return;
    }
    void openNativeWorkbenchTabWindow(tabId, preferred).catch((error) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  }, [tabs]);
  const dockedActiveTabId = useMemo(() => {
    return resolveDockedActiveTabId(tabs, activeTabId, detachedWorkbenchWindows);
  }, [activeTabId, detachedWorkbenchWindows, tabs]);
  const pendingCloseTabIdsRef = useRef<Set<string>>(new Set());

  const onChange = (newActiveKey: string) => {
    setActiveTab(newActiveKey);
  };

  const requestCloseSQLFileTabs = useCallback(async (
    targetTabs: TabData[],
    closeConfirmedTabs: () => void,
  ) => {
    const candidateTabs = targetTabs.filter(isSQLFileQueryTab);
    if (candidateTabs.length === 0) {
      closeConfirmedTabs();
      return;
    }

    const closeConfirmedTabsAndClearDrafts = () => {
      closeConfirmedTabs();
      candidateTabs.forEach((tab) => clearSQLFileTabDraft(tab.id));
    };

    const dirtyTabs: Array<{ tab: TabData; draft: string }> = [];
    const missingFileTabs: Array<{ tab: TabData; filePath: string }> = [];
    for (const tab of candidateTabs) {
      const filePath = getSQLFileTabPath(tab);
      if (!filePath) continue;
      try {
        const res = await ReadSQLFile(filePath);
        if (!res.success) {
          if (isSQLFileMissingReadResult(res)) {
            missingFileTabs.push({ tab, filePath });
            continue;
          }
          message.error(t('tab_manager.sql_file_close.read_failed_cancel_close', { detail: res.message || filePath }));
          return;
        }
        const latestTab = useStore.getState().tabs.find((candidate) => candidate.id === tab.id);
        const draft = getSQLFileTabDraft(
          tab.id,
          String(latestTab?.query ?? tab.query ?? ''),
        );
        if (hasSQLFileTabUnsavedChanges({ ...tab, query: draft }, normalizeSQLFileReadContent(res.data))) {
          dirtyTabs.push({ tab, draft });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isSQLFileMissingErrorMessage(errorMessage)) {
          missingFileTabs.push({ tab, filePath });
          continue;
        }
        message.error(t('tab_manager.sql_file_close.read_failed_cancel_close', { detail: errorMessage }));
        return;
      }
    }

    const confirmDirtyTabsOrClose = () => {
      if (dirtyTabs.length === 0) {
        closeConfirmedTabsAndClearDrafts();
        return;
      }

      const firstDirtyTab = dirtyTabs[0].tab;
      const dirtyFilePath = getSQLFileTabPath(firstDirtyTab);
      const dirtyLabel = dirtyTabs.length === 1
        ? t('tab_manager.sql_file_close.dirty_single_label', { title: firstDirtyTab.title || dirtyFilePath })
        : t('tab_manager.sql_file_close.dirty_multiple_label', { count: dirtyTabs.length });

      let destroyConfirm: (() => void) | null = null;
      const confirmRef = Modal.confirm({
        title: t('tab_manager.sql_file_close.save_confirm_title'),
        content: t('tab_manager.sql_file_close.save_confirm_content', { label: dirtyLabel }),
        okText: t('tab_manager.sql_file_close.save_and_close'),
        cancelText: t('common.cancel'),
        closable: true,
        maskClosable: true,
        okButtonProps: { type: 'primary' },
        footer: (_, { OkBtn, CancelBtn }) => (
          <>
            <Button
              onClick={() => {
                destroyConfirm?.();
                closeConfirmedTabsAndClearDrafts();
              }}
            >
              {t('tab_manager.sql_file_close.discard')}
            </Button>
            <CancelBtn />
            <OkBtn />
          </>
        ),
        onOk: async () => {
          try {
            for (const { tab, draft } of dirtyTabs) {
              const filePath = getSQLFileTabPath(tab);
              if (!filePath) continue;
              const res = await WriteSQLFile(filePath, draft);
              if (!res.success) {
                throw new Error(t('tab_manager.sql_file_close.save_failed', {
                  title: tab.title || filePath,
                  detail: res.message || t('tab_manager.sql_file_close.unknown_error'),
                }));
              }
            }
            message.success(t('tab_manager.sql_file_close.saved'));
            closeConfirmedTabsAndClearDrafts();
          } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      });
      destroyConfirm = confirmRef.destroy;
    };

    if (missingFileTabs.length > 0) {
      const firstMissing = missingFileTabs[0];
      const missingLabel = missingFileTabs.length === 1
        ? t('tab_manager.sql_file_close.missing_single_label', { title: firstMissing.tab.title || firstMissing.filePath })
        : t('tab_manager.sql_file_close.missing_multiple_label', { count: missingFileTabs.length });
      Modal.confirm({
        title: t('tab_manager.sql_file_close.missing_confirm_title'),
        content: t('tab_manager.sql_file_close.missing_confirm_content', { label: missingLabel }),
        okText: dirtyTabs.length > 0 ? t('tab_manager.sql_file_close.continue_close') : t('tab_manager.sql_file_close.close_tabs'),
        cancelText: t('common.cancel'),
        closable: true,
        maskClosable: true,
        okButtonProps: { danger: true },
        onOk: () => {
          confirmDirtyTabsOrClose();
        },
      });
      return;
    }

    confirmDirtyTabsOrClose();
  }, []);

  const closeTabsWithSQLFilePrompt = useCallback((targetIds: string[], closeConfirmedTabs: () => void) => {
    const uniqueIds = Array.from(new Set(targetIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const targetIdSet = new Set(uniqueIds);
    // Query text is intentionally excluded from the chrome subscription. Resolve
    // close/save candidates from the live store so SQL-file dirty checks never
    // fall back to the render snapshot after an editor-only update.
    const targetTabs = useStore.getState().tabs.filter((tab) => targetIdSet.has(tab.id));
    const runningImportTabs = targetTabs.filter(isRunningDataImportWorkbenchTab);
    if (runningImportTabs.length > 0) {
      void message.warning(t('tab_manager.message.data_import_running_close_blocked'));
    }
    const closableTabs = targetTabs.filter((tab) => !isRunningDataImportWorkbenchTab(tab));
    if (closableTabs.length === 0) return;
    const dedupeKey = closableTabs.map((tab) => tab.id).sort().join('\n');
    if (pendingCloseTabIdsRef.current.has(dedupeKey)) return;
    pendingCloseTabIdsRef.current.add(dedupeKey);
    void (async () => {
      let sqlTargets;
      try {
        const latestState = useStore.getState();
        sqlTargets = await collectApplicationQuitUnsavedSQLTargets(
          closableTabs,
          latestState.savedQueries,
        );
      } catch (error) {
        message.error(t('tab_manager.close_protection.inspect_failed', {
          detail: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      let dataGuards = getDirtyWorkbenchTabCloseGuards(closableTabs.map((tab) => tab.id));
      if (sqlTargets.length === 0 && dataGuards.length === 0) {
        // Inspecting an external SQL file is asynchronous. Re-read the live
        // tab state before the no-prompt close so edits made during that read
        // are never discarded without a confirmation.
        const finalState = useStore.getState();
        const finalTargetTabs = finalState.tabs.filter((tab) => targetIdSet.has(tab.id));
        sqlTargets = await collectApplicationQuitUnsavedSQLTargets(
          finalTargetTabs,
          finalState.savedQueries,
        );
        dataGuards = getDirtyWorkbenchTabCloseGuards(finalTargetTabs.map((tab) => tab.id));
        if (sqlTargets.length === 0 && dataGuards.length === 0) {
          closeConfirmedTabs();
          return;
        }
      }

      const label = sqlTargets.length === 1 && dataGuards.length === 0
        ? buildApplicationQuitUnsavedSQLLabel(sqlTargets)
        : String(sqlTargets.length + dataGuards.length);
      let destroyConfirm: (() => void) | null = null;
      const confirmRef = Modal.confirm({
        title: t('tab_manager.close_protection.title'),
        content: t(
          sqlTargets.length === 1 && dataGuards.length === 0
            ? 'tab_manager.close_protection.content_single'
            : 'tab_manager.close_protection.content_multiple',
          { label },
        ),
        okText: t('tab_manager.close_protection.save_close'),
        cancelText: t('common.cancel'),
        closable: true,
        maskClosable: true,
        okButtonProps: { type: 'primary' },
        footer: (_, { OkBtn, CancelBtn }) => (
          <>
            <Button
              onClick={() => {
                destroyConfirm?.();
                void Promise.all(dataGuards.map(({ guard }) => guard.discard()))
                  .then(() => {
                    sqlTargets.forEach(({ tabId }) => clearQueryTabDraft(tabId));
                    closeConfirmedTabs();
                  });
              }}
            >
              {t('tab_manager.close_protection.discard_close')}
            </Button>
            <CancelBtn />
            <OkBtn />
          </>
        ),
        onOk: async () => {
          try {
            const latestState = useStore.getState();
            const latestTargetTabs = latestState.tabs.filter((tab) => targetIdSet.has(tab.id));
            const latestSqlTargets = await collectApplicationQuitUnsavedSQLTargets(
              latestTargetTabs,
              latestState.savedQueries,
            );
            const latestDataGuards = getDirtyWorkbenchTabCloseGuards(
              latestTargetTabs.map((tab) => tab.id),
            );
            const savedTargets = await saveApplicationQuitUnsavedSQLTargets(
              latestSqlTargets,
              latestState.saveQuery,
            );
            assertApplicationQuitSavedSQLTargetsUnchanged(savedTargets);
            useStore.setState((state) => ({
              tabs: reconcileApplicationQuitSavedSQLTargets(state.tabs, savedTargets),
            }));
            savedTargets.forEach(({ target }) => clearQueryTabDraft(target.tabId));
            for (const { guard } of latestDataGuards) {
              if (!(await guard.save())) {
                throw new Error(t('tab_manager.close_protection.save_failed'));
              }
            }
            closeConfirmedTabs();
          } catch (error) {
            message.error(t('tab_manager.close_protection.save_failed_detail', {
              detail: error instanceof Error ? error.message : String(error),
            }));
            throw error;
          }
        },
      });
      destroyConfirm = confirmRef.destroy;
    })().finally(() => {
      pendingCloseTabIdsRef.current.delete(dedupeKey);
    });
  }, []);

  const requestCloseActiveWorkspaceTab = useCallback(() => {
    if (!dockedActiveTabId) return;
    closeTabsWithSQLFilePrompt(
      [dockedActiveTabId],
      () => closeTab(dockedActiveTabId),
    );
  }, [closeTab, closeTabsWithSQLFilePrompt, dockedActiveTabId]);

  useEffect(() => {
    window.addEventListener(CLOSE_ACTIVE_WORKSPACE_TAB_EVENT, requestCloseActiveWorkspaceTab);
    return () => {
      window.removeEventListener(CLOSE_ACTIVE_WORKSPACE_TAB_EVENT, requestCloseActiveWorkspaceTab);
    };
  }, [requestCloseActiveWorkspaceTab]);

  useEffect(() => {
    const handleRequestedClose = (event: Event) => {
      const tabIds = (event as CustomEvent<{ tabIds?: unknown }>).detail?.tabIds;
      if (!Array.isArray(tabIds)) return;
      const normalizedTabIds = tabIds.map((id) => String(id || '').trim()).filter(Boolean);
      closeTabsWithSQLFilePrompt(normalizedTabIds, () => {
        closeConfirmedWorkbenchTabs(normalizedTabIds, closeTab);
      });
    };
    window.addEventListener(REQUEST_CLOSE_WORKBENCH_TABS_EVENT, handleRequestedClose);
    return () => window.removeEventListener(REQUEST_CLOSE_WORKBENCH_TABS_EVENT, handleRequestedClose);
  }, [closeTab, closeTabsWithSQLFilePrompt]);

  const onEdit = (targetKey: React.MouseEvent | React.KeyboardEvent | string, action: 'add' | 'remove') => {
    if (action === 'remove') {
      const id = String(targetKey || '');
      closeTabsWithSQLFilePrompt([id], () => closeTab(id));
    }
  };

  const dispatchDndPointerCancel = useCallback(() => {
    document.dispatchEvent(new Event('pointercancel', {
      bubbles: true,
      cancelable: true,
    }));
  }, []);
  return {
    tabs, connections, savedQueries, externalSQLDirectories, recentConnectionTargets,
    recentSQLFiles, pinnedSidebarTables, theme, appearance, languagePreference, activeTabId,
    shouldDestroyHiddenTab, setActiveTab, addTab, closeTab, moveTab, setAIPanelVisible, dockedTabs,
    connectionGroupNameById, tabsNavBorderColor, tabWorkbenchRef, setDraggingTabId,
    detachDragPreview, setDetachDragPreview, openingRecentSQLFileKey, setOpeningRecentSQLFileKey,
    detachDragSessionRef, suppressClickUntilRef, sensors, hasTabs, hasDockedTabs, tabWorkbenchStyle,
    detachTabToWindow, dockedActiveTabId, onChange, closeTabsWithSQLFilePrompt, onEdit,
    dispatchDndPointerCancel,
  };
};

export type TabManagerStateApi = ReturnType<typeof useTabManagerState>;
