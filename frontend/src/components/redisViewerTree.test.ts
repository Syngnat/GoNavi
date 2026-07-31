import { describe, expect, it } from 'vitest';

import type { RedisKeyInfo } from '../types';
import {
  applyRenamedRedisKeyState,
  applyTreeNodeCheck,
  buildCheckedTreeNodeState,
  buildRedisKeyTree,
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
