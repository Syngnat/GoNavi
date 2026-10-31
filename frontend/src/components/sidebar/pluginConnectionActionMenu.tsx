import React from 'react';
import { CodeOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { t } from '../../i18n';
import type { PluginConnectionActionEntry, PluginConnectionActionScope } from '../../plugins/connectionActions';

export interface PluginConnectionActionTarget {
  connectionId: string;
  database?: string;
  collection?: string;
}

export interface BuildPluginConnectionActionMenuItemsInput {
  actions: readonly PluginConnectionActionEntry[];
  connectionType: string;
  scope: PluginConnectionActionScope;
  target: PluginConnectionActionTarget;
  run: (entry: PluginConnectionActionEntry, target: PluginConnectionActionTarget) => void;
}

/**
 * Renders package-declared connection actions as direct menu items. The host owns
 * the launch context; the sidebar only supplies the selected node identity.
 */
export function buildPluginConnectionActionMenuItems({
  actions,
  connectionType,
  scope,
  target,
  run,
}: BuildPluginConnectionActionMenuItemsInput): NonNullable<MenuProps['items']> {
  if (!target.connectionId) return [];
  const normalized = String(connectionType || '').trim().toLowerCase();
  const matches = actions.filter((entry) => {
    const types = entry.action.connectionTypes.map((value) => String(value).trim().toLowerCase());
    if (!types.includes(normalized)) return false;
    const scopes = entry.action.scopes?.length ? entry.action.scopes : ['connection'];
    return scopes.includes(scope);
  });
  const items: MenuProps['items'] = matches.map((entry) => ({
    key: `plugin-connection-action:${entry.pluginID}:${entry.action.id}`,
    label: entry.action.title,
    icon: <CodeOutlined />,
    onClick: () => run(entry, target),
  }));
  if (items.length <= 1) return items;
  return [{
    key: 'plugin-connection-actions',
    label: t('plugin.connection_actions.menu'),
    icon: <CodeOutlined />,
    children: items,
  }];
}
