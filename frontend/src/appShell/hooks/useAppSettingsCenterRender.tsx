import {
  SettingOutlined,
  GlobalOutlined,
  SkinOutlined,
  TableOutlined,
  FolderOpenOutlined,
  CloudDownloadOutlined,
  SafetyCertificateOutlined,
  InfoCircleOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import React, { useCallback } from 'react';
import { Alert, Button, Spin } from 'antd';
import AiSparkOutlined from '../../components/icons/AiSparkOutlined';
import { AI_SETTINGS_NAV_ITEMS } from '../../components/ai/AISettingsSidebar';
import LanguageSettingsPanel from '../../components/LanguageSettingsPanel';
import WebAuthSettingsPanel from '../../components/WebAuthSettingsPanel';
import CloudBackupSettings from '../../components/CloudBackupSettings';
import BrandIconPicker from '../../components/BrandIconPicker';
import AIPanelErrorBoundary from '../../components/ai/AIPanelErrorBoundary';
import {
  isWailsDevNativeContextMenu,
  shouldAllowNativeContextMenu,
} from '../../utils/nativeContextMenu';
import { useNativeMenuUpdateCheck } from '../../hooks/useNativeMenuUpdateCheck';
import { useMacNativeMenuBridge } from '../../hooks/useMacNativeMenuBridge';
import TitleBarSystemActions from '../../components/TitleBarSystemActions';
import TitleBarActionRow from '../../components/titlebar/TitleBarActionRow';
import { DockedSidebarActionsHost } from '../../components/sidebar/SidebarExplorerToolbar';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppSettingsNavigationApi } from './useAppSettingsNavigation';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppAboutSettingsRenderApi } from './useAppAboutSettingsRender';
import type { AppShellStateApi } from './useAppShellState';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppThemeSettingsRenderApi } from './useAppThemeSettingsRender';
import type { AppSettingsPanesRenderApi } from './useAppSettingsPanesRender';
import type { AppWorkbenchActionsApi } from './useAppWorkbenchActions';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';
import type { SettingsCenterNavigationGroup } from '../settingsCenterNavigation';

