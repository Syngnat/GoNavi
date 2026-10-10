import { describe, expect, it } from 'vitest';

import {
  buildV2ExplorerFilterOptions,
  filterV2ExplorerTreeByKind,
  isNacosConnection,
  resolveExplorerFilterFamily,
  resolveExplorerFilterReset,
  V2_EXPLORER_FILTER_LABEL_KEYS,
  V2_EXPLORER_FILTER_ORDER,
  type V2ExplorerFilter,
} from './sidebarExplorerFilter';

const nacosTree = () => [
  {
    key: 'nacos-1-ns-public',
    type: 'nacos-namespace',
    children: [
      { key: 'nacos-1-ns-public-config', type: 'nacos-config-entry' },
      { key: 'nacos-1-ns-public-services', type: 'nacos-services-entry' },
    ],
  },
];

const nodeKeys = (nodes: any[]): string[] => nodes.map((node) => node.key);

describe('sidebarExplorerFilter / Nacos 过滤', () => {
  it('keeps unloaded schema nodes expandable under relational object filters', () => {
    const tree = [{ key: 'db', type: 'database', children: [{ key: 'schema', type: 'object-group', isLeaf: false, dataRef: { groupKey: 'schema', schemaLazy: true } }] }];
    for (const filter of ['tables', 'views', 'routines'] as const) {
      expect(filterV2ExplorerTreeByKind(tree as any, filter)[0]?.children?.[0].key).toBe('schema');
      expect(filterV2ExplorerTreeByKind([{ key: 'unloaded-db', title: 'app', type: 'database' }], filter)[0]?.key).toBe('unloaded-db');
    }
  });
  it('「服务发现」只留服务分支，「配置」只留配置分支', () => {
    const services = filterV2ExplorerTreeByKind(nacosTree() as any, 'nacos-services');
    expect(nodeKeys(services)).toEqual(['nacos-1-ns-public']);
    expect(nodeKeys(services[0].children || [])).toEqual(['nacos-1-ns-public-services']);

    const configs = filterV2ExplorerTreeByKind(nacosTree() as any, 'nacos-configs');
    expect(nodeKeys(configs)).toEqual(['nacos-1-ns-public']);
    expect(nodeKeys(configs[0].children || [])).toEqual(['nacos-1-ns-public-config']);
  });

  it('分支被全部过滤掉时，命名空间本身也不再出现', () => {
    // 命名空间只是容器。留下一个没有子节点的空壳会让侧栏出现一行点不开的空行。
    const onlyServices = [{
      key: 'nacos-1-ns-public',
      type: 'nacos-namespace',
      children: [{ key: 'nacos-1-ns-public-services', type: 'nacos-services-entry' }],
    }];
    expect(filterV2ExplorerTreeByKind(onlyServices as any, 'nacos-configs')).toEqual([]);
  });

  it('Nacos 过滤作用在关系型树上时清空，且不抛错', () => {
    // 过滤值来自「当前激活连接」与持久化的 UI 状态，两者可以不同步，
    // 所以一棵关系型树完全可能遇到 Nacos 过滤值。这类跨族组合必须落到
    // 「清空」而不是抛错或漏放行。
    const relational = [{
      key: 'conn-main',
      type: 'database',
      children: [
        { key: 'conn-main-tables', type: 'object-group', dataRef: { groupKey: 'tables' } },
        { key: 'conn-main-views', type: 'object-group', dataRef: { groupKey: 'views' } },
      ],
    }];

    expect(() => filterV2ExplorerTreeByKind(relational as any, 'nacos-services')).not.toThrow();
    expect(filterV2ExplorerTreeByKind(relational as any, 'nacos-configs')).toEqual([]);
  });

  it('Nacos 过滤保留命名空间下的服务分组行', () => {
    const tree = [{
      key: 'nacos-1-ns-public',
      type: 'nacos-namespace',
      children: [
        { key: 'nacos-1-ns-public-config', type: 'nacos-config-entry' },
        {
          key: 'nacos-1-ns-public-services',
          type: 'nacos-services-entry',
          children: [{ key: 'nacos-1-ns-public-sg-ORDER', type: 'nacos-service-group' }],
        },
      ],
    }];

    const services = filterV2ExplorerTreeByKind(tree as any, 'nacos-services');
    expect(nodeKeys(services[0].children || [])).toEqual(['nacos-1-ns-public-services']);
    // 分支内部是后端已经铺好的树，整体保留而不是按行再筛一遍。
    expect(nodeKeys((services[0].children || [])[0].children || [])).toEqual(['nacos-1-ns-public-sg-ORDER']);
  });

  it('all 原样返回同一棵树', () => {
    const tree = nacosTree();
    expect(filterV2ExplorerTreeByKind(tree as any, 'all')).toBe(tree);
  });
});

