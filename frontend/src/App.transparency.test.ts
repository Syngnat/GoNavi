import { describe, expect, it } from 'vitest';
import { BUILTIN_CUSTOM_THEME_PRESETS } from './utils/customThemePresets';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('built-in custom theme transparency contract', () => {
  it('keeps built-in theme surfaces connected to the live opacity', () => {
    const surfaceProperties = [
      '--gn-bg-app',
      '--gn-bg-chrome',
      '--gn-bg-panel',
      '--gn-bg-panel-2',
      '--gn-bg-titlebar',
      '--gn-bg-input',
      '--gn-bg-subtle',
    ];

    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      for (const property of surfaceProperties) {
        const declaration = preset.css.match(
          new RegExp(`${escapeRegExp(property)}\\s*:\\s*[^;]+`),
        )?.[0];
        expect(declaration, `${preset.id} ${property}`).toContain('var(--gn-window-opacity-percent, 100%)');
      }
    }
  });

  it('uses a white foreground hierarchy for every dark translucent preset', () => {
    const darkPresets = BUILTIN_CUSTOM_THEME_PRESETS.filter((preset) => (
      preset.css.includes('color-scheme: dark;')
    ));
    expect(darkPresets.length).toBeGreaterThan(0);
    for (const preset of darkPresets) {
      expect(preset.css, preset.id).toContain('--gn-fg-1: #ffffff;');
      expect(preset.css, preset.id).toContain('--gn-fg-2: #f5f5f5;');
      expect(preset.css, preset.id).toContain('--gn-fg-3: #e6e6e6;');
      expect(preset.css, preset.id).toContain('--gn-fg-4: #d9d9d9;');
      expect(preset.css, preset.id).toContain('--gn-fg-5: #cccccc;');
    }
  });
});
