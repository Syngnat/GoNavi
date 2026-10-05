import React, { useCallback, useEffect } from 'react';
import { message } from 'antd';
import { useAppLogPanelResize } from '../../hooks/useAppLogPanelResize';
import { SavedConnection } from '../../types';
import {
  shouldRetrySecurityUpdateAfterRepairSave,
  shouldReopenSecurityUpdateDetails,
} from '../../utils/securityUpdateRepairFlow';
import {
  finalizeSecurityUpdateStatus,
  mergeSecurityUpdateStatusWithLegacySource,
} from '../../utils/secureConfigBootstrap';
import {
  stripLegacyPersistedConnectionById,
  LEGACY_PERSIST_KEY,
  hasLegacyMigratableSensitiveItems,
} from '../../utils/legacyConnectionStorage';
import { OPEN_GLOBAL_PROXY_SETTINGS_EVENT } from '../../utils/driverManagerTab';
import { withAISettingsLeaveGuard } from '../../utils/aiSettingsLeaveGuard';
import { safeWindowRuntimeCall } from '../../utils/wailsRuntime';
import {
  WindowIsFullscreen,
  WindowIsMaximised,
  WindowUnfullscreen,
  WindowFullscreen,
  WindowUnmaximise,
  WindowMaximise,
  WindowGetSize,
  WindowSetSize,
} from '../../../wailsjs/runtime';
import { useStore } from '../../store';
import { waitForWindowCondition } from '../../utils/windowTransition';
import { isWindowsPlatform } from '../../utils/appearance';
import { getWindowsScaleFixNudgedWidth } from '../../utils/windowsScaleFix';
import { useAppSidebarResize } from '../../hooks/useAppSidebarResize';
import { resolveSidebarResizeHitGeometry } from '../../utils/sidebarLayout';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppShellStateApi } from './useAppShellState';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppBootstrapEffectsApi } from './useAppBootstrapEffects';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';

export interface UseAppWorkbenchActionsInput {
  pendingConnectionTagIdRef: AppCoreStateApi['pendingConnectionTagIdRef'];
  setSecurityUpdateRepairSource: AppShellStateApi['setSecurityUpdateRepairSource'];
  setEditingConnection: AppCoreStateApi['setEditingConnection'];
  setIsConnectionModalMounted: AppCoreStateApi['setIsConnectionModalMounted'];
  setIsModalOpen: AppCoreStateApi['setIsModalOpen'];
  t: AppCoreStateApi['t'];
  connectionModalWarmupDoneRef: AppCoreStateApi['connectionModalWarmupDoneRef'];
  moveConnectionToTag: AppSecurityUpdateApi['moveConnectionToTag'];
  securityUpdateRepairSource: AppShellStateApi['securityUpdateRepairSource'];
  securityUpdateStatus: AppShellStateApi['securityUpdateStatus'];
  replaceConnections: AppCoreStateApi['replaceConnections'];
  replaceGlobalProxy: AppCoreStateApi['replaceGlobalProxy'];
  normalizeSecurityUpdateStatus: AppBootstrapEffectsApi['normalizeSecurityUpdateStatus'];
  applySecurityUpdateStatus: AppBootstrapEffectsApi['applySecurityUpdateStatus'];
  setSecurityUpdateHasLegacySensitiveItems: AppShellStateApi['setSecurityUpdateHasLegacySensitiveItems'];
  setSecurityUpdateRawPayload: AppShellStateApi['setSecurityUpdateRawPayload'];
  securityUpdateRawPayload: AppShellStateApi['securityUpdateRawPayload'];
  openSecurityUpdateSettings: AppSecurityUpdateApi['openSecurityUpdateSettings'];
  setConnectionHealthTargetIds: AppCoreStateApi['setConnectionHealthTargetIds'];
  setToolCenterBackGroupKey: AppProxySettingsApi['setToolCenterBackGroupKey'];
  setActiveSettingsCenterGroupKey: AppShellStateApi['setActiveSettingsCenterGroupKey'];
  setActiveSettingsCenterPane: AppShellStateApi['setActiveSettingsCenterPane'];
  openSettingsCenterWorkbenchTab: AppShellStateApi['openSettingsCenterWorkbenchTab'];
  handleOpenDriverManagerWorkbench: AppSecurityUpdateApi['handleOpenDriverManagerWorkbench'];
  setIsProxyModalOpen: AppProxySettingsApi['setIsProxyModalOpen'];
  aiSettingsLeaveGuardRef: AppShellStateApi['aiSettingsLeaveGuardRef'];
  setFocusedAIProviderId: AppShellStateApi['setFocusedAIProviderId'];
  setAiSettingsSection: AppShellStateApi['setAiSettingsSection'];
  setAiSettingsProviderView: AppShellStateApi['setAiSettingsProviderView'];
  setAiPanelRenderNonce: AppShellStateApi['setAiPanelRenderNonce'];
  setAiSettingsRenderNonce: AppShellStateApi['setAiSettingsRenderNonce'];
  emitWindowDiagnostic: AppUpdateAndDiagnosticsApi['emitWindowDiagnostic'];
  useNativeMacWindowControls: AppUpdateAndDiagnosticsApi['useNativeMacWindowControls'];
  isMacRuntime: AppShellStateApi['isMacRuntime'];
  captureMainWindowStateRef: AppShellStateApi['captureMainWindowStateRef'];
  effectiveUiScale: AppCoreStateApi['effectiveUiScale'];
  setSidebarWidth: AppShellStateApi['setSidebarWidth'];
  sidebarWidth: AppShellStateApi['sidebarWidth'];
  isSidebarCollapsed: AppShellStateApi['isSidebarCollapsed'];
}

