import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  getShortcutPlatform,
  installGlobalImeCompositionTracking,
  isEditableElement,
} from '../../utils/shortcuts';
import { resolveTitleBarPrimaryActionShortcut } from '../../components/TitleBarPrimaryActions';
import { shouldEnableMacWindowDiagnostics } from '../../utils/macWindowDiagnostics';
import { useAppUpdateManager } from '../../hooks/useAppUpdateManager';
import { formatAboutCheckedAt } from '../aboutSettingsFormat';
import {
  buildReleaseNotesReadKey,
  isReleaseNotesRead,
  markReleaseNotesRead,
} from '../../utils/updateReleaseNotesReadState';
import { safeWindowRuntimeCall } from '../../utils/wailsRuntime';
import {
  WindowIsFullscreen,
  WindowIsMaximised,
  WindowIsMinimised,
  WindowIsNormal,
  WindowGetSize,
  WindowGetPosition,
} from '../../../wailsjs/runtime';
import {
  getDataSourceCapabilities,
  isMessageQueueDataSource,
  resolveMessageQueueExecutionDbName,
  resolveDataSourceType,
} from '../../utils/dataSourceCapabilities';
import {
  resolveNewQueryContext,
  canInheritNewQueryTableContext,
} from '../../utils/newQueryContext';
import { buildContextualNewQueryTemplate } from '../../utils/objectQueryTemplates';
import {
  CancelApplicationQuit,
  ForceQuitApplication,
  RestartApplication,
} from '../../../wailsjs/go/app/App';
import type { AppShellStateApi } from './useAppShellState';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';

export interface UseAppUpdateAndDiagnosticsInput {
  isMacRuntime: AppShellStateApi['isMacRuntime'];
  shortcutOptions: AppCoreStateApi['shortcutOptions'];
  runtimeBuildType: AppCoreStateApi['runtimeBuildType'];
  t: AppCoreStateApi['t'];
  windowDiagSequenceRef: AppShellStateApi['windowDiagSequenceRef'];
  windowDiagLastSignatureRef: AppShellStateApi['windowDiagLastSignatureRef'];
  windowDiagLastAtRef: AppShellStateApi['windowDiagLastAtRef'];
  activeTabId: AppSecurityUpdateApi['activeTabId'];
  tabs: AppSecurityUpdateApi['tabs'];
  connections: AppSecurityUpdateApi['connections'];
  activeContext: AppSecurityUpdateApi['activeContext'];
  addTab: AppSecurityUpdateApi['addTab'];
  appearance: AppCoreStateApi['appearance'];
  setActiveTab: AppSecurityUpdateApi['setActiveTab'];
  applicationQuitHandlingRef: AppSecurityUpdateApi['applicationQuitHandlingRef'];
  applicationQuitConfirmRef: AppSecurityUpdateApi['applicationQuitConfirmRef'];
}

