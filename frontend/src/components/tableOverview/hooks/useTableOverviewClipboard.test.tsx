// @vitest-environment jsdom

import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedConnection, TabData } from '../../../types';
import type { ShortcutPlatform } from '../../../utils/shortcuts';
import { useSidebarTableClipboard } from '../../sidebar/useSidebarTableClipboard';
import { clearSidebarTableClipboard } from '../../sidebar/sidebarTableClipboardSession';
import { useTableOverviewClipboard } from './useTableOverviewClipboard';

const mocks = vi.hoisted(() => ({
  addTab: vi.fn(), copyTables: vi.fn(), confirmMutation: vi.fn(),
  success: vi.fn(), error: vi.fn(), warning: vi.fn(),
}));
const connections: SavedConnection[] = [
  { id: 'source', name: 'Source', config: { type: 'mysql', host: 'fixture.invalid', port: 3306, user: '' } },
  { id: 'target', name: 'Target', config: { type: 'postgres', host: 'target.invalid', port: 5432, user: '' } },
];
const sourceNode = {
  type: 'table', title: 'orders',
  dataRef: { ...connections[0], dbName: 'shop', schemaName: '', tableName: 'orders' },
};

vi.mock('../../../store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({ connections, addTab: mocks.addTab, activeTabId: 'overview' }),
}));
vi.mock('antd', () => ({ message: { success: mocks.success, error: mocks.error, warning: mocks.warning } }));
vi.mock('../../tableCopyAction', () => ({ confirmCopyTables: mocks.copyTables }));
vi.mock('../../../utils/productionRiskConfirm', () => ({ confirmProductionMutation: mocks.confirmMutation }));

describe('table clipboard across overview and sidebar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selectedNames: string[];
  let tab: TabData;
  let platform: ShortcutPlatform;
  const treeCopy = vi.fn();
  const treeSync = vi.fn();
  const loadData = vi.fn(async () => {});
  const writeClipboard = vi.fn(async (_text: string) => {});
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  const Harness = () => {
    const treeRef = useRef<HTMLDivElement | null>(null);
    const overviewRef = useRef<HTMLDivElement | null>(null);
    const treeNodesRef = useRef([sourceNode]);
    useSidebarTableClipboard({
      rootRef: treeRef, selectedNodesRef: treeNodesRef, connectionIds: ['source', 'target'],
      activeShortcutPlatform: platform, onCopyTables: treeCopy, onOpenDataSyncWorkbench: treeSync,
    });
    useTableOverviewClipboard({
      rootRef: overviewRef, selectedNames, tab, connection: connections.find((connection) => connection.id === tab.connectionId),
      activeShortcutPlatform: platform, loadData, blocked: false,
    });
    return <><div ref={treeRef} data-testid="tree" /><div ref={overviewRef} data-testid="overview"><input /></div></>;
  };

  const render = async () => { await act(async () => { root.render(<Harness />); }); };
  const fire = async (region: 'tree' | 'overview', key: string, shiftKey = false) => {
    const target = container.querySelector<HTMLElement>(`[data-testid="${region}"]`)!;
    const event = new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, shiftKey,
      metaKey: platform === 'mac', ctrlKey: platform === 'windows',
    });
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(event);
    });
    return event;
  };

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    clearSidebarTableClipboard();
    mocks.confirmMutation.mockResolvedValue(true);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writeClipboard } });
    selectedNames = ['orders', 'customers'];
    tab = { id: 'overview', title: 'Tables', type: 'table-overview', connectionId: 'source', dbName: 'shop' };
    platform = 'mac';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearSidebarTableClipboard();
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
    vi.unstubAllGlobals();
  });

  it.each(['mac', 'windows'] as const)('copies multiple overview tables and pastes through the shared confirmation on %s', async (nextPlatform) => {
    platform = nextPlatform;
    await render();
    expect((await fire('overview', 'c')).defaultPrevented).toBe(true);
    expect((await fire('overview', 'v')).defaultPrevented).toBe(true);
    expect(mocks.copyTables).toHaveBeenCalledWith(expect.objectContaining({
      dbName: 'shop', sourceTableNames: ['orders', 'customers'], sourceSchemaName: '',
    }));
    expect(mocks.confirmMutation).toHaveBeenCalledTimes(1);
  });

  it('pastes a table copied from the sidebar into an unselected overview database', async () => {
    await fire('tree', 'c');
    selectedNames = [];
    await render();
    await fire('overview', 'v');
    expect(mocks.copyTables).toHaveBeenCalledWith(expect.objectContaining({ sourceTableNames: ['orders'] }));
  });

  it('pastes overview selections back into the sidebar', async () => {
    await fire('overview', 'c');
    await fire('tree', 'v');
    expect(treeCopy.mock.calls[0][0].map((node: typeof sourceNode) => node.dataRef.tableName)).toEqual(['orders', 'customers']);
    expect(mocks.copyTables).not.toHaveBeenCalled();
  });

  it.each([['source', 'archive'], ['target', 'warehouse']])('opens the migration workbench for %s / %s', async (connectionId, dbName) => {
    await fire('overview', 'c');
    tab = { ...tab, connectionId, dbName };
    selectedNames = [];
    await render();
    await fire('overview', 'v');
    expect(mocks.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'data-sync',
      dataSyncPastePrefill: {
        source: { connectionId: 'source', database: 'shop', tables: ['orders', 'customers'] },
        target: { connectionId, database: dbName },
      },
    }));
    expect(mocks.copyTables).not.toHaveBeenCalled();
  });

  it.each(['tree', 'overview'] as const)('copies only table names with Shift+C in %s', async (region) => {
    await fire(region, 'c', true);
    expect(writeClipboard).toHaveBeenCalledWith(region === 'tree' ? 'orders' : 'orders\ncustomers');
    await fire(region, 'v');
    expect(treeCopy).not.toHaveBeenCalled();
    expect(mocks.copyTables).not.toHaveBeenCalled();
  });

  it('leaves text editing and native clipboard events inside the search input alone', async () => {
    await fire('tree', 'c');
    const input = container.querySelector('input')!;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.dispatchEvent(paste);
    });
    expect(paste.defaultPrevented).toBe(false);
    expect(mocks.copyTables).not.toHaveBeenCalled();
    expect(mocks.addTab).not.toHaveBeenCalled();
  });

  it('allows pasting into a different target within the native event deduplication window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await fire('overview', 'c');
      selectedNames = [];
      tab = { ...tab, dbName: 'archive' };
      await render();
      await fire('overview', 'v');
      clock.mockReturnValue(1050);
      tab = { ...tab, connectionId: 'target', dbName: 'warehouse' };
      await render();
      await fire('overview', 'v');

      expect(mocks.addTab).toHaveBeenCalledTimes(2);
      expect(mocks.addTab.mock.calls.map(([added]) => added.dataSyncPastePrefill.target.database)).toEqual(['archive', 'warehouse']);
    } finally {
      clock.mockRestore();
    }
  });

  it('still handles a keydown and native paste event for the same target only once', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await fire('overview', 'c');
      await fire('overview', 'v');
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      await act(async () => { container.querySelector('[data-testid="overview"]')!.dispatchEvent(paste); });

      expect(paste.defaultPrevented).toBe(true);
      expect(mocks.copyTables).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});
