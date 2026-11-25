// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import {
  V2MultiTableContextMenuView,
  V2TableContextMenuView,
} from '../../V2TableContextMenu';
import { useTableOverviewTableActions } from './useTableOverviewTableActions';

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  drop: vi.fn(),
  truncate: vi.fn(),
}));

vi.mock('../../sidebar/sidebarMultiTableActions', () => ({
  runSidebarMultiTableClear: mocks.clear,
  runSidebarMultiTableDrop: mocks.drop,
  runSidebarMultiTableTruncate: mocks.truncate,
}));

const connection = {
  id: 'conn-1',
  name: 'shop',
  environmentType: 'local',
  config: {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'shop',
  },
};

const table = {
  name: 'orders',
  comment: '',
  rows: 0,
  dataSize: 0,
  indexSize: 0,
  engine: 'InnoDB',
  charset: 'utf8mb4',
  collation: 'utf8mb4_general_ci',
  createTime: '',
  updateTime: '',
};

const captureActions = () => {
  let api: ReturnType<typeof useTableOverviewTableActions> | null = null;
  const noop = vi.fn();
  const setV2ContextMenu = vi.fn();
  const Probe = () => {
    api = useTableOverviewTableActions({
      tab: { id: 'overview', title: 'Tables', type: 'table-overview', connectionId: 'conn-1', dbName: 'shop' },
      addTab: noop,
      schemaName: '',
      buildConfig: () => connection.config as any,
      connection: connection as any,
      loadData: noop,
      allowClear: true,
      pinnedSidebarTables: [],
      setSidebarTablePinned: noop,
      addAIContext: noop,
      setAIPanelVisible: noop,
      sortField: 'name',
      setSortField: noop,
      setSortOrder: noop,
      sortOrder: 'asc',
      tables: [table],
      sortedFiltered: [table],
      openTable: noop,
      openDesign: noop,
      openQueryForTable: noop,
      openTableDdl: noop,
      openTableInER: noop,
      handleCopyTableName: noop,
      handleCopyStructure: noop,
      handleCopyTable: noop,
      activeShortcutPlatform: 'mac',
      supportsCopyTable: true,
      metadataDialect: 'mysql',
      setV2ContextMenu,
    });
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return {
    api: api as unknown as ReturnType<typeof useTableOverviewTableActions>,
    setV2ContextMenu,
  };
};

describe('table overview multi-table danger actions', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  it.each([
    ['truncate-table', mocks.truncate],
    ['clear-table', mocks.clear],
    ['drop-table', mocks.drop],
  ] as const)('routes %s to all selected overview tables', (action, handler) => {
    const { api, setV2ContextMenu } = captureActions();
    const menu = api.renderV2OverviewTableContextMenu(
      table,
      ['orders', 'customers', 'orders'],
    ) as React.ReactElement;

    expect(menu.type).toBe(V2MultiTableContextMenuView);
    expect(menu.props.tableNames).toEqual(['orders', 'customers']);
    expect(menu.props.supportsOpenData).toBe(false);
    expect(menu.props.supportsRename).toBe(false);
    expect(menu.props.supportsBatchTables).toBe(false);

    act(() => menu.props.onAction(action));

    expect(setV2ContextMenu).toHaveBeenCalledWith(null);
    expect(handler).toHaveBeenCalledTimes(1);
    const [, nodes] = handler.mock.calls[0];
    expect(nodes.map((node: any) => node.dataRef.tableName)).toEqual(['orders', 'customers']);
    expect(nodes.every((node: any) => node.dataRef.id === 'conn-1')).toBe(true);
  });

  it('keeps the single-table menu when the right-clicked table is not in the multi-selection', () => {
    const { api } = captureActions();
    const menu = api.renderV2OverviewTableContextMenu(
      table,
      ['customers', 'users'],
    ) as React.ReactElement;

    expect(menu.type).toBe(V2TableContextMenuView);
    expect(menu.props.tableName).toBe('orders');
  });
});
