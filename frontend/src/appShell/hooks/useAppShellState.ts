import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { message } from 'antd';
import {
  resolveUIFontFamily,
  resolveMonoFontFamily,
  type InstalledFontFamily,
  buildFontFamilyOptions,
  getLinuxCJKFontInstallHint,
} from '../../utils/fontFamilies';
import {
  resolveAppearanceValues,
  normalizeOpacityForPlatform,
  normalizeBlurForPlatform,
  blurToFilter,
} from '../../utils/appearance';
import { EMPTY_INSTALLED_FONT_FAMILIES } from '../appSettingsConstants';
import { useStore } from '../../store';
import type { DownloadSourceId } from '../../utils/driverManagerTab';
import type { ConnectionSidebarLayoutCoordinator } from '../../utils/connectionSidebarLayoutCoordinator';
import { SecurityUpdateStatus } from '../../types';
import { createEmptySecurityUpdateStatus, detectNavigatorPlatform } from '../appEnvironment';
import type {
  SecurityUpdateSettingsFocusTarget,
  SecurityUpdateRepairSource,
} from '../../utils/securityUpdateRepairFlow';
import {
  SETTINGS_CENTER_WORKBENCH_TAB_ID,
  buildSettingsCenterWorkbenchTab,
} from '../../utils/settingsCenterTab';
import type {
  SettingsCenterGroupKey,
  SettingsCenterPaneState,
  ToolCenterGroupKey,
} from '../settingsCenterPanes';
import type { AISettingsLeaveGuard } from '../../utils/aiSettingsLeaveGuard';
import type { TabDisplayElementKey } from '../../utils/tabDisplay';
import type { AISettingsSectionKey } from '../../components/ai/AISettingsSidebar';
import {
  type ConnectionPackageDialogState,
  createClosedConnectionPackageDialogState,
} from '../connectionPackageImport';
import type { ConnectionImportNotice } from '../../components/settings/ConnectionImportSettingsPanel';
import { createLazyAIChatPanel, createLazyAISettingsContent } from '../appLayoutParts';
import {
  resolveDocumentPlatform,
  resolveTitlebarRuntimePlatform,
  shouldDockCollapsedSidebarActionsInTitlebar as resolveCollapsedSidebarDocking,
  resolveTitleBarLayout,
} from '../../utils/titlebarLayout';
import { useAppSidebarCollapse } from '../../hooks/useAppSidebarCollapse';
import {
  APP_FOREGROUND_MODAL_Z_INDEX,
  APP_NESTED_MODAL_Z_INDEX,
  APP_APPLICATION_QUIT_MODAL_Z_INDEX,
} from '../../utils/overlayZIndex';
import {
  hasNativeDetachedWindowManager,
  toggleOrFocusNativeAIChatFromMainWindow,
  openNativeAIChatWindow,
} from '../../utils/nativeDetachedWindowHost';
import { getConnectionWorkbenchState } from '../../utils/startupReadiness';
import {
  getSecurityUpdateStatusMeta,
  resolveSecurityUpdateEntryVisibility,
} from '../../utils/securityUpdatePresentation';
import type { AppCoreStateApi } from './useAppCoreState';

export interface UseAppShellStateInput {
  appearance: AppCoreStateApi['appearance'];
  effectiveUiScale: AppCoreStateApi['effectiveUiScale'];
  runtimeBuildType: AppCoreStateApi['runtimeBuildType'];
  runtimePlatform: AppCoreStateApi['runtimePlatform'];
  t: AppCoreStateApi['t'];
  effectiveSidebarRailScale: AppCoreStateApi['effectiveSidebarRailScale'];
}

