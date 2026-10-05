
import SettingsCenterTreeNav, { findSettingsCenterTreeItem } from '../../components/settings/SettingsCenterTreeNav';
import { isToolCenterGroupKey } from '../settingsCenterPanes';
import { SettingsCenterWorkbenchRegistrar } from '../../components/settings/SettingsCenterWorkbenchBridge';
import type { useAppCoreState } from '../hooks/useAppCoreState';
import type { useAppSettingsNavigation } from '../hooks/useAppSettingsNavigation';
import type { useAppConnectionImportExport } from '../hooks/useAppConnectionImportExport';
import type { useAppWorkbenchActions } from '../hooks/useAppWorkbenchActions';
import type { useAppShellState } from '../hooks/useAppShellState';
import type { useAppSecurityUpdate } from '../hooks/useAppSecurityUpdate';
import type { useAppSettingsCenterRender } from '../hooks/useAppSettingsCenterRender';
import type { useAppProxySettings } from '../hooks/useAppProxySettings';
import type { useAppQuitAndUpdate } from '../hooks/useAppQuitAndUpdate';
import type { useAppDirectorySettingsRender } from '../hooks/useAppDirectorySettingsRender';
import type { useAppBootstrapEffects } from '../hooks/useAppBootstrapEffects';
import type { useAppUpdateAndDiagnostics } from '../hooks/useAppUpdateAndDiagnostics';
import type { useAppAboutSettingsRender } from '../hooks/useAppAboutSettingsRender';
import { createToolCenterPaneRenderer } from './toolCenterPaneRenderer';
import { buildToolCenterGroups } from './toolCenterGroups';