export interface UseAppSettingsCenterRenderInput {
  t: AppCoreStateApi['t'];
  handleOpenSettingsCenterPane: AppSettingsNavigationApi['handleOpenSettingsCenterPane'];
  setThemeModalSection: AppProxySettingsApi['setThemeModalSection'];
  themeSettingsSections: AppAboutSettingsRenderApi['themeSettingsSections'];
  isWebRuntime: AppShellStateApi['isWebRuntime'];
  setSecurityUpdateRepairSource: AppShellStateApi['setSecurityUpdateRepairSource'];
  setFocusedAIProviderId: AppShellStateApi['setFocusedAIProviderId'];
  focusedAIProviderId: AppShellStateApi['focusedAIProviderId'];
  setAiSettingsSection: AppShellStateApi['setAiSettingsSection'];
  setAiSettingsProviderView: AppShellStateApi['setAiSettingsProviderView'];
  activeSettingsCenterPane: AppShellStateApi['activeSettingsCenterPane'];
  toolCenterDetailPanelStyle: AppSecurityUpdateApi['toolCenterDetailPanelStyle'];
  toolCenterDetailBodyStyle: AppSecurityUpdateApi['toolCenterDetailBodyStyle'];
  utilityPanelStyle: AppSecurityUpdateApi['utilityPanelStyle'];
  overlayTheme: AppSecurityUpdateApi['overlayTheme'];
  utilityMutedTextStyle: AppSecurityUpdateApi['utilityMutedTextStyle'];
  renderThemeSettingsContent: AppThemeSettingsRenderApi['renderThemeSettingsContent'];
  renderSidebarMetadataSettingsPane: AppSettingsPanesRenderApi['renderSidebarMetadataSettingsPane'];
  renderSidebarObjectVisibilitySettingsPane: AppSettingsPanesRenderApi['renderSidebarObjectVisibilitySettingsPane'];
  renderProxySettingsContent: AppSettingsPanesRenderApi['renderProxySettingsContent'];
  renderDownloadSourceSettingsContent: AppSettingsPanesRenderApi['renderDownloadSourceSettingsContent'];
  darkMode: AppCoreStateApi['darkMode'];
  aiSettingsRenderNonce: AppShellStateApi['aiSettingsRenderNonce'];
  handleAIPanelRenderError: AppWorkbenchActionsApi['handleAIPanelRenderError'];
  handleRetryAISettingsRender: AppWorkbenchActionsApi['handleRetryAISettingsRender'];
  LazyAISettingsContent: AppShellStateApi['LazyAISettingsContent'];
  isSettingsModalOpen: AppShellStateApi['isSettingsModalOpen'];
  aiSettingsSection: AppShellStateApi['aiSettingsSection'];
  aiSettingsProviderView: AppShellStateApi['aiSettingsProviderView'];
  handleCancelSettingsCenterPane: AppSettingsNavigationApi['handleCancelSettingsCenterPane'];
  handlePrepareExternalMCPUse: AppSecurityUpdateApi['handlePrepareExternalMCPUse'];
  registerAISettingsLeaveGuard: AppShellStateApi['registerAISettingsLeaveGuard'];
  applicationQuitModalZIndex: AppShellStateApi['applicationQuitModalZIndex'];
  renderSettingsCenterAboutPane: AppAboutSettingsRenderApi['renderSettingsCenterAboutPane'];
  isSidebarCollapsed: AppShellStateApi['isSidebarCollapsed'];
  selectPresetTheme: AppCoreStateApi['selectPresetTheme'];
  themeMode: AppCoreStateApi['themeMode'];
  checkForUpdates: AppUpdateAndDiagnosticsApi['checkForUpdates'];
  useNativeMacWindowControls: AppUpdateAndDiagnosticsApi['useNativeMacWindowControls'];
  language: AppCoreStateApi['language'];
  handleOpenSettingsModal: AppSettingsNavigationApi['handleOpenSettingsModal'];
  handleTitleBarSettingsNavigation: AppSettingsNavigationApi['handleTitleBarSettingsNavigation'];
  titleBarActionsInline: AppShellStateApi['titleBarActionsInline'];
  appearance: AppCoreStateApi['appearance'];
  primaryActionIsMessageQueue: AppSecurityUpdateApi['primaryActionIsMessageQueue'];
  titleBarNewQueryShortcut: AppUpdateAndDiagnosticsApi['titleBarNewQueryShortcut'];
  titleBarNewConnectionShortcut: AppUpdateAndDiagnosticsApi['titleBarNewConnectionShortcut'];
  handleNewQuery: AppUpdateAndDiagnosticsApi['handleNewQuery'];
  handleCreateConnection: AppWorkbenchActionsApi['handleCreateConnection'];
  setIsConnectionGroupManagementOpen: AppShellStateApi['setIsConnectionGroupManagementOpen'];
  aiPanelVisible: AppShellStateApi['aiPanelVisible'];
  handleToggleOrFocusAIPanel: AppShellStateApi['handleToggleOrFocusAIPanel'];
  shouldDockCollapsedSidebarActionsInTitlebar: AppShellStateApi['shouldDockCollapsedSidebarActionsInTitlebar'];
  setCollapsedSidebarActionsTarget: AppShellStateApi['setCollapsedSidebarActionsTarget'];
  handleExpandSidebarPanel: AppShellStateApi['handleExpandSidebarPanel'];
  handleCollapseSidebarPanel: AppShellStateApi['handleCollapseSidebarPanel'];
  sidebarCollapsedToggleRef: AppShellStateApi['sidebarCollapsedToggleRef'];
  brandIconId: AppCoreStateApi['brandIconId'];
  handleBrandIconChange: AppCoreStateApi['handleBrandIconChange'];
}

