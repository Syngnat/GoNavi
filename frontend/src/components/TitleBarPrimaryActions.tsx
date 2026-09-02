import React from 'react';
import { ConsoleSqlOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import {
  getShortcutDisplayLabel,
  resolveShortcutBinding,
  type ShortcutOptions,
  type ShortcutPlatform,
} from '../utils/shortcuts';

type TitleBarPrimaryShortcutAction = 'newQueryTab' | 'newConnection';

export const resolveTitleBarPrimaryActionShortcut = (
  shortcutOptions: Partial<ShortcutOptions> | null | undefined,
  action: TitleBarPrimaryShortcutAction,
  platform: ShortcutPlatform,
): string | undefined => {
  const binding = resolveShortcutBinding(shortcutOptions, action, platform);
  return binding.enabled && binding.combo
    ? getShortcutDisplayLabel(binding.combo, platform)
    : undefined;
};

interface TitleBarPrimaryActionsProps {
  newQueryLabel: string;
  newQueryIcon?: React.ReactNode;
  newConnectionLabel: string;
  newQueryShortcut?: string;
  newConnectionShortcut?: string;
  onNewQuery: () => void;
  onNewConnection: () => void;
  connectionGroupLabel?: string;
  onConnectionGroupManagement?: () => void;
}

const getActionTitle = (label: string, shortcut?: string): string => (
  shortcut ? `${label} \u00b7 ${shortcut}` : label
);

const TitleBarPrimaryActions: React.FC<TitleBarPrimaryActionsProps> = ({
  newQueryLabel,
  newQueryIcon,
  newConnectionLabel,
  newQueryShortcut,
  newConnectionShortcut,
  onNewQuery,
  onNewConnection,
  connectionGroupLabel,
  onConnectionGroupManagement,
}) => (
  <div
    className="gonavi-titlebar-primary-actions"
    data-titlebar-primary-actions="true"
    data-no-titlebar-toggle="true"
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <button
      type="button"
      className="gonavi-titlebar-primary-action"
      aria-label={newQueryLabel}
      title={getActionTitle(newQueryLabel, newQueryShortcut)}
      data-gonavi-new-query-action="true"
      onClick={onNewQuery}
    >
      {newQueryIcon || <ConsoleSqlOutlined />}
      {newQueryLabel}
    </button>
    <button
      type="button"
      className="gonavi-titlebar-primary-action"
      aria-label={newConnectionLabel}
      title={getActionTitle(newConnectionLabel, newConnectionShortcut)}
      data-gonavi-create-connection-action="true"
      onClick={onNewConnection}
    >
      <PlusOutlined />
      {newConnectionLabel}
    </button>
    {connectionGroupLabel && onConnectionGroupManagement && <button type="button" className="gonavi-titlebar-primary-action" aria-label={connectionGroupLabel} data-gonavi-connection-group-management-action="true" onClick={onConnectionGroupManagement}>
      <SettingOutlined />
      {connectionGroupLabel}
    </button>}
  </div>
);

export default TitleBarPrimaryActions;
