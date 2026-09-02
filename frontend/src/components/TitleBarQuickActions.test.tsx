import React from 'react';
import { readFileSync } from 'node:fs';
import { create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import TitleBarQuickActions from './TitleBarQuickActions';

const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
const getCssRuleBody = (selector: string) => {
  const match = appCss.match(new RegExp(`${selector}\\s*\\{(?<body>[^}]*)\\}`, 's'));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.groups?.body ?? '';
};

vi.mock('antd', () => ({
  Dropdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@ant-design/icons', () => ({
  MoreOutlined: () => <span data-icon="more" />,
}));

describe('TitleBarQuickActions', () => {
  it('keeps the unused titlebar span draggable while quick-action buttons remain clickable', () => {
    const actionSlot = getCssRuleBody('\\.gonavi-titlebar-quick-actions-slot');
    const actionContainer = getCssRuleBody('\\.gn-v2-titlebar-quick-actions');
    const actionButtons = getCssRuleBody('\\.gn-v2-titlebar-quick-action,\\s*\\.gn-v2-titlebar-quick-more');

    expect(actionSlot).toContain('-webkit-app-region: drag;');
    expect(actionSlot).toContain('--wails-draggable: drag;');
    expect(actionContainer).toContain('flex: 0 1 auto;');
    expect(actionContainer).toContain('-webkit-app-region: drag;');
    expect(actionContainer).toContain('--wails-draggable: drag;');
    expect(actionButtons).toContain('-webkit-app-region: no-drag;');
    expect(actionButtons).toContain('--wails-draggable: no-drag;');
    expect(appCss).toContain('body[data-ui-version="v2"] .gn-v2-titlebar-quick-more .gn-v2-titlebar-quick-label');
    expect(appCss).toContain('display: inline;');
    expect(appCss).not.toContain('body[data-ui-version="v2"] .gn-v2-titlebar-quick-more span');
  });

  it('renders primary actions with visible labels and keeps secondary actions in More', () => {
    const onBatchTables = vi.fn();
    const onBatchDatabases = vi.fn();
    const onImport = vi.fn();
    const onExternalSql = vi.fn();
    const onSlowQuery = vi.fn();
    const onSqlAudit = vi.fn();
    const onSchemaCompare = vi.fn();
    const onDataCompare = vi.fn();
    const onDataSync = vi.fn();
    const renderer = create(
      <TitleBarQuickActions
        label="Object actions"
        moreLabel="More tools"
        actions={[
          {
            key: 'batch-actions',
            label: 'Batch operations',
            icon: <span />,
            menu: [
              { key: 'batch-tables', label: 'Batch tables', icon: <span />, onClick: onBatchTables },
              { key: 'batch-databases', label: 'Batch databases', icon: <span />, onClick: onBatchDatabases },
              { key: 'data-import', label: 'Data import', icon: <span />, onClick: onImport },
            ],
          },
          {
            key: 'sql-tools',
            label: 'SQL tools',
            icon: <span />,
            menu: [
              { key: 'slow-query', label: 'Slow SQL workbench', icon: <span />, onClick: onSlowQuery, disabled: true },
              { key: 'sql-audit', label: 'SQL Audit Center', icon: <span />, onClick: onSqlAudit },
            ],
          },
          {
            key: 'data-workflow',
            label: 'Data workflows',
            icon: <span />,
            menu: [
              { key: 'schema-compare', label: 'Schema Compare', icon: <span />, onClick: onSchemaCompare },
              { key: 'data-compare', label: 'Data Compare', icon: <span />, onClick: onDataCompare },
              { key: 'data-sync', label: 'Data Sync', icon: <span />, onClick: onDataSync },
            ],
          },
          { key: 'open-external-sql-file', label: 'Run SQL file', icon: <span />, onClick: onExternalSql, priority: 'secondary' },
        ]}
      />,
    );

    const toolbar = renderer.root.findByProps({ 'data-titlebar-quick-actions': 'true' });
    expect(toolbar.props['aria-label']).toBe('Object actions');
    expect(toolbar.props['data-no-titlebar-toggle']).toBe('true');
    expect(toolbar.findAllByProps({ className: 'gn-v2-titlebar-quick-label' })).toHaveLength(1);
    const batchMenuButton = toolbar.findByProps({ 'data-titlebar-quick-menu': 'batch-actions' });
    expect(batchMenuButton.props['data-no-titlebar-toggle']).toBe('true');
    const dropdowns = renderer.root.findAll((node) => Array.isArray(node.props.menu?.items)) as ReactTestInstance[];
    expect(dropdowns).toHaveLength(4);
    const batchDropdown = dropdowns.find((dropdown) => dropdown.props.menu.items.some((item: { key: string }) => item.key === 'batch-tables'));
    expect(batchDropdown).toBeDefined();
    const batchPopup = create(batchDropdown?.props.popupRender(<div data-menu-content="true" />));
    expect(batchPopup.root.findAllByProps({ className: 'gn-v2-context-menu-header gn-v2-action-menu-header' })).toHaveLength(0);
    expect(batchPopup.root.findAllByProps({ 'data-menu-content': 'true' })).toHaveLength(1);
    const moreDropdown = dropdowns.find((dropdown) => dropdown.props.menu.items.some((item: { key: string }) => item.key === 'open-external-sql-file'));
    const morePopup = create(moreDropdown?.props.popupRender(<div data-menu-content="true" />));
    expect(morePopup.root.findAllByProps({ className: 'gn-v2-context-menu-header gn-v2-action-menu-header' })).toHaveLength(0);
    const textOf = (instance: ReactTestInstance) => instance
      .findAllByType('span')
      .flatMap((span) => span.children.filter((child): child is string => typeof child === 'string'))
      .join(' ');
    expect(textOf(batchMenuButton)).toContain('Batch operations');
    const moreButton = toolbar.findByProps({ 'data-titlebar-quick-more': 'true' });
    expect(moreButton.findByProps({ 'data-icon': 'more' })).toBeDefined();
    expect(moreButton.findByProps({ className: 'gn-v2-titlebar-quick-label' }).children).toContain('More tools');
    expect(textOf(moreButton)).toContain('More tools');

    const batchMenuItems = batchDropdown?.props.menu.items as Array<{ key: string; onClick?: () => void }>;
    batchMenuItems.find((item) => item.key === 'batch-tables')?.onClick?.();
    batchMenuItems.find((item) => item.key === 'batch-databases')?.onClick?.();
    batchMenuItems.find((item) => item.key === 'data-import')?.onClick?.();
    expect(onBatchTables).toHaveBeenCalledTimes(1);
    expect(onBatchDatabases).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledTimes(1);
    const sqlDropdown = dropdowns.find((dropdown) => dropdown.props.menu.items.some((item: { key: string }) => item.key === 'slow-query'));
    expect(sqlDropdown?.props.menu.items.find((item: { key: string }) => item.key === 'slow-query')?.disabled).toBe(true);
    sqlDropdown?.props.menu.items.find((item: { key: string }) => item.key === 'sql-audit')?.onClick?.();
    expect(onSqlAudit).toHaveBeenCalledTimes(1);
    const workflowDropdown = dropdowns.find((dropdown) => dropdown.props.menu.items.some((item: { key: string }) => item.key === 'schema-compare'));
    workflowDropdown?.props.menu.items.find((item: { key: string }) => item.key === 'schema-compare')?.onClick?.();
    workflowDropdown?.props.menu.items.find((item: { key: string }) => item.key === 'data-compare')?.onClick?.();
    workflowDropdown?.props.menu.items.find((item: { key: string }) => item.key === 'data-sync')?.onClick?.();
    expect(onSchemaCompare).toHaveBeenCalledTimes(1);
    expect(onDataCompare).toHaveBeenCalledTimes(1);
    expect(onDataSync).toHaveBeenCalledTimes(1);
    expect(onExternalSql).not.toHaveBeenCalled();
  });
});
