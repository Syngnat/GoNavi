import { describe, expect, it } from 'vitest';

import {
  normalizeTitlebarRuntimePlatform,
  resolveDocumentPlatform,
  resolveTitleBarLayout,
  resolveTitlebarRuntimePlatform,
  shouldDockCollapsedSidebarActionsInTitlebar,
} from './titlebarLayout';

describe('titlebarLayout', () => {
  describe('normalizeTitlebarRuntimePlatform', () => {
    it.each([
      [' Darwin ', 'darwin'],
      ['macOS', 'darwin'],
      ['WIN32', 'windows'],
      ['linux', 'linux'],
      ['freebsd', 'freebsd'],
      ['', ''],
    ])('normalizes %s to %s', (runtimePlatform, expected) => {
      expect(normalizeTitlebarRuntimePlatform(runtimePlatform)).toBe(expected);
    });
  });

  describe('resolveTitlebarRuntimePlatform', () => {
    it.each([
      ['darwin', '', 'darwin'],
      [' Darwin ', '', 'darwin'],
      ['macOS', 'Windows', 'darwin'],
      ['windows', '', 'windows'],
      [' WIN32 ', 'MacIntel', 'windows'],
    ])('prefers a recognized runtime platform (%s)', (runtimePlatform, navigatorPlatform, expected) => {
      expect(resolveTitlebarRuntimePlatform(runtimePlatform, navigatorPlatform)).toBe(expected);
    });

    it.each([
      ['Darwin', 'darwin'],
      ['MacIntel', 'darwin'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'darwin'],
      ['Windows', 'windows'],
      ['Win32', 'windows'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ])('recognizes explicit browser platform data (%s)', (navigatorPlatform, expected) => {
      expect(resolveTitlebarRuntimePlatform('', navigatorPlatform)).toBe(expected);
    });

    it('does not fall back to browser data when runtime reports another platform', () => {
      expect(resolveTitlebarRuntimePlatform('linux', 'MacIntel')).toBeNull();
    });
  });

  describe('resolveDocumentPlatform', () => {
    it.each([
      ['macOS', 'Windows', 'darwin'],
      [' WIN32 ', 'MacIntel', 'windows'],
      ['linux', 'MacIntel', 'linux'],
      ['FreeBSD', 'MacIntel', 'freebsd'],
    ])('keeps a reported runtime platform authoritative (%s)', (runtimePlatform, navigatorPlatform, expected) => {
      expect(resolveDocumentPlatform(runtimePlatform, navigatorPlatform)).toBe(expected);
    });

    it.each([
      ['', 'MacIntel', 'darwin'],
      ['', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
      ['', 'Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
      ['', 'Android', ''],
      ['', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', ''],
    ])('uses a canonical browser fallback before runtime bootstrap (%s / %s)', (runtimePlatform, navigatorPlatform, expected) => {
      expect(resolveDocumentPlatform(runtimePlatform, navigatorPlatform)).toBe(expected);
    });
  });

  describe('shouldDockCollapsedSidebarActionsInTitlebar', () => {
    it.each([
      ['darwin', ''],
      ['windows', ''],
      [' Darwin ', ''],
      [' WINDOWS ', ''],
    ])('docks V2 actions for runtime platform %s', (runtimePlatform, navigatorPlatform) => {
      expect(shouldDockCollapsedSidebarActionsInTitlebar(true, runtimePlatform, navigatorPlatform)).toBe(true);
    });

    it.each([
      ['', 'MacIntel'],
      ['', 'Win32'],
      ['', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)'],
      ['', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'],
    ])('uses navigator platform fallback %s / %s', (runtimePlatform, navigatorPlatform) => {
      expect(shouldDockCollapsedSidebarActionsInTitlebar(true, runtimePlatform, navigatorPlatform)).toBe(true);
    });

    it.each([
      [false, 'darwin', ''],
      [true, 'linux', 'MacIntel'],
      [true, 'linux', 'Win32'],
      [true, 'freebsd', 'MacIntel'],
      [true, 'android', 'Win32'],
      [true, '', 'Linux x86_64'],
      [true, '', 'Android'],
    ])('does not dock unsupported platform %s / %s / %s', (isV2Ui, runtimePlatform, navigatorPlatform) => {
      expect(shouldDockCollapsedSidebarActionsInTitlebar(isV2Ui, runtimePlatform, navigatorPlatform)).toBe(false);
    });

    it('does not dock browser-hosted V2 actions even when the browser is Windows or macOS', () => {
      expect(shouldDockCollapsedSidebarActionsInTitlebar(true, 'windows', '', true)).toBe(false);
      expect(shouldDockCollapsedSidebarActionsInTitlebar(true, '', 'MacIntel', true)).toBe(false);
    });
  });

  it('restores the compact V2 titlebar while the explorer is expanded', () => {
    expect(resolveTitleBarLayout(1, true)).toEqual({
      height: 32,
      actionHeight: 26,
      dividerHeight: 12,
      upperBandHeight: 32,
      emptyWorkbenchTopOffset: 0,
    });
  });

  it('keeps the expanded V2 layout responsive to the configured UI scale', () => {
    expect(resolveTitleBarLayout(0.8, true, false)).toEqual({
      height: 28,
      actionHeight: 24,
      dividerHeight: 10,
      upperBandHeight: 28,
      emptyWorkbenchTopOffset: 0,
    });
    expect(resolveTitleBarLayout(1.25, true, false)).toEqual({
      height: 40,
      actionHeight: 33,
      dividerHeight: 15,
      upperBandHeight: 40,
      emptyWorkbenchTopOffset: 0,
    });
    expect(resolveTitleBarLayout(1.1, true, false)).toEqual({
      height: 35,
      actionHeight: 29,
      dividerHeight: 13,
      upperBandHeight: 35,
      emptyWorkbenchTopOffset: 0,
    });
  });

  it('keeps the taller V2 titlebar only while collapsed actions are docked into it', () => {
    expect(resolveTitleBarLayout(1, true, true)).toEqual({
      height: 57,
      actionHeight: 26,
      dividerHeight: 12,
      upperBandHeight: 29,
      emptyWorkbenchTopOffset: 25,
    });
    expect(resolveTitleBarLayout(0.8, true, true)).toEqual({
      height: 52,
      actionHeight: 24,
      dividerHeight: 10,
      upperBandHeight: 29,
      emptyWorkbenchTopOffset: 24,
    });
    expect(resolveTitleBarLayout(1.25, true, true)).toEqual({
      height: 70,
      actionHeight: 33,
      dividerHeight: 15,
      upperBandHeight: 33,
      emptyWorkbenchTopOffset: 30,
    });
    expect(resolveTitleBarLayout(1.1, true, true)).toEqual({
      height: 62,
      actionHeight: 29,
      dividerHeight: 13,
      upperBandHeight: 31,
      emptyWorkbenchTopOffset: 27,
    });
  });

  it.each([0.8, 0.9, 0.95, 1, 1.1, 1.25])(
    'keeps the empty workbench content origin stable at UI scale %s',
    (scale) => {
      const expanded = resolveTitleBarLayout(scale, true, false);
      const collapsed = resolveTitleBarLayout(scale, true, true);

      expect(collapsed.height - collapsed.emptyWorkbenchTopOffset).toBe(expanded.height);
    },
  );

  it.each([0.8, 0.9, 0.95, 1, 1.1, 1.25])(
    'keeps the two docked titlebar rows separated at UI scale %s',
    (scale) => {
      const layout = resolveTitleBarLayout(scale, true, true);
      const upperBandBottom = layout.upperBandHeight;
      const collapsedBandTop = layout.height - 1 - (26 * scale);

      expect(collapsedBandTop - upperBandBottom).toBeGreaterThanOrEqual(1);
    },
  );

  it('preserves the compact legacy titlebar dimensions', () => {
    expect(resolveTitleBarLayout(1, false)).toEqual({
      height: 32,
      actionHeight: 26,
      dividerHeight: 12,
      upperBandHeight: 32,
      emptyWorkbenchTopOffset: 0,
    });
  });
});
