/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { buildSidebarTablePinKey } from '../../utils/sidebarTreeOrder';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import { useSidebarTablePinSync } from './useSidebarTablePinSync';

describe('useSidebarTablePinSync', () => {
  let renderer: ReactTestRenderer | undefined;
  const previousPins = useStore.getState().pinnedSidebarTables;

  afterEach(() => {
    act(() => renderer?.unmount());
    useStore.setState({ pinnedSidebarTables: previousPins });
  });

  it('applies an overview pin without reloading the schema tree', () => {
    useStore.setState({
      pinnedSidebarTables: [buildSidebarTablePinKey('pg', 'app', 'orders', 'public')],
      tableSortPreference: {},
    });
    const orders: SidebarTreeNode = {
      key: 'public-orders',
      title: 'orders',
      type: 'table',
      dataRef: { id: 'pg', dbName: 'app', schemaName: 'public', tableName: 'orders' },
    };
    const treeDataRef = { current: [{
      key: 'public-tables',
      title: 'tables',
      type: 'object-group' as const,
      dataRef: { id: 'pg', dbName: 'app', groupKey: 'tables', schemaName: 'public' },
      children: [orders],
    }] };
    const replaced: Array<{ key: string; children?: SidebarTreeNode[] }> = [];
    const Harness = () => {
      useSidebarTablePinSync({
        treeDataRef,
        replaceTreeNodeChildren: (key, children) => {
          replaced.push({ key: String(key), children });
        },
      });
      return null;
    };
    act(() => { renderer = create(React.createElement(Harness)); });

    act(() => {
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-table-pin-changed', {
        detail: { connectionId: 'pg', dbName: 'app' },
      }));
    });

    expect(replaced.map((update) => update.key)).toEqual(['public-tables']);
    expect(replaced[0].children?.some((node) => node.dataRef?.pinnedSidebarTable)).toBe(true);
    expect(orders.dataRef?.pinnedSidebarTable).toBeUndefined();
  });
});
