import { describe, expect, it } from 'vitest';
import { pruneSavedQueryTreeAfterDelete } from './sidebarSavedQueryTreePrune';
import type { TreeNode } from './sidebarNodeMenuHelpers';

const queryNode = (id: string): TreeNode => ({
  title: id,
  key: `all-saved-query-${id}`,
  type: 'saved-query',
  dataRef: { id },
  isLeaf: true,
} as TreeNode);

const groupNode = (key: string, children: TreeNode[]): TreeNode => ({
  title: key,
  key,
  type: 'saved-query-group',
  children,
} as TreeNode);

const allSavedQueriesNode = (children: TreeNode[]): TreeNode => ({
  title: 'all',
  key: 'all-saved-queries',
  type: 'all-saved-queries',
  children,
} as TreeNode);

describe('pruneSavedQueryTreeAfterDelete', () => {
  it('drops the host and database groups once their last query is deleted', () => {
    const tree = [
      groupNode('root-connection', [
        groupNode('root-connection-db-only', [queryNode('q1')]),
        groupNode('root-connection-db-keep', [queryNode('q2')]),
      ]),
    ];

    const next = pruneSavedQueryTreeAfterDelete(tree, 'q1');

    expect(next).toHaveLength(1);
    expect(next[0].children?.map((node) => String(node.key))).toEqual(['root-connection-db-keep']);
    expect(next[0].children?.[0].children?.map((node) => String(node.key))).toEqual(['all-saved-query-q2']);
  });

  it('removes the whole saved-query root when nothing is left under it', () => {
    const tree = [
      groupNode('root-connection', [groupNode('db', [queryNode('q1')])]),
      { title: 'conn', key: 'conn-1', type: 'connection' } as TreeNode,
    ];

    const next = pruneSavedQueryTreeAfterDelete(tree, 'q1');

    expect(next.map((node) => String(node.key))).toEqual(['conn-1']);
  });

  it('keeps an empty manual group because the user created it explicitly', () => {
    const tree = [
      {
        title: 'manual',
        key: 'saved-query-manual-group-g1',
        type: 'saved-query-manual-group',
        children: [queryNode('q1')],
      } as TreeNode,
    ];

    const next = pruneSavedQueryTreeAfterDelete(tree, 'q1');

    expect(next).toHaveLength(1);
    expect(next[0].children).toEqual([]);
  });

  it('also prunes the ungrouped wrapper when it loses its last host group', () => {
    const tree = [
      allSavedQueriesNode([
        groupNode('all-saved-queries-ungrouped', [groupNode('host-db', [queryNode('q1')])]),
      ]),
    ];

    expect(pruneSavedQueryTreeAfterDelete(tree, 'q1')).toEqual([]);
  });

  it('returns the original array when the query is not in the tree', () => {
    const tree = [groupNode('host', [groupNode('db', [queryNode('q1')])])];

    expect(pruneSavedQueryTreeAfterDelete(tree, 'missing')).toBe(tree);
  });
});
