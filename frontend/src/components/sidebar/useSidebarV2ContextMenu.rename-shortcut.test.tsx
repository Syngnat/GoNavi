/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarV2ContextMenu } from './useSidebarV2ContextMenu';

const tableNode = {
  key: 'table-1',
  type: 'table',
  title: 'T_WARE',
  dataRef: {
    id: 'conn-1',
    dbName: 'mkefu_prod1',
    tableName: 'T_WARE',
  },
};

const secondTableNode = {
  key: 'table-2',
  type: 'table',
  title: 'T_ORDER',
  dataRef: {
    id: 'conn-1',
    dbName: 'mkefu_prod1',
    tableName: 'T_ORDER',
  },
};

const renderHook = (initialNodes: any[] = [tableNode]) => {
  const selectedNodesRef = { current: initialNodes };
  const handleTableAction = vi.fn();
  const handleMultiTableAction = vi.fn();
  let api: ReturnType<typeof useSidebarV2ContextMenu> | null = null;
  const Probe = () => {
    api = useSidebarV2ContextMenu({
      connections: [],
      connectionTags: [],
      activeShortcutPlatform: 'mac',
      flattenConnectionNodes: () => [],
      v2TreeMetrics: {
        databaseTableCounts: new Map(),
        objectGroupCounts: new Map(),
      },
      tableSortPreference: {},
      pinnedSidebarTables: [],
      pinnedSidebarDatabases: [],
      selectedNodesRef,
      getConnectionNodeForAction: vi.fn(),
      buildRuntimeConfig: vi.fn(),
      extractObjectName: (value: string) => value,
      isPostgresSchemaDialect: () => false,
      loadTables: vi.fn(async () => undefined),
      getDatabaseNodeRef: vi.fn(),
      handleExportSchemaSQL: vi.fn(async () => undefined),
      handleDeleteSchema: vi.fn(),
      openRenameSchemaModal: vi.fn(),
      openSchemaVisibilitySettings: vi.fn(),
      supportsConnectionVisibility: () => false,
      resolveMessagePublishTarget: vi.fn(),
      addSqlLog: vi.fn(),
      handleV2TableContextMenuAction: handleTableAction,
      handleV2MultiTableContextMenuAction: handleMultiTableAction,
      handleV2TableGroupContextMenuAction: vi.fn(),
      handleV2DatabaseContextMenuAction: vi.fn(),
      handleV2ConnectionContextMenuAction: vi.fn(),
      handleV2ConnectionGroupContextMenuAction: vi.fn(),
    });
    return null;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  return {
    api: api as unknown as ReturnType<typeof useSidebarV2ContextMenu>,
    selectedNodesRef,
    handleTableAction,
    handleMultiTableAction,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

describe('sidebar table rename shortcut', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renames the selected table when F2 is pressed inside the sidebar tree', () => {
    const { handleTableAction, cleanup } = renderHook();
    const treePanel = document.createElement('div');
    treePanel.setAttribute('data-sidebar-tree-panel', 'true');
    const row = document.createElement('div');
    row.tabIndex = 0;
    treePanel.appendChild(row);
    document.body.appendChild(treePanel);

    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(handleTableAction).toHaveBeenCalledWith(tableNode, 'rename-table');
    cleanup();
  });

  it('does not intercept F2 outside the sidebar tree', () => {
    const { api, handleTableAction, cleanup } = renderHook();
    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(handleTableAction).not.toHaveBeenCalled();
    expect(api.contextMenu).toBeNull();
    cleanup();
  });

  it('does not intercept F2 while editing a sidebar input', () => {
    const { handleTableAction, cleanup } = renderHook();
    const treePanel = document.createElement('div');
    treePanel.setAttribute('data-sidebar-tree-panel', 'true');
    const input = document.createElement('input');
    treePanel.appendChild(input);
    document.body.appendChild(treePanel);

    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(handleTableAction).not.toHaveBeenCalled();
    cleanup();
  });

  it('keeps F2 working after dragging a sidebar table selection that did not take focus', () => {
    const { handleTableAction, cleanup } = renderHook();
    const treePanel = document.createElement('div');
    treePanel.setAttribute('data-sidebar-tree-panel', 'true');
    const row = document.createElement('div');
    treePanel.appendChild(row);
    document.body.appendChild(treePanel);

    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(handleTableAction).toHaveBeenCalledWith(tableNode, 'rename-table');
    cleanup();
  });

  it('routes F2 to the multi-table rename flow when several tables are selected', () => {
    const { handleTableAction, handleMultiTableAction, cleanup } = renderHook([
      tableNode,
      secondTableNode,
    ]);
    const treePanel = document.createElement('div');
    treePanel.setAttribute('data-sidebar-tree-panel', 'true');
    const row = document.createElement('div');
    row.tabIndex = 0;
    treePanel.appendChild(row);
    document.body.appendChild(treePanel);

    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(handleTableAction).not.toHaveBeenCalled();
    expect(handleMultiTableAction).toHaveBeenCalledWith(
      [tableNode, secondTableNode],
      'rename-table',
    );
    cleanup();
  });

  it('ignores F2 when a non-table node is part of the selection', () => {
    const { handleTableAction, handleMultiTableAction, cleanup } = renderHook([
      tableNode,
      { key: 'db-1', type: 'database', title: 'mkefu_prod1' },
    ]);
    const treePanel = document.createElement('div');
    treePanel.setAttribute('data-sidebar-tree-panel', 'true');
    const row = document.createElement('div');
    row.tabIndex = 0;
    treePanel.appendChild(row);
    document.body.appendChild(treePanel);

    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(handleTableAction).not.toHaveBeenCalled();
    expect(handleMultiTableAction).not.toHaveBeenCalled();
    cleanup();
  });
});
