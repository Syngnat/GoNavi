import { describe, expect, it } from 'vitest';
import {
  gonaviConnectionNodes,
  gonaviDatabaseNodes,
  gonaviTableNodes,
  mergeGonaviConnectionTree,
} from './connectionTree';

describe('connection tree helpers', () => {
  it('builds connection nodes and filters by type', () => {
    const connections = [
      { id: 'a', name: 'A', type: 'mysql', host: 'db' },
      { id: 'b', name: 'B', type: 'redis' },
    ];
    expect(gonaviConnectionNodes(connections).map((node) => node.key)).toEqual(['connection:a', 'connection:b']);
    expect(gonaviConnectionNodes(connections, ['MYSQL']).map((node) => node.key)).toEqual(['connection:a']);
  });

  it('deduplicates and sorts databases', () => {
    const nodes = gonaviDatabaseNodes('c1', ['b', 'a', 'b']);
    expect(nodes.map((node) => node.title)).toEqual(['a', 'b']);
    expect(nodes[0]).toMatchObject({ kind: 'database', connectionId: 'c1', database: 'a' });
  });

  it('marks views and sorts tables', () => {
    const nodes = gonaviTableNodes('c1', 'app', [
      { name: 'orders', type: 'table' },
      { name: 'active_users', type: 'view' },
      { name: 'orders', type: 'table' },
      { name: '' },
    ]);
    expect(nodes.map((node) => node.title)).toEqual(['active_users', 'orders']);
    expect(nodes[0]).toMatchObject({ kind: 'view', isLeaf: true });
    expect(nodes[1]).toMatchObject({ kind: 'table', isLeaf: true });
  });

  it('overlays loaded children without mutating roots', () => {
    const roots = gonaviConnectionNodes([{ id: 'a', name: 'A', type: 'mysql' }]);
    const merged = mergeGonaviConnectionTree(roots, {
      'connection:a': gonaviDatabaseNodes('a', ['app']),
    });
    expect(merged[0].children?.[0].title).toBe('app');
    expect(roots[0].children).toBeUndefined();
  });
});
