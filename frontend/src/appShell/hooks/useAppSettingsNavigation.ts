import { useCallback, useRef, useEffect } from 'react';
import { message } from 'antd';
import {
  resolveSettingsCenterGroupInitialPane,
  isConnectionPackageSettingsPaneKey,
  type ToolCenterGroupKey,
  type SettingsCenterGroupKey,
  type SettingsCenterPaneKey,
  type ToolCenterPaneKey,
  isToolCenterGroupKey,
} from '../settingsCenterPanes';
import { withAISettingsLeaveGuard } from '../../utils/aiSettingsLeaveGuard';
import { shouldReopenSecurityUpdateDetails } from '../../utils/securityUpdateRepairFlow';
import {
  type DataSyncEntryModeAlias,
  normalizeDataSyncEntryMode,
} from '../../components/dataSyncEntryMode';
import {
  buildDataSyncWorkbenchTab,
  resolveExistingDataSyncWorkbenchTabId,
} from '../../utils/dataSyncTab';
import { useStore } from '../../store';
import type { SettingsCenterNavigationTarget } from '../../components/settings/settingsCenterMenuCatalog';
import {
  SETTINGS_WORKBENCH_TAB_BUILDERS,
  resolveThemeSettingsSection,
  resolveAISettingsSection,
} from '../../components/settings/settingsCenterNavigationTargets';
import {
  GetDataRootDirectoryInfo,
  SelectDataRootDirectory,
  ApplyDataRootDirectory,
  OpenDataRootDirectory,
  SelectLogDirectory,
  ApplyLogDirectory,
  OpenLogDirectory,
  SelectSavedQueryDirectory,
  ApplySavedQueryDirectory,
  GetSavedQueries,
  OpenSavedQueryDirectory,
} from '../../../wailsjs/go/app/App';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppShellStateApi } from './useAppShellState';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppQuitAndUpdateApi } from './useAppQuitAndUpdate';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';
import type { AppConnectionImportExportApi } from './useAppConnectionImportExport';

