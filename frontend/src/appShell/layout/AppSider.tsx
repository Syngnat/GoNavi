import { Spin } from 'antd';
import { Sider } from '../appLayoutParts';
import Sidebar from '../../components/Sidebar';
import type { AppWorkbenchActionsApi } from '../hooks/useAppWorkbenchActions';
import type { AppShellStateApi } from '../hooks/useAppShellState';
import type { AppSettingsNavigationApi } from '../hooks/useAppSettingsNavigation';
import type { AppUpdateAndDiagnosticsApi } from '../hooks/useAppUpdateAndDiagnostics';
import type { AppSettingsCenterRenderApi } from '../hooks/useAppSettingsCenterRender';
import type { AppSecurityUpdateApi } from '../hooks/useAppSecurityUpdate';
import type { AppCoreStateApi } from '../hooks/useAppCoreState';

export interface AppSiderProps {
  siderRef: AppWorkbenchActionsApi['siderRef'];
  sidebarWidth: AppShellStateApi['sidebarWidth'];
  isSidebarCollapsed: AppShellStateApi['isSidebarCollapsed'];
  sidebarCollapsedWidth: AppShellStateApi['sidebarCollapsedWidth'];
  isCollapsedSidebarActionsDocked: AppShellStateApi['isCollapsedSidebarActionsDocked'];
  sidebarResizeHit: AppWorkbenchActionsApi['sidebarResizeHit'];
  sidebarContentRef: AppShellStateApi['sidebarContentRef'];
  connectionWorkbenchState: AppShellStateApi['connectionWorkbenchState'];
  handleCreateConnection: AppWorkbenchActionsApi['handleCreateConnection'];
  handleCreateConnectionInGroup: AppWorkbenchActionsApi['handleCreateConnectionInGroup'];
  handleEditConnection: AppWorkbenchActionsApi['handleEditConnection'];
  handleOpenSettingsModal: AppSettingsNavigationApi['handleOpenSettingsModal'];
  handleTitleBarSettingsNavigation: AppSettingsNavigationApi['handleTitleBarSettingsNavigation'];
  activeSettingsCenterPane: AppShellStateApi['activeSettingsCenterPane'];
  useNativeMacWindowControls: AppUpdateAndDiagnosticsApi['useNativeMacWindowControls'];
  handleNativeMenuCheckUpdate: AppSettingsCenterRenderApi['handleNativeMenuCheckUpdate'];
  isWebRuntime: AppShellStateApi['isWebRuntime'];
  handleOpenDataSyncWorkbench: AppSettingsNavigationApi['handleOpenDataSyncWorkbench'];
  handleToggleOrFocusAIPanel: AppShellStateApi['handleToggleOrFocusAIPanel'];
  handleToggleLogPanel: AppWorkbenchActionsApi['handleToggleLogPanel'];
  v2ExplorerContext: AppSecurityUpdateApi['v2ExplorerContext'];
  collapsedSidebarActionsTarget: AppShellStateApi['collapsedSidebarActionsTarget'];
  handleFocusSidebarSearch: AppSettingsNavigationApi['handleFocusSidebarSearch'];
  handleCollapseSidebarPanel: AppShellStateApi['handleCollapseSidebarPanel'];
  handleExpandSidebarPanel: AppShellStateApi['handleExpandSidebarPanel'];
  handleEnsureSidebarExpanded: AppShellStateApi['handleEnsureSidebarExpanded'];
  setSidebarTitlebarSnapshot: AppSecurityUpdateApi['setSidebarTitlebarSnapshot'];
  sidebarPanelCollapseLabel: AppSettingsCenterRenderApi['sidebarPanelCollapseLabel'];
  sidebarExplorerToggleRef: AppShellStateApi['sidebarExplorerToggleRef'];
  sidebarPanelExpandLabel: AppSettingsCenterRenderApi['sidebarPanelExpandLabel'];
  sidebarCollapsedToggleRef: AppShellStateApi['sidebarCollapsedToggleRef'];
  darkMode: AppCoreStateApi['darkMode'];
  handleSidebarMouseDown: AppWorkbenchActionsApi['handleSidebarMouseDown'];
  t: AppCoreStateApi['t'];
}

