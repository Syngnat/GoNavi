import { Tooltip, Button } from 'antd';
import { PoweroffOutlined } from '@ant-design/icons';
import {
  getMacNativeTitlebarContentOffset,
  getMacNativeTitlebarPaddingLeft,
  getMacNativeTitlebarPaddingRight,
} from '../../utils/macWindow';
import {
  TitleBarMinimizeIcon,
  TitleBarRestoreIcon,
  TitleBarMaximizeIcon,
  TitleBarCloseIcon,
} from '../../components/TitleBarWindowControlIcons';
import { WindowMinimise } from '../../../wailsjs/runtime';
import type { AppUpdateAndDiagnosticsApi } from '../hooks/useAppUpdateAndDiagnostics';
import type { AppShellStateApi } from '../hooks/useAppShellState';
import type { AppWorkbenchActionsApi } from '../hooks/useAppWorkbenchActions';
import type { AppCoreStateApi } from '../hooks/useAppCoreState';
import type { AppSettingsCenterRenderApi } from '../hooks/useAppSettingsCenterRender';
import type { AppQuitAndUpdateApi } from '../hooks/useAppQuitAndUpdate';

export interface AppTitleBarProps {
  useNativeMacWindowControls: AppUpdateAndDiagnosticsApi['useNativeMacWindowControls'];
  dockActionsInTitlebarBand: AppShellStateApi['dockActionsInTitlebarBand'];
  handleTitleBarDoubleClick: AppWorkbenchActionsApi['handleTitleBarDoubleClick'];
  titleBarHeight: AppShellStateApi['titleBarHeight'];
  isWebRuntime: AppShellStateApi['isWebRuntime'];
  titleBarLayout: AppShellStateApi['titleBarLayout'];
  titleBarButtonWidth: AppShellStateApi['titleBarButtonWidth'];
  effectiveUiScale: AppCoreStateApi['effectiveUiScale'];
  tokenFontSize: AppCoreStateApi['tokenFontSize'];
  titleBarActionsInline: AppShellStateApi['titleBarActionsInline'];
  titleBarActionRow: AppSettingsCenterRenderApi['titleBarActionRow'];
  dockedSidebarActionsHost: AppSettingsCenterRenderApi['dockedSidebarActionsHost'];
  titleBarSystemActionsNode: AppSettingsCenterRenderApi['titleBarSystemActionsNode'];
  handleWebLogout: AppWorkbenchActionsApi['handleWebLogout'];
  titleBarToggleIconKey: AppCoreStateApi['titleBarToggleIconKey'];
  handleTitleBarWindowToggle: AppWorkbenchActionsApi['handleTitleBarWindowToggle'];
  handleApplicationQuitRequest: AppQuitAndUpdateApi['handleApplicationQuitRequest'];
}

export const AppTitleBar = ({
  useNativeMacWindowControls, dockActionsInTitlebarBand, handleTitleBarDoubleClick, titleBarHeight,
  isWebRuntime, titleBarLayout, titleBarButtonWidth, effectiveUiScale, tokenFontSize,
  titleBarActionsInline, titleBarActionRow, dockedSidebarActionsHost, titleBarSystemActionsNode,
  handleWebLogout, titleBarToggleIconKey, handleTitleBarWindowToggle, handleApplicationQuitRequest,
}: AppTitleBarProps) => (
  <div
    className={[
      'gn-v2-titlebar',
      useNativeMacWindowControls ? 'gn-v2-titlebar-native-mac' : '',
      dockActionsInTitlebarBand ? 'gn-v2-titlebar-collapsed-docked' : '',
    ].filter(Boolean).join(' ')}
    onDoubleClick={handleTitleBarDoubleClick}
    style={{
        height: titleBarHeight,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        // Match the titlebar to the adjacent theme surface with its compensated opacity.
        background: 'var(--gn-bg-titlebar)',
        borderBottom: 'none',
        userSelect: 'none',
        WebkitAppRegion: isWebRuntime ? 'no-drag' : 'drag',
        '--wails-draggable': isWebRuntime ? 'no-drag' : 'drag',
        '--gn-titlebar-action-height': `${titleBarLayout.actionHeight}px`,
        '--gn-titlebar-divider-height': `${titleBarLayout.dividerHeight}px`,
        '--gn-titlebar-collapsed-upper-height': `${titleBarLayout.upperBandHeight}px`,
        '--gn-titlebar-window-controls-width': `${isWebRuntime ? titleBarButtonWidth : (useNativeMacWindowControls ? 0 : titleBarButtonWidth * 3)}px`,
        '--gn-titlebar-native-content-offset': `${getMacNativeTitlebarContentOffset(titleBarHeight, useNativeMacWindowControls)}px`,
        paddingLeft: getMacNativeTitlebarPaddingLeft(effectiveUiScale, useNativeMacWindowControls),
        paddingRight: getMacNativeTitlebarPaddingRight(effectiveUiScale, useNativeMacWindowControls),
        fontSize: tokenFontSize
    } as any}
  >
      <div className="gonavi-titlebar-leading">
          <div
            data-titlebar-brand-region="true"
            style={{ display: 'flex', alignItems: 'center', gap: Math.max(6, Math.round(8 * effectiveUiScale)), fontWeight: 700, minWidth: 0, letterSpacing: '-0.01em' }}
          >
              <span>GoNavi</span>
          </div>
          {titleBarActionsInline && titleBarActionRow}
      </div>
      {titleBarActionsInline && dockedSidebarActionsHost}
      {/* Collapsed sidebar titlebar actions end */}
      <div className="gn-v2-titlebar-right">
          {!useNativeMacWindowControls && titleBarSystemActionsNode}
          {isWebRuntime ? (
              <div
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag', '--wails-draggable': 'no-drag' } as any}
              >
                  <Tooltip title="退出当前 Web 会话">
                      <Button
                        type="text"
                        icon={<PoweroffOutlined />}
                        className="titlebar-web-logout-btn"
                        style={{ height: '100%', borderRadius: 8, width: titleBarButtonWidth }}
                        onClick={() => { void handleWebLogout(); }}
                      />
                  </Tooltip>
              </div>
          ) : useNativeMacWindowControls ? null : (
              <div
                className="titlebar-window-controls"
                data-no-titlebar-toggle="true"
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ display: 'flex', height: '100%', WebkitAppRegion: 'no-drag', '--wails-draggable': 'no-drag' } as any}
              >
                  <Button
                    type="text"
                    icon={<TitleBarMinimizeIcon />}
                    className="titlebar-window-control-btn"
                    style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }}
                    onClick={WindowMinimise}
                  />
                  <Button
                    type="text"
                    icon={titleBarToggleIconKey === 'restore' ? <TitleBarRestoreIcon /> : <TitleBarMaximizeIcon />}
                    className="titlebar-window-control-btn"
                    style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }}
                    onClick={() => { void handleTitleBarWindowToggle(); }}
                  />
                  <Button
                    type="text"
                    icon={<TitleBarCloseIcon />}
                    danger
                    className="titlebar-close-btn titlebar-window-control-btn"
                    style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }}
                    onClick={() => { void handleApplicationQuitRequest(); }}
                  />
              </div>
          )}
      </div>
  </div>
);
