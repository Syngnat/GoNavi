import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readV2ThemeCss } from '../test/readV2ThemeCss';

const appCss = readFileSync(
  fileURLToPath(new globalThis.URL('../App.css', import.meta.url)),
  'utf8',
);
const v2ThemeCss = readV2ThemeCss();

const MIN_TEXT_CONTRAST = 4.5;
const MIN_STATE_CONTRAST = 1.25;

const themeModes = ['light', 'dark'] as const;

const primaryButtonStates = [
  {
    name: 'default',
    selector: 'body[data-ui-version="v2"] .ant-btn-primary',
    backgroundToken: '--gn-accent-strong',
    backgroundValue: 'var(--gn-accent-strong, var(--gn-accent))',
  },
  {
    name: 'hover',
    selector: 'body[data-ui-version="v2"] .ant-btn-primary:hover',
    backgroundToken: '--gn-accent-strong-hover',
    backgroundValue: 'var(--gn-accent-strong-hover, var(--gn-accent-2))',
  },
  {
    name: 'active',
    selector: 'body[data-ui-version="v2"] .ant-btn-primary:active',
    backgroundToken: '--gn-accent-strong-active',
    backgroundValue: 'var(--gn-accent-strong-active, var(--gn-accent-2))',
  },
] as const;

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

const readThemeBlock = (theme: (typeof themeModes)[number]): string => {
  const block = v2ThemeCss.match(
    new RegExp(`body\\[data-ui-version="v2"\\]\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`, 's'),
  )?.[1];
  if (!block) throw new Error(`Missing ${theme} theme block`);
  return block;
};

const readCssRule = (selector: string): string => {
  const selectorStart = v2ThemeCss.indexOf(`${selector} {`);
  if (selectorStart < 0) throw new Error(`Missing CSS rule ${selector}`);
  const bodyStart = v2ThemeCss.indexOf('{', selectorStart) + 1;
  const bodyEnd = v2ThemeCss.indexOf('}', bodyStart);
  if (bodyEnd < 0) throw new Error(`Unclosed CSS rule ${selector}`);
  return v2ThemeCss.slice(bodyStart, bodyEnd);
};

describe('DriverManagerModal embedded layout', () => {
  it('keeps version, transient progress, and actions in one readable settings flow', () => {
    const controlsRule = appCss.match(
      /\.driver-manager-shell\.is-embedded \.driver-manager-card-controls\s*\{([^}]*)\}/s,
    )?.[1] || '';
    expect(controlsRule).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(controlsRule).not.toContain('minmax(96px, 0.7fr)');
    expect(appCss).toMatch(
      /\.driver-manager-shell\.is-embedded \.driver-manager-card-actions\s*\{[^}]*grid-column:\s*1[^}]*justify-content:\s*flex-start/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-control-block\s*\{[^}]*min-width:\s*0/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-progress\.ant-progress-line\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s,
    );
  });

});

describe('V2 filled accent contrast', () => {
  it.each(themeModes)('keeps %s-theme accent surfaces readable', (theme) => {
    const block = readThemeBlock(theme);
    const foreground = readHexToken(block, '--gn-on-accent');

    for (const backgroundToken of ['--gn-accent', '--gn-accent-2']) {
      const background = readHexToken(block, backgroundToken);
      expect(
        contrastRatio(foreground, background),
        `${theme} ${backgroundToken} foreground contrast`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it.each(themeModes)('keeps %s-theme primary button states readable and distinct', (theme) => {
    const block = readThemeBlock(theme);
    const foreground = readHexToken(
      readCssRule('body[data-ui-version="v2"]:not([data-custom-theme])'),
      '--gn-ant-on-primary',
    );
    const backgrounds = primaryButtonStates.map(({ backgroundToken }) => (
      readHexToken(block, backgroundToken)
    ));

    backgrounds.forEach((background, index) => {
      expect(
        contrastRatio(foreground, background),
        `${theme} ${primaryButtonStates[index].name} label contrast`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
    for (let index = 0; index < backgrounds.length - 1; index += 1) {
      expect(
        contrastRatio(backgrounds[index], backgrounds[index + 1]),
        `${theme} ${primaryButtonStates[index].name} to ${primaryButtonStates[index + 1].name} state contrast`,
      ).toBeGreaterThanOrEqual(MIN_STATE_CONTRAST);
    }
  });

  it('wires every primary button state to the primary foreground token', () => {
    for (const state of primaryButtonStates) {
      const rule = readCssRule(state.selector);
      expect(rule).toContain(`background: ${state.backgroundValue} !important;`);
      expect(rule).toContain(
        'color: var(--gn-ant-on-primary, var(--gn-on-accent, #fff)) !important;',
      );
    }
  });
});