export const useAppSettingsCenterRender = ({
  t, handleOpenSettingsCenterPane, setThemeModalSection, themeSettingsSections, isWebRuntime,
  setSecurityUpdateRepairSource, setFocusedAIProviderId, focusedAIProviderId, setAiSettingsSection,
  setAiSettingsProviderView, activeSettingsCenterPane, toolCenterDetailPanelStyle,
  toolCenterDetailBodyStyle, utilityPanelStyle, overlayTheme, utilityMutedTextStyle,
  renderThemeSettingsContent, renderSidebarMetadataSettingsPane,
  renderSidebarObjectVisibilitySettingsPane, renderProxySettingsContent,
  renderDownloadSourceSettingsContent, darkMode, aiSettingsRenderNonce, handleAIPanelRenderError,
  handleRetryAISettingsRender, LazyAISettingsContent, isSettingsModalOpen, aiSettingsSection,
  aiSettingsProviderView, handleCancelSettingsCenterPane, handlePrepareExternalMCPUse,
  registerAISettingsLeaveGuard, applicationQuitModalZIndex, renderSettingsCenterAboutPane,
  isSidebarCollapsed, selectPresetTheme, themeMode, checkForUpdates, useNativeMacWindowControls,
  language, handleOpenSettingsModal, handleTitleBarSettingsNavigation, titleBarActionsInline,
  appearance, primaryActionIsMessageQueue, titleBarNewQueryShortcut, titleBarNewConnectionShortcut,
  handleNewQuery, handleCreateConnection, setIsConnectionGroupManagementOpen, aiPanelVisible,
  handleToggleOrFocusAIPanel, shouldDockCollapsedSidebarActionsInTitlebar,
  setCollapsedSidebarActionsTarget, handleExpandSidebarPanel, handleCollapseSidebarPanel,
  sidebarCollapsedToggleRef, brandIconId, handleBrandIconChange,
}: UseAppSettingsCenterRenderInput) => {
  const settingsCenterGroups: SettingsCenterNavigationGroup[] = [
      {
          key: 'preferences' as const,
          icon: <SettingOutlined />,
          title: t('app.settings.group.preferences.title'),
          description: t('app.settings.group.preferences.description'),
          items: [
              {
                  key: 'language',
                  icon: <GlobalOutlined />,
                  title: t('settings.language.title'),
                  description: t('settings.language.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'language'),
              },
              {
                  key: 'theme',
                  icon: <SkinOutlined />,
                  title: t('app.settings.entry.theme.title'),
                  description: t('app.settings.entry.theme.description'),
                  onClick: () => {
                      setThemeModalSection('theme');
                      handleOpenSettingsCenterPane('preferences', 'theme');
                  },
                  children: themeSettingsSections.map((section) => ({
                      key: `theme-${section.value}`,
                      icon: section.icon,
                      title: section.label,
                      description: section.value === 'appearance'
                          ? t('app.theme.nav.appearance.description')
                          : section.value === 'workspace'
                              ? t('app.theme.nav.workspace.description')
                              : t('app.theme.nav.theme.description'),
                      onClick: () => {
                          setThemeModalSection(section.value);
                          handleOpenSettingsCenterPane('preferences', 'theme');
                      },
                  })),
              },
              {
                  key: 'sidebar-metadata',
                  icon: <TableOutlined />,
                  title: t('app.settings.sidebar_metadata.title'),
                  description: t('app.settings.sidebar_metadata.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'sidebar-metadata'),
              },
              {
                  key: 'sidebar-objects',
                  icon: <FolderOpenOutlined />,
                  title: t('app.settings.sidebar_objects.title'),
                  description: t('app.settings.sidebar_objects.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'sidebar-objects'),
              },
              {
                  key: 'brand-icon',
                  icon: <AppstoreOutlined />,
                  title: t('app.settings.entry.brand_icon.title'),
                  description: t('app.settings.entry.brand_icon.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'brand-icon'),
              },
          ],
      },
      {
          key: 'services' as const,
          icon: <GlobalOutlined />,
          title: t('app.settings.group.services.title'),
          description: t('app.settings.group.services.description'),
          items: [
              {
                  key: 'proxy',
                  icon: <GlobalOutlined />,
                  title: t('app.settings.entry.proxy.title'),
                  description: t('app.settings.entry.proxy.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'proxy'),
              },
              {
                  key: 'download-source',
                  icon: <CloudDownloadOutlined />,
                  title: t('app.settings.entry.download_source.title'),
                  description: t('app.settings.entry.download_source.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'download-source'),
              },
              ...(isWebRuntime ? [{
                  key: 'web-auth' as const,
                  icon: <SafetyCertificateOutlined />,
                  title: t('app.settings.entry.web_auth.title'),
                  description: t('app.settings.entry.web_auth.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'web-auth'),
              }] : []),
              {
                  key: 'cloud-backup',
                  icon: <CloudDownloadOutlined />,
                  title: t('app.settings.entry.cloud_backup.title'),
                  description: t('app.settings.entry.cloud_backup.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'cloud-backup'),
              },
              {
                  key: 'ai',
                  icon: <AiSparkOutlined />,
                  title: t('app.settings.entry.ai.title'),
                  description: t('app.settings.entry.ai.description'),
                  onClick: () => {
                      setSecurityUpdateRepairSource(null);
                      setFocusedAIProviderId(undefined);
                      setAiSettingsSection('providers');
                      setAiSettingsProviderView('workspace');
                      handleOpenSettingsCenterPane('services', 'ai');
                  },
                  children: AI_SETTINGS_NAV_ITEMS.map((item) => ({
                      key: `ai-${item.key}`,
                      icon: item.icon,
                      title: t(item.titleKey),
                      description: t(item.descriptionKey),
                      onClick: () => {
                          setSecurityUpdateRepairSource(null);
                          setFocusedAIProviderId(item.key === 'providers' ? focusedAIProviderId : undefined);
                          setAiSettingsSection(item.key);
                          setAiSettingsProviderView('workspace');
                          handleOpenSettingsCenterPane('services', 'ai');
                      },
                      children: item.key === 'providers' ? [{
                          key: 'ai-providers-connected',
                          icon: item.icon,
                          title: t('ai_settings.provider.configured'),
                          description: t('ai_settings.provider.configured_hint'),
                          onClick: () => {
                              setSecurityUpdateRepairSource(null);
                              setAiSettingsSection('providers');
                              setAiSettingsProviderView('connected');
                              handleOpenSettingsCenterPane('services', 'ai');
                          },
                      }] : undefined,
                  })),
              },
          ],
      },
      {
          key: 'about' as const,
          icon: <InfoCircleOutlined />,
          title: t('app.settings.entry.about.title'),
          description: t('app.settings.entry.about.description'),
          items: [],
      },
  ];
  const isSettingsCenterContainedScrollPane =
      activeSettingsCenterPane?.key === 'theme' || activeSettingsCenterPane?.key === 'ai';
  const isV2ThemeSettingsPane = activeSettingsCenterPane?.key === 'theme';
  const activeSettingsCenterDetailPanelStyle: React.CSSProperties = {
      ...toolCenterDetailPanelStyle,
      padding: '0 4px 0 0',
      border: 'none',
      borderBottom: 'none',
      borderRadius: 0,
      background: 'transparent',
  };
  const settingsCenterDetailBodyStyle: React.CSSProperties = isSettingsCenterContainedScrollPane
      ? {
          ...toolCenterDetailBodyStyle,
          overflowY: 'hidden',
          // v2 主题设置页含 Slider 手柄横向伸出，hidden 会裁切贴边圆点
          overflowX: isV2ThemeSettingsPane ? 'visible' : 'hidden',
          // 右侧只留给内层滚动容器，避免 padding + 滚动条叠出大块空白
          paddingRight: 0,
          paddingLeft: isV2ThemeSettingsPane ? 4 : undefined,
      }
      : {
          ...toolCenterDetailBodyStyle,
          paddingRight: 0,
      };
  const renderSettingsCenterPane = () => {
      if (!activeSettingsCenterPane) {
          return null;
      }
      if (activeSettingsCenterPane.key === 'brand-icon') {
          return (
              <div style={{ padding: '16px 0 20px' }}>
                  <BrandIconPicker
                    value={brandIconId}
                    darkMode={darkMode}
                    accentColor={overlayTheme.selectedText}
                    ariaLabel={t('app.settings.entry.brand_icon.title')}
                    onChange={handleBrandIconChange}
                  />
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'language') {
          return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
                  <div style={utilityPanelStyle}>
                      <LanguageSettingsPanel />
                  </div>
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'theme') {
          return (
              <div style={{ height: '100%', minHeight: 0 }}>
                  {renderThemeSettingsContent({ hideSectionTabs: true })}
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'sidebar-metadata') {
          return renderSidebarMetadataSettingsPane();
      }
      if (activeSettingsCenterPane.key === 'sidebar-objects') {
          return renderSidebarObjectVisibilitySettingsPane();
      }
      if (activeSettingsCenterPane.key === 'proxy') {
          return renderProxySettingsContent();
      }
      if (activeSettingsCenterPane.key === 'download-source') {
          return renderDownloadSourceSettingsContent();
      }
      if (activeSettingsCenterPane.key === 'web-auth') {
          return (
              <WebAuthSettingsPanel
                darkMode={darkMode}
                dividerColor={overlayTheme.divider}
                mutedColor={String(utilityMutedTextStyle.color || overlayTheme.mutedText)}
                titleColor={overlayTheme.titleText}
              />
          );
      }
      if (activeSettingsCenterPane.key === 'cloud-backup') {
          return (
              <CloudBackupSettings t={t} />
          );
      }
      if (activeSettingsCenterPane.key === 'ai') {
          return (
              <div style={{ height: '100%', minHeight: 0 }}>
                  <AIPanelErrorBoundary
                    key={`ai-settings-${aiSettingsRenderNonce}`}
                    onError={handleAIPanelRenderError}
                    fallback={(error) => (
                      <Alert
                        type="error"
                        showIcon
                        message={t('app.ai_panel.error.title')}
                        description={error?.message || t('app.ai_panel.error.description')}
                        action={(
                          <Button size="small" onClick={handleRetryAISettingsRender}>
                            {t('app.ai_panel.action.reload')}
                          </Button>
                        )}
                      />
                    )}
                  >
                    <React.Suspense
                      fallback={(
                        <div style={{ height: '100%', display: 'grid', placeItems: 'center' }} aria-busy="true">
                          <Spin />
                        </div>
                      )}
                    >
                      <LazyAISettingsContent
                        active={isSettingsModalOpen && activeSettingsCenterPane.key === 'ai'}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        focusProviderId={focusedAIProviderId}
                        hideSidebar
                        section={aiSettingsSection}
                        onSectionChange={(section) => {
                            setAiSettingsSection(section);
                            setAiSettingsProviderView('workspace');
                        }}
                        providersView={aiSettingsSection === 'providers' ? aiSettingsProviderView : 'workspace'}
                        onProvidersViewChange={setAiSettingsProviderView}
                        onCloseHost={handleCancelSettingsCenterPane}
                        onBeforeExternalMCPUse={handlePrepareExternalMCPUse}
                        onLeaveGuardChange={registerAISettingsLeaveGuard}
                        confirmationZIndex={applicationQuitModalZIndex + 100}
                      />
                    </React.Suspense>
                  </AIPanelErrorBoundary>
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'about-go-navi') {
          return renderSettingsCenterAboutPane();
      }
      return null;
  };

  const sidebarPanelCollapseLabel = t('app.sidebar.collapse');
  const sidebarPanelExpandLabel = t('app.sidebar.expand');
  const sidebarPanelToggleLabel = isSidebarCollapsed ? sidebarPanelExpandLabel : sidebarPanelCollapseLabel;
  const allowDebugNativeContextMenu = isWailsDevNativeContextMenu(import.meta.env.DEV);
  const handleAppContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || shouldAllowNativeContextMenu(event.target, { allowDebugMenu: allowDebugNativeContextMenu })) return;
    event.preventDefault();
  }, [allowDebugNativeContextMenu]);

  const handleToggleThemeMode = () => selectPresetTheme(themeMode === 'dark' ? 'light' : 'dark');
  const handleNativeMenuCheckUpdate = useNativeMenuUpdateCheck(checkForUpdates, t);
  useMacNativeMenuBridge({ enabled: useNativeMacWindowControls && !isWebRuntime, language, themeMode, onOpenPreferences: handleOpenSettingsModal, onToggleTheme: handleToggleThemeMode, onOpenThemeSettings: () => handleTitleBarSettingsNavigation({ group: 'preferences', pane: 'theme' }), onOpenDrivers: () => handleTitleBarSettingsNavigation({ group: 'workspace', action: 'drivers' }), onCheckUpdate: handleNativeMenuCheckUpdate, onOpenAbout: () => handleTitleBarSettingsNavigation({ group: 'about', pane: 'about-go-navi' }) });
  // 驱动管理 / 关于的 portal 槽位：非 macOS 在标题栏胶囊中间，macOS 跟在功能入口行 AI 之后。
  const titleBarTrailingSlot = <div id="gonavi-titlebar-about-action" className="gonavi-titlebar-quick-actions-slot gn-v2-titlebar-about-slot" />;
  const titleBarSystemActionsNode = ( // 非 macOS 放右区；macOS 走原生菜单栏
    <TitleBarSystemActions
      settingsLabel={t('app.sidebar.settings')}
      onOpenSettings={handleOpenSettingsModal}
      trailingSlot={titleBarTrailingSlot}
      themeLabel={t('app.titlebar.theme')}
      isDarkTheme={themeMode === 'dark'}
      onToggleTheme={handleToggleThemeMode}
    />
  );
  const titleBarActionRow = (
    <TitleBarActionRow
      placement={titleBarActionsInline ? 'titlebar' : 'toolbar'} display={appearance.titlebarActionsDisplay}
      messageQueuePrimary={primaryActionIsMessageQueue}
      newQueryShortcut={titleBarNewQueryShortcut} newConnectionShortcut={titleBarNewConnectionShortcut}
      onNewQuery={handleNewQuery} onNewConnection={handleCreateConnection}
      onManageConnectionGroups={() => setIsConnectionGroupManagementOpen(true)}
      aiActive={aiPanelVisible} onToggleAI={handleToggleOrFocusAIPanel}
      trailingSlot={useNativeMacWindowControls ? titleBarTrailingSlot : undefined}
    />
  );

  const dockedSidebarActionsHost = shouldDockCollapsedSidebarActionsInTitlebar ? (
    <DockedSidebarActionsHost
      label={t('sidebar.rail.system_actions')}
      slotRef={setCollapsedSidebarActionsTarget}
      placement={titleBarActionsInline ? 'titlebar' : 'below-toolbar'}
      collapsed={isSidebarCollapsed}
      toggleLabel={sidebarPanelToggleLabel}
      onToggle={isSidebarCollapsed ? handleExpandSidebarPanel : handleCollapseSidebarPanel}
      toggleButtonRef={sidebarCollapsedToggleRef}
    />
  ) : null;
  return {
    settingsCenterGroups, activeSettingsCenterDetailPanelStyle, settingsCenterDetailBodyStyle,
    renderSettingsCenterPane, sidebarPanelCollapseLabel, sidebarPanelExpandLabel,
    handleAppContextMenu, handleNativeMenuCheckUpdate, titleBarSystemActionsNode, titleBarActionRow,
    dockedSidebarActionsHost,
  };
};

export type AppSettingsCenterRenderApi = ReturnType<typeof useAppSettingsCenterRender>;
