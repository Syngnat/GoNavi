import { describe, expect, it } from 'vitest';

import {
  V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT,
  V2_COMMAND_SEARCH_MAX_TREE_RESULTS,
  buildV2CommandSearchTreeIndex,
  collectSidebarSubtreeKeys,
  filterV2CommandSearchTreeItems,
  parseV2CommandSearchQuery,
  resolveSidebarDatabaseTreePruneKeys,
  shouldClearSidebarNodeChildrenOnCollapse,
  type V2CommandSearchItem,
} from './sidebarV2Utils';

const buildNodeItems = (count: number): V2CommandSearchItem[] => {
  return Array.from({ length: count }, (_, index) => ({
    key: `node-table-${index}`,
    kind: 'node' as const,
    title: `fs_order_${index}`,
    meta: `开发240 · front_end_sys_${index % 4}`,
    icon: null,
    node: {
      type: index % 6 === 0 ? 'view' : 'table',
      key: `table-${index}`,
      title: `fs_order_${index}`,
      dataRef: {
        tableName: `fs_order_${index}`,
        viewName: index % 6 === 0 ? `v_order_${index}` : undefined,
        dbName: `front_end_sys_${index % 4}`,
        name: `obj_${index}`,
        config: {
          host: `10.0.0.${index % 16}`,
        },
      },
    },
  }));
};

describe('sidebarV2 command search performance helpers', () => {
  it('keeps the initial tree result limit when the query is empty', () => {
    const items = buildNodeItems(V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT + 80);

    expect(
      filterV2CommandSearchTreeItems(items, parseV2CommandSearchQuery('')),
    ).toHaveLength(V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT);
  });

  it('caps broad keyword matches to avoid rendering the full loaded tree', () => {
    const items = buildNodeItems(V2_COMMAND_SEARCH_MAX_TREE_RESULTS + 160);

    const result = filterV2CommandSearchTreeItems(
      items,
      parseV2CommandSearchQuery('fs_order'),
    );

    expect(result).toHaveLength(V2_COMMAND_SEARCH_MAX_TREE_RESULTS);
    expect(result[0]?.key).toBe('node-table-0');
    expect(result[result.length - 1]?.key).toBe(`node-table-${V2_COMMAND_SEARCH_MAX_TREE_RESULTS - 1}`);
  });

  it('returns the same matches when filtering with a prebuilt search index', () => {
    const items = buildNodeItems(200);
    const index = buildV2CommandSearchTreeIndex(items);
    const query = parseV2CommandSearchQuery('@fs_order_1');

    expect(filterV2CommandSearchTreeItems(index, query)).toEqual(
      filterV2CommandSearchTreeItems(items, query),
    );
  });

  it('prunes only cold collapsed database trees when too many object trees stay loaded', () => {
    expect(resolveSidebarDatabaseTreePruneKeys({
      treeData: [
        {
          key: 'conn-1',
          title: 'conn-1',
          type: 'connection',
          children: [
            {
              key: 'conn-1-db-a',
              title: 'db-a',
              type: 'database',
              children: [{ key: 'a-tables', title: '表', type: 'object-group' }],
            },
            {
              key: 'conn-1-db-b',
              title: 'db-b',
              type: 'database',
              children: [{ key: 'b-tables', title: '表', type: 'object-group' }],
            },
            {
              key: 'conn-1-db-c',
              title: 'db-c',
              type: 'database',
              children: [{ key: 'c-tables', title: '表', type: 'object-group' }],
            },
            {
              key: 'conn-1-db-d',
              title: 'db-d',
              type: 'database',
              children: [{ key: 'd-tables', title: '表', type: 'object-group' }],
            },
          ],
        },
      ],
      expandedKeys: ['conn-1-db-c'],
      selectedKeys: [],
      activeDatabaseKey: 'conn-1-db-d',
      touchedAtByDatabaseKey: {
        'conn-1-db-a': 10,
        'conn-1-db-b': 20,
        'conn-1-db-c': 30,
        'conn-1-db-d': 40,
      },
      maxLoadedDatabases: 2,
    })).toEqual(['conn-1-db-a', 'conn-1-db-b']);
  });

  it('keeps database and table children loaded on collapse', () => {
    const tableChildren = Array.from({ length: 180 }, (_, index) => ({
      key: `table-${index}`,
      title: `table_${index}`,
      type: 'table' as const,
    }));
    const largeTableGroup = {
      key: 'conn-1-db-a-tables',
      title: '表',
      type: 'object-group' as const,
      dataRef: { groupKey: 'tables' },
      children: tableChildren,
    };

    expect(collectSidebarSubtreeKeys(largeTableGroup)).toHaveLength(180);
    expect(shouldClearSidebarNodeChildrenOnCollapse(largeTableGroup)).toBe(false);
    expect(shouldClearSidebarNodeChildrenOnCollapse({
      type: 'object-group',
      children: tableChildren.slice(0, 8),
    })).toBe(false);
    expect(shouldClearSidebarNodeChildrenOnCollapse({
      type: 'database',
      children: tableChildren,
    })).toBe(false);
    expect(shouldClearSidebarNodeChildrenOnCollapse({
      type: 'connection',
      children: tableChildren,
    })).toBe(true);
    expect(shouldClearSidebarNodeChildrenOnCollapse({
      type: 'table',
      children: tableChildren,
    })).toBe(false);
  });
});
