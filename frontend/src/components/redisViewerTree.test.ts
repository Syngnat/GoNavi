import { describe, expect, it } from 'vitest';

import type { RedisKeyInfo } from '../types';
import {
  applyRenamedRedisKeyState,
  applyTreeNodeCheck,
  buildCheckedTreeNodeState,
  buildRedisKeyListView,
  buildRedisKeyTree,
  buildRedisKeyTypeView,
  isGroupFullyChecked,
} from './redisViewerTree';

const sampleKeys: RedisKeyInfo[] = [
  { key: 'app:user:1', type: 'string', ttl: -1 },
  { key: 'app:user:2', type: 'string', ttl: -1 },
  { key: 'app:order:1', type: 'hash', ttl: 120 },
  { key: 'misc', type: 'set', ttl: -1 },
];

describe('redisViewerTree helpers', () => {
  it('builds grouped redis key tree and group selection state', () => {
    const tree = buildRedisKeyTree(sampleKeys, true);
    const appGroup = tree.treeData.find((node) => node.key === 'group:app');
    const userGroup = appGroup?.children?.find((node) => node.key === 'group:app:user');

    expect(appGroup).toBeTruthy();
    expect(userGroup).toBeTruthy();
    expect(appGroup?.groupPath).toBe('app');
    expect(userGroup?.groupPath).toBe('app:user');
    expect(appGroup?.descendantRawKeys).toEqual(['app:order:1', 'app:user:1', 'app:user:2']);

    const selectedAfterGroupCheck = applyTreeNodeCheck([], appGroup!, true);
    expect(selectedAfterGroupCheck).toEqual(['app:order:1', 'app:user:1', 'app:user:2']);

    const checkedState = buildCheckedTreeNodeState(selectedAfterGroupCheck, tree);
    expect(checkedState.checked).toEqual(['key:app:order:1', 'group:app:order', 'key:app:user:1', 'key:app:user:2', 'group:app:user', 'group:app']);
    expect(checkedState.halfChecked).toEqual([]);
    expect(isGroupFullyChecked(appGroup!, selectedAfterGroupCheck)).toBe(true);

    const selectedAfterGroupUncheck = applyTreeNodeCheck(selectedAfterGroupCheck, appGroup!, false);
    expect(selectedAfterGroupUncheck).toEqual([]);
    expect(isGroupFullyChecked(appGroup!, selectedAfterGroupUncheck)).toBe(false);
  });

  it('marks parent groups as half checked for partial selection', () => {
    const tree = buildRedisKeyTree(sampleKeys, true);
    const appGroup = tree.treeData.find((node) => node.key === 'group:app');
    const partialState = buildCheckedTreeNodeState(['app:user:1'], tree);

    expect(partialState.halfChecked).toEqual(['group:app:user', 'group:app']);
    expect(isGroupFullyChecked(appGroup!, ['app:user:1'])).toBe(false);
  });

  it('builds a flat list view with full Key labels', () => {
    const list = buildRedisKeyListView(sampleKeys, true);

    expect(list.groupKeys).toEqual([]);
    expect(list.treeData.every((node) => node.nodeType === 'leaf')).toBe(true);
    expect(list.treeData.map((node) => [node.leafLabel, node.rawKey])).toEqual([
      ['app:order:1', 'app:order:1'],
      ['app:user:1', 'app:user:1'],
      ['app:user:2', 'app:user:2'],
      ['misc', 'misc'],
    ]);

    const unsortedList = buildRedisKeyListView([sampleKeys[3], sampleKeys[0]], false);
    expect(unsortedList.treeData.map((node) => node.rawKey)).toEqual(['misc', 'app:user:1']);
  });

  it('groups Keys by Redis type in a stable operational order', () => {
    const typeView = buildRedisKeyTypeView([
      ...sampleKeys,
      { key: 'module:item', type: 'bitmap', ttl: -1 },
      { key: 'unknown:item', type: '  ', ttl: -1 },
    ], true);

    expect(typeView.groupKeys).toEqual([
      'type-group:string',
      'type-group:hash',
      'type-group:set',
      'type-group:bitmap',
      'type-group:unknown',
    ]);
    expect(typeView.treeData.map((node) => [node.groupKind, node.groupName, node.groupLeafCount])).toEqual([
      ['type', 'string', 2],
      ['type', 'hash', 1],
      ['type', 'set', 1],
      ['type', 'bitmap', 1],
      ['type', 'unknown', 1],
    ]);

    const stringGroup = typeView.treeData[0];
    expect(stringGroup.descendantRawKeys).toEqual(['app:user:1', 'app:user:2']);
    expect(stringGroup.children?.map((node) => node.leafLabel)).toEqual(['app:user:1', 'app:user:2']);

    const partialState = buildCheckedTreeNodeState(['app:user:1'], typeView);
    expect(partialState.checked).toContain('key:app:user:1');
    expect(partialState.halfChecked).toEqual(['type-group:string']);

    expect(applyTreeNodeCheck([], stringGroup, true)).toEqual(['app:user:1', 'app:user:2']);
    expect(typeView.treeData[typeView.treeData.length - 1]?.groupName).toBe('unknown');
  });

  it('keeps every loaded Key in large unsorted list and type views', () => {
    const largeKeys: RedisKeyInfo[] = Array.from({ length: 10_000 }, (_, index) => ({
      key: `bulk:${9_999 - index}`,
      type: index % 2 === 0 ? 'string' : 'hash',
      ttl: -1,
    }));

    const listView = buildRedisKeyListView(largeKeys, false);
    const typeView = buildRedisKeyTypeView(largeKeys, false);

    expect(listView.treeData).toHaveLength(10_000);
    expect(listView.treeData[0]?.rawKey).toBe('bulk:9999');
    expect(typeView.treeData.reduce((total, group) => total + (group.descendantRawKeys?.length || 0), 0)).toBe(10_000);
    expect(typeView.treeData[0]?.children?.[0]?.rawKey).toBe('bulk:9999');
  });

  it('updates selected keys consistently after rename', () => {
    const renamedState = applyRenamedRedisKeyState(
      {
        keys: sampleKeys,
        selectedKey: 'app:user:2',
        selectedKeys: ['app:user:1', 'app:user:2', 'misc'],
      },
      'app:user:2',
      'app:user:200'
    );

    expect(renamedState.keys.map((item) => item.key)).toEqual(['app:user:1', 'app:user:200', 'app:order:1', 'misc']);
    expect(renamedState.selectedKey).toBe('app:user:200');
    expect(renamedState.selectedKeys).toEqual(['app:user:1', 'app:user:200', 'misc']);

    const unrelatedRenameState = applyRenamedRedisKeyState(
      {
        keys: sampleKeys,
        selectedKey: 'misc',
        selectedKeys: ['app:user:1'],
      },
      'app:order:1',
      'app:order:9'
    );

    expect(unrelatedRenameState.selectedKey).toBe('misc');
    expect(unrelatedRenameState.selectedKeys).toEqual(['app:user:1']);
  });
});
