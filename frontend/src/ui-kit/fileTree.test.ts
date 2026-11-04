import { describe, expect, it } from 'vitest';
import { normalizeGonaviFileNodes } from './fileTree';

describe('file tree helpers', () => {
  it('sorts folders before files and keeps names ordered', () => {
    const nodes = normalizeGonaviFileNodes([
      { key: 'b.txt', title: 'b.txt', kind: 'file' },
      { key: 'z', title: 'z', kind: 'folder' },
      { key: 'a.txt', title: 'a.txt', kind: 'file' },
      { key: 'a', title: 'a', kind: 'folder' },
    ]);
    expect(nodes.map((node) => node.key)).toEqual(['a', 'z', 'a.txt', 'b.txt']);
  });

  it('marks files as leaves and recurses into folders', () => {
    const nodes = normalizeGonaviFileNodes([{
      key: 'root', title: 'root', kind: 'folder',
      children: [{ key: 'root/child', title: 'child', kind: 'file' }],
    }]);
    expect(nodes[0].isLeaf).toBe(false);
    expect(nodes[0].children?.[0]).toMatchObject({ key: 'root/child', isLeaf: true });
  });
});