export const useAppWorkbenchActions = ({
  pendingConnectionTagIdRef, setSecurityUpdateRepairSource, setEditingConnection,
  setIsConnectionModalMounted, setIsModalOpen, t, connectionModalWarmupDoneRef, moveConnectionToTag,
  securityUpdateRepairSource, securityUpdateStatus, replaceConnections, replaceGlobalProxy,
  normalizeSecurityUpdateStatus, applySecurityUpdateStatus,
  setSecurityUpdateHasLegacySensitiveItems, setSecurityUpdateRawPayload, securityUpdateRawPayload,
  openSecurityUpdateSettings, setConnectionHealthTargetIds, setToolCenterBackGroupKey,
  setActiveSettingsCenterGroupKey, setActiveSettingsCenterPane, openSettingsCenterWorkbenchTab,
  handleOpenDriverManagerWorkbench, setIsProxyModalOpen, aiSettingsLeaveGuardRef,
  setFocusedAIProviderId, setAiSettingsSection, setAiSettingsProviderView, setAiPanelRenderNonce,
  setAiSettingsRenderNonce, emitWindowDiagnostic, useNativeMacWindowControls, isMacRuntime,
  captureMainWindowStateRef, effectiveUiScale, setSidebarWidth, sidebarWidth, isSidebarCollapsed,
}: UseAppWorkbenchActionsInput) => {
  const {
      handleCloseLogPanel: handleCloseAppLogPanel,
      handleLogResizeStart,
      isLogPanelOpen,
      logGhostRef,
      logPanelHeight,
  } = useAppLogPanelResize();
  const handleToggleLogPanel = useCallback(() => {
      window.dispatchEvent(new CustomEvent('gonavi:show-sql-execution-log', { detail: { mode: 'open' } }));
  }, []);
  const handleCloseLogPanel = useCallback(() => {
      handleCloseAppLogPanel();
  }, [handleCloseAppLogPanel]);

  const openCreateConnection = useCallback((targetTagId?: string) => {
      const normalizedTargetTagId = String(targetTagId || '').trim();
      pendingConnectionTagIdRef.current = normalizedTargetTagId || null;
      setSecurityUpdateRepairSource(null);
      setEditingConnection(null);
      setIsConnectionModalMounted(true);
      setIsModalOpen(true);
  }, []);
  const handleCreateConnection = useCallback(() => openCreateConnection(), [openCreateConnection]);
  const handleCreateConnectionInGroup = useCallback(
      (targetTagId: string) => openCreateConnection(targetTagId),
      [openCreateConnection],
  );

  const handleEditConnection = useCallback((conn: SavedConnection) => {
      pendingConnectionTagIdRef.current = null;
      setSecurityUpdateRepairSource(null);
      setIsConnectionModalMounted(true);
      void (async () => {
          const backendApp = (window as any).go?.app?.App;
          let nextConnection = conn;
          if (typeof backendApp?.GetEditableSavedConnection === 'function') {
              try {
                  const editableConnection = await backendApp.GetEditableSavedConnection(conn.id);
                  if (editableConnection) {
                      nextConnection = editableConnection;
                  }
              } catch (error: any) {
                  const errorMessage = error?.message;
                  const detail = (
                      typeof errorMessage === 'string'
                          ? errorMessage
                          : (
                              typeof errorMessage === 'number'
                              || typeof errorMessage === 'boolean'
                                  ? String(errorMessage)
                                  : String(error ?? '')
                          )
                  ).trim();
                  void message.warning(
                      detail
                          ? t('app.connection.message.editable_load_failed_with_detail', { detail })
                          : t('app.connection.message.editable_load_failed')
                  );
              }
          }
          setEditingConnection(nextConnection);
          setIsModalOpen(true);
      })();
  }, [t]);

  useEffect(() => {
      if (connectionModalWarmupDoneRef.current) {
          return;
      }
      connectionModalWarmupDoneRef.current = true;
      const warmup = () => setIsConnectionModalMounted(true);
      if (typeof window === 'undefined') {
          warmup();
          return;
      }
      if (typeof window.requestIdleCallback === 'function') {
          const idleId = window.requestIdleCallback(() => warmup(), { timeout: 1200 });
          return () => window.cancelIdleCallback?.(idleId);
      }
      const timerId = window.setTimeout(warmup, 300);
      return () => window.clearTimeout(timerId);
  }, []);

  const handleConnectionSaved = useCallback(async (savedConnection: SavedConnection) => {
      const targetTagId = pendingConnectionTagIdRef.current;
      pendingConnectionTagIdRef.current = null;
      if (targetTagId && savedConnection?.id) {
          moveConnectionToTag(savedConnection.id, targetTagId);
      }

      if (!shouldRetrySecurityUpdateAfterRepairSave(securityUpdateRepairSource)) {
          return;
      }

      const backendApp = (window as any).go?.app?.App;
      if (securityUpdateStatus.migrationId) {
          if (typeof backendApp?.RetrySecurityUpdateCurrentRound !== 'function') {
              return;
          }

          const rawStatus = await backendApp.RetrySecurityUpdateCurrentRound({
              migrationId: securityUpdateStatus.migrationId,
          });
          const nextStatus = await finalizeSecurityUpdateStatus({
              backend: backendApp,
              replaceConnections,
              replaceGlobalProxy,
              t,
          }, normalizeSecurityUpdateStatus(rawStatus));

          applySecurityUpdateStatus(nextStatus, {
              openSettings: false,
          });

          if (nextStatus.overallStatus === 'completed') {
              setSecurityUpdateHasLegacySensitiveItems(false);
              setSecurityUpdateRawPayload(null);
          }
          return;
      }

      if (!securityUpdateRawPayload || !savedConnection?.id) {
          return;
      }

      const nextRawPayload = stripLegacyPersistedConnectionById(securityUpdateRawPayload, savedConnection.id);
      if (!nextRawPayload || nextRawPayload === securityUpdateRawPayload) {
          return;
      }

      window.localStorage.setItem(LEGACY_PERSIST_KEY, nextRawPayload);

      const rawStatus = typeof backendApp?.GetSecurityUpdateStatus === 'function'
          ? await backendApp.GetSecurityUpdateStatus()
          : securityUpdateStatus;
      const nextStatus = mergeSecurityUpdateStatusWithLegacySource(rawStatus, nextRawPayload, {
          previousStatus: securityUpdateStatus,
          t,
      });
      const nextHasLegacySensitiveItems = hasLegacyMigratableSensitiveItems(nextRawPayload);

      setSecurityUpdateRawPayload(nextRawPayload);
      setSecurityUpdateHasLegacySensitiveItems(nextHasLegacySensitiveItems);
      applySecurityUpdateStatus(nextStatus, {
          openSettings: false,
      });
  }, [
      applySecurityUpdateStatus,
      normalizeSecurityUpdateStatus,
      moveConnectionToTag,
      replaceConnections,
      replaceGlobalProxy,
      securityUpdateRawPayload,
      securityUpdateRepairSource,
      securityUpdateStatus,
      securityUpdateStatus.migrationId,
      t,
  ]);

  const handleCloseModal = () => {
      const reopenSecurityUpdateDetails = shouldReopenSecurityUpdateDetails(securityUpdateRepairSource);
      pendingConnectionTagIdRef.current = null;
      setIsModalOpen(false);
      setEditingConnection(null);
      setSecurityUpdateRepairSource(null);
      if (reopenSecurityUpdateDetails) {
          openSecurityUpdateSettings();
      }
  };
  const handleOpenConnectionHealth = useCallback((connectionIds: string[] = []) => {
      setConnectionHealthTargetIds(Array.from(new Set(connectionIds.filter((id) => String(id || '').trim() !== ''))));
      setToolCenterBackGroupKey('config');
      setActiveSettingsCenterGroupKey('config');
      setActiveSettingsCenterPane({ key: 'connection-health', group: 'config' });
      openSettingsCenterWorkbenchTab();
  }, [openSettingsCenterWorkbenchTab]);

  const handleOpenDriverManagerFromConnection = useCallback(() => {
      pendingConnectionTagIdRef.current = null;
      setIsModalOpen(false);
      setEditingConnection(null);
      setToolCenterBackGroupKey(null);
      handleOpenDriverManagerWorkbench();
  }, [handleOpenDriverManagerWorkbench]);

  const handleOpenGlobalProxySettings = useCallback(() => {
      setSecurityUpdateRepairSource(null);
      setIsProxyModalOpen(true);
  }, []);

  useEffect(() => {
      const openGlobalProxySettings = () => handleOpenGlobalProxySettings();
      window.addEventListener(OPEN_GLOBAL_PROXY_SETTINGS_EVENT, openGlobalProxySettings);
      return () => window.removeEventListener(OPEN_GLOBAL_PROXY_SETTINGS_EVENT, openGlobalProxySettings);
  }, [handleOpenGlobalProxySettings]);

  const handleCloseGlobalProxySettings = useCallback(() => {
      const reopenSecurityUpdateDetails = shouldReopenSecurityUpdateDetails(securityUpdateRepairSource);
      setIsProxyModalOpen(false);
      setSecurityUpdateRepairSource(null);
      if (reopenSecurityUpdateDetails) {
          openSecurityUpdateSettings();
      }
  }, [openSecurityUpdateSettings, securityUpdateRepairSource]);

  /** 从聊天面板等入口打开 AI 配置：走设置中心，不再弹独立 AISettingsModal */
  const handleOpenAISettings = useCallback((providerId?: string) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      setSecurityUpdateRepairSource(null);
      setFocusedAIProviderId(providerId);
      setAiSettingsSection('providers');
      setAiSettingsProviderView('workspace');
      setActiveSettingsCenterGroupKey('services');
      setActiveSettingsCenterPane({ key: 'ai', group: 'services' });
      openSettingsCenterWorkbenchTab();
  }), []);

  const handleAIPanelRenderError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
      try {
          (window as any).__gonaviLastAIPanelRenderError = {
              message: error?.message || '',
              stack: error?.stack || '',
              componentStack: errorInfo?.componentStack || '',
          };
      } catch {
          // ignore debug capture failures
      }
      console.error('AIChatPanel render error:', error, errorInfo);
  }, []);

  const handleRetryAIPanelRender = useCallback(() => {
      setAiPanelRenderNonce((current) => current + 1);
  }, []);

  const handleRetryAISettingsRender = useCallback(() => {
      setAiSettingsRenderNonce((current) => current + 1);
  }, []);

  const handleWebLogout = useCallback(async () => {
      try {
          await fetch('/__gonavi/auth/logout', {
              method: 'POST',
              credentials: 'same-origin',
          });
      } catch (_) {
          // ignore
      }
      window.location.assign('/login');
  }, []);

  const handleTitleBarWindowToggle = async (options?: { allowMacNativeFullscreen?: boolean }) => {
      const allowMacNativeFullscreen = options?.allowMacNativeFullscreen === true;
      const syncWindowStateFromRuntime = async () => {
          try {
              const [isFullscreen, isMaximised] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
                  safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              ]);
              useStore.getState().setWindowState(isFullscreen ? 'fullscreen' : (isMaximised ? 'maximized' : 'normal'));
          } catch {
              // ignore
          }
      };

      try {
          void emitWindowDiagnostic('action:titlebar-toggle:before');
          if (await WindowIsFullscreen()) {
              await WindowUnfullscreen();
              await syncWindowStateFromRuntime();
              void emitWindowDiagnostic('action:titlebar-toggle:after-unfullscreen');
              return;
          }
          if (allowMacNativeFullscreen && useNativeMacWindowControls && isMacRuntime) {
              await WindowFullscreen();
              await syncWindowStateFromRuntime();
              void emitWindowDiagnostic('action:titlebar-toggle:after-fullscreen');
              return;
          }
          const isMaximised = await safeWindowRuntimeCall(() => WindowIsMaximised(), false);
          if (isMaximised) {
              WindowUnmaximise();
          } else {
              // Preserve the latest normal bounds before the native maximise transition
              // makes WindowGetSize report the maximised surface.
              await captureMainWindowStateRef.current();
              WindowMaximise();
          }
          await waitForWindowCondition({
              read: async () => (await WindowIsMaximised()) !== isMaximised,
              wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
              maxChecks: 16,
              intervalMs: 40,
          });
          await syncWindowStateFromRuntime();
          void emitWindowDiagnostic('action:titlebar-toggle:after-set-maximise-state');
      } catch (_) {
          // ignore
      }
  };

  const handleTitleBarDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-no-titlebar-toggle="true"]')) {
          return;
      }
      void handleTitleBarWindowToggle({ allowMacNativeFullscreen: false });
  };

  // handleManualResetWindowZoom 由 resetWindowZoom 快捷键（默认 Ctrl+Shift+0）触发，
  // 作为自动路径失败时的兜底入口。
  //
  // 优先调 backend App.ResetWebViewZoom 走 WebView2 zoom reset（零动画零感知）；
  // 失败时回退到 Unmaximise→Maximise toggle —— 用户主动按了快捷键，预期看见动画。
  const handleManualResetWindowZoom = React.useCallback(async () => {
      if (!isWindowsPlatform()) {
          message.info(t('app.window_zoom.message.windows_only'));
          return;
      }
      try {
          const res = await (window as any).go?.app?.App?.ResetWebViewZoom?.();
          if (res?.success) {
              window.dispatchEvent(new Event('resize'));
              message.success(t('app.window_zoom.message.reset_success'));
              return;
          }
          console.warn('ResetWebViewZoom backend reported failure, falling back to maximise toggle:', res?.message);
      } catch (e) {
          console.warn('ResetWebViewZoom backend unavailable, falling back to maximise toggle', e);
      }
      try {
          const isFullscreen = await safeWindowRuntimeCall(() => WindowIsFullscreen(), false);
          if (isFullscreen) {
              message.info(t('app.window_zoom.message.fullscreen_exit_first'));
              return;
          }
          const isMaximised = await safeWindowRuntimeCall(() => WindowIsMaximised(), false);
          if (isMaximised) {
              WindowUnmaximise();
              await new Promise((resolve) => window.setTimeout(resolve, 96));
              WindowMaximise();
              await new Promise((resolve) => window.setTimeout(resolve, 96));
          } else {
              const size = await safeWindowRuntimeCall(() => WindowGetSize(), null);
              const width = Math.trunc(Number(size?.w) || 0);
              const height = Math.trunc(Number(size?.h) || 0);
              if (width > 0 && height > 0) {
                  WindowSetSize(getWindowsScaleFixNudgedWidth(width), height);
                  await new Promise((resolve) => window.setTimeout(resolve, 28));
                  WindowSetSize(width, height);
              }
          }
          window.dispatchEvent(new Event('resize'));
          message.success(t('app.window_zoom.message.reset_success_fallback'));
      } catch (e) {
          console.warn('Failed to reset window zoom', e);
          message.error(t('app.window_zoom.message.reset_failed'));
      }
  }, [t]);

  const {
      handleSidebarMouseDown,
      sidebarResizeHandleWidth,
      siderRef,
  } = useAppSidebarResize({
      effectiveUiScale,
      setSidebarWidth,
      sidebarWidth,
      sidebarCollapsed: isSidebarCollapsed,
  });
  const sidebarResizeHit = resolveSidebarResizeHitGeometry(sidebarResizeHandleWidth);
  return {
    isLogPanelOpen, logGhostRef, handleToggleLogPanel, handleCreateConnection,
    handleCreateConnectionInGroup, handleEditConnection, handleConnectionSaved, handleCloseModal,
    handleOpenConnectionHealth, handleOpenDriverManagerFromConnection,
    handleCloseGlobalProxySettings, handleOpenAISettings, handleAIPanelRenderError,
    handleRetryAIPanelRender, handleRetryAISettingsRender, handleWebLogout,
    handleTitleBarWindowToggle, handleTitleBarDoubleClick, handleManualResetWindowZoom,
    handleSidebarMouseDown, siderRef, sidebarResizeHit,
  };
};

export type AppWorkbenchActionsApi = ReturnType<typeof useAppWorkbenchActions>;
