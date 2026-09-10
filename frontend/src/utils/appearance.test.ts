import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  blurToFilter,
  normalizeBlurForPlatform,
  normalizeOpacityForPlatform,
  resolveAppearanceValues,
  resolveTextInputSafeBackdropFilter,
} from './appearance';

describe('appearance helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to opaque non-blurred appearance when disabled', () => {
    expect(resolveAppearanceValues({ enabled: false, opacity: 0.3, blur: 12 })).toEqual({ opacity: 1, blur: 0 });
  });

  it('preserves configured values when appearance is enabled', () => {
    expect(resolveAppearanceValues({ enabled: true, opacity: 0.72, blur: 9 })).toEqual({ opacity: 0.72, blur: 9 });
  });

  it('caps opacity at full opacity upper bound', () => {
    expect(normalizeOpacityForPlatform(2)).toBe(1);
  });

  it('keeps macOS opacity changes anchored to the opaque end of the slider', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' });

    expect(normalizeOpacityForPlatform(0.95)).toBeCloseTo(0.97);
    expect(normalizeOpacityForPlatform(0.35)).toBeCloseTo(0.61);
    expect(normalizeOpacityForPlatform(1)).toBe(1);
  });

  it('never returns negative blur and formats blur filter correctly', () => {
    expect(normalizeBlurForPlatform(-4)).toBe(0);
    expect(blurToFilter(0)).toBeUndefined();
    expect(blurToFilter(8)).toBe('blur(8px)');
  });

  it('disables local backdrop blur for text-entry surfaces on macOS', () => {
    expect(resolveTextInputSafeBackdropFilter('blur(18px)', true)).toBe('none');
    expect(resolveTextInputSafeBackdropFilter('blur(18px)', false)).toBe('blur(18px)');
    expect(resolveTextInputSafeBackdropFilter(undefined, true)).toBe('none');
  });
});
