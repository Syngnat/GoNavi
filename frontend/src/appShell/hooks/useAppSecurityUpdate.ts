import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { message } from 'antd';
import { useAppUtilityStyles } from '../../hooks/useAppUtilityStyles';
import { useStore } from '../../store';
import { useOpenDriverManagerWorkbench } from '../../hooks/useDriverManagerWorkbench';
import { type TitlebarSidebarSnapshot, resolveTitlebarContext } from '../../utils/titlebarContext';
import { buildConnectionImportGroupOptions } from '../../components/settings/ConnectionImportSettingsPanel';
import { useWorkbenchTabs } from '../../hooks/useWorkbenchTabs';
import { useWorkbenchSidebarAutoCollapse } from '../../hooks/useAppSidebarCollapse';
import { useWorkbenchSessionRestore } from '../../hooks/useWorkbenchSessionRestore';
import { isMessageQueueDataSource } from '../../utils/dataSourceCapabilities';
import {
  type SecurityUpdateSettingsFocusTarget,
  shouldRefreshSecurityUpdateDetailsFocus,
  resolveSecurityUpdateRepairEntry,
} from '../../utils/securityUpdateRepairFlow';
import { withAISettingsLeaveGuard } from '../../utils/aiSettingsLeaveGuard';
import type { ToolCenterGroupKey } from '../settingsCenterPanes';
import { SecurityUpdateStatus, SecurityUpdateIssue } from '../../types';
import {
  startSecurityUpdateFromBootstrap,
  finalizeSecurityUpdateStatus,
  prepareSecureConfigForExternalMCP,
  mergeSecurityUpdateStatusWithLegacySource,
} from '../../utils/secureConfigBootstrap';
import type { AppShellStateApi } from './useAppShellState';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppBootstrapEffectsApi } from './useAppBootstrapEffects';

export interface UseAppSecurityUpdateInput {
  blurFilter: AppShellStateApi['blurFilter'];
  darkMode: AppCoreStateApi['darkMode'];
  effectiveOpacity: AppShellStateApi['effectiveOpacity'];
  effectiveUiScale: AppCoreStateApi['effectiveUiScale'];
  resolvedAppearance: AppShellStateApi['resolvedAppearance'];
  sidebarWidth: AppShellStateApi['sidebarWidth'];
  connectionImportTargetTagId: AppShellStateApi['connectionImportTargetTagId'];
  setConnectionImportTargetTagId: AppShellStateApi['setConnectionImportTargetTagId'];
  isSidebarCollapsed: AppShellStateApi['isSidebarCollapsed'];
  setIsSidebarCollapsed: AppShellStateApi['setIsSidebarCollapsed'];
  isStoreHydrated: AppShellStateApi['isStoreHydrated'];
  hasLoadedSecureConfig: AppShellStateApi['hasLoadedSecureConfig'];
  t: AppCoreStateApi['t'];
  aiSettingsLeaveGuardRef: AppShellStateApi['aiSettingsLeaveGuardRef'];
  setIsSecurityUpdateIntroOpen: AppShellStateApi['setIsSecurityUpdateIntroOpen'];
  setSecurityUpdateSettingsFocusTarget: AppShellStateApi['setSecurityUpdateSettingsFocusTarget'];
  setSecurityUpdateSettingsFocusRequest: AppShellStateApi['setSecurityUpdateSettingsFocusRequest'];
  setToolCenterBackGroupKey: React.Dispatch<React.SetStateAction<ToolCenterGroupKey | null>>;
  setActiveSettingsCenterGroupKey: AppShellStateApi['setActiveSettingsCenterGroupKey'];
  setActiveSettingsCenterPane: AppShellStateApi['setActiveSettingsCenterPane'];
  openSettingsCenterWorkbenchTab: AppShellStateApi['openSettingsCenterWorkbenchTab'];
  isSettingsModalOpen: AppShellStateApi['isSettingsModalOpen'];
  activeSettingsCenterPane: AppShellStateApi['activeSettingsCenterPane'];
  setSecurityUpdateProgressStage: AppShellStateApi['setSecurityUpdateProgressStage'];
  setIsSecurityUpdateProgressOpen: AppShellStateApi['setIsSecurityUpdateProgressOpen'];
  replaceConnections: AppCoreStateApi['replaceConnections'];
  replaceGlobalProxy: AppCoreStateApi['replaceGlobalProxy'];
  normalizeSecurityUpdateStatus: AppBootstrapEffectsApi['normalizeSecurityUpdateStatus'];
  securityUpdateStatus: AppShellStateApi['securityUpdateStatus'];
  securityUpdateRawPayload: AppShellStateApi['securityUpdateRawPayload'];
  setSecurityUpdateRawPayload: AppShellStateApi['setSecurityUpdateRawPayload'];
  applySecurityUpdateStatus: AppBootstrapEffectsApi['applySecurityUpdateStatus'];
  setSecurityUpdateHasLegacySensitiveItems: AppShellStateApi['setSecurityUpdateHasLegacySensitiveItems'];
  closeSettingsCenterWorkbenchTab: AppShellStateApi['closeSettingsCenterWorkbenchTab'];
  setSecurityUpdateRepairSource: AppShellStateApi['setSecurityUpdateRepairSource'];
  setEditingConnection: AppCoreStateApi['setEditingConnection'];
  setIsModalOpen: AppCoreStateApi['setIsModalOpen'];
  setIsProxyModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setFocusedAIProviderId: AppShellStateApi['setFocusedAIProviderId'];
  setAiSettingsSection: AppShellStateApi['setAiSettingsSection'];
  setAiSettingsProviderView: AppShellStateApi['setAiSettingsProviderView'];
}