export interface RenderAppSettingsCenterModalInput {
  t: ReturnType<typeof useAppCoreState>['t'];
  handleOpenToolCenterPane: ReturnType<typeof useAppSettingsNavigation>['handleOpenToolCenterPane'];
  handleExportConnections: ReturnType<typeof useAppConnectionImportExport>['handleExportConnections'];
  handleOpenConnectionHealth: ReturnType<typeof useAppWorkbenchActions>['handleOpenConnectionHealth'];
  securityUpdateEntryVisibility: ReturnType<typeof useAppShellState>['securityUpdateEntryVisibility'];
  securityUpdateHasLegacySensitiveItems: ReturnType<typeof useAppShellState>['securityUpdateHasLegacySensitiveItems'];
  securityUpdateStatusMeta: ReturnType<typeof useAppShellState>['securityUpdateStatusMeta'];
  handleOpenDataSyncWorkbench: ReturnType<typeof useAppSettingsNavigation>['handleOpenDataSyncWorkbench'];
  handleCancelSettingsCenterPane: ReturnType<typeof useAppSettingsNavigation>['handleCancelSettingsCenterPane'];
  addTab: ReturnType<typeof useAppSecurityUpdate>['addTab'];
  settingsCenterGroups: ReturnType<typeof useAppSettingsCenterRender>['settingsCenterGroups'];
  activeSettingsCenterGroupKey: ReturnType<typeof useAppShellState>['activeSettingsCenterGroupKey'];
  activeSettingsCenterPane: ReturnType<typeof useAppShellState>['activeSettingsCenterPane'];
  themeModalSection: ReturnType<typeof useAppProxySettings>['themeModalSection'];
  aiSettingsSection: ReturnType<typeof useAppShellState>['aiSettingsSection'];
  aiSettingsProviderView: ReturnType<typeof useAppShellState>['aiSettingsProviderView'];
  handleOpenToolsModal: ReturnType<typeof useAppSettingsNavigation>['handleOpenToolsModal'];
  handleOpenSettingsModal: ReturnType<typeof useAppSettingsNavigation>['handleOpenSettingsModal'];
  connectionImportGroupOptions: ReturnType<typeof useAppSecurityUpdate>['connectionImportGroupOptions'];
  connectionImportTargetTagId: ReturnType<typeof useAppShellState>['connectionImportTargetTagId'];
  connectionPackageDialog: ReturnType<typeof useAppShellState>['connectionPackageDialog'];
  pendingConnectionImportPayload: ReturnType<typeof useAppShellState>['pendingConnectionImportPayload'];
  connectionImportNotice: ReturnType<typeof useAppShellState>['connectionImportNotice'];
  setConnectionImportTargetTagId: ReturnType<typeof useAppShellState>['setConnectionImportTargetTagId'];
  setConnectionImportNotice: ReturnType<typeof useAppShellState>['setConnectionImportNotice'];
  setConnectionPackageDialog: ReturnType<typeof useAppShellState>['setConnectionPackageDialog'];
  handleImportConnections: ReturnType<typeof useAppConnectionImportExport>['handleImportConnections'];
  handleConfirmConnectionPackageDialog: ReturnType<typeof useAppConnectionImportExport>['handleConfirmConnectionPackageDialog'];
  setPendingConnectionImportPayload: ReturnType<typeof useAppShellState>['setPendingConnectionImportPayload'];
  utilityPanelStyle: ReturnType<typeof useAppSecurityUpdate>['utilityPanelStyle'];
  utilityMutedTextStyle: ReturnType<typeof useAppSecurityUpdate>['utilityMutedTextStyle'];
  connections: ReturnType<typeof useAppSecurityUpdate>['connections'];
  closeConnectionPackageDialog: ReturnType<typeof useAppQuitAndUpdate>['closeConnectionPackageDialog'];
  connectionHealthTargetIds: ReturnType<typeof useAppCoreState>['connectionHealthTargetIds'];
  closeConnectionHealthSettingsPane: ReturnType<typeof useAppSettingsNavigation>['closeConnectionHealthSettingsPane'];
  isWebRuntime: ReturnType<typeof useAppShellState>['isWebRuntime'];
  renderDataDirectorySettings: ReturnType<typeof useAppDirectorySettingsRender>['renderDataDirectorySettings'];
  darkMode: ReturnType<typeof useAppCoreState>['darkMode'];
  overlayTheme: ReturnType<typeof useAppSecurityUpdate>['overlayTheme'];
  effectiveOpacity: ReturnType<typeof useAppShellState>['effectiveOpacity'];
  securityUpdateStatus: ReturnType<typeof useAppShellState>['securityUpdateStatus'];
  securityUpdateSettingsFocusTarget: ReturnType<typeof useAppShellState>['securityUpdateSettingsFocusTarget'];
  securityUpdateSettingsFocusRequest: ReturnType<typeof useAppShellState>['securityUpdateSettingsFocusRequest'];
  handleStartSecurityUpdate: ReturnType<typeof useAppSecurityUpdate>['handleStartSecurityUpdate'];
  handleRetrySecurityUpdate: ReturnType<typeof useAppSecurityUpdate>['handleRetrySecurityUpdate'];
  handleRestartSecurityUpdate: ReturnType<typeof useAppSecurityUpdate>['handleRestartSecurityUpdate'];
  handleSecurityUpdateIssueAction: ReturnType<typeof useAppSecurityUpdate>['handleSecurityUpdateIssueAction'];
  handleOpenSettingsCenterPane: ReturnType<typeof useAppSettingsNavigation>['handleOpenSettingsCenterPane'];
  handleDownloadSourceChange: ReturnType<typeof useAppBootstrapEffects>['handleDownloadSourceChange'];
  downloadSourceSaving: ReturnType<typeof useAppShellState>['downloadSourceSaving'];
  downloadSource: ReturnType<typeof useAppShellState>['downloadSource'];
  setCapturingShortcutAction: ReturnType<typeof useAppProxySettings>['setCapturingShortcutAction'];
  resetShortcutOptions: ReturnType<typeof useAppCoreState>['resetShortcutOptions'];
  isMacRuntime: ReturnType<typeof useAppShellState>['isMacRuntime'];
  shortcutOptions: ReturnType<typeof useAppCoreState>['shortcutOptions'];
  activeShortcutPlatform: ReturnType<typeof useAppUpdateAndDiagnostics>['activeShortcutPlatform'];
  capturingShortcutAction: ReturnType<typeof useAppProxySettings>['capturingShortcutAction'];
  shortcutConflictMap: ReturnType<typeof useAppProxySettings>['shortcutConflictMap'];
  resolvedMonoFontFamily: ReturnType<typeof useAppShellState>['resolvedMonoFontFamily'];
  updateShortcut: ReturnType<typeof useAppCoreState>['updateShortcut'];
  toolCenterModalWorkspaceStyle: ReturnType<typeof useAppSecurityUpdate>['toolCenterModalWorkspaceStyle'];
  toolCenterModalSplitStyle: ReturnType<typeof useAppSecurityUpdate>['toolCenterModalSplitStyle'];
  toolCenterNavPanelStyle: ReturnType<typeof useAppSecurityUpdate>['toolCenterNavPanelStyle'];
  toolCenterContentPanelStyle: ReturnType<typeof useAppSecurityUpdate>['toolCenterContentPanelStyle'];
  activeSettingsCenterDetailPanelStyle: ReturnType<typeof useAppSettingsCenterRender>['activeSettingsCenterDetailPanelStyle'];
  toolCenterDetailBodyStyle: ReturnType<typeof useAppSecurityUpdate>['toolCenterDetailBodyStyle'];
  settingsCenterDetailBodyStyle: ReturnType<typeof useAppSettingsCenterRender>['settingsCenterDetailBodyStyle'];
  renderSettingsCenterPane: ReturnType<typeof useAppSettingsCenterRender>['renderSettingsCenterPane'];
  renderSettingsCenterAboutFooter: ReturnType<typeof useAppAboutSettingsRender>['renderSettingsCenterAboutFooter'];
}

