
import React from 'react';
import { Layout, ConfigProvider } from 'antd';
import ConnectionGroupManagementModal from './components/sidebar/ConnectionGroupManagementModal';
import ConnectionModal from './components/ConnectionModal';
import LinuxCJKFontBanner from './components/LinuxCJKFontBanner';
import CustomThemeStyleHost from './components/theme/CustomThemeStyleHost';
import ToolbarAppearanceStyleHost from './components/theme/ToolbarAppearanceStyleHost';
import { type TabDisplayElementKey } from './utils/tabDisplay';
import { APP_NESTED_MODAL_Z_INDEX } from './utils/overlayZIndex';
import { getAntdLocale } from './i18n/frameworkLocale';
import './App.css';
import './v2-theme.css';
import './styles/v2-theme-workbench.css';
import './styles/v2-theme-ai.css';
import { type ToolCenterGroupKey } from './appShell/settingsCenterPanes';
import { useAppCoreState } from './appShell/hooks/useAppCoreState';
import { useAppShellState } from './appShell/hooks/useAppShellState';
import { useAppBootstrapEffects } from './appShell/hooks/useAppBootstrapEffects';
import { useAppStartupEffects } from './appShell/hooks/useAppStartupEffects';
import { useAppWindowEffects } from './appShell/hooks/useAppWindowEffects';
import { useAppSecurityUpdate } from './appShell/hooks/useAppSecurityUpdate';
import { useAppUpdateAndDiagnostics } from './appShell/hooks/useAppUpdateAndDiagnostics';
import { useAppQuitAndUpdate } from './appShell/hooks/useAppQuitAndUpdate';
import { useAppConnectionImportExport } from './appShell/hooks/useAppConnectionImportExport';
import { useAppProxySettings } from './appShell/hooks/useAppProxySettings';
import { useAppSettingsNavigation } from './appShell/hooks/useAppSettingsNavigation';
import { useAppDirectorySettingsRender } from './appShell/hooks/useAppDirectorySettingsRender';
import { useAppWorkbenchActions } from './appShell/hooks/useAppWorkbenchActions';
import { useAppLayoutEffects } from './appShell/hooks/useAppLayoutEffects';
import { useAppAntdTheme } from './appShell/hooks/useAppAntdTheme';
import { useAppSettingsPanesRender } from './appShell/hooks/useAppSettingsPanesRender';
import { useAppAboutSettingsRender } from './appShell/hooks/useAppAboutSettingsRender';
import { useAppThemeSettingsRender } from './appShell/hooks/useAppThemeSettingsRender';
import { useAppSettingsCenterRender } from './appShell/hooks/useAppSettingsCenterRender';
import { useLateBoundCallback } from './hooks/useLateBoundCallback';
import { renderAppSettingsCenterModal } from './appShell/settings/renderAppSettingsCenterModal';
import { AppTitleBar } from './appShell/layout/AppTitleBar';
import { AppSider } from './appShell/layout/AppSider';
import { AppContent } from './appShell/layout/AppContent';
import { AppGlobalDialogs } from './appShell/layout/AppGlobalDialogs';

