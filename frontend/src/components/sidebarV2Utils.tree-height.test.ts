import { describe, expect, it } from 'vitest';

import { resolveSidebarTreeVirtualHeight } from './sidebarV2Utils';

describe('resolveSidebarTreeVirtualHeight', () => {
  it('matches the V2 tree virtual viewport to the visible holder height', () => {
    expect(resolveSidebarTreeVirtualHeight(500, true)).toBe(464);
  });

  it('keeps the legacy tree height unchanged', () => {
    expect(resolveSidebarTreeVirtualHeight(500, false)).toBe(500);
  });

  it('never returns a negative height and preserves subpixel measurements', () => {
    expect(resolveSidebarTreeVirtualHeight(20, true)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(Number.NaN, true)).toBe(0);
    expect(resolveSidebarTreeVirtualHeight(500.9, true)).toBeCloseTo(464.9);
    expect(resolveSidebarTreeVirtualHeight(500.9, false)).toBe(500.9);
  });
});
