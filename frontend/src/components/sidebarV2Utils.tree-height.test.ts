import { describe, expect, it } from 'vitest';

import {
  resolveSidebarTreeRowHeight,
  resolveSidebarTreeVirtualHeight,
} from './sidebarV2Utils';

describe('resolveSidebarTreeVirtualHeight', () => {
  // 容器里 .sidebar-tree-scroll-content 有 6px 上 + 8px 下共 14px 内边距。
  // 虚拟列表拿到的高度必须扣掉它，否则 Tree 比可用空间高出一截，底部那条
  // 既不在可视区内也不会被渲染，表现为展开后下方留白。
  it('subtracts the content padding from the visible holder height', () => {
    expect(resolveSidebarTreeVirtualHeight(500)).toBe(486);
  });

  it('never returns a negative height and preserves subpixel measurements', () => {
    expect(resolveSidebarTreeVirtualHeight(20)).toBe(6);
    expect(resolveSidebarTreeVirtualHeight(14)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(3)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(Number.NaN)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(500.9)).toBeCloseTo(486.9);
  });
});

describe('resolveSidebarTreeRowHeight', () => {
  it('matches the measured explorer row geometry', () => {
    expect(resolveSidebarTreeRowHeight({ key: 'db', title: 'db', type: 'database' })).toBe(30);
    expect(resolveSidebarTreeRowHeight({ key: 'table', title: 'table', type: 'table' })).toBe(30);
    expect(resolveSidebarTreeRowHeight({ key: 'connection', title: 'connection', type: 'connection' })).toBe(30);
    expect(resolveSidebarTreeRowHeight({ key: 'tag', title: 'tag', type: 'tag' })).toBe(30);
    expect(resolveSidebarTreeRowHeight({ key: 'db-section', title: 'Pinned', type: 'v2-database-section' })).toBe(36);
    expect(resolveSidebarTreeRowHeight({ key: 'table-section', title: 'Pinned', type: 'v2-table-section' })).toBe(36);
  });
});
