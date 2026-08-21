import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage, t } from '../i18n';
import { buildSidebarLegacyNodeMenuItems } from './sidebar/sidebarLegacyNodeMenu';
import { resolveV2ConnectionGroup, type V2RailConnectionGroup } from './sidebarV2Utils';
import { V2ConnectionGroupContextMenuView } from './V2TableContextMenu';

const findElementByAction = (node: React.ReactNode, action: string): React.ReactElement<any> | null => {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<any>;
  if (element.props?.item?.action === action) return element;
  for (const child of React.Children.toArray(element.props?.children)) {
    const match = findElementByAction(child, action);
    if (match) return match;
  }
  return null;
};

describe('Sidebar connection group new connection action', () => {
  it('opens the V2 group menu for any right-clicked group, including nested groups', () => {
    const productionGroup: V2RailConnectionGroup = {
      id: 'production',
      name: '生产环境',
      connections: [],
      rootToken: 'tag:production',
    };
    const rootGroup: V2RailConnectionGroup = {
      id: 'root',
      name: '全部环境',
      connections: [],
      children: [productionGroup],
      rootToken: 'tag:root',
    };

    expect(resolveV2ConnectionGroup({
      type: 'tag',
      dataRef: { id: 'production' },
    }, [rootGroup])).toBe(productionGroup);
  });

  it('renders the V2 group header, connection count, and new connection action', () => {
    setCurrentLanguage('zh-CN');
    const markup = renderToStaticMarkup(
      <V2ConnectionGroupContextMenuView groupName="生产环境" count={2} />,
    );

    expect(markup).toContain('生产环境');
    expect(markup).toContain(t('connection.sidebar.group.meta', { count: '2' }));
    expect(markup).toContain(t('connection.new'));
    expect(markup).toContain(t('connection_health.action.open'));
  });

  it('dispatches the V2 health-check action for a non-empty group', () => {
    const onAction = vi.fn();
    const menu = V2ConnectionGroupContextMenuView({
      groupName: '生产环境',
      count: 2,
      onAction,
    });
    const healthCheckItem = findElementByAction(menu, 'connection-health');
    expect(healthCheckItem).not.toBeNull();

    const renderMenuItem = healthCheckItem?.type as React.FC<any>;
    const healthCheckButton = renderMenuItem(healthCheckItem?.props) as React.ReactElement<any>;
    healthCheckButton.props.onClick({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(onAction).toHaveBeenCalledWith('connection-health');
  });

  it('adds enabled health checks for groups with saved connections', () => {
    const onCreateConnectionInGroup = vi.fn();
    const onOpenConnectionHealthForGroup = vi.fn();
    const node = {
      key: 'tag-production',
      type: 'tag',
      title: '生产环境',
      dataRef: {
        id: 'production',
        parentTagId: null,
        connectionIds: [],
      },
    };
    const context = {
      createTagForm: { resetFields: vi.fn(), setFieldsValue: vi.fn() },
      setRenameViewTarget: vi.fn(),
      setIsCreateTagModalOpen: vi.fn(),
      removeConnectionTag: vi.fn(),
      onCreateConnectionInGroup,
      onOpenConnectionHealthForGroup,
      connectionTags: [{
        id: 'production',
        name: 'Production',
        connectionIds: [],
      }, {
        id: 'production-analytics',
        name: 'Production Analytics',
        parentTagId: 'production',
        connectionIds: ['production-db'],
      }],
      connections: [{
        id: 'production-db',
        name: 'Production DB',
        config: { type: 'mysql', host: '', port: 0, user: '' },
      }],
    };

    const items = buildSidebarLegacyNodeMenuItems(node, context) as Array<{ key?: string; disabled?: boolean; onClick?: () => void }>;
    const createItem = items.find((item) => item?.key === 'new-connection-in-tag');

    expect(createItem).toBeDefined();
    createItem?.onClick?.();
    expect(onCreateConnectionInGroup).toHaveBeenCalledWith('production');

    const healthCheckItem = items.find((item) => item?.key === 'connection-health');
    expect(healthCheckItem).toBeDefined();
    expect(healthCheckItem?.disabled).toBe(false);
    healthCheckItem?.onClick?.();
    expect(onOpenConnectionHealthForGroup).toHaveBeenCalledWith('production');
  });

  it('disables legacy health checks for groups without direct or nested saved connections', () => {
    const items = buildSidebarLegacyNodeMenuItems({
      key: 'tag-empty',
      type: 'tag',
      title: 'Empty',
      dataRef: { id: 'empty', parentTagId: null, connectionIds: [] },
    }, {
      createTagForm: { resetFields: vi.fn(), setFieldsValue: vi.fn() },
      setRenameViewTarget: vi.fn(),
      setIsCreateTagModalOpen: vi.fn(),
      removeConnectionTag: vi.fn(),
      onOpenConnectionHealthForGroup: vi.fn(),
      connectionTags: [{ id: 'empty', name: 'Empty', connectionIds: [] }],
      connections: [],
    }) as Array<{ key?: string; disabled?: boolean }>;

    expect(items.find((item) => item?.key === 'connection-health')?.disabled).toBe(true);
  });
});