describe('sidebarExplorerFilter / 过滤维度表', () => {
  it('每个维度都有文案键，两个族的快捷键都齐全', () => {
    // 漏一个键会让按钮渲染出 `undefined`，而不是报错。锁住完整性。
    for (const order of Object.values(V2_EXPLORER_FILTER_ORDER)) {
      for (const key of order) {
        expect(V2_EXPLORER_FILTER_LABEL_KEYS[key], `缺少文案键: ${key}`).toBeTruthy();
      }
      expect(order[0]).toBe('all');
    }
    expect(V2_EXPLORER_FILTER_ORDER.nacos).toEqual(['all', 'nacos-services', 'nacos-configs']);
    expect(V2_EXPLORER_FILTER_ORDER.relational).toHaveLength(7);
  });

  it('按族生成按钮列表，文案走传入的翻译器', () => {
    const translate = (key: string) => `T:${key}`;

    expect(buildV2ExplorerFilterOptions(translate, V2_EXPLORER_FILTER_ORDER.nacos)).toEqual([
      { key: 'all', label: 'T:sidebar.command_search.object_kind.all' },
      { key: 'nacos-services', label: 'T:sidebar.command_search.object_kind.nacos_services' },
      { key: 'nacos-configs', label: 'T:sidebar.command_search.object_kind.nacos_configs' },
    ]);

    // 默认仍是关系型的 7 个，既有调用方行为不变。
    expect(buildV2ExplorerFilterOptions(translate).map((o) => o.key)).toEqual(
      V2_EXPLORER_FILTER_ORDER.relational,
    );
  });

  it('V2ExplorerFilter 的每个取值都能被过滤函数接受', () => {
    const everyFilter: V2ExplorerFilter[] = [
      ...V2_EXPLORER_FILTER_ORDER.relational,
      ...V2_EXPLORER_FILTER_ORDER.nacos,
    ];
    // `all` 是两个族共有的，所以出现 12 次但只有 9 个不同取值。
    expect(new Set(everyFilter).size).toBe(9);
    for (const filter of everyFilter) {
      expect(() => filterV2ExplorerTreeByKind([], filter)).not.toThrow();
    }
  });

  it('每个关系型维度都有分组键表项', () => {
    // 漏一个表项不会抛错（new Set(undefined) 得到空集），但会把整棵树静默清空 ——
    // 一个只表现为「侧栏突然空了」的故障。这里只覆盖走分组键表的关系型维度；
    // Nacos 维度作用在关系型树上本就应当清空（见上一条用例）。
    const relational = V2_EXPLORER_FILTER_ORDER.relational.filter((filter) => filter !== 'all');
    // 树里备齐所有分组键，这样每个维度都该命中属于自己的那一组。
    const tree = [{
      key: 'conn-main',
      type: 'database',
      children: ['tables', 'views', 'materializedViews', 'sequences', 'routines', 'packages', 'events']
        .map((groupKey) => ({
          key: `conn-main-${groupKey}`,
          type: 'object-group',
          dataRef: { groupKey },
        })),
    }];

    for (const filter of relational) {
      const result = filterV2ExplorerTreeByKind(tree as any, filter);
      expect(
        result.length,
        `${filter} 把整棵树清空了，说明 V2_EXPLORER_FILTER_GROUP_KEYS 缺这个键`,
      ).toBeGreaterThan(0);
    }
  });

  it('切换连接族时丢弃不属于该族的过滤值', () => {
    // 回归守卫。过滤值比它所属的连接活得久：在 Nacos 上点了「服务发现」再切到
    // 关系型连接（或反过来），残留的过滤值会让 filterV2ExplorerTreeByKind 把整棵树
    // 清空，而槽位此时只显示本族的按钮，用户没有按钮可以清掉它 —— 侧栏整片空白。
    const relationalTree = [{
      key: 'conn-main',
      type: 'database',
      children: [{ key: 'conn-main-tables', type: 'object-group', dataRef: { groupKey: 'tables' } }],
    }];

    // 关系型连接上残留 Nacos 过滤值：确实会清空，所以必须被重置。
    expect(filterV2ExplorerTreeByKind(relationalTree as any, 'nacos-services')).toEqual([]);
    expect(resolveExplorerFilterReset('relational', 'nacos-services')).toBe('all');
    expect(resolveExplorerFilterReset('relational', 'nacos-configs')).toBe('all');

    // 反向同理。
    expect(resolveExplorerFilterReset('nacos', 'tables')).toBe('all');
    expect(resolveExplorerFilterReset('nacos', 'views')).toBe('all');

    // 本族内的过滤值必须原样保留，否则按钮看起来像失灵。
    expect(resolveExplorerFilterReset('relational', 'tables')).toBeNull();
    expect(resolveExplorerFilterReset('nacos', 'nacos-services')).toBeNull();
    expect(resolveExplorerFilterReset('nacos', 'nacos-configs')).toBeNull();
    expect(resolveExplorerFilterReset('relational', 'all')).toBeNull();
    expect(resolveExplorerFilterReset('nacos', 'all')).toBeNull();

    // 没有本族维度的工作台：任何非 all 的过滤值都要清掉。
    expect(resolveExplorerFilterReset(null, 'tables')).toBe('all');
    expect(resolveExplorerFilterReset(null, 'nacos-services')).toBe('all');
    expect(resolveExplorerFilterReset(null, 'all')).toBeNull();
  });

  it('按连接类型解析族：Nacos 优先于关系型能力', () => {
    expect(resolveExplorerFilterFamily({ config: { type: 'nacos' } })).toBe('nacos');
    expect(resolveExplorerFilterFamily({ config: { type: 'postgres' } })).toBe('relational');
    expect(resolveExplorerFilterFamily({ config: { type: 'mysql' } })).toBe('relational');
    // 专用工作台与无激活连接都没有维度。
    expect(resolveExplorerFilterFamily({ config: { type: 'redis' } })).toBeNull();
    expect(resolveExplorerFilterFamily({ config: { type: 'mqtt' } })).toBeNull();
    expect(resolveExplorerFilterFamily(null)).toBeNull();
    expect(resolveExplorerFilterFamily(undefined)).toBeNull();
  });

  it('只有 nacos 类型被认作 Nacos 连接', () => {
    expect(isNacosConnection({ config: { type: 'nacos' } })).toBe(true);
    expect(isNacosConnection({ config: { type: 'redis' } })).toBe(false);
    expect(isNacosConnection({ config: {} })).toBe(false);
    expect(isNacosConnection(null)).toBe(false);
    expect(isNacosConnection(undefined)).toBe(false);
  });
});
