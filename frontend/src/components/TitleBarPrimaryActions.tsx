import React from 'react';
import { ConsoleSqlOutlined, PlusOutlined } from '@ant-design/icons';
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
  newConnectionLabel: string;
  newQueryShortcut?: string;
  newConnectionShortcut?: string;
  onNewQuery: () => void;
  onNewConnection: () => void;
}

const getActionTitle = (label: string, shortcut?: string): string => (
  shortcut ? `${label} \u00b7 ${shortcut}` : label
);

const TitleBarPrimaryActions: React.FC<TitleBarPrimaryActionsProps> = ({
  newQueryLabel,
  newConnectionLabel,
  newQueryShortcut,
  newConnectionShortcut,
  onNewQuery,
  onNewConnection,
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
      <ConsoleSqlOutlined />
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
  </div>
);

export default TitleBarPrimaryActions;
