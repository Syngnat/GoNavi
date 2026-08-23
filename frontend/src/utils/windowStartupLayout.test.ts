import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearStartupWindowRestorePending,
  isStartupMaximisedWindowSettled,
  isStartupWindowRestorePending,
  markStartupWindowRestorePending,
  resolveDefaultStartupWindowBounds,
  resolveStartupWindowRestoreMode,
  resolveWorkAreaFillWindowBounds,
} from './windowStartupLayout';

describe('windowStartupLayout', () => {
  afterEach(() => {
    clearStartupWindowRestorePending();
    vi.useRealTimers();
  });

  it('centers a large first-launch window on the visible work area', () => {
    expect(resolveDefaultStartupWindowBounds({
      availWidth: 1920,
      availHeight: 1080,
      availLeft: 0,
      availTop: 0,
    })).toEqual({
      width: 1612,
      height: 907,
      x: 154,
      y: 86,
    });
  });

  it('never exceeds a small screen and still fills most of the work area', () => {
    expect(resolveDefaultStartupWindowBounds({
      availWidth: 1280,
      availHeight: 720,
      availLeft: 0,
      availTop: 40,
    })).toEqual({
      width: 1075,
      height: 604,
      x: 102,
      y: 98,
    });
  });

  it('respects multi-monitor work-area offsets', () => {
    expect(resolveDefaultStartupWindowBounds({
      availWidth: 1600,
      availHeight: 900,
      availLeft: 1920,
      availTop: 0,
    })).toEqual({
      width: 1344,
      height: 756,
      x: 2048,
      y: 72,
    });
  });

  it('tracks the startup restore grace window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T10:00:00.000Z'));

    expect(isStartupWindowRestorePending()).toBe(false);
    markStartupWindowRestorePending(1000);
    expect(isStartupWindowRestorePending()).toBe(true);

    vi.setSystemTime(new Date('2026-07-09T10:00:00.999Z'));
    expect(isStartupWindowRestorePending()).toBe(true);

    vi.setSystemTime(new Date('2026-07-09T10:00:01.001Z'));
    expect(isStartupWindowRestorePending()).toBe(false);
  });

  it('fills the OS work area as a maximise-failure fallback', () => {
    expect(resolveWorkAreaFillWindowBounds({
      availWidth: 1920,
      availHeight: 1040,
      availLeft: 0,
      availTop: 0,
    })).toEqual({
      width: 1920,
      height: 1040,
      x: 0,
      y: 0,
    });

    expect(resolveWorkAreaFillWindowBounds({
      availWidth: 1600,
      availHeight: 900,
      availLeft: 1920,
      availTop: 40,
    })).toEqual({
      width: 1600,
      height: 900,
      x: 1920,
      y: 40,
    });
  });

  it('restores the last normal window when startup maximise is disabled', () => {
    expect(resolveStartupWindowRestoreMode(false, 'normal')).toBe('normal');
  });

  it('restores a user-maximised window when startup maximise is disabled', () => {
    expect(resolveStartupWindowRestoreMode(false, 'maximized')).toBe('maximised');
  });

  it('maximises the startup window on every desktop platform when enabled', () => {
    expect(resolveStartupWindowRestoreMode(true, 'normal')).toBe('maximised');
  });

  it('does not accept a stale Windows WebView surface as a settled maximised window', () => {
    expect(isStartupMaximisedWindowSettled({
      isMaximised: true,
      isWindows: true,
      surfaceWidth: 1432,
      surfaceHeight: 892,
      viewport: {
        availWidth: 1920,
        availHeight: 1050,
      },
    })).toBe(false);
  });

  it('accepts a Windows WebView surface that covers the maximised work area', () => {
    expect(isStartupMaximisedWindowSettled({
      isMaximised: true,
      isWindows: true,
      surfaceWidth: 1912,
      surfaceHeight: 1042,
      viewport: {
        availWidth: 1920,
        availHeight: 1050,
      },
    })).toBe(true);
  });

  it('keeps state-only maximise detection on non-Windows platforms', () => {
    expect(isStartupMaximisedWindowSettled({
      isMaximised: true,
      isWindows: false,
      surfaceWidth: 800,
      surfaceHeight: 600,
      viewport: {
        availWidth: 1920,
        availHeight: 1050,
      },
    })).toBe(true);
  });

  it('never settles when the native window is not maximised', () => {
    expect(isStartupMaximisedWindowSettled({
      isMaximised: false,
      isWindows: true,
      surfaceWidth: 1920,
      surfaceHeight: 1050,
      viewport: {
        availWidth: 1920,
        availHeight: 1050,
      },
    })).toBe(false);
  });
});
