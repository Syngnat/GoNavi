import { describe, expect, it } from 'vitest';

import {
  V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT,
  V2_COMMAND_SEARCH_MAX_TREE_RESULTS,
  buildV2CommandSearchTreeIndex,
  collectSidebarSubtreeKeys,
  dedupeSidebarTreeNodesByKey,
  filterV2CommandSearchTreeItems,
  parseV2CommandSearchQuery,
  replaceSidebarTreeNodeChildren,
  resolveSidebarDatabaseTreePruneKeys,
  shouldClearSidebarNodeChildrenOnCollapse,
  type SidebarTreeNode,
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
  it('drops duplicate tree keys while preserving children from later copies', () => {
    const deduped = dedupeSidebarTreeNodesByKey([
      {
        key: 'conn-1',
        title: '开发库',
        type: 'connection',
        isLeaf: true,
        children: [{ key: 'db-1', title: '业务库', type: 'database' }],
      },
      {
        key: 'conn-1',
        title: '开发库（重复响应）',
        type: 'connection',
        children: [{ key: 'db-2', title: '报表库', type: 'database' }],
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.title).toBe('开发库');
    expect(deduped[0]?.children?.map((node) => node.key)).toEqual(['db-1', 'db-2']);
    expect(deduped[0]?.isLeaf).toBe(false);
  });

  it('indexes each command-search node key only once', () => {
    const items = buildNodeItems(2);
    const duplicate = { ...items[0], key: 'different-wrapper-key', title: 'same key duplicate' };

    expect(buildV2CommandSearchTreeIndex([items[0], duplicate, items[1]])).toHaveLength(2);
  });

  it('handles numeric keys and cyclic tree references without repeating rows', () => {
    const cyclicNode: SidebarTreeNode = { key: 'cyclic-node', title: '循环节点', type: 'database' };
    cyclicNode.children = [cyclicNode];
    const zeroKeyNode = {
      key: 0 as unknown as string,
      title: '零键节点',
      type: 'database' as const,
    };

    const deduped = dedupeSidebarTreeNodesByKey([zeroKeyNode, { ...zeroKeyNode }, cyclicNode]);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.key).toBe(0);
    expect(deduped[1]?.children).toBeUndefined();
  });

  it('collapses malformed blank keys so the rendered tree remains globally unique', () => {
    const deduped = dedupeSidebarTreeNodesByKey([
      { key: '', title: '缺少 key 的节点', type: 'database' },
      { key: '  ', title: '空白 key 的节点', type: 'database', children: [
        { key: 'blank-child', title: '保留的子节点', type: 'table' },
      ] },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.key).toBe('');
    expect(deduped[0]?.children?.map((node) => node.key)).toEqual(['blank-child']);
    expect(collectSidebarSubtreeKeys({ children: deduped })).toEqual(['blank-child']);
  });

  it('handles deep duplicate-key chains without recursive stack growth', () => {
    const root: SidebarTreeNode = { key: 'deep-duplicate', title: '根节点', type: 'database' };
    let current = root;
    for (let index = 0; index < 12000; index += 1) {
      const child: SidebarTreeNode = {
        key: 'deep-duplicate',
        title: `重复节点 ${index}`,
        type: 'database',
      };
      current.children = [child];
      current = child;
    }

    const deduped = dedupeSidebarTreeNodesByKey([root]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.key).toBe('deep-duplicate');
    expect(deduped[0]?.children).toBeUndefined();
  });

  it('merges descendants from distinct duplicate-key objects while breaking key cycles', () => {
    const first: SidebarTreeNode = { key: 'same-key', title: '首个节点', type: 'database' };
    const duplicate: SidebarTreeNode = { key: 'same-key', title: '重复节点', type: 'database' };
    const descendant: SidebarTreeNode = { key: 'descendant', title: '保留子节点', type: 'table' };
    first.children = [duplicate];
    duplicate.children = [descendant];
    descendant.children = [{ key: 'same-key', title: '回到重复键', type: 'database' }];

    const deduped = dedupeSidebarTreeNodesByKey([first]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.children?.map((node) => node.key)).toEqual(['descendant']);
    expect(deduped[0]?.children?.[0]?.children).toBeUndefined();
  });

  it('keeps the first depth-first node as canonical when a later root reuses its key', () => {
    const nested: SidebarTreeNode = { key: 'shared-key', title: '先遇到的节点', type: 'table' };
    const root: SidebarTreeNode = {
      key: 'root-node',
      title: '根节点',
      type: 'connection',
      children: [nested],
    };
    const laterRoot: SidebarTreeNode = {
      key: 'shared-key',
      title: '后遇到的节点',
      type: 'table',
    };

    const deduped = dedupeSidebarTreeNodesByKey([root, laterRoot]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.children?.[0]?.title).toBe('先遇到的节点');
  });

  it('keeps replacement state globally unique across duplicate roots, siblings, and descendants', () => {
    const result = replaceSidebarTreeNodeChildren([
      {
        key: 'conn-1',
        title: '首个连接',
        type: 'connection',
        children: [
          {
            key: 'db-1',
            title: '首个数据库',
            type: 'database',
            children: [
              { key: 'old-table', title: '旧表', type: 'table' },
              { key: 'old-table', title: '重复旧表', type: 'table' },
            ],
          },
          {
            key: 'db-1',
            title: '重复数据库',
            type: 'database',
            children: [{ key: 'stale-table', title: '不应复活', type: 'table' }],
          },
        ],
      },
      {
        key: 'conn-1',
        title: '重复连接',
        type: 'connection',
        children: [{ key: 'other-db', title: '保留数据库', type: 'database' }],
      },
    ], 'db-1', [
      { key: 'table-1', title: '新表', type: 'table' },
      { key: 'table-1', title: '重复新表', type: 'table' },
      {
        key: 'objects',
        title: '对象',
        type: 'object-group',
        children: [
          { key: 'nested-table', title: '嵌套表', type: 'table' },
          { key: 'nested-table', title: '重复嵌套表', type: 'table' },
        ],
      },
    ]);

    const keys = collectSidebarSubtreeKeys({ children: result });
    expect(keys).toHaveLength(new Set(keys).size);
    expect(result).toHaveLength(1);
    expect(result[0]?.children?.map((node) => node.key)).toEqual(['db-1', 'other-db']);
    expect(result[0]?.children?.[0]?.children?.map((node) => node.key)).toEqual([
      'table-1',
      'objects',
    ]);
    expect(result[0]?.children?.[0]?.children?.[1]?.children?.map((node) => node.key)).toEqual([
      'nested-table',
    ]);
    expect(keys).not.toContain('stale-table');
  });

  it('matches numeric and trimmed target keys using the same identity as dedupe', () => {
    const trimmedResult = replaceSidebarTreeNodeChildren([
      { key: '  numeric-key  ', title: '目标', type: 'database' },
    ], 'numeric-key', [{ key: 'child', title: '子节点', type: 'table' }]);
    const numericResult = replaceSidebarTreeNodeChildren([
      { key: '1', title: '数值目标', type: 'database' },
    ], 1, [{ key: 'numeric-child', title: '数值子节点', type: 'table' }]);

    expect(trimmedResult[0]?.children?.map((node) => node.key)).toEqual(['child']);
    expect(numericResult[0]?.children?.map((node) => node.key)).toEqual(['numeric-child']);
  });

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
