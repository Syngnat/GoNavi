import { describe, expect, it } from 'vitest';

import { buildOverlayWorkbenchTheme } from './overlayWorkbenchTheme';

describe('buildOverlayWorkbenchTheme', () => {
  it('builds dark theme tokens', () => {
    const darkTheme = buildOverlayWorkbenchTheme(true);
    expect(darkTheme.isDark).toBe(true);
    expect(darkTheme.shellBg).toMatch(/rgba\(22, 26, 33,/);
    expect(darkTheme.sectionBg).toMatch(/rgba\(255,?\s*255,?\s*255,?\s*0\.04\)/);
    expect(darkTheme.iconColor).toBe('#22c55e');
  });

  it('builds light theme tokens', () => {
    const lightTheme = buildOverlayWorkbenchTheme(false);
    expect(lightTheme.isDark).toBe(false);
    expect(lightTheme.shellBg).toMatch(/rgba\(255,255,255,0\.98\)/);
    expect(lightTheme.sectionBg).toMatch(/rgba\(255,?\s*255,?\s*255,?\s*0\.85\)/);
    expect(lightTheme.iconColor).toBe('#16a34a');
  });

  it('can disable shell blur for macOS text-entry compatibility', () => {
    const darkTheme = buildOverlayWorkbenchTheme(true, { disableBackdropFilter: true });
    expect(darkTheme.shellBackdropFilter).toBe('none');
  });

  it('can resolve V2 overlay colors from the active document theme variables', () => {
    const detachedTheme = buildOverlayWorkbenchTheme(false, {
      useThemeVariables: true,
    });

    expect(detachedTheme.shellBg).toBe('var(--gn-bg-panel, #ffffff)');
    expect(detachedTheme.sectionBg).toBe('var(--gn-bg-panel-2, #fafaf8)');
    expect(detachedTheme.titleText).toBe('var(--gn-fg-1, #0c1322)');
    expect(detachedTheme.iconColor).toBe('var(--gn-accent, #15803d)');
    expect(detachedTheme.selectedBg).toBe('var(--gn-bg-selected, rgba(34, 197, 94, 0.10))');
  });
});
