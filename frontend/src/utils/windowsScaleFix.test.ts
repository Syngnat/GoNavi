import { describe, expect, it } from 'vitest';
import {
  computeWindowsViewportScaleRatio,
  getWindowsScaleFixNudgedWidth,
  hasWindowsViewportScaleDrift,
} from './windowsScaleFix';

describe('windowsScaleFix', () => {
  it.each([1, 1.25, 1.5, 2])('treats Wails DIP metrics as stable at %sx DPI', (devicePixelRatio) => {
    const ratio = computeWindowsViewportScaleRatio({
      windowWidth: 1280,
      innerWidth: 1280,
      devicePixelRatio,
    });

    expect(ratio).toBeCloseTo(1, 5);
    expect(hasWindowsViewportScaleDrift({
      windowWidth: 1280,
      innerWidth: 1280,
      devicePixelRatio,
    })).toBe(false);
  });

  it('detects zoom drift from viewport width mismatch', () => {
    expect(hasWindowsViewportScaleDrift({
      windowWidth: 1280,
      innerWidth: 1100,
      devicePixelRatio: 1.5,
    })).toBe(true);
  });

  it('detects zoom drift from visual viewport scale', () => {
    expect(hasWindowsViewportScaleDrift({
      windowWidth: 1600,
      innerWidth: 1600,
      devicePixelRatio: 1,
      visualViewportScale: 1.12,
    })).toBe(true);
  });

  it('returns a one-pixel nudge width for normal windows', () => {
    expect(getWindowsScaleFixNudgedWidth(960)).toBe(959);
    expect(getWindowsScaleFixNudgedWidth(420)).toBe(421);
  });
});
