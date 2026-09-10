import React from 'react';
import { Button, Tooltip } from 'antd';
import { RobotOutlined, SettingOutlined } from '@ant-design/icons';

type TitleBarSystemActionsProps = {
  aiAssistantLabel: string;
  settingsLabel: string;
  aiActive: boolean;
  onToggleAI: () => void;
  onOpenSettings: () => void;
};

const TitleBarSystemActions: React.FC<TitleBarSystemActionsProps> = ({
  aiAssistantLabel,
  settingsLabel,
  aiActive,
  onToggleAI,
  onOpenSettings,
}) => (
  <div
    className="gn-v2-titlebar-system-actions"
    data-titlebar-system-actions="true"
    data-no-titlebar-toggle="true"
    role="toolbar"
    aria-label={`${aiAssistantLabel} / ${settingsLabel}`}
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <Tooltip title={aiAssistantLabel} placement="bottom" mouseEnterDelay={0.35}>
      <Button
        size="small"
        type="text"
        className={`gn-v2-titlebar-system-action${aiActive ? ' is-active' : ''}`}
        icon={<RobotOutlined />}
        aria-label={aiAssistantLabel}
        aria-pressed={aiActive}
        data-gonavi-ai-entry-action="true"
        onClick={onToggleAI}
      />
    </Tooltip>
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
  </div>
);

export default TitleBarSystemActions;
