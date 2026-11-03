import { describe, expect, it } from 'vitest';

import type { SavedConnection, TabData } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import {
  buildTabOverflowRows,
  filterTabOverflowRows,
} from './tabOverflowModel';

const translate = (key: string, params?: Record<string, string | number | boolean | null | undefined>) => (
  catalogTranslate('zh-CN', key, params)
);

const connection: SavedConnection = {
  id: 'conn-1',
  name: '订单库',
  config: { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: 'sales' },
};

const queryTab: TabData = {
  id: 'tab-query',
  title: '新建查询',
  type: 'query',
  connectionId: 'conn-1',
  dbName: 'sales',
};

const pluginTab: TabData = {
  id: 'tab-plugin',
  title: '插件',
  type: 'plugin-manager',
};

describe('tab overflow model', () => {
  it('builds compact IDEA-style rows from workbench tabs', () => {
    const rows = buildTabOverflowRows([queryTab, pluginTab], {
      connections: [connection],
      connectionGroupNameById: new Map(),
      activeTabId: 'tab-plugin',
      translate,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'tab-query',
        kind: 'SQL',
        title: '新建查询',
        subtitle: '订单库 · sales',
        active: false,
      }),
      expect.objectContaining({
        id: 'tab-plugin',
        kind: 'PLUGIN',
        title: '插件',
        active: true,
      }),
    ]);
  });

  it('filters by kind, title and connection subtitle', () => {
    const rows = buildTabOverflowRows([queryTab, pluginTab], {
      connections: [connection],
      connectionGroupNameById: new Map(),
      translate,
    });

    expect(filterTabOverflowRows(rows, ' plugin ').map((row) => row.id)).toEqual(['tab-plugin']);
    expect(filterTabOverflowRows(rows, '订单库').map((row) => row.id)).toEqual(['tab-query']);
    expect(filterTabOverflowRows(rows, 'nope')).toEqual([]);
    expect(filterTabOverflowRows(rows, '  ')).toHaveLength(2);
  });
});
