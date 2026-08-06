import { describe, expect, it } from 'vitest';

import { resolveWailsWindowSetPosition, resolveWailsWindowVisibleViewport } from './wailsWindowViewport';

describe('wailsWindowViewport', () => {
  it('keeps browser work-area offsets for platforms that use absolute screen coordinates', () => {
    expect(resolveWailsWindowVisibleViewport(
      { availWidth: 1728, availHeight: 1040, availLeft: -1728, availTop: 40 },
      { innerWidth: 1440, innerHeight: 900 },
    )).toEqual({
      availWidth: 1728,
      availHeight: 1040,
      availLeft: -1728,
      availTop: 40,
    });
  });

  it('uses current-monitor local origin for macOS Wails window positioning', () => {
    expect(resolveWailsWindowVisibleViewport(
      { availWidth: 1728, availHeight: 1040, availLeft: -1728, availTop: 40 },
      { innerWidth: 1440, innerHeight: 900 },
      { useMonitorLocalOrigin: true },
    )).toEqual({
      availWidth: 1728,
      availHeight: 1040,
      availLeft: 0,
      availTop: 0,
    });
  });

  it('falls back to window inner size when screen size is unavailable', () => {
    expect(resolveWailsWindowVisibleViewport(
      null,
      { innerWidth: 1280, innerHeight: 720 },
      { useMonitorLocalOrigin: true },
    )).toEqual({
      availWidth: 1280,
      availHeight: 720,
      availLeft: 0,
      availTop: 0,
    });
  });

  it('converts negative secondary-monitor coordinates to Wails monitor-local input', () => {
    expect(resolveWailsWindowSetPosition(
      { x: -1600, y: 80 },
      { availWidth: 1728, availHeight: 1040, availLeft: -1728, availTop: 40 },
      { useMonitorLocalOrigin: true },
    )).toEqual({ x: 128, y: 40 });
  });

  it('maps an offset work-area origin to local zero without double-applying it', () => {
    expect(resolveWailsWindowSetPosition(
      { x: 1920, y: 40 },
      { availWidth: 1600, availHeight: 900, availLeft: 1920, availTop: 40 },
      { useMonitorLocalOrigin: true },
    )).toEqual({ x: 0, y: 0 });
  });
});
