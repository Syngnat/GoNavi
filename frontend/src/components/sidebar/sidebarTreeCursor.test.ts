import { describe, expect, it } from 'vitest';
import { readCssWithImports } from '../../test/readCssWithImports';

describe('sidebar tree cursor', () => {
  it('uses the default arrow for tree rows while retaining active drag feedback', () => {
    const css = readCssWithImports(new URL('../../v2-theme.css', import.meta.url));
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-treenode\.ant-tree-treenode-draggable \{[^}]*cursor: default !important;/s);
    expect(css).toContain('cursor: grabbing !important;');
  });
});