export interface UseAppSettingsNavigationInput {
  setConnectionHealthTargetIds: AppCoreStateApi['setConnectionHealthTargetIds'];
  setActiveSettingsCenterPane: AppShellStateApi['setActiveSettingsCenterPane'];
  setCapturingShortcutAction: AppProxySettingsApi['setCapturingShortcutAction'];
  activeSettingsCenterPaneRef: AppShellStateApi['activeSettingsCenterPaneRef'];
  closeConnectionPackageDialog: AppQuitAndUpdateApi['closeConnectionPackageDialog'];
  setFocusedAIProviderId: AppShellStateApi['setFocusedAIProviderId'];
  setSecurityUpdateRepairSource: AppShellStateApi['setSecurityUpdateRepairSource'];
  aiSettingsLeaveGuardRef: AppShellStateApi['aiSettingsLeaveGuardRef'];
  setToolCenterBackGroupKey: AppProxySettingsApi['setToolCenterBackGroupKey'];
  setActiveSettingsCenterGroupKey: AppShellStateApi['setActiveSettingsCenterGroupKey'];
  openSettingsCenterWorkbenchTab: AppShellStateApi['openSettingsCenterWorkbenchTab'];
  securityUpdateRepairSource: AppShellStateApi['securityUpdateRepairSource'];
  openSecurityUpdateSettings: AppSecurityUpdateApi['openSecurityUpdateSettings'];
  activeSettingsCenterPane: AppShellStateApi['activeSettingsCenterPane'];
  closeSettingsCenterWorkbenchTab: AppShellStateApi['closeSettingsCenterWorkbenchTab'];
  addTab: AppSecurityUpdateApi['addTab'];
  isSettingsModalOpen: AppShellStateApi['isSettingsModalOpen'];
  updateCenterBridgeRef: AppUpdateAndDiagnosticsApi['updateCenterBridgeRef'];
  openReleaseNotesOnManualCheckRef: AppUpdateAndDiagnosticsApi['openReleaseNotesOnManualCheckRef'];
  setReleaseNotesModalOpen: AppUpdateAndDiagnosticsApi['setReleaseNotesModalOpen'];
  prepareAboutSurface: AppUpdateAndDiagnosticsApi['prepareAboutSurface'];
  handleExportConnectionsRef: AppConnectionImportExportApi['handleExportConnectionsRef'];
  setThemeModalSection: AppProxySettingsApi['setThemeModalSection'];
  setAiSettingsSection: AppShellStateApi['setAiSettingsSection'];
  setAiSettingsProviderView: AppShellStateApi['setAiSettingsProviderView'];
  toolCenterBackGroupKey: AppProxySettingsApi['toolCenterBackGroupKey'];
  setIsSidebarCollapsed: AppShellStateApi['setIsSidebarCollapsed'];
  setDataRootLoading: AppProxySettingsApi['setDataRootLoading'];
  t: AppCoreStateApi['t'];
  setDataRootInfo: AppProxySettingsApi['setDataRootInfo'];
  setSelectedDataRootPath: AppProxySettingsApi['setSelectedDataRootPath'];
  setSelectedLogDirectoryPath: AppProxySettingsApi['setSelectedLogDirectoryPath'];
  setSelectedSavedQueryDirectoryPath: AppProxySettingsApi['setSelectedSavedQueryDirectoryPath'];
  isDataRootModalOpen: AppProxySettingsApi['isDataRootModalOpen'];
  selectedDataRootPath: AppProxySettingsApi['selectedDataRootPath'];
  dataRootInfo: AppProxySettingsApi['dataRootInfo'];
  setDataRootApplying: AppProxySettingsApi['setDataRootApplying'];
  selectedLogDirectoryPath: AppProxySettingsApi['selectedLogDirectoryPath'];
  setLogDirectoryApplying: AppProxySettingsApi['setLogDirectoryApplying'];
  selectedSavedQueryDirectoryPath: AppProxySettingsApi['selectedSavedQueryDirectoryPath'];
  setSavedQueryDirectoryApplying: AppProxySettingsApi['setSavedQueryDirectoryApplying'];
  replaceSavedQueries: AppCoreStateApi['replaceSavedQueries'];
  reloadSavedQueryGroups: AppCoreStateApi['reloadSavedQueryGroups'];
}

