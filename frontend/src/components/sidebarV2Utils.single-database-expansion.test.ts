import { describe, expect, it } from 'vitest';

import {
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarSingleDatabaseExpandedKeys,
  type SidebarTreeNode,
} from './sidebarV2Utils';

const treeData: SidebarTreeNode[] = [
  {
    key: 'conn-a',
    title: 'Connection A',
    type: 'connection',
    dataRef: { id: 'conn-a' },
    children: [
      {
        key: 'conn-a-main',
        title: 'main',
        type: 'database',
        dataRef: { id: 'conn-a', dbName: 'main' },
        children: [{ key: 'conn-a-main-tables', title: 'Tables', type: 'object-group' }],
      },
      {
        key: 'conn-a-audit',
        title: 'audit',
        type: 'database',
        dataRef: { id: 'conn-a', dbName: 'audit' },
        children: [{ key: 'conn-a-audit-tables', title: 'Tables', type: 'object-group' }],
      },
    ],
  },
  {
    key: 'conn-b',
    title: 'Connection B',
    type: 'connection',
    dataRef: { id: 'conn-b' },
    children: [
      {
        key: 'conn-b-main',
        title: 'main',
        type: 'database',
        dataRef: { id: 'conn-b', dbName: 'main' },
      },
    ],
  },
];

describe('resolveSidebarSingleDatabaseExpandedKeys', () => {
  it('orders expanded connection resources from parent to child for refresh reloads', () => {
    expect(resolveSidebarConnectionRefreshKeys({
      treeData,
      expandedKeys: [
        'conn-a-main-tables',
        'conn-a',
        'external-sql-root',
        'conn-a-main',
        'conn-a-missing',
      ],
      connectionId: 'conn-a',
    })).toEqual([
      'conn-a',
      'conn-a-main',
      'conn-a-main-tables',
    ]);
  });

  it('keeps the newly expanded database and collapses its siblings only', () => {
    expect(resolveSidebarSingleDatabaseExpandedKeys({
      previousExpandedKeys: [
        'conn-a',
        'conn-a-main',
        'conn-a-main-tables',
        'conn-b',
        'conn-b-main',
      ],
      nextExpandedKeys: [
        'conn-a',
        'conn-a-main',
        'conn-a-main-tables',
        'conn-a-audit',
        'conn-b',
        'conn-b-main',
      ],
      treeData,
    })).toEqual([
      'conn-a',
      'conn-a-audit',
      'conn-b',
      'conn-b-main',
    ]);
  });

  it('applies the same single-open behavior to Redis databases', () => {
    const redisTree: SidebarTreeNode[] = [{
      key: 'redis-1',
      title: 'Redis',
      type: 'connection',
      dataRef: { id: 'redis-1' },
      children: [
        {
          key: 'redis-1-db0',
          title: 'db0',
          type: 'redis-db',
          dataRef: { id: 'redis-1', redisDB: 0 },
          children: [{ key: 'redis-1-db0-group', title: 'Keys', type: 'object-group' }],
        },
        {
          key: 'redis-1-db1',
          title: 'db1',
          type: 'redis-db',
          dataRef: { id: 'redis-1', redisDB: 1 },
        },
      ],
    }];

    expect(resolveSidebarSingleDatabaseExpandedKeys({
      previousExpandedKeys: ['redis-1', 'redis-1-db0', 'redis-1-db0-group'],
      nextExpandedKeys: ['redis-1', 'redis-1-db0', 'redis-1-db0-group', 'redis-1-db1'],
      treeData: redisTree,
    })).toEqual(['redis-1', 'redis-1-db1']);
  });

  it('leaves unrelated tree nodes unchanged', () => {
    const keys = ['conn-a', 'saved-queries', 'external-sql-root'];
    expect(resolveSidebarSingleDatabaseExpandedKeys({
      previousExpandedKeys: keys,
      nextExpandedKeys: keys,
      treeData,
    })).toBe(keys);
  });
});