export const useAppUpdateAndDiagnostics = ({
  isMacRuntime, shortcutOptions, runtimeBuildType, t, windowDiagSequenceRef,
  windowDiagLastSignatureRef, windowDiagLastAtRef, activeTabId, tabs, connections, activeContext,
  addTab, appearance, setActiveTab, applicationQuitHandlingRef, applicationQuitConfirmRef,
}: UseAppUpdateAndDiagnosticsInput) => {
  const useNativeMacWindowControls = isMacRuntime;
  const activeShortcutPlatform = getShortcutPlatform(isMacRuntime);
  const titleBarNewQueryShortcut = resolveTitleBarPrimaryActionShortcut(
      shortcutOptions,
      'newQueryTab',
      activeShortcutPlatform,
  );
  const titleBarNewConnectionShortcut = resolveTitleBarPrimaryActionShortcut(
      shortcutOptions,
      'newConnection',
      activeShortcutPlatform,
  );
  const macWindowDiagnosticsEnabled = shouldEnableMacWindowDiagnostics(
      isMacRuntime,
      import.meta.env.DEV,
      import.meta.env.VITE_GONAVI_ENABLE_MAC_WINDOW_DIAGNOSTICS,
  );
  useEffect(() => {
      return installGlobalImeCompositionTracking(window, document);
  }, []);
  // 启动发现更新时打开设置中心「关于」页（由 useAppUpdateManager 通过 bridge 调用）
  const updateCenterBridgeRef = useRef<{
      open: () => void;
      close: () => void;
      isOpen: () => boolean;
  } | null>(null);
  // 手动「检查更新」发现新版本时，由 useAppUpdateManager 触发打开更新日志弹窗
  const openReleaseNotesOnManualCheckRef = useRef<(() => void) | null>(null);
  const {
      aboutDisplayVersion,
      aboutInfo,
      aboutLoading,
      aboutUpdateStatus,
      canShowProgressEntry,
      changeUpdateChannel,
      checkForUpdates,
      downloadUpdate,
      formatBytes,
      handleInstallFromProgress,
      hideUpdateDownloadProgress,
      isBackgroundProgressForLatestUpdate,
      isCheckingForUpdates,
      isLatestUpdateDownloaded,
      isUpdateChannelLoading,
      isUpdateChannelSaving,
      installMode,
      lastUpdateInfo,
      markUpdateProgressDismissed,
      muteLatestUpdate,
      openDownloadedUpdateDirectory,
      prepareAboutSurface,
      showUpdateDownloadProgress,
      updateChannel,
      updateDownloadProgress,
      updateInstallAction,
  } = useAppUpdateManager({
      runtimeBuildType,
      t,
      updateCenterBridgeRef,
      onManualCheckHasUpdateRef: openReleaseNotesOnManualCheckRef,
  });
  const [aboutLastCheckedAt, setAboutLastCheckedAt] = useState('');
  const [releaseNotesModalOpen, setReleaseNotesModalOpen] = useState(false);
  const [releaseNotesReadTick, setReleaseNotesReadTick] = useState(0);
  useEffect(() => {
      if (!lastUpdateInfo) {
          return;
      }
      setAboutLastCheckedAt(formatAboutCheckedAt(new Date()));
  }, [
      lastUpdateInfo?.channel,
      lastUpdateInfo?.currentVersion,
      lastUpdateInfo?.hasUpdate,
      lastUpdateInfo?.latestVersion,
  ]);

  const releaseNotesReadKey = useMemo(
      () => buildReleaseNotesReadKey(lastUpdateInfo),
      [lastUpdateInfo?.channel, lastUpdateInfo?.latestVersion],
  );
  // releaseNotesReadTick 强制在 mark 后重算未读态
  const hasUnreadReleaseNotes = useMemo(() => {
      void releaseNotesReadTick;
      if (!lastUpdateInfo || !releaseNotesReadKey) return false;
      // 有正文或至少有 GitHub 链接时，未读才有提示意义
      if (!String(lastUpdateInfo.releaseNotes || '').trim() && !String(lastUpdateInfo.releaseNotesUrl || '').trim()) {
          return false;
      }
      return !isReleaseNotesRead(releaseNotesReadKey);
  }, [lastUpdateInfo, releaseNotesReadKey, releaseNotesReadTick]);

  const openReleaseNotesModal = useCallback(() => {
      if (!lastUpdateInfo) return;
      setReleaseNotesModalOpen(true);
  }, [lastUpdateInfo]);

  const closeReleaseNotesModal = useCallback(() => {
      setReleaseNotesModalOpen(false);
      hideUpdateDownloadProgress();
  }, [hideUpdateDownloadProgress]);

  const handleReleaseNotesModalOpen = useCallback(() => {
      if (!releaseNotesReadKey) return;
      if (markReleaseNotesRead(releaseNotesReadKey)) {
          setReleaseNotesReadTick((value) => value + 1);
      }
  }, [releaseNotesReadKey]);

  /** 下载与更新日志同窗：点下载即打开弹窗并开始下载 */
  const handleDownloadUpdateWithNotes = useCallback(() => {
      if (!lastUpdateInfo) return;
      setReleaseNotesModalOpen(true);
      void downloadUpdate(lastUpdateInfo, false);
  }, [downloadUpdate, lastUpdateInfo]);

  const releaseNotesModalVisible = releaseNotesModalOpen || updateDownloadProgress.open;

  const emitWindowDiagnostic = useCallback(async (stage: string, extra: Record<string, unknown> = {}) => {
      if (!macWindowDiagnosticsEnabled) {
          return;
      }
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.LogWindowDiagnostic !== 'function') {
          return;
      }
      try {
          const [isFullscreen, isMaximised, isMinimised, isNormal, size, position] = await Promise.all([
              safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
              safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              safeWindowRuntimeCall(() => WindowIsMinimised(), false),
              safeWindowRuntimeCall(() => WindowIsNormal(), false),
              safeWindowRuntimeCall(() => WindowGetSize(), null),
              safeWindowRuntimeCall(() => WindowGetPosition(), null),
          ]);
          const payload = {
              seq: ++windowDiagSequenceRef.current,
              ts: new Date().toISOString(),
              stage,
              nativeControls: useNativeMacWindowControls,
              documentVisible: document.visibilityState,
              documentHasFocus: document.hasFocus(),
              devicePixelRatio: Number(window.devicePixelRatio) || 1,
              windowState: {
                  isFullscreen,
                  isMaximised,
                  isMinimised,
                  isNormal,
              },
              size: size ? { w: Math.trunc(Number(size.w || 0)), h: Math.trunc(Number(size.h || 0)) } : null,
              position: position ? { x: Math.trunc(Number(position.x || 0)), y: Math.trunc(Number(position.y || 0)) } : null,
              extra,
          };
          const signature = JSON.stringify({
              stage,
              nativeControls: payload.nativeControls,
              visible: payload.documentVisible,
              focus: payload.documentHasFocus,
              state: payload.windowState,
              size: payload.size,
              position: payload.position,
              extra,
          });
          const now = Date.now();
          if (signature === windowDiagLastSignatureRef.current && now-windowDiagLastAtRef.current < 250) {
              return;
          }
          windowDiagLastSignatureRef.current = signature;
          windowDiagLastAtRef.current = now;
          await backendApp.LogWindowDiagnostic(stage, JSON.stringify(payload));
      } catch (error) {
          console.warn('Failed to emit window diagnostic', error);
      }
  }, [macWindowDiagnosticsEnabled, useNativeMacWindowControls]);

  useEffect(() => {
      if (!macWindowDiagnosticsEnabled) {
          return;
      }

      let cancelled = false;
      let pollTimer: number | null = null;
      let burstTimer: number | null = null;

      const stopBurst = () => {
          if (pollTimer !== null) {
              window.clearInterval(pollTimer);
              pollTimer = null;
          }
          if (burstTimer !== null) {
              window.clearTimeout(burstTimer);
              burstTimer = null;
          }
      };

      const startBurst = (reason: string, extra: Record<string, unknown> = {}) => {
          if (cancelled) {
              return;
          }
          void emitWindowDiagnostic(`burst:start:${reason}`, extra);
          if (pollTimer === null) {
              pollTimer = window.setInterval(() => {
                  void emitWindowDiagnostic(`burst:tick:${reason}`);
              }, 250);
          }
          if (burstTimer !== null) {
              window.clearTimeout(burstTimer);
          }
          burstTimer = window.setTimeout(() => {
              stopBurst();
              void emitWindowDiagnostic(`burst:stop:${reason}`);
          }, 6000);
      };

      const handleFocus = () => {
          void emitWindowDiagnostic('event:focus');
      };
      const handleBlur = () => {
          void emitWindowDiagnostic('event:blur');
      };
      const handleResize = () => {
          void emitWindowDiagnostic('event:resize');
      };
      const handleVisibilityChange = () => {
          void emitWindowDiagnostic('event:visibilitychange', { visibility: document.visibilityState });
      };
      const handleEditableKeydown = (event: KeyboardEvent) => {
          if (!isEditableElement(event.target)) {
              return;
          }
          const key = String(event.key || '');
          const maybeFullscreenKey = key === 'Escape' || key.toLowerCase() === 'f' || key === 'Process';
          const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
          startBurst('editable-keydown', {
              key,
              code: String(event.code || ''),
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              shiftKey: event.shiftKey,
              maybeFullscreenKey,
              hasModifier,
          });
      };
      const handleCompositionStart = () => {
          startBurst('compositionstart');
      };
      const handleCompositionEnd = () => {
          startBurst('compositionend');
      };

      void emitWindowDiagnostic('session:start');
      window.addEventListener('focus', handleFocus);
      window.addEventListener('blur', handleBlur);
      window.addEventListener('resize', handleResize);
      window.addEventListener('keydown', handleEditableKeydown, true);
      window.addEventListener('compositionstart', handleCompositionStart, true);
      window.addEventListener('compositionend', handleCompositionEnd, true);
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
          cancelled = true;
          stopBurst();
          window.removeEventListener('focus', handleFocus);
          window.removeEventListener('blur', handleBlur);
          window.removeEventListener('resize', handleResize);
          window.removeEventListener('keydown', handleEditableKeydown, true);
          window.removeEventListener('compositionstart', handleCompositionStart, true);
          window.removeEventListener('compositionend', handleCompositionEnd, true);
          document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
  }, [emitWindowDiagnostic, macWindowDiagnosticsEnabled]);

  const handleNewQuery = useCallback(() => {
      const currentTab = activeTabId ? tabs.find(tab => tab.id === activeTabId) : undefined;
      // 只继承支持查询编辑器的活动连接；Nacos/JVM 等工作台活动时不预选连接，
      // 避免新建查询落入必然失败的 SQL 工作流。
      const validConnectionIds = new Set(
          connections
              .filter(connection => getDataSourceCapabilities(connection.config).supportsQueryEditor)
              .map(connection => connection.id),
      );
      const targetContext = resolveNewQueryContext({
          sidebarContext: activeContext,
          activeTab: currentTab,
          validConnectionIds,
      });
      const connection = connections.find(c => c.id === targetContext.connectionId);
      if (connection && isMessageQueueDataSource(connection.config)) {
          const dbName = resolveMessageQueueExecutionDbName(
              connection.config,
              targetContext.dbName,
          );
          addTab({
              id: `message-queue-${connection.id}-${encodeURIComponent(dbName || 'default')}`,
              title: `${connection.name} · ${t('message_queue_workbench.tab_kind')}`,
              type: 'message-queue',
              connectionId: connection.id,
              dbName,
              messageQueueAction: 'open',
              messageQueueRequestKey: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          });
          return;
      }
      const inheritsTableContext = canInheritNewQueryTableContext({
          activeTab: currentTab,
          targetContext,
      });
      const tableName = inheritsTableContext ? String(currentTab?.tableName || '').trim() : '';
      const contextualQuery = tableName && connection
          ? buildContextualNewQueryTemplate({
              dbType: resolveDataSourceType(connection.config),
              tableName,
              customTemplate: appearance.newQuerySqlTemplate,
          })
          : null;

      addTab({
          id: `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: t('query.new'),
          type: 'query',
          connectionId: targetContext.connectionId,
          dbName: targetContext.dbName,
          schemaName: targetContext.schemaName,
          query: contextualQuery ?? '',
      });
  }, [activeTabId, tabs, connections, activeContext, addTab, appearance.newQuerySqlTemplate, t]);

  const switchActiveTabByOffset = useCallback((offset: 1 | -1) => {
      if (tabs.length < 2) return;
      const activeIndex = tabs.findIndex(tab => tab.id === activeTabId);
      const baseIndex = activeIndex >= 0 ? activeIndex : 0;
      const nextIndex = (baseIndex + offset + tabs.length) % tabs.length;
      setActiveTab(tabs[nextIndex].id);
  }, [activeTabId, setActiveTab, tabs]);

  const resetApplicationQuitRequest = useCallback(() => {
      applicationQuitHandlingRef.current = false;
      applicationQuitConfirmRef.current = null;
      void CancelApplicationQuit();
  }, []);

  const forceQuitApplication = useCallback(async () => {
      const res = await ForceQuitApplication();
      if (res && res.success === false) {
          throw new Error(res.message || t('common.unknown'));
      }
  }, [t]);

  const restartApplication = useCallback(async (): Promise<boolean> => {
      const res = await RestartApplication();
      if (res && res.success === false) {
          throw new Error(res.message || t('common.unknown'));
      }
      return true;
  }, [t]);
  return {
    useNativeMacWindowControls, activeShortcutPlatform, titleBarNewQueryShortcut,
    titleBarNewConnectionShortcut, updateCenterBridgeRef, openReleaseNotesOnManualCheckRef,
    aboutDisplayVersion, aboutInfo, aboutLoading, aboutUpdateStatus, changeUpdateChannel,
    checkForUpdates, formatBytes, handleInstallFromProgress, hideUpdateDownloadProgress,
    isBackgroundProgressForLatestUpdate, isCheckingForUpdates, isLatestUpdateDownloaded,
    isUpdateChannelLoading, isUpdateChannelSaving, installMode, lastUpdateInfo,
    markUpdateProgressDismissed, muteLatestUpdate, openDownloadedUpdateDirectory,
    prepareAboutSurface, showUpdateDownloadProgress, updateChannel, updateDownloadProgress,
    updateInstallAction, setReleaseNotesModalOpen, hasUnreadReleaseNotes, openReleaseNotesModal,
    closeReleaseNotesModal, handleReleaseNotesModalOpen, handleDownloadUpdateWithNotes,
    releaseNotesModalVisible, emitWindowDiagnostic, handleNewQuery, switchActiveTabByOffset,
    resetApplicationQuitRequest, forceQuitApplication,
  };
};

export type AppUpdateAndDiagnosticsApi = ReturnType<typeof useAppUpdateAndDiagnostics>;
