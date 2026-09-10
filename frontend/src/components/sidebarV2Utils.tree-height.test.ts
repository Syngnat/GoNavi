import { describe, expect, it } from 'vitest';

import {
  resolveSidebarTreeRowHeight,
  resolveSidebarTreeVirtualHeight,
} from './sidebarV2Utils';

describe('resolveSidebarTreeVirtualHeight', () => {
  it('matches the V2 tree virtual viewport to the visible holder height', () => {
    expect(resolveSidebarTreeVirtualHeight(500)).toBe(464);
  });

  it('never returns a negative height and preserves subpixel measurements', () => {
    expect(resolveSidebarTreeVirtualHeight(20)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(Number.NaN)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(500.9)).toBeCloseTo(464.9);
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
