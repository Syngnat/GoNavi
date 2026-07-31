import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readV2ThemeCss } from '../test/readV2ThemeCss';

const appCss = readFileSync(
  fileURLToPath(new globalThis.URL('../App.css', import.meta.url)),
  'utf8',
);
const v2ThemeCss = readV2ThemeCss();

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrastRatio = (foreground: string, background: string): number => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
};

const readHexToken = (cssBlock: string, token: string): string => {
  const match = cssBlock.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`Missing token ${token}`);
  return match[1];
};

describe('DriverManagerModal embedded layout', () => {
  it('keeps the version and progress controls shrinkable inside the settings panel', () => {
    expect(appCss).toMatch(
      /\.driver-manager-shell\.is-embedded \.driver-manager-card-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(96px,\s*0\.7fr\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-control-block\s*\{[^}]*min-width:\s*0/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-progress\.ant-progress-line\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s,
    );
  });

  it('keeps light-theme primary buttons at accessible contrast', () => {
    const lightBlock = v2ThemeCss.match(
      /body\[data-ui-version="v2"\]\[data-theme="light"\]\s*\{([^}]*)\}/s,
    )?.[1];
    expect(lightBlock).toBeTruthy();
    const foreground = readHexToken(lightBlock || '', '--gn-on-accent');
    const background = readHexToken(lightBlock || '', '--gn-accent-strong');
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
