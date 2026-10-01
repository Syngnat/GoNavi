import React from 'react';
import { Button, Tooltip } from 'antd';
import { SettingOutlined } from '@ant-design/icons';

import TitleBarPreferencesPill from './titlebar/TitleBarPreferencesPill';

type TitleBarSystemActionsProps = {
  settingsLabel: string;
  onOpenSettings: () => void;
  /** 主题段文案；不传则不渲染胶囊的主题行为（保持旧的设置按钮语义）。 */
  themeLabel?: string;
  isDarkTheme?: boolean;
  onToggleTheme?: () => void;
  /** 插在「设置」与「主题」之间的内容，通常是驱动管理 / 关于的 portal 槽位。 */
  trailingSlot?: React.ReactNode;
};

const TitleBarSystemActions: React.FC<TitleBarSystemActionsProps> = ({
  settingsLabel,
  onOpenSettings,
  themeLabel,
  isDarkTheme = false,
  onToggleTheme,
  trailingSlot,
}) => (
  <div
    className="gn-v2-titlebar-system-actions"
    data-titlebar-system-actions="true"
    data-no-titlebar-toggle="true"
    role="toolbar"
    aria-label={settingsLabel}
    onDoubleClick={(event) => event.stopPropagation()}
  >
    {themeLabel && onToggleTheme ? (
      <TitleBarPreferencesPill
        preferencesLabel={settingsLabel}
        themeLabel={themeLabel}
        isDarkTheme={isDarkTheme}
        onOpenPreferences={onOpenSettings}
        onToggleTheme={onToggleTheme}
        middle={trailingSlot}
      />
    ) : (
      <>
        <Tooltip title={settingsLabel} placement="bottom" mouseEnterDelay={0.35}>
          <Button
            size="small"
            type="text"
            className="gn-v2-titlebar-system-action"
            icon={<SettingOutlined />}
            aria-label={settingsLabel}
            data-sidebar-settings-action="true"
            data-titlebar-settings-action="true"
            onClick={onOpenSettings}
          />
        </Tooltip>
        {trailingSlot}
      </>
    )}
  </div>
);

export default TitleBarSystemActions;
