import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import SidebarConnectionRail from './SidebarConnectionRail';

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span data-icon="true" />;
  return {
    AimOutlined: Icon,
    DatabaseOutlined: Icon,
    FileAddOutlined: Icon,
    FolderOpenOutlined: Icon,
    ImportOutlined: Icon,
    MenuUnfoldOutlined: Icon,
    RobotOutlined: Icon,
    SettingOutlined: Icon,
    TableOutlined: Icon,
  };
});

describe('SidebarConnectionRail', () => {
  it('renders the collapsed sidebar toggle at the top of the fixed rail', () => {
    const expandSidebar = vi.fn();
    const noop = vi.fn();
    const renderer = create(
      <SidebarConnectionRail
        labels={{
          railSystemActions: 'System actions',
          railObjectActions: 'Object actions',
          newGroup: 'New group',
          batchTables: 'Batch tables',
          batchDatabases: 'Batch databases',
          dataImport: 'Data import',
          openExternalSqlFile: 'Open SQL file',
          locateCurrentTable: 'Locate table',
          locateCurrentTableUnavailable: 'No table',
          aiAssistant: 'AI assistant',
          settings: 'Settings',
        }}
        handlers={{
          openCreateTagModal: noop,
          openBatchTableExport: noop,
          openBatchDatabaseExport: noop,
          openDataImport: noop,
          openExternalSqlFile: noop,
          locateActiveTab: noop,
          toggleAI: noop,
          openSettings: noop,
        }}
        canLocateActiveTab
        sidebarExpandAction={{ label: 'Expand sidebar', onClick: expandSidebar }}
      />,
    );

    const rail = renderer.root.findByProps({ 'data-sidebar-fixed-rail': 'true' });
    const primaryActions = rail.findByProps({ className: 'gn-v2-rail-primary-actions' });
    const toggleSlot = rail.findByProps({ className: 'gn-v2-rail-sidebar-toggle-slot' });
    const toggle = rail.findByProps({ 'data-sidebar-toggle-placement': 'fixed-rail' });
    expect(primaryActions.children.indexOf(toggleSlot)).toBe(0);
    expect(primaryActions.findAllByType('button').slice(0, 2).map((button) => button.props['aria-label'])).toEqual([
      'Expand sidebar',
      'New group',
    ]);
    expect(toggle.props['aria-label']).toBe('Expand sidebar');
    expect(toggle.props['aria-expanded']).toBe(false);

    toggle.props.onClick();
    expect(expandSidebar).toHaveBeenCalledTimes(1);
  });

  it('opens the data import workbench from its dedicated rail action', () => {
    const openDataImport = vi.fn();
    const noop = vi.fn();
    const renderer = create(
      <SidebarConnectionRail
        labels={{
          railSystemActions: 'System actions',
          railObjectActions: 'Object actions',
          newGroup: 'New group',
          batchTables: 'Batch tables',
          batchDatabases: 'Batch databases',
          dataImport: 'Data import',
          openExternalSqlFile: 'Open SQL file',
          locateCurrentTable: 'Locate table',
          locateCurrentTableUnavailable: 'No table',
          aiAssistant: 'AI assistant',
          settings: 'Settings',
        }}
        handlers={{
          openCreateTagModal: noop,
          openBatchTableExport: noop,
          openBatchDatabaseExport: noop,
          openDataImport,
          openExternalSqlFile: noop,
          locateActiveTab: noop,
          toggleAI: noop,
          openSettings: noop,
        }}
        canLocateActiveTab
      />,
    );

    const action = renderer.root.findByProps({
      'data-sidebar-data-import-action': 'true',
    });
    action.props.onClick();

    expect(action.props['aria-label']).toBe('Data import');
    expect(openDataImport).toHaveBeenCalledTimes(1);
  });

  it('keeps the current table locator in the fixed rail when object actions move to the title bar', () => {
    const locateActiveTab = vi.fn();
    const noop = vi.fn();
    const renderer = create(
      <SidebarConnectionRail
        labels={{
          railSystemActions: 'System actions',
          railObjectActions: 'Object actions',
          newGroup: 'New group',
          batchTables: 'Batch tables',
          batchDatabases: 'Batch databases',
          dataImport: 'Data import',
          openExternalSqlFile: 'Open SQL file',
          locateCurrentTable: 'Locate table',
          locateCurrentTableUnavailable: 'No table',
          aiAssistant: 'AI assistant',
          settings: 'Settings',
        }}
        handlers={{
          openCreateTagModal: noop,
          openBatchTableExport: noop,
          openBatchDatabaseExport: noop,
          openDataImport: noop,
          openExternalSqlFile: noop,
          locateActiveTab,
          toggleAI: noop,
          openSettings: noop,
        }}
        canLocateActiveTab
        showObjectActions={false}
      />,
    );

    const rail = renderer.root.findByProps({ 'data-sidebar-fixed-rail': 'true' });
    const locateAction = rail.findByProps({ 'data-sidebar-locate-current-tab-action': 'true' });

    expect(rail.findAllByProps({ 'data-sidebar-create-group-action': 'true' })).toHaveLength(0);
    expect(locateAction.props['aria-label']).toBe('Locate table');
    locateAction.props.onClick();
    expect(locateActiveTab).toHaveBeenCalledTimes(1);
  });

  it('keeps workbench actions in the fixed secondary rail above AI and settings', () => {
    const noop = vi.fn();
    const renderer = create(
      <SidebarConnectionRail
        labels={{
          railSystemActions: 'System actions',
          railObjectActions: 'Object actions',
          newGroup: 'New group',
          batchTables: 'Batch tables',
          batchDatabases: 'Batch databases',
          dataImport: 'Data import',
          openExternalSqlFile: 'Open SQL file',
          locateCurrentTable: 'Locate table',
          locateCurrentTableUnavailable: 'No table',
          aiAssistant: 'AI assistant',
          settings: 'Settings',
        }}
        handlers={{
          openCreateTagModal: noop,
          openBatchTableExport: noop,
          openBatchDatabaseExport: noop,
          openDataImport: noop,
          openExternalSqlFile: noop,
          locateActiveTab: noop,
          toggleAI: noop,
          openSettings: noop,
        }}
        canLocateActiveTab
        workbenchActions={(
          <>
            <button type="button" aria-label="SQL analysis" data-sidebar-sql-analysis-action="true" />
            <button type="button" aria-label="SQL audit" data-sidebar-sql-audit-action="true" />
          </>
        )}
      />,
    );

    const rail = renderer.root.findByProps({ 'data-sidebar-fixed-rail': 'true' });
    const secondaryActions = rail.findByProps({ className: 'gn-v2-rail-secondary-actions' });
    const labels = secondaryActions.findAllByType('button').map((button) => button.props['aria-label']);

    expect(rail.findByProps({ className: 'gn-v2-rail-items' })).toBeTruthy();
    expect(labels).toEqual(['SQL analysis', 'SQL audit', 'AI assistant', 'Settings']);
  });
});