export const useAppShellState = ({
  appearance, effectiveUiScale, runtimeBuildType, runtimePlatform, t, effectiveSidebarRailScale,
}: UseAppShellStateInput) => {
  const resolvedUiFontFamily = resolveUIFontFamily(appearance.customUIFontFamily);
  const resolvedMonoFontFamily = resolveMonoFontFamily(appearance.customMonoFontFamily);
  const appComponentSize: 'small' | 'middle' | 'large' = effectiveUiScale <= 0.92 ? 'small' : (effectiveUiScale >= 1.12 ? 'large' : 'middle');
  const titleBarButtonWidth = Math.max(40, Math.round(46 * effectiveUiScale));
  const floatingLogButtonHeight = Math.max(30, Math.round(34 * effectiveUiScale));
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const effectiveOpacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const effectiveBlur = normalizeBlurForPlatform(resolvedAppearance.blur);
  const blurFilter = blurToFilter(effectiveBlur);
  const isWebRuntime = runtimeBuildType === 'web'
    || (typeof window !== 'undefined' && (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web');
  const [installedFontFamilies, setInstalledFontFamilies] = useState<InstalledFontFamily[]>(EMPTY_INSTALLED_FONT_FAMILIES);
  const [isFontFamiliesLoading, setIsFontFamiliesLoading] = useState(false);
  const [fontFamiliesLoadError, setFontFamiliesLoadError] = useState<string | null>(null);
  const hasLoadedInstalledFontsRef = useRef(false);
  const uiFontOptions = useMemo(
      () => buildFontFamilyOptions(runtimePlatform, 'ui', installedFontFamilies, t),
      [installedFontFamilies, runtimePlatform, t],
  );
  const monoFontOptions = useMemo(
      () => buildFontFamilyOptions(runtimePlatform, 'mono', installedFontFamilies, t),
      [installedFontFamilies, runtimePlatform, t],
  );
  const linuxCJKFontInstallHint = getLinuxCJKFontInstallHint(runtimePlatform, installedFontFamilies);
  const [isStoreHydrated, setIsStoreHydrated] = useState(() => useStore.persist.hasHydrated());
  const closeTabsByConnection = useStore(state => state.closeTabsByConnection);
  const savedQueriesBootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const savedQueriesLoadedRef = useRef(false);
  const [hasLoadedSecureConfig, setHasLoadedSecureConfig] = useState(false);
  const [downloadSource, setDownloadSource] = useState<DownloadSourceId>('cst');
  const [downloadSourceSaving, setDownloadSourceSaving] = useState(false);
  const [hasLoadedConnectionSidebarLayout, setHasLoadedConnectionSidebarLayout] = useState(false);
  const connectionSidebarLayoutCoordinatorRef = useRef<ConnectionSidebarLayoutCoordinator | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth || 1280));
  const [securityUpdateStatus, setSecurityUpdateStatus] = useState<SecurityUpdateStatus>(() => createEmptySecurityUpdateStatus());
  const [securityUpdateRawPayload, setSecurityUpdateRawPayload] = useState<string | null>(null);
  const [securityUpdateHasLegacySensitiveItems, setSecurityUpdateHasLegacySensitiveItems] = useState(false);
  const [isSecurityUpdateIntroOpen, setIsSecurityUpdateIntroOpen] = useState(false);
  const [isSecurityUpdateBannerDismissed, setIsSecurityUpdateBannerDismissed] = useState(false);
  const [securityUpdateSettingsFocusTarget, setSecurityUpdateSettingsFocusTarget] = useState<SecurityUpdateSettingsFocusTarget | null>(null);
  const [securityUpdateSettingsFocusRequest, setSecurityUpdateSettingsFocusRequest] = useState(0);
  const [isSecurityUpdateProgressOpen, setIsSecurityUpdateProgressOpen] = useState(false);
  const [securityUpdateProgressStage, setSecurityUpdateProgressStage] = useState(() => t('app.security_update.stage.checking_saved_config'));
  const [securityUpdateRepairSource, setSecurityUpdateRepairSource] = useState<SecurityUpdateRepairSource | null>(null);
  const isSettingsModalOpen = useStore((state) => state.tabs.some((tab) => tab.id === SETTINGS_CENTER_WORKBENCH_TAB_ID));
  const openSettingsCenterWorkbenchTab = useCallback(() => {
      useStore.getState().addTab(buildSettingsCenterWorkbenchTab());
  }, []);
  const closeSettingsCenterWorkbenchTab = useCallback(() => {
      const { tabs, closeTab } = useStore.getState();
      if (tabs.some((tab) => tab.id === SETTINGS_CENTER_WORKBENCH_TAB_ID)) {
          closeTab(SETTINGS_CENTER_WORKBENCH_TAB_ID);
      }
  }, []);
  const [isConnectionGroupManagementOpen, setIsConnectionGroupManagementOpen] = useState(false);
  const [activeSettingsCenterGroupKey, setActiveSettingsCenterGroupKey] = useState<SettingsCenterGroupKey>('preferences');
  const [activeSettingsCenterPane, setActiveSettingsCenterPane] = useState<SettingsCenterPaneState | null>(null);
  const activeSettingsCenterPaneRef = useRef<SettingsCenterPaneState | null>(null);
  const aiSettingsLeaveGuardRef = useRef<AISettingsLeaveGuard | null>(null);
  const registerAISettingsLeaveGuard = useCallback((guard: AISettingsLeaveGuard | null) => {
      aiSettingsLeaveGuardRef.current = guard;
  }, []);
  activeSettingsCenterPaneRef.current = activeSettingsCenterPane;
  const [focusedTabDisplayElementKey, setFocusedTabDisplayElementKey] = useState<TabDisplayElementKey | null>(null);
  const [focusedAIProviderId, setFocusedAIProviderId] = useState<string | undefined>(undefined);
  const [aiSettingsSection, setAiSettingsSection] = useState<AISettingsSectionKey>('providers');
  const [aiSettingsProviderView, setAiSettingsProviderView] = useState<'workspace' | 'connected'>('workspace');
  const [connectionPackageDialog, setConnectionPackageDialog] = useState<ConnectionPackageDialogState>(() => createClosedConnectionPackageDialogState());
  const [pendingConnectionImportPayload, setPendingConnectionImportPayload] = useState<string | null>(null);
  const [connectionImportTargetTagId, setConnectionImportTargetTagId] = useState('');
  const [connectionImportNotice, setConnectionImportNotice] = useState<ConnectionImportNotice | null>(null);
  const browserConnectionImportInputRef = useRef<HTMLInputElement>(null);
  const browserConnectionImportSourceGroupRef = useRef<ToolCenterGroupKey | undefined>(undefined);
  const [aiPanelRenderNonce, setAiPanelRenderNonce] = useState(0);
  const [aiSettingsRenderNonce, setAiSettingsRenderNonce] = useState(0);
  const LazyAIChatPanel = useMemo(createLazyAIChatPanel, [aiPanelRenderNonce]);
  const LazyAISettingsContent = useMemo(createLazyAISettingsContent, [aiSettingsRenderNonce]);
  const sidebarWidth = useStore(state => state.sidebarWidth);
  const setSidebarWidth = useStore(state => state.setSidebarWidth);
  const navigatorPlatform = detectNavigatorPlatform();
  const documentPlatform = resolveDocumentPlatform(runtimePlatform, navigatorPlatform);
  const titlebarRuntimePlatform = resolveTitlebarRuntimePlatform(runtimePlatform, navigatorPlatform);
  const isMacRuntime = titlebarRuntimePlatform === 'darwin';
  const shouldDockCollapsedSidebarActionsInTitlebar = resolveCollapsedSidebarDocking(
      runtimePlatform,
      navigatorPlatform,
      isWebRuntime,
      appearance.sidebarActionsPlacement === 'rail',
  );
  const {
      collapsedSidebarActionsTarget,
      handleCollapseSidebarPanel,
      handleEnsureSidebarExpanded,
      handleExpandSidebarPanel,
      isCollapsedSidebarActionsDocked,
      isSidebarCollapsed,
      setCollapsedSidebarActionsTarget,
      setIsSidebarCollapsed,
      sidebarCollapsedToggleRef,
      sidebarContentRef,
      sidebarExplorerToggleRef,
  } = useAppSidebarCollapse(shouldDockCollapsedSidebarActionsInTitlebar);
  const titleBarActionsInline = appearance.titlebarActionsPlacement === 'titlebar'; // 功能入口行：默认工具条，可切到 GoNavi 右侧
  // 内联形态下工具条常驻标题栏第二行；独立工具条形态下改放在工具条下方，标题栏不再预留第二行。
  const dockActionsInTitlebarBand = shouldDockCollapsedSidebarActionsInTitlebar && titleBarActionsInline;
  const titleBarLayout = resolveTitleBarLayout(
      effectiveUiScale,
      dockActionsInTitlebarBand,
      effectiveSidebarRailScale,
  );
  const titleBarHeight = titleBarLayout.height;
  const sidebarCollapsedWidth = !shouldDockCollapsedSidebarActionsInTitlebar
      ? 38 * effectiveUiScale * effectiveSidebarRailScale
      : 0;
  const renderedSidebarWidth = isSidebarCollapsed ? sidebarCollapsedWidth : sidebarWidth;
  const aiPanelVisible = useStore(state => state.aiPanelVisible);
  const aiPanelWidth = useStore(state => state.aiPanelWidth);
  const setAIPanelWidth = useStore(state => state.setAIPanelWidth);
  const detachedAIChatWindow = useStore(state => state.detachedAIChatWindow);
  const detachAIChatPanel = useStore(state => state.detachAIChatPanel);
  const aiChatDetached = Boolean(detachedAIChatWindow);
  const detachedAIChatZIndex = Number(detachedAIChatWindow?.zIndex);
  const settingsCenterModalZIndex = Math.max(
    APP_FOREGROUND_MODAL_Z_INDEX,
    Number.isFinite(detachedAIChatZIndex) ? detachedAIChatZIndex + 1 : APP_FOREGROUND_MODAL_Z_INDEX,
  );
  const settingsChildModalZIndex = Math.max(
    APP_NESTED_MODAL_Z_INDEX,
    settingsCenterModalZIndex + 100,
  );
  const applicationQuitModalZIndex = Math.max(
    APP_APPLICATION_QUIT_MODAL_Z_INDEX,
    settingsChildModalZIndex + 100,
  );
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const aiPanelTerminalGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const aiPanelTerminalActionPendingRef = useRef(false);
  const registerAIPanelTerminalGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    aiPanelTerminalGuardRef.current = guard;
  }, []);
  const runAIPanelTerminalAction = useCallback((action: () => void) => {
    if (aiPanelTerminalActionPendingRef.current) return;
    aiPanelTerminalActionPendingRef.current = true;
    void (async () => {
      try {
        const canTerminate = await aiPanelTerminalGuardRef.current?.();
        if (canTerminate === false) return;
        action();
      } catch (error) {
        console.warn('Failed to stop AI activity before changing the panel state', error);
      } finally {
        aiPanelTerminalActionPendingRef.current = false;
      }
    })();
  }, []);
  const handleCloseAIPanel = useCallback(() => {
    runAIPanelTerminalAction(() => setAIPanelVisible(false));
  }, [runAIPanelTerminalAction, setAIPanelVisible]);
  const handleDetachAIPanel = useCallback(() => {
    runAIPanelTerminalAction(() => detachAIChatPanel());
  }, [detachAIChatPanel, runAIPanelTerminalAction]);
  const handleToggleOrFocusAIPanel = useCallback(() => {
    if (aiPanelVisible && (!aiChatDetached || !hasNativeDetachedWindowManager())) {
      handleCloseAIPanel();
      return;
    }
    void toggleOrFocusNativeAIChatFromMainWindow().catch((error) => {
      void message.error(error instanceof Error ? error.message : String(error));
    });
  }, [aiChatDetached, aiPanelVisible, handleCloseAIPanel]);
  useEffect(() => {
    if (!aiPanelVisible || !detachedAIChatWindow || !hasNativeDetachedWindowManager()) {
      return undefined;
    }
    let active = true;
    void openNativeAIChatWindow().catch((error) => {
      if (!active) return;
      useStore.getState().attachAIChatPanel();
      void message.error(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
    };
  }, [aiPanelVisible, aiChatDetached]);
  const windowDiagSequenceRef = React.useRef(0);
  const windowDiagLastSignatureRef = React.useRef('');
  const windowDiagLastAtRef = React.useRef(0);
  const captureMainWindowStateRef = React.useRef<() => Promise<void>>(async () => undefined);
  const connectionWorkbenchState = getConnectionWorkbenchState(
      isStoreHydrated,
      hasLoadedSecureConfig,
      hasLoadedConnectionSidebarLayout,
  );
  const securityUpdateStatusMeta = useMemo(
      () => getSecurityUpdateStatusMeta(securityUpdateStatus, t),
      [securityUpdateStatus, t],
  );
  const securityUpdateEntryVisibility = useMemo(
      () => resolveSecurityUpdateEntryVisibility(securityUpdateStatus),
      [securityUpdateStatus],
  );
  const isSecurityUpdateBannerVisible = securityUpdateEntryVisibility.showBanner
      && !isSecurityUpdateBannerDismissed;

  const windowCornerRadius = 14;
  return {
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
  };
};

export type AppShellStateApi = ReturnType<typeof useAppShellState>;
