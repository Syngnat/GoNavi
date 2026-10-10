/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { buildSidebarTablePinKey } from '../../utils/sidebarTreeOrder';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import { useSidebarV2ActionHandlers } from './useSidebarV2ActionHandlers';

describe('useSidebarV2ActionHandlers table pin', () => {
  it('reorders the open postgres schema in place instead of reloading the database', () => {
    const previousPins = useStore.getState().pinnedSidebarTables;
    const previousSort = useStore.getState().tableSortPreference;
    useStore.setState({ pinnedSidebarTables: [], tableSortPreference: {} });
    try {
      const columns = { key: 'public-orders-columns', title: 'columns', type: 'folder-columns' as const };
      const orders: SidebarTreeNode = {
        key: 'public-orders',
        title: 'orders',
        type: 'table',
        children: [columns],
        dataRef: { id: 'pg', dbName: 'app', schemaName: 'public', tableName: 'orders', config: { type: 'postgres' } },
      };
      const users: SidebarTreeNode = {
        key: 'public-users',
        title: 'users',
        type: 'table',
        dataRef: { id: 'pg', dbName: 'app', schemaName: 'public', tableName: 'users', config: { type: 'postgres' } },
      };
      const publicTables: SidebarTreeNode = {
        key: 'public-tables',
        title: 'tables',
        type: 'object-group',
        dataRef: { id: 'pg', dbName: 'app', groupKey: 'tables', schemaName: 'public' },
        children: [users, orders],
      };
      const tree: SidebarTreeNode[] = [{
        key: 'pg-app',
        title: 'app',
        type: 'database',
        children: [{
          key: 'schema-public',
          title: 'public',
          type: 'object-group',
          dataRef: { groupKey: 'schema', schemaName: 'public', schemaLazy: true },
          children: [publicTables],
        }],
      }];
      const replaced: Array<[string, SidebarTreeNode[] | undefined]> = [];
      const loadTables = () => {
        throw new Error('pin must not reload tables');
      };
      const handlers = useSidebarV2ActionHandlers({
        connections: [],
        connectionTags: [],
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
        loadingNodesRef: { current: new Set() },
        treeDataRef: { current: tree },
        findTreeNodeByKeyRef: { current: () => null },
        refreshV2TableContextMenuStatsRef: { current: () => undefined },
        setSidebarTablePinned: useStore.getState().setSidebarTablePinned,
        replaceTreeNodeChildren: (key: string, children: SidebarTreeNode[] | undefined) => {
          replaced.push([String(key), children]);
        },
        loadTables,
      } as any);

      handlers.handleV2TableContextMenuAction(orders, 'pin-table');

      expect(useStore.getState().pinnedSidebarTables).toEqual([
        buildSidebarTablePinKey('pg', 'app', 'orders', 'public'),
      ]);
      expect(replaced).toHaveLength(1);
      expect(replaced[0][0]).toBe('public-tables');
      const children = replaced[0][1] || [];
      expect(children.filter((node) => node.type === 'table').map((node) => node.title)).toEqual(['orders', 'users']);
      expect(children[1].children).toEqual([columns]);
      expect(tree[0].children?.[0].children?.[0]).toBe(publicTables);
    } finally {
      useStore.setState({ pinnedSidebarTables: previousPins, tableSortPreference: previousSort });
    }
  });
});
