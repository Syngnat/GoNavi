import { describe, expect, it } from 'vitest';

import { buildRedisWorkbenchTheme } from './redisViewerWorkbenchTheme';

describe('buildRedisWorkbenchTheme', () => {
  it('builds dark redis workbench theme', () => {
    const darkTheme = buildRedisWorkbenchTheme({ darkMode: true, blur: 14 });
    expect(darkTheme.isDark).toBe(true);
    expect(darkTheme.panelBg).toBe('#161a21');
    expect(darkTheme.toolbarPrimaryBg).toMatch(/^linear-gradient\(/);
    expect(darkTheme.actionDangerBg).not.toBe(darkTheme.actionSecondaryBg);
    expect(darkTheme.treeSelectedBg).not.toBe(darkTheme.treeHoverBg);
    expect(darkTheme.appBg).toBe('#0c0e12');
    expect(darkTheme.panelBgStrong).toBe('#1b1f27');
    expect(darkTheme.backdropFilter).toBe('blur(14px)');
  });

  it('builds light redis workbench theme', () => {
    const lightTheme = buildRedisWorkbenchTheme({ darkMode: false, blur: 0 });
    expect(lightTheme.isDark).toBe(false);
    expect(lightTheme.panelBg).toBe('#ffffff');
    expect(lightTheme.contentEmptyBg).toMatch(/^linear-gradient\(/);
    expect(lightTheme.textPrimary).not.toBe(lightTheme.textSecondary);
    expect(lightTheme.statusTagBg).not.toBe(lightTheme.statusTagMutedBg);
    expect(lightTheme.backdropFilter).toBe('none');
  });

  it('can disable redis workbench blur for macOS text-entry compatibility', () => {
    const darkTheme = buildRedisWorkbenchTheme({ darkMode: true, blur: 14, disableBackdropFilter: true });
    expect(darkTheme.backdropFilter).toBe('none');
  });
});
