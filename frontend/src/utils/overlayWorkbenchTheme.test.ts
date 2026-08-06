import { describe, expect, it } from 'vitest';

import { buildOverlayWorkbenchTheme } from './overlayWorkbenchTheme';

describe('buildOverlayWorkbenchTheme', () => {
  it('builds dark theme tokens', () => {
    const darkTheme = buildOverlayWorkbenchTheme(true);
    expect(darkTheme.isDark).toBe(true);
    expect(darkTheme.shellBg).toMatch(/rgba\(15, 15, 17,/);
    expect(darkTheme.sectionBg).toMatch(/rgba\(255,?\s*255,?\s*255,?\s*0\.03\)/);
    expect(darkTheme.iconColor).toBe('#ffd666');
  });

  it('builds light theme tokens', () => {
    const lightTheme = buildOverlayWorkbenchTheme(false);
    expect(lightTheme.isDark).toBe(false);
    expect(lightTheme.shellBg).toMatch(/rgba\(255,255,255,0\.98\)/);
    expect(lightTheme.sectionBg).toMatch(/rgba\(255,?\s*255,?\s*255,?\s*0\.84\)/);
    expect(lightTheme.iconColor).toBe('#1677ff');
  });

  it('can disable shell blur for macOS text-entry compatibility', () => {
    const darkTheme = buildOverlayWorkbenchTheme(true, { disableBackdropFilter: true });
    expect(darkTheme.shellBackdropFilter).toBe('none');
  });

  it('builds v2 theme tokens from explicit uiVersion instead of reading body state', () => {
    const darkTheme = buildOverlayWorkbenchTheme(true, { uiVersion: 'v2' });
    const lightTheme = buildOverlayWorkbenchTheme(false, { uiVersion: 'v2' });

    expect(darkTheme.iconColor).toBe('#22c55e');
    expect(darkTheme.selectedText).toBe('#4ade80');
    expect(lightTheme.iconColor).toBe('#16a34a');
    expect(lightTheme.selectedText).toBe('#15803d');
  });

  it('can resolve V2 overlay colors from the active document theme variables', () => {
    const detachedTheme = buildOverlayWorkbenchTheme(false, {
      uiVersion: 'v2',
      useThemeVariables: true,
    });

    expect(detachedTheme.shellBg).toBe('var(--gn-bg-panel, #ffffff)');
    expect(detachedTheme.sectionBg).toBe('var(--gn-bg-panel-2, #fafaf8)');
    expect(detachedTheme.titleText).toBe('var(--gn-fg-1, #0c1322)');
    expect(detachedTheme.iconColor).toBe('var(--gn-accent, #15803d)');
    expect(detachedTheme.selectedBg).toBe('var(--gn-bg-selected, rgba(34, 197, 94, 0.10))');
  });
});