export const AppSider = ({
  siderRef, sidebarWidth, isSidebarCollapsed, sidebarCollapsedWidth,
  isCollapsedSidebarActionsDocked, sidebarResizeHit, sidebarContentRef, connectionWorkbenchState,
  handleCreateConnection, handleCreateConnectionInGroup, handleEditConnection,
  handleOpenSettingsModal, handleTitleBarSettingsNavigation, activeSettingsCenterPane,
  useNativeMacWindowControls, handleNativeMenuCheckUpdate, isWebRuntime,
  handleOpenDataSyncWorkbench, handleToggleOrFocusAIPanel, handleToggleLogPanel, v2ExplorerContext,
  collapsedSidebarActionsTarget, handleFocusSidebarSearch, handleCollapseSidebarPanel,
  handleExpandSidebarPanel, handleEnsureSidebarExpanded, setSidebarTitlebarSnapshot,
  sidebarPanelCollapseLabel, sidebarExplorerToggleRef, sidebarPanelExpandLabel,
  sidebarCollapsedToggleRef, darkMode, handleSidebarMouseDown, t,
}: AppSiderProps) => (
  <Sider
    ref={siderRef}
    width={sidebarWidth}
    collapsible
    collapsed={isSidebarCollapsed}
    collapsedWidth={sidebarCollapsedWidth}
    trigger={null}
    data-sidebar-panel="true"
    data-sidebar-collapsed={isSidebarCollapsed}
    data-sidebar-actions-placement={isCollapsedSidebarActionsDocked ? 'titlebar' : 'fixed-rail'}
    className="gn-v2-app-sider"
    style={{
        borderRight: 'none',
        position: 'relative',
        background: 'var(--gn-bg-panel-2)',
        ['--gonavi-sidebar-collapsed-width' as any]: `${sidebarCollapsedWidth}px`,
        [sidebarResizeHit.cssVariable as any]: `${sidebarResizeHit.innerHitWidth}px`,
    }}
  >
    <div
        ref={sidebarContentRef}
        data-sidebar-content="true"
        aria-hidden={isCollapsedSidebarActionsDocked ? true : undefined}
        style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        }}
    >
        <div style={{ flex: 1, overflow: 'hidden', paddingBottom: 0, paddingRight: 0, position: 'relative' }}>
            <div style={{ height: '100%', opacity: connectionWorkbenchState.ready ? 1 : 0.72, pointerEvents: connectionWorkbenchState.ready ? 'auto' : 'none' }}>
                <Sidebar
                    onCreateConnection={handleCreateConnection}
                    onCreateConnectionInGroup={handleCreateConnectionInGroup}
                    onEditConnection={handleEditConnection}
                    onOpenSettings={handleOpenSettingsModal}
                    onOpenSettingsNavigation={handleTitleBarSettingsNavigation}
                    activeSettingsCenterPaneKey={activeSettingsCenterPane?.key}
                    hideTitlebarAboutAction={useNativeMacWindowControls} onCheckUpdate={handleNativeMenuCheckUpdate}
                    hideTitlebarDriverAction={useNativeMacWindowControls && !isWebRuntime}
                    isWebRuntime={isWebRuntime}
                    onOpenDataSyncWorkbench={handleOpenDataSyncWorkbench}
                    onToggleAI={handleToggleOrFocusAIPanel}
                    onToggleLogPanel={handleToggleLogPanel}
                    v2ExplorerContext={v2ExplorerContext}
                    collapsedSidebarActionsTarget={collapsedSidebarActionsTarget}
                    onFocusCommandSearch={handleFocusSidebarSearch}
                    onCollapseSidebar={handleCollapseSidebarPanel}
                    onExpandSidebar={handleExpandSidebarPanel}
                    onEnsureSidebarExpanded={handleEnsureSidebarExpanded}
                    onTitlebarSnapshotChange={setSidebarTitlebarSnapshot}
                    collapseSidebarLabel={sidebarPanelCollapseLabel}
                    collapseSidebarButtonRef={sidebarExplorerToggleRef}
                    expandSidebarLabel={sidebarPanelExpandLabel}
                    expandSidebarButtonRef={sidebarCollapsedToggleRef}
                />
            </div>
            {!connectionWorkbenchState.ready && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 16,
                        background: darkMode ? 'rgba(7, 12, 20, 0.42)' : 'rgba(255, 255, 255, 0.58)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 1,
                    }}
                >
                    <div
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '10px 14px',
                            borderRadius: 999,
                            background: darkMode ? 'rgba(15, 23, 36, 0.86)' : 'rgba(255, 255, 255, 0.94)',
                            border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(22,32,51,0.08)',
                            boxShadow: darkMode ? '0 12px 24px rgba(0,0,0,0.26)' : '0 12px 24px rgba(15,23,42,0.08)',
                            color: darkMode ? 'rgba(255,255,255,0.88)' : '#162033',
                            fontSize: 12,
                            fontWeight: 500,
                        }}
                    >
                        <Spin size="small" />
                        <span>{connectionWorkbenchState.message}</span>
                    </div>
                </div>
            )}
        </div>
    </div>
    {!isSidebarCollapsed && <div
        data-sidebar-resize-handle="true"
        onMouseDown={handleSidebarMouseDown}
        onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
        }}
        role="separator"
        aria-orientation="vertical"
        title={t('app.sidebar.resize_width')}
        style={{
            position: 'absolute',
            right: sidebarResizeHit.handleOffset,
            top: 0,
            bottom: 0,
            width: sidebarResizeHit.handleWidth,
            cursor: 'col-resize',
            zIndex: 3,
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            background: 'transparent',
        }}
    />}
  </Sider>
);