export const useAppSecurityUpdate = ({
  blurFilter, darkMode, effectiveOpacity, effectiveUiScale, resolvedAppearance, sidebarWidth,
  connectionImportTargetTagId, setConnectionImportTargetTagId, isSidebarCollapsed,
  setIsSidebarCollapsed, isStoreHydrated, hasLoadedSecureConfig, t, aiSettingsLeaveGuardRef,
  setIsSecurityUpdateIntroOpen, setSecurityUpdateSettingsFocusTarget,
  setSecurityUpdateSettingsFocusRequest, setToolCenterBackGroupKey, setActiveSettingsCenterGroupKey,
  setActiveSettingsCenterPane, openSettingsCenterWorkbenchTab, isSettingsModalOpen,
  activeSettingsCenterPane, setSecurityUpdateProgressStage, setIsSecurityUpdateProgressOpen,
  replaceConnections, replaceGlobalProxy, normalizeSecurityUpdateStatus, securityUpdateStatus,
  securityUpdateRawPayload, setSecurityUpdateRawPayload, applySecurityUpdateStatus,
  setSecurityUpdateHasLegacySensitiveItems, closeSettingsCenterWorkbenchTab,
  setSecurityUpdateRepairSource, setEditingConnection, setIsModalOpen, setIsProxyModalOpen,
  setFocusedAIProviderId, setAiSettingsSection, setAiSettingsProviderView,
}: UseAppSecurityUpdateInput) => {
  const {
      bgContent,
      floatingLogButtonBgColor, floatingLogButtonBorderColor, floatingLogButtonShadow, floatingLogButtonTextColor,
      isSidebarNarrow, isSidebarUltraCompact,
      overlayTheme, renderUtilityModalTitle,
      sidebarHorizontalPadding,
      toolCenterContentPanelStyle, toolCenterDetailBodyStyle, toolCenterDetailPanelStyle,
      toolCenterModalSplitStyle, toolCenterModalWorkspaceStyle,
      toolCenterNavPanelStyle, utilityButtonStyle,
      utilityModalShellStyle, utilityMutedTextStyle, utilityPanelStyle,
  } = useAppUtilityStyles({
      blurFilter,
      darkMode,
      effectiveOpacity,
      effectiveUiScale,
      resolvedAppearance,
      sidebarWidth,
  });

  const addTab = useStore(state => state.addTab);
  const handleOpenDriverManagerWorkbench = useOpenDriverManagerWorkbench();
  const activeContext = useStore(state => state.activeContext);
  const connections = useStore(state => state.connections);
  const connectionTags = useStore(state => state.connectionTags);
  const [sidebarTitlebarSnapshot, setSidebarTitlebarSnapshot] = useState<TitlebarSidebarSnapshot>({
      selection: null,
      connectionStates: {},
  });
  const moveConnectionToTag = useStore(state => state.moveConnectionToTag);
  const moveConnectionsToTag = useStore(state => state.moveConnectionsToTag);
  const setConnectionDisplaySortMode = useStore(state => state.setConnectionDisplaySortMode);
  const connectionImportGroupOptions = useMemo(
      () => buildConnectionImportGroupOptions(connectionTags),
      [connectionTags],
  );
  useEffect(() => {
      if (
          connectionImportTargetTagId
          && !connectionTags.some((tag) => tag.id === connectionImportTargetTagId)
      ) {
          setConnectionImportTargetTagId('');
      }
  }, [connectionImportTargetTagId, connectionTags]);
  const tabs = useWorkbenchTabs();
  const activeTabId = useStore(state => state.activeTabId);
  const setActiveTab = useStore(state => state.setActiveTab);
  const savedQueries = useStore(state => state.savedQueries);
  const saveQuery = useStore(state => state.saveQuery);
  const activeWorkbenchTab = useMemo(
      () => activeTabId ? tabs.find(tab => tab.id === activeTabId) : undefined,
      [activeTabId, tabs],
  );
  useWorkbenchSidebarAutoCollapse(activeWorkbenchTab?.type, isSidebarCollapsed, setIsSidebarCollapsed);
  useWorkbenchSessionRestore(isStoreHydrated && hasLoadedSecureConfig);
  const titlebarContext = useMemo(
      () => resolveTitlebarContext({
          activeContext,
          sidebarContext: sidebarTitlebarSnapshot.selection,
          activeTab: activeWorkbenchTab,
          connections,
      }),
      [activeContext, activeWorkbenchTab, connections, sidebarTitlebarSnapshot.selection],
  );
  // Keep primary-action semantics anchored to the active workbench context.
  // The title-bar summary may intentionally follow a separate Sidebar row.
  const currentPrimaryActionConnection = useMemo(() => {
      const connectionId = String(activeContext?.connectionId || activeWorkbenchTab?.connectionId || '').trim();
      return connections.find(connection => connection.id === connectionId) || null;
  }, [activeContext?.connectionId, activeWorkbenchTab?.connectionId, connections]);
  const explorerContextConnectionName = titlebarContext.connectionName
      || t('sidebar.active_connection.no_host_selected');
  const explorerContextTooltipText = [
      titlebarContext.connection ? explorerContextConnectionName : '',
      titlebarContext.databaseName,
      titlebarContext.tableName,
  ].filter(Boolean).join(' · ') || explorerContextConnectionName;
  const explorerContextTooltip = titlebarContext.connection
      ? explorerContextTooltipText
      : t('sidebar.active_connection.no_host_selected');
  const v2ExplorerContext = useMemo(() => ({
      active: Boolean(titlebarContext.connection),
      connectionName: explorerContextConnectionName,
      databaseName: titlebarContext.databaseName,
      objectName: titlebarContext.tableName,
      tooltip: explorerContextTooltip,
  }), [
      explorerContextConnectionName,
      explorerContextTooltip,
      titlebarContext.connection,
      titlebarContext.databaseName,
      titlebarContext.tableName,
  ]);
  const primaryActionIsMessageQueue = isMessageQueueDataSource(
      currentPrimaryActionConnection?.config,
  );
  const applicationQuitConfirmRef = useRef<{ destroy: () => void } | null>(null);
  const applicationQuitHandlingRef = useRef(false);
  const openSecurityUpdateSettings = useCallback((focusTarget?: SecurityUpdateSettingsFocusTarget | null) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      setIsSecurityUpdateIntroOpen(false);
      if (focusTarget !== undefined) {
          setSecurityUpdateSettingsFocusTarget(focusTarget);
          setSecurityUpdateSettingsFocusRequest((current) => current + 1);
      }
      setToolCenterBackGroupKey('config');
      setActiveSettingsCenterGroupKey('config');
      setActiveSettingsCenterPane({ key: 'security-update', group: 'config' });
      openSettingsCenterWorkbenchTab();
  }), []);
  const handleOpenSecurityUpdateSettings = useCallback((focusTarget: SecurityUpdateSettingsFocusTarget | null = null) => {
      openSecurityUpdateSettings(focusTarget);
  }, [openSecurityUpdateSettings]);
  const runSecurityUpdateRound = useCallback(async (mode: 'start' | 'retry' | 'restart') => {
      const backendApp = (window as any).go?.app?.App;
      const stageText = mode === 'start'
          ? t('app.security_update.stage.checking_saved_config')
          : (mode === 'retry'
              ? t('app.security_update.stage.verifying_result')
              : t('app.security_update.stage.updating_secure_storage'));
      const detailsWereOpen = isSettingsModalOpen && activeSettingsCenterPane?.key === 'security-update';
      setSecurityUpdateProgressStage(stageText);
      setIsSecurityUpdateProgressOpen(true);
      setIsSecurityUpdateIntroOpen(false);

      let nextStatus: SecurityUpdateStatus | null = null;
      let shouldOpenSettings = false;
      let refreshSettingsFocus = false;
      try {
          if (mode === 'start') {
              const result = await startSecurityUpdateFromBootstrap({
                  backend: backendApp,
                  replaceConnections,
                  replaceGlobalProxy,
                  t,
              });
              if (result.error) {
                  throw result.error;
              }
              nextStatus = normalizeSecurityUpdateStatus(result.status);
          } else if (mode === 'retry') {
              if (typeof backendApp?.RetrySecurityUpdateCurrentRound !== 'function') {
                  throw new Error(t('app.security_update.error.capability_unavailable'));
              }
              nextStatus = normalizeSecurityUpdateStatus(await backendApp.RetrySecurityUpdateCurrentRound({
                  migrationId: securityUpdateStatus.migrationId,
              }));
          } else {
              if (typeof backendApp?.RestartSecurityUpdate !== 'function') {
                  throw new Error(t('app.security_update.error.capability_unavailable'));
              }
              nextStatus = normalizeSecurityUpdateStatus(await backendApp.RestartSecurityUpdate({
                  migrationId: securityUpdateStatus.migrationId,
                  sourceType: 'current_app_saved_config',
                  rawPayload: securityUpdateRawPayload ?? '',
                  options: {
                      allowPartial: true,
                      writeBackup: true,
                  },
              }));
          }

          if (mode !== 'start') {
              nextStatus = await finalizeSecurityUpdateStatus({
                  backend: backendApp,
                  replaceConnections,
                  replaceGlobalProxy,
                  t,
              }, nextStatus);
          }

          shouldOpenSettings = nextStatus.overallStatus === 'needs_attention' || nextStatus.overallStatus === 'rolled_back';
          refreshSettingsFocus = shouldRefreshSecurityUpdateDetailsFocus({
              requestedOpen: shouldOpenSettings,
              wasOpen: detailsWereOpen,
          });
      } catch (err: any) {
          console.warn('Failed to execute security update round', err);
          setIsSecurityUpdateProgressOpen(false);
          if (detailsWereOpen) {
              openSecurityUpdateSettings();
          }
          void message.error(err?.message || t('app.security_update.message.not_finished_retry_later'));
          return;
      }

      if (!nextStatus) {
          setIsSecurityUpdateProgressOpen(false);
          return;
      }
      setIsSecurityUpdateProgressOpen(false);
      applySecurityUpdateStatus(nextStatus, {
          openSettings: shouldOpenSettings,
          refreshFocus: refreshSettingsFocus,
      });

      if (nextStatus.overallStatus === 'completed') {
          setSecurityUpdateHasLegacySensitiveItems(false);
          setSecurityUpdateRawPayload(null);
          void message.success(t('app.security_update.message.completed'));
      } else if (nextStatus.overallStatus === 'needs_attention') {
          void message.warning(t('app.security_update.message.needs_attention'));
      } else if (nextStatus.overallStatus === 'rolled_back') {
          void message.warning(t('app.security_update.message.rolled_back'));
      }
  }, [
      applySecurityUpdateStatus,
      activeSettingsCenterPane?.key,
      isSettingsModalOpen,
      normalizeSecurityUpdateStatus,
      openSecurityUpdateSettings,
      replaceConnections,
      replaceGlobalProxy,
      securityUpdateRawPayload,
      securityUpdateStatus.migrationId,
      t,
  ]);
  const handleStartSecurityUpdate = useCallback(() => {
      void runSecurityUpdateRound('start');
  }, [runSecurityUpdateRound]);
  const handlePrepareExternalMCPUse = useCallback(async () => {
      const backendApp = (window as any).go?.app?.App;
      const result = await prepareSecureConfigForExternalMCP({
          backend: backendApp,
          replaceConnections,
          replaceGlobalProxy,
          t,
      });
      if (result.error) {
          throw result.error;
      }
      if (!result.status) {
          return;
      }

      const nextStatus = normalizeSecurityUpdateStatus(result.status);
      const shouldOpenSettings = nextStatus.overallStatus === 'needs_attention' || nextStatus.overallStatus === 'rolled_back';
      applySecurityUpdateStatus(nextStatus, {
          openSettings: shouldOpenSettings,
          refreshFocus: shouldOpenSettings,
      });

      if (nextStatus.overallStatus === 'completed') {
          setSecurityUpdateHasLegacySensitiveItems(false);
          setSecurityUpdateRawPayload(null);
          return;
      }

      const hasConnectionIssue = nextStatus.issues.some((issue) =>
          issue.scope === 'connection' && issue.status !== 'updated',
      );
      if (nextStatus.overallStatus === 'rolled_back' || hasConnectionIssue) {
          throw new Error(t('app.security_update.message.needs_attention'));
      }
      if (nextStatus.overallStatus === 'needs_attention') {
          void message.warning(t('app.security_update.message.needs_attention'));
      }
  }, [
      applySecurityUpdateStatus,
      normalizeSecurityUpdateStatus,
      replaceConnections,
      replaceGlobalProxy,
      t,
  ]);
  const handleRetrySecurityUpdate = useCallback(() => {
      void runSecurityUpdateRound('retry');
  }, [runSecurityUpdateRound]);
  const handleRestartSecurityUpdate = useCallback(() => {
      void runSecurityUpdateRound('restart');
  }, [runSecurityUpdateRound]);
  const handlePostponeSecurityUpdate = useCallback(async () => {
      const backendApp = (window as any).go?.app?.App;
      setIsSecurityUpdateIntroOpen(false);
      try {
          if (typeof backendApp?.DismissSecurityUpdateReminder === 'function') {
              const nextStatus = mergeSecurityUpdateStatusWithLegacySource(
                  await backendApp.DismissSecurityUpdateReminder(),
                  securityUpdateRawPayload,
                  { t },
              );
              applySecurityUpdateStatus(nextStatus);
              return;
          }
          applySecurityUpdateStatus({
              overallStatus: 'postponed',
              canStart: true,
              canPostpone: true,
              summary: securityUpdateStatus.summary,
              issues: securityUpdateStatus.issues,
          });
      } catch (err: any) {
          console.warn('Failed to dismiss security update reminder', err);
          void message.error(err?.message || t('app.security_update.message.postpone_failed'));
      }
  }, [
      applySecurityUpdateStatus,
      securityUpdateRawPayload,
      securityUpdateStatus.issues,
      securityUpdateStatus.summary,
      t,
  ]);
  const handleSecurityUpdateIssueAction = useCallback((issue: SecurityUpdateIssue) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const repairEntry = resolveSecurityUpdateRepairEntry(issue, connections, securityUpdateStatus, t);
      if (repairEntry.type === 'warning') {
          void message.warning(repairEntry.message);
          return;
      }
      if (repairEntry.type === 'connection') {
          closeSettingsCenterWorkbenchTab();
          setSecurityUpdateRepairSource(repairEntry.repairSource);
          setEditingConnection(repairEntry.connection);
          setIsModalOpen(true);
          return;
      }
      if (repairEntry.type === 'proxy') {
          closeSettingsCenterWorkbenchTab();
          setSecurityUpdateRepairSource(repairEntry.repairSource);
          setIsProxyModalOpen(true);
          return;
      }
      if (repairEntry.type === 'ai') {
          setSecurityUpdateRepairSource(repairEntry.repairSource);
          setFocusedAIProviderId(repairEntry.providerId);
          setAiSettingsSection('providers');
          setAiSettingsProviderView('workspace');
          setActiveSettingsCenterGroupKey('services');
          setActiveSettingsCenterPane({ key: 'ai', group: 'services' });
          openSettingsCenterWorkbenchTab();
          return;
      }
      if (repairEntry.type === 'retry') {
          void runSecurityUpdateRound('retry');
          return;
      }
      setSecurityUpdateRepairSource(null);
      openSecurityUpdateSettings(repairEntry.focusTarget);
  }), [connections, openSecurityUpdateSettings, runSecurityUpdateRound, securityUpdateStatus, t]);
  return {
    bgContent, overlayTheme, renderUtilityModalTitle, toolCenterContentPanelStyle,
    toolCenterDetailBodyStyle, toolCenterDetailPanelStyle, toolCenterModalSplitStyle,
    toolCenterModalWorkspaceStyle, toolCenterNavPanelStyle, utilityModalShellStyle,
    utilityMutedTextStyle, utilityPanelStyle, addTab, handleOpenDriverManagerWorkbench,
    activeContext, connections, setSidebarTitlebarSnapshot, moveConnectionToTag,
    moveConnectionsToTag, setConnectionDisplaySortMode, connectionImportGroupOptions, tabs,
    activeTabId, setActiveTab, saveQuery, v2ExplorerContext, primaryActionIsMessageQueue,
    applicationQuitConfirmRef, applicationQuitHandlingRef, openSecurityUpdateSettings,
    handleOpenSecurityUpdateSettings, handleStartSecurityUpdate, handlePrepareExternalMCPUse,
    handleRetrySecurityUpdate, handleRestartSecurityUpdate, handlePostponeSecurityUpdate,
    handleSecurityUpdateIssueAction,
  };
};

export type AppSecurityUpdateApi = ReturnType<typeof useAppSecurityUpdate>;
