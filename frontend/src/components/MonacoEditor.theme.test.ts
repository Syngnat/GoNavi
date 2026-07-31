import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_CUSTOM_THEME_PRESETS } from '../utils/customThemePresets';
import { registerGonaviMonacoThemes } from './MonacoEditor';

const readHexProperty = (css: string, property: string): string => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
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

describe('GoNavi Monaco themes', () => {
  it('defines bold SQL keyword colors that remain AA-readable on the shared workbench surface', () => {
    const defineTheme = vi.fn();
    registerGonaviMonacoThemes({ editor: { defineTheme } } as never);

    const definitions = new Map(
      defineTheme.mock.calls.map(([name, definition]) => [name, definition]),
    );
    const keywordTokens = [
      'keyword.sql',
      'keyword.try.sql',
      'keyword.catch.sql',
      'keyword.block.sql',
      'keyword.choice.sql',
    ];
    const lightRules = definitions.get('transparent-light')?.rules ?? [];
    const darkRules = definitions.get('transparent-dark')?.rules ?? [];

    for (const token of keywordTokens) {
      expect(lightRules.find((rule: any) => rule.token === token)).toMatchObject({
        foreground: '6D28D9',
        fontStyle: 'bold',
      });
      expect(darkRules.find((rule: any) => rule.token === token)).toMatchObject({
        foreground: 'C792EA',
        fontStyle: 'bold',
      });
    }

    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const keyword = (preset.baseMode === 'dark' ? darkRules : lightRules)
        .find((rule: any) => rule.token === 'keyword.sql');
      const background = readHexProperty(preset.css, '--gn-bg-panel-2');
      expect(
        contrastRatio(`#${keyword.foreground}`, background),
        `${preset.id} SQL keyword must contrast with its editor background`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