export const useAppSettingsNavigation = ({
  setConnectionHealthTargetIds, setActiveSettingsCenterPane, setCapturingShortcutAction,
  activeSettingsCenterPaneRef, closeConnectionPackageDialog, setFocusedAIProviderId,
  setSecurityUpdateRepairSource, aiSettingsLeaveGuardRef, setToolCenterBackGroupKey,
  setActiveSettingsCenterGroupKey, openSettingsCenterWorkbenchTab, securityUpdateRepairSource,
  openSecurityUpdateSettings, activeSettingsCenterPane, closeSettingsCenterWorkbenchTab, addTab,
  isSettingsModalOpen, updateCenterBridgeRef, openReleaseNotesOnManualCheckRef,
  setReleaseNotesModalOpen, prepareAboutSurface, handleExportConnectionsRef, setThemeModalSection,
  setAiSettingsSection, setAiSettingsProviderView, toolCenterBackGroupKey, setIsSidebarCollapsed,
  setDataRootLoading, t, setDataRootInfo, setSelectedDataRootPath, setSelectedLogDirectoryPath,
  setSelectedSavedQueryDirectoryPath, isDataRootModalOpen, selectedDataRootPath, dataRootInfo,
  setDataRootApplying, selectedLogDirectoryPath, setLogDirectoryApplying,
  selectedSavedQueryDirectoryPath, setSavedQueryDirectoryApplying, replaceSavedQueries,
  reloadSavedQueryGroups,
}: UseAppSettingsNavigationInput) => {
  const closeConnectionHealthSettingsPane = useCallback(() => {
      setConnectionHealthTargetIds([]);
      setActiveSettingsCenterPane((current) => (
          current?.key === 'connection-health' ? resolveSettingsCenterGroupInitialPane('config') : current
      ));
  }, []);
  const clearSettingsCenterTransientPaneState = useCallback(() => {
      setCapturingShortcutAction(null);
      if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPaneRef.current?.key)) {
          closeConnectionPackageDialog();
      }
      if (activeSettingsCenterPaneRef.current?.key === 'connection-health') {
          setConnectionHealthTargetIds([]);
      }
      if (activeSettingsCenterPaneRef.current?.key === 'ai') {
          setFocusedAIProviderId(undefined);
          setSecurityUpdateRepairSource(null);
      }
  }, [closeConnectionPackageDialog]);
  const handleOpenToolsModal = useCallback((group: ToolCenterGroupKey = 'config') => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane(resolveSettingsCenterGroupInitialPane(group));
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState, openSettingsCenterWorkbenchTab]);
  const handleOpenSettingsModal = useCallback((group: SettingsCenterGroupKey = 'preferences') => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane(resolveSettingsCenterGroupInitialPane(group));
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState, openSettingsCenterWorkbenchTab]);
  const handleOpenSettingsCenterPane = useCallback((group: SettingsCenterGroupKey, key: SettingsCenterPaneKey) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane({ key, group });
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState, openSettingsCenterWorkbenchTab]);
  const finalizeSecurityRepairReturnFromAISettings = useCallback(() => {
      const reopenSecurityUpdateDetails = shouldReopenSecurityUpdateDetails(securityUpdateRepairSource);
      setFocusedAIProviderId(undefined);
      setSecurityUpdateRepairSource(null);
      if (reopenSecurityUpdateDetails) {
          openSecurityUpdateSettings();
      }
  }, [openSecurityUpdateSettings, securityUpdateRepairSource]);
  const handleCancelSettingsCenterPane = useCallback(() => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const leavingAI = activeSettingsCenterPane?.key === 'ai';
      if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPane?.key)) {
          closeConnectionPackageDialog();
      }
      if (activeSettingsCenterPane?.key === 'connection-health') {
          setConnectionHealthTargetIds([]);
      }
      setCapturingShortcutAction(null);
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterPane(null);
      closeSettingsCenterWorkbenchTab();
      if (leavingAI) {
          finalizeSecurityRepairReturnFromAISettings();
      }
  }), [activeSettingsCenterPane?.key, closeConnectionPackageDialog, closeSettingsCenterWorkbenchTab, finalizeSecurityRepairReturnFromAISettings]);
  const handleOpenDataSyncWorkbench = useCallback((entryMode: DataSyncEntryModeAlias) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const normalized = normalizeDataSyncEntryMode(entryMode);
      const nextTab = buildDataSyncWorkbenchTab({ entryMode: normalized });
      const existingId = resolveExistingDataSyncWorkbenchTabId(
          normalized,
          useStore.getState().tabs,
      );
      addTab(existingId ? { ...nextTab, id: existingId } : nextTab);
  }), [addTab]);
  const isSettingsAboutPaneOpen = isSettingsModalOpen && activeSettingsCenterPane?.key === 'about-go-navi';
  const wasSettingsCenterTabOpenRef = useRef(false);
  useEffect(() => {
      const wasOpen = wasSettingsCenterTabOpenRef.current;
      wasSettingsCenterTabOpenRef.current = isSettingsModalOpen;
      if (!wasOpen || isSettingsModalOpen) {
          return;
      }
      // Tab closed via workbench chrome (X) — mirror cancel cleanup without re-entering leave guard.
      if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPaneRef.current?.key)) {
          closeConnectionPackageDialog();
      }
      if (activeSettingsCenterPaneRef.current?.key === 'connection-health') {
          setConnectionHealthTargetIds([]);
      }
      const leavingAI = activeSettingsCenterPaneRef.current?.key === 'ai';
      setCapturingShortcutAction(null);
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterPane(null);
      if (leavingAI) {
          finalizeSecurityRepairReturnFromAISettings();
      }
  }, [closeConnectionPackageDialog, finalizeSecurityRepairReturnFromAISettings, isSettingsModalOpen]);
  const isSettingsAboutPaneOpenRef = useRef(false);
  useEffect(() => {
      isSettingsAboutPaneOpenRef.current = isSettingsAboutPaneOpen;
  }, [isSettingsAboutPaneOpen]);
  useEffect(() => {
      updateCenterBridgeRef.current = {
          open: () => {
              handleOpenSettingsCenterPane('about', 'about-go-navi');
          },
          close: () => {
              handleCancelSettingsCenterPane();
          },
          isOpen: () => isSettingsAboutPaneOpenRef.current,
      };
      return () => {
          updateCenterBridgeRef.current = null;
      };
  }, [handleCancelSettingsCenterPane, handleOpenSettingsCenterPane]);
  useEffect(() => {
      openReleaseNotesOnManualCheckRef.current = () => {
          setReleaseNotesModalOpen(true);
      };
      return () => {
          openReleaseNotesOnManualCheckRef.current = null;
      };
  }, []);
  useEffect(() => {
      if (!isSettingsAboutPaneOpen) {
          return;
      }
      prepareAboutSurface();
  }, [isSettingsAboutPaneOpen, prepareAboutSurface]);
  const handleOpenToolCenterPane = useCallback((group: ToolCenterGroupKey, key: ToolCenterPaneKey) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setToolCenterBackGroupKey(group);
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane({ key, group });
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState]);
  /** Title-bar / explorer settings entries → settings center navigation. */
  const handleTitleBarSettingsNavigation = useCallback((spec: SettingsCenterNavigationTarget) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      if (spec.action === 'import-connections') {
          handleOpenToolCenterPane('config', 'import');
          return;
      }
      if (spec.action === 'export-connections') {
          void handleExportConnectionsRef.current('config');
          return;
      }
      if (
          spec.action === 'compare' ||
          spec.action === 'schema-compare' ||
          spec.action === 'data-compare'
      ) {
          handleOpenDataSyncWorkbench('compare');
          return;
      }
      if (spec.action === 'sync') {
          handleOpenDataSyncWorkbench('sync');
          return;
      }
      if (spec.action === 'drivers') {
          handleOpenToolCenterPane('workspace', 'drivers');
          return;
      }
      const buildWorkbenchTab = spec.action ? SETTINGS_WORKBENCH_TAB_BUILDERS[spec.action] : undefined;
      if (buildWorkbenchTab) {
          handleCancelSettingsCenterPane();
          addTab(buildWorkbenchTab());
          return;
      }
      if (!spec.pane) {
          if (isToolCenterGroupKey(spec.group)) {
              handleOpenToolsModal(spec.group);
              return;
          }
          handleOpenSettingsModal(spec.group);
          return;
      }
      if (isToolCenterGroupKey(spec.group)) {
          handleOpenToolCenterPane(spec.group, spec.pane as ToolCenterPaneKey);
          return;
      }
      if (spec.group === 'preferences' && spec.pane === 'theme') {
          setThemeModalSection(resolveThemeSettingsSection(spec.section));
          handleOpenSettingsCenterPane('preferences', 'theme');
          return;
      }
      if (spec.group === 'services' && spec.pane === 'ai') {
          setSecurityUpdateRepairSource(null);
          setFocusedAIProviderId(undefined);
          setAiSettingsSection(resolveAISettingsSection(spec.section));
          setAiSettingsProviderView('workspace');
          handleOpenSettingsCenterPane('services', 'ai');
          return;
      }
      handleOpenSettingsCenterPane(spec.group, spec.pane as SettingsCenterPaneKey);
  }), [
      addTab,
      handleCancelSettingsCenterPane,
      handleOpenDataSyncWorkbench,
      handleOpenSettingsCenterPane,
      handleOpenSettingsModal,
      handleOpenToolCenterPane,
      handleOpenToolsModal,
  ]);
  const handleReturnToToolCenter = useCallback((closeChild?: () => void) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const returnGroup = toolCenterBackGroupKey ?? 'config';
      closeChild?.();
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterGroupKey(returnGroup);
      setActiveSettingsCenterPane(resolveSettingsCenterGroupInitialPane(returnGroup));
      openSettingsCenterWorkbenchTab();
  }), [toolCenterBackGroupKey]);
  const handleFocusSidebarSearch = useCallback(() => {
      setIsSidebarCollapsed(false);
      window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('gonavi:focus-sidebar-search'));
      }, 0);
  }, []);
  const loadDataRootInfo = useCallback(async () => {
      setDataRootLoading(true);
      try {
          const res = await GetDataRootDirectoryInfo();
          if (!res?.success) {
              throw new Error(res?.message || t('app.data_root.message.load_failed'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedDataRootPath(String(data.path || ''));
          setSelectedLogDirectoryPath(String(data.logDirectory || data.defaultLogDirectory || ''));
          setSelectedSavedQueryDirectoryPath(String(
              data.savedQueryDirectory || data.defaultSavedQueryDirectory || '',
          ));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.load_failed_with_error', { error: errMsg }));
      } finally {
          setDataRootLoading(false);
      }
  }, [t]);

  useEffect(() => {
      if (!isDataRootModalOpen && !activeSettingsCenterPane?.key.startsWith('data-root')) {
          return;
      }
      void loadDataRootInfo();
  }, [activeSettingsCenterPane?.key, isDataRootModalOpen, loadDataRootInfo]);

  const handleSelectDataRoot = useCallback(async () => {
      try {
          const res = await SelectDataRootDirectory(selectedDataRootPath || dataRootInfo?.path || '');
          if (!res?.success) {
              if (String(res?.message || '') !== '已取消') {
                  throw new Error(res?.message || t('app.data_root.message.select_failed'));
              }
              return;
          }
          const data = (res?.data || {}) as any;
          setSelectedDataRootPath(String(data.path || ''));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.select_failed_with_error', { error: errMsg }));
      }
  }, [dataRootInfo?.path, selectedDataRootPath, t]);

  const handleApplyDataRoot = useCallback(async (migrate: boolean, useDefaultPath = false) => {
      const nextPath = useDefaultPath ? String(dataRootInfo?.defaultPath || '') : String(selectedDataRootPath || '').trim();
      if (!nextPath) {
          void message.warning(t('app.data_root.message.select_valid_first'));
          return;
      }
      setDataRootApplying(true);
      try {
          const res = await ApplyDataRootDirectory(nextPath, migrate);
          if (!res?.success) {
              throw new Error(res?.message || t('app.data_root.message.apply_failed'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedDataRootPath(String(data.path || nextPath));
          void message.success(res?.message || t('app.data_root.message.updated'));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.apply_failed_with_error', { error: errMsg }));
      } finally {
          setDataRootApplying(false);
      }
  }, [dataRootInfo?.defaultPath, selectedDataRootPath, t]);

  const handleOpenDataRoot = useCallback(async () => {
      try {
          const res = await OpenDataRootDirectory();
          if (!res?.success) {
              throw new Error(res?.message || t('app.data_root.message.open_failed'));
          }
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.open_failed_with_error', { error: errMsg }));
      }
  }, [t]);

  const handleSelectLogDirectory = useCallback(async () => {
      try {
          const res = await SelectLogDirectory(
              selectedLogDirectoryPath || dataRootInfo?.logDirectory || dataRootInfo?.defaultLogDirectory || '',
          );
          if (!res?.success) {
              if (String(res?.message || '') !== '已取消') {
                  throw new Error(res?.message || t('common.unknown'));
              }
              return;
          }
          const data = (res?.data || {}) as any;
          setSelectedLogDirectoryPath(String(data.directory || ''));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.log_directory.message.select_failed_with_error', { error: errMsg }));
      }
  }, [dataRootInfo?.defaultLogDirectory, dataRootInfo?.logDirectory, selectedLogDirectoryPath, t]);

  const handleApplyLogDirectory = useCallback(async (useDefaultPath = false) => {
      const nextPath = useDefaultPath
          ? String(dataRootInfo?.defaultLogDirectory || '')
          : String(selectedLogDirectoryPath || '').trim();
      if (!nextPath) {
          void message.warning(t('app.data_root.log_directory.message.select_valid_first'));
          return;
      }
      setLogDirectoryApplying(true);
      try {
          const res = await ApplyLogDirectory(nextPath);
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedLogDirectoryPath(String(data.logDirectory || data.defaultLogDirectory || nextPath));
          void message.success(res?.message || t('app.data_root.log_directory.message.updated'));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.log_directory.message.apply_failed_with_error', { error: errMsg }));
      } finally {
          setLogDirectoryApplying(false);
      }
  }, [dataRootInfo?.defaultLogDirectory, selectedLogDirectoryPath, t]);

  const handleOpenLogDirectory = useCallback(async () => {
      try {
          const res = await OpenLogDirectory();
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.log_directory.message.open_failed_with_error', { error: errMsg }));
      }
  }, [t]);

  const handleSelectSavedQueryDirectory = useCallback(async () => {
      try {
          const res = await SelectSavedQueryDirectory(
              selectedSavedQueryDirectoryPath
                  || dataRootInfo?.savedQueryDirectory
                  || dataRootInfo?.defaultSavedQueryDirectory
                  || '',
          );
          if (!res?.success) {
              const data = (res?.data || {}) as any;
              if (data.cancelled === true) return;
              throw new Error(res?.message || t('common.unknown'));
          }
          const data = (res?.data || {}) as any;
          setSelectedSavedQueryDirectoryPath(String(data.directory || ''));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.saved_query_directory.message.select_failed_with_error', { error: errMsg }));
      }
  }, [
      dataRootInfo?.defaultSavedQueryDirectory,
      dataRootInfo?.savedQueryDirectory,
      selectedSavedQueryDirectoryPath,
      t,
  ]);

  const handleApplySavedQueryDirectory = useCallback(async (useDefaultPath = false) => {
      const nextPath = useDefaultPath
          ? String(dataRootInfo?.defaultSavedQueryDirectory || '')
          : String(selectedSavedQueryDirectoryPath || '').trim();
      if (!nextPath) {
          void message.warning(t('app.data_root.saved_query_directory.message.select_valid_first'));
          return;
      }
      setSavedQueryDirectoryApplying(true);
      try {
          const res = await ApplySavedQueryDirectory(nextPath);
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedSavedQueryDirectoryPath(String(
              data.savedQueryDirectory || data.defaultSavedQueryDirectory || nextPath,
          ));
          try {
              const queries = await GetSavedQueries();
              replaceSavedQueries(Array.isArray(queries) ? queries : []);
              await reloadSavedQueryGroups();
          } catch (refreshError) {
              console.warn('Failed to refresh saved queries after changing their directory', refreshError);
          }
          void message.success(res?.message || t('app.data_root.saved_query_directory.message.updated'));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.saved_query_directory.message.apply_failed_with_error', { error: errMsg }));
      } finally {
          setSavedQueryDirectoryApplying(false);
      }
  }, [
      dataRootInfo?.defaultSavedQueryDirectory,
      reloadSavedQueryGroups,
      replaceSavedQueries,
      selectedSavedQueryDirectoryPath,
      t,
  ]);

  const handleOpenSavedQueryDirectory = useCallback(async () => {
      try {
          const res = await OpenSavedQueryDirectory();
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.saved_query_directory.message.open_failed_with_error', { error: errMsg }));
      }
  }, [t]);
  return {
    closeConnectionHealthSettingsPane, handleOpenToolsModal, handleOpenSettingsModal,
    handleOpenSettingsCenterPane, handleCancelSettingsCenterPane, handleOpenDataSyncWorkbench,
    handleOpenToolCenterPane, handleTitleBarSettingsNavigation, handleReturnToToolCenter,
    handleFocusSidebarSearch, handleSelectDataRoot, handleApplyDataRoot, handleOpenDataRoot,
    handleSelectLogDirectory, handleApplyLogDirectory, handleOpenLogDirectory,
    handleSelectSavedQueryDirectory, handleApplySavedQueryDirectory, handleOpenSavedQueryDirectory,
  };
};

export type AppSettingsNavigationApi = ReturnType<typeof useAppSettingsNavigation>;
