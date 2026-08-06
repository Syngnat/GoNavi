import { describe, expect, it } from 'vitest';
import {
  CUSTOM_THEME_MAX_BYTES,
  getCustomThemeByteLength,
  sanitizeCustomThemeDefinition,
  validateCustomThemeCss,
  type CustomThemeDefinition,
} from './customTheme';
import {
  BUILTIN_CUSTOM_THEME_PRESETS,
  resolveAvailableCustomTheme,
  resolveBuiltinCustomThemePreset,
} from './customThemePresets';

const readHexProperty = (css: string, property: string): string => {
  const match = css.match(new RegExp(`${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`Missing hexadecimal custom property: ${property}`);
  return match[1];
};

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

const contrastRatio = (foreground: string, background: string): number => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
};

describe('built-in custom theme presets', () => {
  it('ships six unique, safe, size-bounded presets', () => {
    expect(BUILTIN_CUSTOM_THEME_PRESETS).toHaveLength(6);
    const ids = new Set<string>();
    const nameKeys = new Set<string>();
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      expect(preset.id).toMatch(/^builtin-[a-z0-9-]+$/);
      expect(ids.has(preset.id)).toBe(false);
      expect(nameKeys.has(preset.nameKey)).toBe(false);
      ids.add(preset.id);
      nameKeys.add(preset.nameKey);
      expect(validateCustomThemeCss(preset.css)).toEqual(expect.objectContaining({ ok: true }));
      expect(getCustomThemeByteLength(preset.css)).toBeLessThan(CUSTOM_THEME_MAX_BYTES);
      expect(sanitizeCustomThemeDefinition(preset)).toEqual(expect.objectContaining({ id: preset.id }));
      expect(preset.css).toContain('--gn-ant-primary:');
      expect(preset.css).toContain('--gn-ant-on-primary:');
      expect(preset.css).toContain('--gn-monaco-bg: var(--gn-bg-panel-2);');
      expect(preset.css).toContain('--gn-settings-card-bg:');
      expect(preset.css).toContain('--gn-explain-critical:');
      expect(preset.css).toContain('--gn-status-connected:');
      expect(preset.css).toContain('.gn-v2-tab-label-part-host');
      expect(preset.css).toContain('.gn-v2-tab-label-part-database');
      expect(preset.css).toContain(
        'background-color: var(--gn-monaco-bg, var(--gn-bg-panel-2)) !important;',
      );
    }
    expect(BUILTIN_CUSTOM_THEME_PRESETS.filter((preset) => preset.baseMode === 'dark')).toHaveLength(4);
    expect(BUILTIN_CUSTOM_THEME_PRESETS.filter((preset) => preset.baseMode === 'light')).toHaveLength(2);
  });

  it('keeps Comfort Dark first and covers low-glare surfaces plus hard-coded hotspots', () => {
    const comfortDark = BUILTIN_CUSTOM_THEME_PRESETS[0];
    expect(comfortDark.id).toBe('builtin-comfort-dark');
    expect(comfortDark.baseMode).toBe('dark');
    expect(comfortDark.badgeKey).toBe('app.theme.custom.preset.badge.recommended');
    expect(comfortDark.css).toContain('--gn-bg-app: #1b1d21');
    expect(comfortDark.css).toContain('--gn-bg-panel: #24272d');
    expect(comfortDark.css).toContain('--gn-fg-5: #878e98');
    expect(comfortDark.css).toContain('--gn-on-accent: #142019');
    expect(comfortDark.css).toContain('.gn-v2-query-toolbar-save-action');
    // 保存：default 同族 + fg-1 图标，禁止软绿底/透明底踩 primary 前景
    expect(comfortDark.css).toContain('color: var(--gn-fg-1) !important');
    expect(comfortDark.css).not.toMatch(
      /\.gn-v2-query-toolbar-save-action[\s\S]{0,200}background:\s*transparent\s*!important/,
    );
    expect(comfortDark.css).toContain('.gn-v2-ai-panel .ai-logo');
    expect(comfortDark.css).toContain('.monaco-editor-background');
    expect(comfortDark.css).not.toContain('background-color: var(--gn-bg-input) !important;');
  });

  it('keeps preset text and solid-button colors at WCAG AA contrast', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const panel = readHexProperty(preset.css, '--gn-bg-panel');
      const panel2 = readHexProperty(preset.css, '--gn-bg-panel-2');
      for (const property of [
        '--gn-fg-1',
        '--gn-fg-2',
        '--gn-fg-3',
        '--gn-fg-4',
        '--gn-fg-5',
        '--gn-accent',
        '--gn-accent-2',
        '--gn-info',
        '--gn-warn',
        '--gn-danger',
        '--gn-purple',
        '--gn-status-connected',
      ]) {
        const color = readHexProperty(preset.css, property);
        expect(
          contrastRatio(color, panel),
          `${preset.id} ${property} must contrast with --gn-bg-panel`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const property of ['--gn-info', '--gn-accent', '--gn-status-connected']) {
        expect(
          contrastRatio(readHexProperty(preset.css, property), panel2),
          `${preset.id} ${property} must contrast with --gn-bg-panel-2`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      const onAccent = readHexProperty(preset.css, '--gn-on-accent');
      for (const property of ['--gn-accent', '--gn-accent-2']) {
        expect(
          contrastRatio(onAccent, readHexProperty(preset.css, property)),
          `${preset.id} --gn-on-accent must contrast with ${property}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrastRatio(readHexProperty(preset.css, '--gn-on-info'), readHexProperty(preset.css, '--gn-info')),
        `${preset.id} --gn-on-info must contrast with --gn-info`,
      ).toBeGreaterThanOrEqual(4.5);
      for (const property of ['--gn-danger-strong', '--gn-danger-strong-hover']) {
        expect(
          contrastRatio(readHexProperty(preset.css, '--gn-on-danger'), readHexProperty(preset.css, property)),
          `${preset.id} --gn-on-danger must contrast with ${property}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('resolves built-in and user themes through one active-theme boundary', () => {
    expect(resolveBuiltinCustomThemePreset('builtin-warm-paper')).toEqual(
      expect.objectContaining({ id: 'builtin-warm-paper', baseMode: 'light' }),
    );
    expect(resolveBuiltinCustomThemePreset('missing')).toBeNull();

    const userTheme: CustomThemeDefinition = {
      schemaVersion: 1,
      id: 'theme-user',
      name: 'User',
      sourceFileName: 'user.css',
      baseMode: 'system',
      css: 'body { color: red; }',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(resolveAvailableCustomTheme([userTheme], userTheme.id)).toBe(userTheme);
    expect(resolveAvailableCustomTheme([userTheme], 'builtin-midnight-navy')).toEqual(
      expect.objectContaining({ id: 'builtin-midnight-navy' }),
    );
    expect(resolveAvailableCustomTheme([userTheme], 'missing')).toBeNull();
  });
});
