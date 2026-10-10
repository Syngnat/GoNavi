import { describe, expect, it } from 'vitest';
import { buildSidebarTablePinKey } from '../../utils/sidebarTreeOrder';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import { collectSidebarTablePinUpdates } from './sidebarTablePinRefresh';

const tableNode = (
  schemaName: string,
  tableName: string,
  pinned = false,
): SidebarTreeNode => ({
  key: `${schemaName}-${tableName}`,
  title: tableName,
  type: 'table',
  children: [{ key: `${schemaName}-${tableName}-columns`, title: 'columns', type: 'folder-columns' }],
  dataRef: {
    id: 'pg',
    dbName: 'app',
    schemaName,
    tableName,
    ...(pinned ? { pinnedSidebarTable: true } : {}),
  },
});

const tablesGroup = (schemaName: string, tables: SidebarTreeNode[]): SidebarTreeNode => ({
  key: `${schemaName}-tables`,
  title: 'tables',
  type: 'object-group',
  dataRef: { id: 'pg', dbName: 'app', groupKey: 'tables', schemaName },
  children: tables,
});

const schemaTree = (): SidebarTreeNode[] => [{
  key: 'pg-app',
  title: 'app',
  type: 'database',
  children: [
    {
      key: 'schema-public',
      title: 'public',
      type: 'object-group',
      dataRef: { id: 'pg', dbName: 'app', groupKey: 'schema', schemaName: 'public', schemaLazy: true },
      children: [tablesGroup('public', [tableNode('public', 'users'), tableNode('public', 'orders')])],
    },
    {
      key: 'schema-sales',
      title: 'sales',
      type: 'object-group',
      dataRef: { id: 'pg', dbName: 'app', groupKey: 'schema', schemaName: 'sales', schemaLazy: true },
      children: [tablesGroup('sales', [tableNode('sales', 'orders')])],
    },
  ],
}];

const pinKey = (schemaName: string, tableName: string) => (
  buildSidebarTablePinKey('pg', 'app', tableName, schemaName)
);

describe('collectSidebarTablePinUpdates', () => {
  it('moves a pinned postgres table into the pinned section without touching sibling schemas', () => {
    const tree = schemaTree();
    const ordersColumns = tree[0].children?.[0].children?.[0].children?.[1].children;

    const updates = collectSidebarTablePinUpdates(tree, { connectionId: 'pg', dbName: 'app' }, {
      pinnedSidebarTables: [pinKey('public', 'orders')],
      sortBy: 'name',
    });

    expect(updates.map((update) => update.key)).toEqual(['public-tables']);
    const titles = updates[0].children.map((node) => node.dataRef?.sectionKind || node.title);
    expect(titles).toEqual(['pinned', 'orders', 'all', 'users']);
    expect(updates[0].children[1].children).toBe(ordersColumns);
    expect(updates[0].children[1].dataRef?.pinnedSidebarTable).toBe(true);
    expect(tree[0].children?.[1].children?.[0].children?.[0].title).toBe('orders');
  });

  it('sorts several pinned tables by name and drops sections after the last unpin', () => {
    const tree = schemaTree();
    const publicGroup = tree[0].children?.[0].children?.[0] as SidebarTreeNode;
    const pinned = collectSidebarTablePinUpdates(tree, { connectionId: 'pg', dbName: 'app' }, {
      pinnedSidebarTables: [pinKey('public', 'orders'), pinKey('public', 'users')],
      sortBy: 'name',
    });
    publicGroup.children = pinned[0].children;

    const titles = pinned[0].children.filter((node) => node.type === 'table').map((node) => node.title);
    expect(titles).toEqual(['orders', 'users']);

    const unpinned = collectSidebarTablePinUpdates(tree, { connectionId: 'pg', dbName: 'app' }, {
      pinnedSidebarTables: [],
      sortBy: 'name',
    });
    expect(unpinned[0].children.map((node) => node.title)).toEqual(['orders', 'users']);
    expect(unpinned[0].children.some((node) => node.type === 'v2-table-section')).toBe(false);
  });

  it('leaves an already matching mysql table group unchanged', () => {
    const users: SidebarTreeNode = {
      key: 'users',
      title: 'users',
      type: 'table',
      dataRef: { id: 'my', dbName: 'app', schemaName: '', tableName: 'users', pinnedSidebarTable: true },
    };
    const tree: SidebarTreeNode[] = [{
      key: 'my-app-tables',
      title: 'tables',
      type: 'object-group',
      dataRef: { id: 'my', dbName: 'app', groupKey: 'tables' },
      children: [
        { key: 'section', title: 'pinned', type: 'v2-table-section', dataRef: { sectionKind: 'pinned' } },
        users,
      ],
    }];

    expect(collectSidebarTablePinUpdates(tree, { connectionId: 'my', dbName: 'app' }, {
      pinnedSidebarTables: [buildSidebarTablePinKey('my', 'app', 'users', '')],
      sortBy: 'name',
    })).toEqual([]);
  });
});
