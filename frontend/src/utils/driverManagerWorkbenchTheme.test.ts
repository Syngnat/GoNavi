import { describe, expect, it } from 'vitest';

import { buildDriverManagerWorkbenchTheme } from './driverManagerWorkbenchTheme';

describe('driverManagerWorkbenchTheme', () => {
  it('builds a dark driver manager theme with dark surfaces', () => {
    const theme = buildDriverManagerWorkbenchTheme(true);

    expect(theme.isDark).toBe(true);
    expect(theme.pageBg).toBe('#161a21');
    expect(theme.sectionBg).toBe('#1b1f27');
    expect(theme.cardBg).toBe('#161a21');
    expect(theme.statBg).toBe('#1b1f27');
    expect(theme.updateNoteBg).toBe('rgba(245, 158, 11, 0.10)');
    expect(theme.titleText).toBe('#f1f3f5');
    expect(theme.warningText).toBe('#f59e0b');
  });

  it('builds a light driver manager theme with light surfaces', () => {
    const theme = buildDriverManagerWorkbenchTheme(false);

    expect(theme.isDark).toBe(false);
    expect(theme.pageBg).toBe('#ffffff');
    expect(theme.sectionBg).toBe('#fafaf8');
    expect(theme.cardBg).toBe('#ffffff');
    expect(theme.statBg).toBe('#fafaf8');
    expect(theme.updateNoteBg).toBe('rgba(217, 119, 6, 0.08)');
    expect(theme.titleText).toBe('#0c1322');
    expect(theme.warningText).toBe('#d97706');
  });
});