function App() {
  const setFocusedTabDisplayElementKeyLate = useLateBoundCallback<React.Dispatch<React.SetStateAction<TabDisplayElementKey | null>>>();
  const {
    language, t, notificationApi, notificationContextHolder, isModalOpen, setIsModalOpen,
    isConnectionModalMounted, setIsConnectionModalMounted, editingConnection, setEditingConnection,
    connectionHealthTargetIds, setConnectionHealthTargetIds, pendingConnectionTagIdRef,
    connectionModalWarmupDoneRef, windowState, themeMode, appearance, setAppearance, setUiScale,
    setFontSize, startupMaximised, setStartupMaximised, autoCheckForUpdates, setAutoCheckForUpdates,
    autoCheckForUpdatesIntervalMinutes, setAutoCheckForUpdatesIntervalMinutes, globalProxy,
    replaceConnections, replaceConnectionSidebarLayout, replaceGlobalProxy, replaceSavedQueries,
    reloadSavedQueryGroups, setQueryOptions, shortcutOptions, updateShortcut, resetShortcutOptions,
    runtimePlatform, setRuntimePlatform, runtimeBuildType, setRuntimeBuildType, isLinuxRuntime,
    setIsLinuxRuntime, effectiveThemePreference, darkMode, setComputedCustomThemeAntTokens,
    customThemeStyleContextKey, customThemeAntTokens, effectiveUiScale, effectiveFontSize,
    tokenFontSize, titleBarToggleIconKey, tokenFontSizeSM, tokenFontSizeLG, tokenControlHeight,
    tokenControlHeightSM, tokenControlHeightLG, dataTableFontSizeFollowsGlobal,
    sqlEditorFontSizeFollowsGlobal, sidebarTreeFontSizeFollowsGlobal, effectiveDataTableFontSize,
    effectiveSqlEditorFontSize, effectiveSidebarTreeFontSize, effectiveSidebarRailScale,
    effectiveTabEnvironmentAccentThickness, tableDoubleClickAction, queryTableCtrlClickAction,
    newQuerySqlTemplate, sidebarTableMetadataFieldOrder, sidebarTableMetadataFields,
    sidebarMetadataDragSensors, tabDisplaySettings, tabDisplayElementOrder,
    visibleTabDisplayElementKeys, getTabDisplayElementLabel, getTabDisplayElementDescription,
    selectPresetTheme, setTabDisplayLayout, updateTabDisplayElementVisibility,
    moveTabDisplayElement, setTabDisplayElementRow, brandIconId, handleBrandIconChange,
  } = useAppCoreState({
    setFocusedTabDisplayElementKey: setFocusedTabDisplayElementKeyLate.call,
  });
  const {
    resolvedUiFontFamily, resolvedMonoFontFamily, appComponentSize, titleBarButtonWidth,
    resolvedAppearance, effectiveOpacity, blurFilter, isWebRuntime, installedFontFamilies,
    setInstalledFontFamilies, isFontFamiliesLoading, setIsFontFamiliesLoading,
    fontFamiliesLoadError, setFontFamiliesLoadError, hasLoadedInstalledFontsRef, uiFontOptions,
    monoFontOptions, linuxCJKFontInstallHint, isStoreHydrated, setIsStoreHydrated,
    closeTabsByConnection, savedQueriesBootstrapPromiseRef, savedQueriesLoadedRef,
    hasLoadedSecureConfig, setHasLoadedSecureConfig, downloadSource, setDownloadSource,
    downloadSourceSaving, setDownloadSourceSaving, setHasLoadedConnectionSidebarLayout,
    connectionSidebarLayoutCoordinatorRef, viewportWidth, setViewportWidth, securityUpdateStatus,
    setSecurityUpdateStatus, securityUpdateRawPayload, setSecurityUpdateRawPayload,
    securityUpdateHasLegacySensitiveItems, setSecurityUpdateHasLegacySensitiveItems,
    isSecurityUpdateIntroOpen, setIsSecurityUpdateIntroOpen, setIsSecurityUpdateBannerDismissed,
    securityUpdateSettingsFocusTarget, setSecurityUpdateSettingsFocusTarget,
    securityUpdateSettingsFocusRequest, setSecurityUpdateSettingsFocusRequest,
    isSecurityUpdateProgressOpen, setIsSecurityUpdateProgressOpen, securityUpdateProgressStage,
    setSecurityUpdateProgressStage, securityUpdateRepairSource, setSecurityUpdateRepairSource,
    isSettingsModalOpen, openSettingsCenterWorkbenchTab, closeSettingsCenterWorkbenchTab,
    isConnectionGroupManagementOpen, setIsConnectionGroupManagementOpen,
    activeSettingsCenterGroupKey, setActiveSettingsCenterGroupKey, activeSettingsCenterPane,
    setActiveSettingsCenterPane, activeSettingsCenterPaneRef, aiSettingsLeaveGuardRef,
    registerAISettingsLeaveGuard, focusedTabDisplayElementKey, setFocusedTabDisplayElementKey,
    focusedAIProviderId, setFocusedAIProviderId, aiSettingsSection, setAiSettingsSection,
    aiSettingsProviderView, setAiSettingsProviderView, connectionPackageDialog,
    setConnectionPackageDialog, pendingConnectionImportPayload, setPendingConnectionImportPayload,
    connectionImportTargetTagId, setConnectionImportTargetTagId, connectionImportNotice,
    setConnectionImportNotice, browserConnectionImportInputRef,
    browserConnectionImportSourceGroupRef, aiPanelRenderNonce, setAiPanelRenderNonce,
    aiSettingsRenderNonce, setAiSettingsRenderNonce, LazyAIChatPanel, LazyAISettingsContent,
    sidebarWidth, setSidebarWidth, documentPlatform, isMacRuntime,
    shouldDockCollapsedSidebarActionsInTitlebar, collapsedSidebarActionsTarget,
    handleCollapseSidebarPanel, handleEnsureSidebarExpanded, handleExpandSidebarPanel,
    isCollapsedSidebarActionsDocked, isSidebarCollapsed, setCollapsedSidebarActionsTarget,
    setIsSidebarCollapsed, sidebarCollapsedToggleRef, sidebarContentRef, sidebarExplorerToggleRef,
    titleBarActionsInline, dockActionsInTitlebarBand, titleBarLayout, titleBarHeight,
    sidebarCollapsedWidth, renderedSidebarWidth, aiPanelVisible, aiPanelWidth, setAIPanelWidth,
    aiChatDetached, settingsChildModalZIndex, applicationQuitModalZIndex,
    registerAIPanelTerminalGuard, handleCloseAIPanel, handleDetachAIPanel,
    handleToggleOrFocusAIPanel, windowDiagSequenceRef, windowDiagLastSignatureRef,
    windowDiagLastAtRef, captureMainWindowStateRef, connectionWorkbenchState,
    securityUpdateStatusMeta, securityUpdateEntryVisibility, isSecurityUpdateBannerVisible,
    windowCornerRadius,
  } = useAppShellState({
    appearance, effectiveUiScale, runtimeBuildType, runtimePlatform, t, effectiveSidebarRailScale,
  });
  setFocusedTabDisplayElementKeyLate.bind(setFocusedTabDisplayElementKey);
  const setToolCenterBackGroupKeyLate = useLateBoundCallback<React.Dispatch<React.SetStateAction<ToolCenterGroupKey | null>>>();
  const {
    ensureSavedQueriesLoaded, normalizeSecurityUpdateStatus, applySecurityUpdateStatus,
    handleDownloadSourceChange,
  } = useAppBootstrapEffects({
    setViewportWidth, windowState, windowCornerRadius, resolvedAppearance, darkMode,
    setRuntimePlatform, setRuntimeBuildType, setIsLinuxRuntime, isStoreHydrated, setIsStoreHydrated,
    savedQueriesLoadedRef, savedQueriesBootstrapPromiseRef, replaceSavedQueries,
    reloadSavedQueryGroups, setSecurityUpdateStatus, setIsSecurityUpdateIntroOpen,
    setIsSecurityUpdateBannerDismissed, aiSettingsLeaveGuardRef,
    setSecurityUpdateSettingsFocusTarget, setSecurityUpdateSettingsFocusRequest,
    setToolCenterBackGroupKey: setToolCenterBackGroupKeyLate.call, setActiveSettingsCenterGroupKey,
    setActiveSettingsCenterPane, openSettingsCenterWorkbenchTab, replaceConnections,
    replaceGlobalProxy, t, setSecurityUpdateRawPayload, setSecurityUpdateHasLegacySensitiveItems,
    setHasLoadedSecureConfig, setDownloadSource, downloadSource, setDownloadSourceSaving,
  });

  const emitWindowDiagnosticLate = useLateBoundCallback<(stage: string, extra?: Record<string, unknown>) => Promise<void>>();
  useAppStartupEffects({
    isStoreHydrated, hasLoadedSecureConfig, replaceConnectionSidebarLayout, notificationApi, t,
    connectionSidebarLayoutCoordinatorRef, setHasLoadedConnectionSidebarLayout,
    emitWindowDiagnostic: emitWindowDiagnosticLate.call,
  });

  useAppWindowEffects({
    emitWindowDiagnostic: emitWindowDiagnosticLate.call, captureMainWindowStateRef,
  });

  const setIsProxyModalOpenLate = useLateBoundCallback<React.Dispatch<React.SetStateAction<boolean>>>();
  const {
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
  } = useAppSecurityUpdate({
    blurFilter, darkMode, effectiveOpacity, effectiveUiScale, resolvedAppearance, sidebarWidth,
    connectionImportTargetTagId, setConnectionImportTargetTagId, isSidebarCollapsed,
    setIsSidebarCollapsed, isStoreHydrated, hasLoadedSecureConfig, t, aiSettingsLeaveGuardRef,
    setIsSecurityUpdateIntroOpen, setSecurityUpdateSettingsFocusTarget,
    setSecurityUpdateSettingsFocusRequest,
    setToolCenterBackGroupKey: setToolCenterBackGroupKeyLate.call, setActiveSettingsCenterGroupKey,
    setActiveSettingsCenterPane, openSettingsCenterWorkbenchTab, isSettingsModalOpen,
    activeSettingsCenterPane, setSecurityUpdateProgressStage, setIsSecurityUpdateProgressOpen,
    replaceConnections, replaceGlobalProxy, normalizeSecurityUpdateStatus, securityUpdateStatus,
    securityUpdateRawPayload, setSecurityUpdateRawPayload, applySecurityUpdateStatus,
    setSecurityUpdateHasLegacySensitiveItems, closeSettingsCenterWorkbenchTab,
    setSecurityUpdateRepairSource, setEditingConnection, setIsModalOpen,
    setIsProxyModalOpen: setIsProxyModalOpenLate.call, setFocusedAIProviderId, setAiSettingsSection,
    setAiSettingsProviderView,
  });
  const {
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
  } = useAppUpdateAndDiagnostics({
    isMacRuntime, shortcutOptions, runtimeBuildType, t, windowDiagSequenceRef,
    windowDiagLastSignatureRef, windowDiagLastAtRef, activeTabId, tabs, connections, activeContext,
    addTab, appearance, setActiveTab, applicationQuitHandlingRef, applicationQuitConfirmRef,
  });
  emitWindowDiagnosticLate.bind(emitWindowDiagnostic);

  const {
    handleApplicationQuitRequest, handleInstallUpdateRequest, closeConnectionPackageDialog,
    refreshConnectionsAfterImport,
  } = useAppQuitAndUpdate({
    applicationQuitHandlingRef, resetApplicationQuitRequest, aiSettingsLeaveGuardRef,
    captureMainWindowStateRef, connectionSidebarLayoutCoordinatorRef, forceQuitApplication, t,
    ensureSavedQueriesLoaded, applicationQuitModalZIndex, applicationQuitConfirmRef, saveQuery,
    hideUpdateDownloadProgress, handleInstallFromProgress, showUpdateDownloadProgress,
    setConnectionPackageDialog, setPendingConnectionImportPayload, setConnectionImportNotice,
    setToolCenterBackGroupKey: setToolCenterBackGroupKeyLate.call, replaceConnections,
  });

  const {
    handleBrowserConnectionImportFileChange, handleImportConnections, handleExportConnections,
    handleExportConnectionsRef, handleConfirmConnectionPackageDialog,
  } = useAppConnectionImportExport({
    t, connectionSidebarLayoutCoordinatorRef, connectionImportTargetTagId,
    setConnectionDisplaySortMode, refreshConnectionsAfterImport, moveConnectionsToTag,
    setConnectionImportNotice, setConnectionPackageDialog, setPendingConnectionImportPayload,
    setToolCenterBackGroupKey: setToolCenterBackGroupKeyLate.call, setActiveSettingsCenterGroupKey,
    setActiveSettingsCenterPane, browserConnectionImportSourceGroupRef,
    openSettingsCenterWorkbenchTab, isWebRuntime, browserConnectionImportInputRef, connections,
    connectionPackageDialog, pendingConnectionImportPayload,
  });

  const {
    toolCenterBackGroupKey, setToolCenterBackGroupKey, isThemeModalOpen, setIsThemeModalOpen,
    themeModalSection, setThemeModalSection, isLinuxCJKFontBannerDismissed,
    setIsLinuxCJKFontBannerDismissed, capturingShortcutAction, setCapturingShortcutAction,
    closeShortcutScopeRef, tabDisplaySettingsPanelRef, setTabDisplaySettingsFocusRequest,
    shortcutConflictMap, isProxyModalOpen, setIsProxyModalOpen, proxyDraft, setProxyDraft,
    proxyDraftClearPassword, setProxyDraftClearPassword, proxyApplying, proxyTestUrl,
    setProxyTestUrl, proxyTesting, proxyTestResult, isDataRootModalOpen, setIsDataRootModalOpen,
    dataRootInfo, setDataRootInfo, selectedDataRootPath, setSelectedDataRootPath,
    selectedLogDirectoryPath, setSelectedLogDirectoryPath, selectedSavedQueryDirectoryPath,
    setSelectedSavedQueryDirectoryPath, dataRootLoading, setDataRootLoading, dataRootApplying,
    setDataRootApplying, logDirectoryApplying, setLogDirectoryApplying, savedQueryDirectoryApplying,
    setSavedQueryDirectoryApplying, directorySettingsApplying, aiPanelOverlayActive,
    aiPanelFullscreenOverlay, aiPanelRenderWidth, proxyDraftHost, proxyDraftPortValid,
    proxyDraftValid, proxyDraftDirty, proxyStatusTitle, proxyStatusDescription, proxyPresetItems,
    proxyTestPresetItems, proxyTestUrlTrimmed, proxyCanTest, resetProxyDraftToCurrent,
    updateProxyDraftType, applyProxyPreset, handleTestGlobalProxyDraft, handleApplyGlobalProxyDraft,
  } = useAppProxySettings({
    activeSettingsCenterPane, runtimePlatform, hasLoadedInstalledFontsRef, isFontFamiliesLoading,
    setIsFontFamiliesLoading, setFontFamiliesLoadError, t, setInstalledFontFamilies,
    shortcutOptions, activeShortcutPlatform, language, globalProxy, aiPanelWidth, viewportWidth,
    aiPanelVisible, renderedSidebarWidth, replaceGlobalProxy,
  });
  setToolCenterBackGroupKeyLate.bind(setToolCenterBackGroupKey);
  setIsProxyModalOpenLate.bind(setIsProxyModalOpen);
  const {
    closeConnectionHealthSettingsPane, handleOpenToolsModal, handleOpenSettingsModal,
    handleOpenSettingsCenterPane, handleCancelSettingsCenterPane, handleOpenDataSyncWorkbench,
    handleOpenToolCenterPane, handleTitleBarSettingsNavigation, handleReturnToToolCenter,
    handleFocusSidebarSearch, handleSelectDataRoot, handleApplyDataRoot, handleOpenDataRoot,
    handleSelectLogDirectory, handleApplyLogDirectory, handleOpenLogDirectory,
    handleSelectSavedQueryDirectory, handleApplySavedQueryDirectory, handleOpenSavedQueryDirectory,
  } = useAppSettingsNavigation({
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
  });

  const { renderDataDirectorySettings } = useAppDirectorySettingsRender({
    t, dataRootInfo, selectedSavedQueryDirectoryPath, handleOpenSavedQueryDirectory,
    directorySettingsApplying, handleSelectSavedQueryDirectory, savedQueryDirectoryApplying,
    handleApplySavedQueryDirectory, handleOpenLogDirectory, selectedLogDirectoryPath,
    handleSelectLogDirectory, logDirectoryApplying, handleApplyLogDirectory, dataRootLoading,
    handleOpenDataRoot, selectedDataRootPath, handleSelectDataRoot, dataRootApplying,
    handleApplyDataRoot,
  });

  const {
    isLogPanelOpen, logGhostRef, handleToggleLogPanel, handleCreateConnection,
    handleCreateConnectionInGroup, handleEditConnection, handleConnectionSaved, handleCloseModal,
    handleOpenConnectionHealth, handleOpenDriverManagerFromConnection,
    handleCloseGlobalProxySettings, handleOpenAISettings, handleAIPanelRenderError,
    handleRetryAIPanelRender, handleRetryAISettingsRender, handleWebLogout,
    handleTitleBarWindowToggle, handleTitleBarDoubleClick, handleManualResetWindowZoom,
    handleSidebarMouseDown, siderRef, sidebarResizeHit,
  } = useAppWorkbenchActions({
    pendingConnectionTagIdRef, setSecurityUpdateRepairSource, setEditingConnection,
    setIsConnectionModalMounted, setIsModalOpen, t, connectionModalWarmupDoneRef,
    moveConnectionToTag, securityUpdateRepairSource, securityUpdateStatus, replaceConnections,
    replaceGlobalProxy, normalizeSecurityUpdateStatus, applySecurityUpdateStatus,
    setSecurityUpdateHasLegacySensitiveItems, setSecurityUpdateRawPayload, securityUpdateRawPayload,
    openSecurityUpdateSettings, setConnectionHealthTargetIds, setToolCenterBackGroupKey,
    setActiveSettingsCenterGroupKey, setActiveSettingsCenterPane, openSettingsCenterWorkbenchTab,
    handleOpenDriverManagerWorkbench, setIsProxyModalOpen, aiSettingsLeaveGuardRef,
    setFocusedAIProviderId, setAiSettingsSection, setAiSettingsProviderView, setAiPanelRenderNonce,
    setAiSettingsRenderNonce, emitWindowDiagnostic, useNativeMacWindowControls, isMacRuntime,
    captureMainWindowStateRef, effectiveUiScale, setSidebarWidth, sidebarWidth, isSidebarCollapsed,
  });

  useAppLayoutEffects({
    darkMode, documentPlatform, effectiveFontSize, resolvedUiFontFamily, resolvedMonoFontFamily,
    effectiveUiScale, effectiveOpacity, effectiveDataTableFontSize, effectiveSidebarTreeFontSize,
    effectiveSidebarRailScale, tokenControlHeight, tokenControlHeightSM, handleOpenToolCenterPane,
    aiSettingsLeaveGuardRef, closeSettingsCenterWorkbenchTab, setThemeModalSection,
    setIsThemeModalOpen, setTabDisplaySettingsFocusRequest, handleNewQuery, isMacRuntime,
    useNativeMacWindowControls, closeShortcutScopeRef, capturingShortcutAction, shortcutOptions,
    activeShortcutPlatform, handleFocusSidebarSearch, switchActiveTabByOffset,
    handleCreateConnection, handleToggleOrFocusAIPanel, handleToggleLogPanel, selectPresetTheme,
    themeMode, handleTitleBarWindowToggle, handleManualResetWindowZoom, setCapturingShortcutAction,
    t, updateShortcut,
  });

  const {
    linuxResizeHandleStyleBase, showLinuxResizeHandles, resizeGuideColor, v2AntPrimaryColor,
    v2AntPrimaryBgColor, antdTheme, filterFontOption, renderFontOptionLabel, showLinuxCJKFontBanner,
    sidebarMetadataFieldItems, toggleSidebarMetadataFieldFromSettings, handleSidebarMetadataDragEnd,
  } = useAppAntdTheme({
    isLinuxRuntime, customThemeAntTokens, darkMode, tokenFontSize, tokenFontSizeSM, tokenFontSizeLG,
    resolvedUiFontFamily, resolvedMonoFontFamily, tokenControlHeight, tokenControlHeightSM,
    tokenControlHeightLG, effectiveOpacity, linuxCJKFontInstallHint, hasLoadedInstalledFontsRef,
    isFontFamiliesLoading, fontFamiliesLoadError, isLinuxCJKFontBannerDismissed, t,
    sidebarTableMetadataFieldOrder, setQueryOptions, sidebarTableMetadataFields,
  });
  const {
    renderProxySettingsContent, renderDownloadSourceSettingsContent,
    renderSidebarMetadataSettingsPane, renderSidebarObjectVisibilitySettingsPane,
    updateInstallActionLabel, updateDownloadActionLabel,
  } = useAppSettingsPanesRender({
    darkMode, viewportWidth, proxyDraft, setProxyDraft, proxyDraftValid, proxyTestResult, t,
    overlayTheme, utilityMutedTextStyle, utilityPanelStyle, proxyStatusDescription,
    proxyStatusTitle, proxyDraftDirty, proxyPresetItems, applyProxyPreset, updateProxyDraftType,
    proxyDraftHost, proxyDraftPortValid, setProxyDraftClearPassword, proxyDraftClearPassword,
    proxyTestPresetItems, proxyTestUrlTrimmed, setProxyTestUrl, proxyTestUrl, proxyCanTest,
    handleTestGlobalProxyDraft, proxyTesting, resetProxyDraftToCurrent, proxyApplying,
    handleApplyGlobalProxyDraft, downloadSource, downloadSourceSaving, handleDownloadSourceChange,
    sidebarMetadataDragSensors, handleSidebarMetadataDragEnd, sidebarMetadataFieldItems,
    sidebarTableMetadataFields, toggleSidebarMetadataFieldFromSettings, setQueryOptions, appearance,
    setAppearance, updateInstallAction, lastUpdateInfo,
  });
  const {
    renderSettingsCenterAboutPane, renderSettingsCenterAboutFooter, renderThemeSettingsSection,
    renderThemeSettingsRow, renderThemeModePreview, themeSettingsSections,
  } = useAppAboutSettingsRender({
    isBackgroundProgressForLatestUpdate, isLatestUpdateDownloaded, showUpdateDownloadProgress,
    lastUpdateInfo, muteLatestUpdate, isCheckingForUpdates, checkForUpdates,
    openDownloadedUpdateDirectory, t, handleDownloadUpdateWithNotes, updateDownloadActionLabel,
    handleInstallUpdateRequest, updateInstallActionLabel, aboutLoading, aboutDisplayVersion,
    aboutInfo, aboutUpdateStatus, updateChannel, changeUpdateChannel, isUpdateChannelLoading,
    isUpdateChannelSaving, updateDownloadProgress, utilityPanelStyle, utilityMutedTextStyle,
    darkMode, overlayTheme, installMode, openReleaseNotesModal, hasUnreadReleaseNotes,
    autoCheckForUpdates, setAutoCheckForUpdates, autoCheckForUpdatesIntervalMinutes,
    setAutoCheckForUpdatesIntervalMinutes, downloadSource, downloadSourceSaving,
    handleDownloadSourceChange,
  });

  const { renderThemeSettingsContent } = useAppThemeSettingsRender({
    t, themeSettingsSections, themeModalSection, setThemeModalSection, renderThemeSettingsSection,
    effectiveThemePreference, selectPresetTheme, renderThemeModePreview, renderThemeSettingsRow,
    effectiveUiScale, setUiScale, effectiveFontSize, setFontSize, effectiveSidebarRailScale,
    setAppearance, appearance, isFontFamiliesLoading, uiFontOptions, filterFontOption,
    renderFontOptionLabel, fontFamiliesLoadError, installedFontFamilies, linuxCJKFontInstallHint,
    hasLoadedInstalledFontsRef, darkMode, monoFontOptions, newQuerySqlTemplate,
    tabDisplaySettingsPanelRef, tabDisplaySettings, setTabDisplayLayout,
    effectiveTabEnvironmentAccentThickness, tabDisplayElementOrder, visibleTabDisplayElementKeys,
    focusedTabDisplayElementKey, setFocusedTabDisplayElementKey, v2AntPrimaryColor, overlayTheme,
    utilityMutedTextStyle, v2AntPrimaryBgColor, resolvedMonoFontFamily,
    updateTabDisplayElementVisibility, getTabDisplayElementLabel, getTabDisplayElementDescription,
    setTabDisplayElementRow, moveTabDisplayElement, tableDoubleClickAction,
    queryTableCtrlClickAction, sqlEditorFontSizeFollowsGlobal, effectiveSqlEditorFontSize,
    dataTableFontSizeFollowsGlobal, effectiveDataTableFontSize, sidebarTreeFontSizeFollowsGlobal,
    effectiveSidebarTreeFontSize, startupMaximised, setStartupMaximised,
  });

  const {
    settingsCenterGroups, activeSettingsCenterDetailPanelStyle, settingsCenterDetailBodyStyle,
    renderSettingsCenterPane, sidebarPanelCollapseLabel, sidebarPanelExpandLabel,
    handleAppContextMenu, handleNativeMenuCheckUpdate, titleBarSystemActionsNode, titleBarActionRow,
    dockedSidebarActionsHost,
  } = useAppSettingsCenterRender({
    t, handleOpenSettingsCenterPane, setThemeModalSection, themeSettingsSections, isWebRuntime,
    setSecurityUpdateRepairSource, setFocusedAIProviderId, focusedAIProviderId,
    setAiSettingsSection, setAiSettingsProviderView, activeSettingsCenterPane,
    toolCenterDetailPanelStyle, toolCenterDetailBodyStyle, utilityPanelStyle, overlayTheme,
    utilityMutedTextStyle, renderThemeSettingsContent, renderSidebarMetadataSettingsPane,
    renderSidebarObjectVisibilitySettingsPane, renderProxySettingsContent,
    renderDownloadSourceSettingsContent, darkMode, aiSettingsRenderNonce, handleAIPanelRenderError,
    handleRetryAISettingsRender, LazyAISettingsContent, isSettingsModalOpen, aiSettingsSection,
    aiSettingsProviderView, handleCancelSettingsCenterPane, handlePrepareExternalMCPUse,
    registerAISettingsLeaveGuard, applicationQuitModalZIndex, renderSettingsCenterAboutPane,
    isSidebarCollapsed, selectPresetTheme, themeMode, checkForUpdates, useNativeMacWindowControls,
    language, handleOpenSettingsModal, handleTitleBarSettingsNavigation, titleBarActionsInline,
    appearance, primaryActionIsMessageQueue, titleBarNewQueryShortcut,
    titleBarNewConnectionShortcut, handleNewQuery, handleCreateConnection,
    setIsConnectionGroupManagementOpen, aiPanelVisible, handleToggleOrFocusAIPanel,
    shouldDockCollapsedSidebarActionsInTitlebar, setCollapsedSidebarActionsTarget,
    handleExpandSidebarPanel, handleCollapseSidebarPanel, sidebarCollapsedToggleRef, brandIconId,
    handleBrandIconChange,
  });

  return (
    <ConfigProvider
        locale={getAntdLocale(language)}
        componentSize={appComponentSize}
        theme={antdTheme}
    >
        {notificationContextHolder}
        <CustomThemeStyleHost
            contextKey={customThemeStyleContextKey}
            onAntTokensChange={setComputedCustomThemeAntTokens}
        />
        <ToolbarAppearanceStyleHost />
        <Layout
          className="gn-v2-app-root"
          onContextMenu={handleAppContextMenu}
          data-gonavi-close-shortcut-scope="workspace"
          data-empty-workbench={tabs.length === 0 ? 'true' : 'false'}
          data-security-update-banner-visible={isSecurityUpdateBannerVisible ? 'true' : 'false'}
          style={{
            height: '100vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            background: 'transparent',
            borderRadius: showLinuxResizeHandles ? 0 : 'var(--gonavi-border-radius)',
            clipPath: showLinuxResizeHandles ? 'none' : 'inset(0 round var(--gonavi-border-radius))',
            backdropFilter: blurFilter,
            WebkitBackdropFilter: blurFilter,
          }}
        >
          <input
            ref={browserConnectionImportInputRef}
            type="file"
            accept=".gonavi-conn,.json,.xml,.ncx,.xlsx"
            style={{ display: 'none' }}
            onChange={(event) => { void handleBrowserConnectionImportFileChange(event); }}
          />
          {/* Custom Title Bar */}
          <AppTitleBar
            useNativeMacWindowControls={useNativeMacWindowControls}
            dockActionsInTitlebarBand={dockActionsInTitlebarBand}
            handleTitleBarDoubleClick={handleTitleBarDoubleClick} titleBarHeight={titleBarHeight}
            isWebRuntime={isWebRuntime} titleBarLayout={titleBarLayout}
            titleBarButtonWidth={titleBarButtonWidth} effectiveUiScale={effectiveUiScale}
            tokenFontSize={tokenFontSize} titleBarActionsInline={titleBarActionsInline}
            titleBarActionRow={titleBarActionRow}
            dockedSidebarActionsHost={dockedSidebarActionsHost}
            titleBarSystemActionsNode={titleBarSystemActionsNode}
            handleWebLogout={handleWebLogout} titleBarToggleIconKey={titleBarToggleIconKey}
            handleTitleBarWindowToggle={handleTitleBarWindowToggle}
            handleApplicationQuitRequest={handleApplicationQuitRequest}
          />

          {!titleBarActionsInline && titleBarActionRow}{/* 工具条不套 mac 红绿灯留白 */}
          {!titleBarActionsInline && dockedSidebarActionsHost}

          {showLinuxCJKFontBanner && (
              <LinuxCJKFontBanner
                darkMode={darkMode}
                installHint={linuxCJKFontInstallHint || ''}
                onOpenFontSettings={() => {
                        setThemeModalSection('appearance');
                        setIsThemeModalOpen(true);
                }}
                onDismiss={() => setIsLinuxCJKFontBannerDismissed(true)}
              />
          )}

          <Layout style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          <AppSider
            siderRef={siderRef} sidebarWidth={sidebarWidth}
            isSidebarCollapsed={isSidebarCollapsed} sidebarCollapsedWidth={sidebarCollapsedWidth}
            isCollapsedSidebarActionsDocked={isCollapsedSidebarActionsDocked}
            sidebarResizeHit={sidebarResizeHit} sidebarContentRef={sidebarContentRef}
            connectionWorkbenchState={connectionWorkbenchState}
            handleCreateConnection={handleCreateConnection}
            handleCreateConnectionInGroup={handleCreateConnectionInGroup}
            handleEditConnection={handleEditConnection}
            handleOpenSettingsModal={handleOpenSettingsModal}
            handleTitleBarSettingsNavigation={handleTitleBarSettingsNavigation}
            activeSettingsCenterPane={activeSettingsCenterPane}
            useNativeMacWindowControls={useNativeMacWindowControls}
            handleNativeMenuCheckUpdate={handleNativeMenuCheckUpdate} isWebRuntime={isWebRuntime}
            handleOpenDataSyncWorkbench={handleOpenDataSyncWorkbench}
            handleToggleOrFocusAIPanel={handleToggleOrFocusAIPanel}
            handleToggleLogPanel={handleToggleLogPanel} v2ExplorerContext={v2ExplorerContext}
            collapsedSidebarActionsTarget={collapsedSidebarActionsTarget}
            handleFocusSidebarSearch={handleFocusSidebarSearch}
            handleCollapseSidebarPanel={handleCollapseSidebarPanel}
            handleExpandSidebarPanel={handleExpandSidebarPanel}
            handleEnsureSidebarExpanded={handleEnsureSidebarExpanded}
            setSidebarTitlebarSnapshot={setSidebarTitlebarSnapshot}
            sidebarPanelCollapseLabel={sidebarPanelCollapseLabel}
            sidebarExplorerToggleRef={sidebarExplorerToggleRef}
            sidebarPanelExpandLabel={sidebarPanelExpandLabel}
            sidebarCollapsedToggleRef={sidebarCollapsedToggleRef} darkMode={darkMode}
            handleSidebarMouseDown={handleSidebarMouseDown} t={t}
          />
           <AppContent
             isSecurityUpdateBannerVisible={isSecurityUpdateBannerVisible}
             securityUpdateStatus={securityUpdateStatus} darkMode={darkMode}
             overlayTheme={overlayTheme} effectiveOpacity={effectiveOpacity}
             handleStartSecurityUpdate={handleStartSecurityUpdate}
             handleRetrySecurityUpdate={handleRetrySecurityUpdate}
             handleRestartSecurityUpdate={handleRestartSecurityUpdate}
             handleOpenSecurityUpdateSettings={handleOpenSecurityUpdateSettings}
             setIsSecurityUpdateBannerDismissed={setIsSecurityUpdateBannerDismissed}
             isLogPanelOpen={isLogPanelOpen} handleFocusSidebarSearch={handleFocusSidebarSearch}
             handleOpenAISettings={handleOpenAISettings}
             handleToggleOrFocusAIPanel={handleToggleOrFocusAIPanel}
             aiPanelVisible={aiPanelVisible} aiChatDetached={aiChatDetached}
             aiPanelOverlayActive={aiPanelOverlayActive}
             aiPanelFullscreenOverlay={aiPanelFullscreenOverlay} titleBarHeight={titleBarHeight}
             t={t} handleCloseAIPanel={handleCloseAIPanel}
             aiPanelRenderNonce={aiPanelRenderNonce}
             handleAIPanelRenderError={handleAIPanelRenderError}
             aiPanelRenderWidth={aiPanelRenderWidth} bgContent={bgContent}
             handleRetryAIPanelRender={handleRetryAIPanelRender} LazyAIChatPanel={LazyAIChatPanel}
             setAIPanelWidth={setAIPanelWidth} handleDetachAIPanel={handleDetachAIPanel}
             registerAIPanelTerminalGuard={registerAIPanelTerminalGuard}
           />
          </Layout>
          {isConnectionModalMounted && (
          <ConnectionModal
            open={isModalOpen}
            onClose={handleCloseModal}
            initialValues={editingConnection}
            modalZIndex={isConnectionGroupManagementOpen ? APP_NESTED_MODAL_Z_INDEX : undefined}
            onOpenDriverManager={handleOpenDriverManagerFromConnection}
            onSaved={handleConnectionSaved}
            onOpenConnectionHealth={(connection) => {
              handleCloseModal();
              handleOpenConnectionHealth([connection.id]);
            }}
          />
          )}
          {isSettingsModalOpen && renderAppSettingsCenterModal({
            t, handleOpenToolCenterPane, handleExportConnections, handleOpenConnectionHealth,
            securityUpdateEntryVisibility, securityUpdateHasLegacySensitiveItems,
            securityUpdateStatusMeta, handleOpenDataSyncWorkbench, handleCancelSettingsCenterPane,
            addTab, settingsCenterGroups, activeSettingsCenterGroupKey, activeSettingsCenterPane,
            themeModalSection, aiSettingsSection, aiSettingsProviderView, handleOpenToolsModal,
            handleOpenSettingsModal, connectionImportGroupOptions, connectionImportTargetTagId,
            connectionPackageDialog, pendingConnectionImportPayload, connectionImportNotice,
            setConnectionImportTargetTagId, setConnectionImportNotice, setConnectionPackageDialog,
            handleImportConnections, handleConfirmConnectionPackageDialog,
            setPendingConnectionImportPayload, utilityPanelStyle, utilityMutedTextStyle,
            connections, closeConnectionPackageDialog, connectionHealthTargetIds,
            closeConnectionHealthSettingsPane, isWebRuntime, renderDataDirectorySettings,
            darkMode, overlayTheme, effectiveOpacity, securityUpdateStatus,
            securityUpdateSettingsFocusTarget, securityUpdateSettingsFocusRequest,
            handleStartSecurityUpdate, handleRetrySecurityUpdate, handleRestartSecurityUpdate,
            handleSecurityUpdateIssueAction, handleOpenSettingsCenterPane,
            handleDownloadSourceChange, downloadSourceSaving, downloadSource,
            setCapturingShortcutAction, resetShortcutOptions, isMacRuntime, shortcutOptions,
            activeShortcutPlatform, capturingShortcutAction, shortcutConflictMap,
            resolvedMonoFontFamily, updateShortcut, toolCenterModalWorkspaceStyle,
            toolCenterModalSplitStyle, toolCenterNavPanelStyle, toolCenterContentPanelStyle,
            activeSettingsCenterDetailPanelStyle, toolCenterDetailBodyStyle,
            settingsCenterDetailBodyStyle, renderSettingsCenterPane,
            renderSettingsCenterAboutFooter,
          })}
          <AppGlobalDialogs
            isDataRootModalOpen={isDataRootModalOpen}
            renderUtilityModalTitle={renderUtilityModalTitle} t={t}
            setIsDataRootModalOpen={setIsDataRootModalOpen}
            setToolCenterBackGroupKey={setToolCenterBackGroupKey}
            toolCenterBackGroupKey={toolCenterBackGroupKey}
            handleReturnToToolCenter={handleReturnToToolCenter}
            utilityModalShellStyle={utilityModalShellStyle}
            renderDataDirectorySettings={renderDataDirectorySettings}
            isSecurityUpdateIntroOpen={isSecurityUpdateIntroOpen}
            isSecurityUpdateProgressOpen={isSecurityUpdateProgressOpen} darkMode={darkMode}
            overlayTheme={overlayTheme} effectiveOpacity={effectiveOpacity}
            handleStartSecurityUpdate={handleStartSecurityUpdate}
            handlePostponeSecurityUpdate={handlePostponeSecurityUpdate}
            handleOpenSecurityUpdateSettings={handleOpenSecurityUpdateSettings}
            settingsChildModalZIndex={settingsChildModalZIndex}
            securityUpdateProgressStage={securityUpdateProgressStage}
            connectionPackageDialog={connectionPackageDialog}
            isSettingsModalOpen={isSettingsModalOpen}
            activeSettingsCenterPane={activeSettingsCenterPane} connections={connections}
            setConnectionPackageDialog={setConnectionPackageDialog}
            closeConnectionPackageDialog={closeConnectionPackageDialog}
            handleConfirmConnectionPackageDialog={handleConfirmConnectionPackageDialog}
            releaseNotesModalVisible={releaseNotesModalVisible}
            closeReleaseNotesModal={closeReleaseNotesModal}
            handleReleaseNotesModalOpen={handleReleaseNotesModalOpen}
            lastUpdateInfo={lastUpdateInfo} updateDownloadProgress={updateDownloadProgress}
            aboutInfo={aboutInfo} formatBytes={formatBytes}
            updateInstallAction={updateInstallAction}
            markUpdateProgressDismissed={markUpdateProgressDismissed}
            isLatestUpdateDownloaded={isLatestUpdateDownloaded}
            handleDownloadUpdateWithNotes={handleDownloadUpdateWithNotes}
            updateDownloadActionLabel={updateDownloadActionLabel}
            openDownloadedUpdateDirectory={openDownloadedUpdateDirectory}
            handleInstallUpdateRequest={handleInstallUpdateRequest}
            updateInstallActionLabel={updateInstallActionLabel}
            isThemeModalOpen={isThemeModalOpen} themeModalSection={themeModalSection}
            setIsThemeModalOpen={setIsThemeModalOpen}
            renderThemeSettingsContent={renderThemeSettingsContent}
            isProxyModalOpen={isProxyModalOpen}
            handleCloseGlobalProxySettings={handleCloseGlobalProxySettings}
            renderProxySettingsContent={renderProxySettingsContent}
          />

          {showLinuxResizeHandles && (
              <>
                  {/* Linux Mint 下 frameless 仅局部可缩放：补四边四角命中层 */}
                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 14, bottom: 14, left: 0, width: 6, cursor: 'ew-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 14, bottom: 14, right: 0, width: 6, cursor: 'ew-resize' }} />

                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
              </>
          )}

          <ConnectionGroupManagementModal
            open={isConnectionGroupManagementOpen}
            onClose={() => setIsConnectionGroupManagementOpen(false)}
            onOpenTagForm={(parentTagId) => window.dispatchEvent(new CustomEvent('gonavi:open-connection-tag-form', { detail: { parentTagId } }))}
            onCreateConnectionInGroup={handleCreateConnectionInGroup}
            onEditConnection={handleEditConnection}
            onCloseTabsByConnection={closeTabsByConnection}
            onConnectionGroupDeleted={async () => {
              await connectionSidebarLayoutCoordinatorRef.current?.refresh().catch(() => undefined);
            }}
          />

          {/* Ghost Resize Line for Log Panel */}
          <div
              ref={logGhostRef}
              style={{
                  position: 'fixed',
                  left: renderedSidebarWidth, // Start from the rendered sidebar edge
                  right: 0,
                  height: '4px',
                  background: resizeGuideColor,
                  zIndex: 9999,
                  pointerEvents: 'none',
                  display: 'none',
                  cursor: 'row-resize'
              }}
          />
        </Layout>
    </ConfigProvider>
  );
}

export default App;