export const renderAppSettingsCenterModal = ({
  t, handleOpenToolCenterPane, handleExportConnections, handleOpenConnectionHealth,
  securityUpdateEntryVisibility, securityUpdateHasLegacySensitiveItems, securityUpdateStatusMeta,
  handleOpenDataSyncWorkbench, handleCancelSettingsCenterPane, addTab, settingsCenterGroups,
  activeSettingsCenterGroupKey, activeSettingsCenterPane, themeModalSection, aiSettingsSection,
  aiSettingsProviderView, handleOpenToolsModal, handleOpenSettingsModal,
  connectionImportGroupOptions, connectionImportTargetTagId, connectionPackageDialog,
  pendingConnectionImportPayload, connectionImportNotice, setConnectionImportTargetTagId,
  setConnectionImportNotice, setConnectionPackageDialog, handleImportConnections,
  handleConfirmConnectionPackageDialog, setPendingConnectionImportPayload, utilityPanelStyle,
  utilityMutedTextStyle, connections, closeConnectionPackageDialog, connectionHealthTargetIds,
  closeConnectionHealthSettingsPane, isWebRuntime, renderDataDirectorySettings, darkMode,
  overlayTheme, effectiveOpacity, securityUpdateStatus, securityUpdateSettingsFocusTarget,
  securityUpdateSettingsFocusRequest, handleStartSecurityUpdate, handleRetrySecurityUpdate,
  handleRestartSecurityUpdate, handleSecurityUpdateIssueAction, handleOpenSettingsCenterPane,
  handleDownloadSourceChange, downloadSourceSaving, downloadSource, setCapturingShortcutAction,
  resetShortcutOptions, isMacRuntime, shortcutOptions, activeShortcutPlatform,
  capturingShortcutAction, shortcutConflictMap, resolvedMonoFontFamily, updateShortcut,
  toolCenterModalWorkspaceStyle, toolCenterModalSplitStyle, toolCenterNavPanelStyle,
  toolCenterContentPanelStyle, activeSettingsCenterDetailPanelStyle, toolCenterDetailBodyStyle,
  settingsCenterDetailBodyStyle, renderSettingsCenterPane, renderSettingsCenterAboutFooter,
}: RenderAppSettingsCenterModalInput) => {
  const { toolCenterGroups } = buildToolCenterGroups({
    t, handleOpenToolCenterPane, handleExportConnections, handleOpenConnectionHealth,
    securityUpdateEntryVisibility, securityUpdateHasLegacySensitiveItems, securityUpdateStatusMeta,
    handleOpenDataSyncWorkbench, handleCancelSettingsCenterPane, addTab,
  });
  const combinedSettingsCenterGroups = [
    ...settingsCenterGroups.filter((group) => group.key !== 'about'),
    ...toolCenterGroups,
    ...settingsCenterGroups.filter((group) => group.key === 'about'),
  ];
  const activeSettingsCenterGroup = combinedSettingsCenterGroups.find(
    (group) => group.key === activeSettingsCenterGroupKey,
  ) ?? combinedSettingsCenterGroups[0];
  const activeSettingsCenterTreeItemKey = activeSettingsCenterPane?.key === 'theme'
    ? `theme-${themeModalSection}`
    : activeSettingsCenterPane?.key === 'ai'
      ? (aiSettingsSection === 'providers' && aiSettingsProviderView === 'connected'
          ? 'ai-providers-connected'
          : `ai-${aiSettingsSection}`)
      : (activeSettingsCenterPane?.key ?? null);
  const activeSettingsCenterPaneItem = activeSettingsCenterPane
    ? (
        findSettingsCenterTreeItem(
          combinedSettingsCenterGroups,
          activeSettingsCenterPane.group,
          activeSettingsCenterTreeItemKey,
        )
        ?? findSettingsCenterTreeItem(
          combinedSettingsCenterGroups,
          activeSettingsCenterPane.group,
          activeSettingsCenterPane.key,
        )
      )
    : null;
  const isActiveToolCenterPane = activeSettingsCenterPane
    ? isToolCenterGroupKey(activeSettingsCenterPane.group)
    : false;
  if (!activeSettingsCenterGroup) {
    return null;
  }
  const activateSettingsCenterGroup = (group: typeof combinedSettingsCenterGroups[number]) => {
    if (isToolCenterGroupKey(group.key)) {
      handleOpenToolsModal(group.key);
      return;
    }
    handleOpenSettingsModal(group.key);
  };
  const { renderToolCenterPane } = createToolCenterPaneRenderer({
    activeSettingsCenterPane, connectionImportGroupOptions, connectionImportTargetTagId,
    connectionPackageDialog, pendingConnectionImportPayload, connectionImportNotice,
    setConnectionImportTargetTagId, setConnectionImportNotice, setConnectionPackageDialog,
    handleImportConnections, handleConfirmConnectionPackageDialog,
    setPendingConnectionImportPayload, utilityPanelStyle, utilityMutedTextStyle, t, connections,
    closeConnectionPackageDialog, connectionHealthTargetIds, closeConnectionHealthSettingsPane,
    isWebRuntime, renderDataDirectorySettings, handleCancelSettingsCenterPane, darkMode,
    overlayTheme, effectiveOpacity, securityUpdateStatus, securityUpdateSettingsFocusTarget,
    securityUpdateSettingsFocusRequest, handleStartSecurityUpdate, handleRetrySecurityUpdate,
    handleRestartSecurityUpdate, handleSecurityUpdateIssueAction, handleOpenSettingsCenterPane,
    handleDownloadSourceChange, downloadSourceSaving, downloadSource, setCapturingShortcutAction,
    resetShortcutOptions, isMacRuntime, shortcutOptions, activeShortcutPlatform,
    capturingShortcutAction, shortcutConflictMap, resolvedMonoFontFamily, updateShortcut,
  });

  return (
    <SettingsCenterWorkbenchRegistrar>
      <div
        className={`gonavi-settings-center-modal gonavi-settings-center-workbench${activeSettingsCenterPane?.key === 'ai' ? ' gonavi-provider-settings-host' : ''}`}
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'transparent',
        }}
      >
      <div style={{ ...toolCenterModalWorkspaceStyle, flex: 1, minHeight: 0, padding: '4px 0 8px 8px' }}>
          <div className="gonavi-settings-center-layout" style={toolCenterModalSplitStyle}>
          <div className="gonavi-settings-center-groups" style={toolCenterNavPanelStyle}>
            <SettingsCenterTreeNav
              groups={combinedSettingsCenterGroups}
              activeGroupKey={activeSettingsCenterGroup.key}
              activeItemKey={activeSettingsCenterTreeItemKey}
              darkMode={darkMode}
              overlayTheme={overlayTheme}
              ariaLabel={t('app.settings.title')}
              onSelectGroup={(groupKey) => {
                const group = combinedSettingsCenterGroups.find((entry) => entry.key === groupKey);
                if (group) {
                  activateSettingsCenterGroup(group);
                }
              }}
            />
          </div>
          <div
            className="gonavi-settings-center-content"
            style={toolCenterContentPanelStyle}
          >
            {activeSettingsCenterPane ? (
              <div style={activeSettingsCenterDetailPanelStyle}>
                {/* 侧栏树已显示当前项，内容区不再重复标题/说明 */}
                <div
                  key={activeSettingsCenterPane.key}
                  style={isActiveToolCenterPane ? toolCenterDetailBodyStyle : settingsCenterDetailBodyStyle}
                >
                  {isActiveToolCenterPane ? renderToolCenterPane() : renderSettingsCenterPane()}
                </div>
                {!isActiveToolCenterPane && activeSettingsCenterPane.key === 'about-go-navi' && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      gap: 8,
                      paddingTop: 10,
                      marginTop: 10,
                      flexShrink: 0,
                    }}
                  >
                    {renderSettingsCenterAboutFooter()}
                  </div>
                )}
              </div>
            ) : (
              <div style={activeSettingsCenterDetailPanelStyle}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <div style={{ fontSize: 'calc(var(--gn-font-size, 14px) * 1.14)', fontWeight: 700, color: overlayTheme.titleText }}>{activeSettingsCenterGroup.title}</div>
                  <div style={utilityMutedTextStyle}>{activeSettingsCenterGroup.description}</div>
                </div>
                <div style={{ flex: 1 }} />
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </SettingsCenterWorkbenchRegistrar>
  );
};
