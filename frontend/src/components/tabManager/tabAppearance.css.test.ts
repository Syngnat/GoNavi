import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabAppearanceCss = readFileSync(new URL('./tabAppearance.css', import.meta.url), 'utf8');

const withoutComments = tabAppearanceCss.replace(/\/\*[\s\S]*?\*\//g, '');

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readRule = (selector: string): string => {
  const match = withoutComments.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1];
};

const collectColorDeclarations = () => {
  const declarations: Array<{ property: string; value: string }> = [];
  withoutComments.replace(/([a-z-]+)\s*:\s*([^;}]+)/g, (_match, property: string, value: string) => {
    declarations.push({ property, value });
    return _match;
  });
  return declarations.filter(({ property }) =>
    /^(?:background|background-color|color|border-color|box-shadow)$/.test(property));
};

const WORKBENCH_ROOT = "body[data-ui-version='v2'] .gn-v2-tab-workbench";
const UNDERLINE_ROOT =
  `${WORKBENCH_ROOT}[data-tab-appearance='underline'] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-nav-list`;
const PILL_ROOT = `${WORKBENCH_ROOT}[data-tab-appearance='pill'] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-nav-list`;
const LEFT_CLOSE_SELECTOR =
  `${WORKBENCH_ROOT}[data-tab-close-position='left'] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-nav-list .gn-v2-tab-close`;

describe('main workbench tab appearance styles', () => {
  it('keeps the card style free of any rule', () => {
    expect(tabAppearanceCss).not.toMatch(/data-tab-appearance\s*=\s*['"]card['"]/);
  });

  it('scopes every rule to the main workbench tab bar', () => {
    const selectors = [...withoutComments.matchAll(/^([^@{}\n][^{}\n]*?)\s*\{/gm)]
      .map((match) => match[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    selectors.forEach((selector) => {
      expect(selector).toContain('.gn-v2-tab-workbench');
      expect(selector).toContain('.gn-v2-main-tabs');
      // navicat 布局的激活页签规则到 (0,6,1)，多这一层 class 才能稳定压过它。
      expect(selector).toContain('.ant-tabs-nav-list');
    });
  });

  it('drops the card surface and draws a bottom accent line for the underline style', () => {
    const base = readRule(`${UNDERLINE_ROOT} .ant-tabs-tab`);
    expect(base).toContain('background: transparent !important;');
    expect(base).toContain('border-right: 0 !important;');
    expect(base).toContain('border-radius: 0 !important;');
    expect(base).toContain('box-shadow: none !important;');

    expect(readRule(`${UNDERLINE_ROOT} .ant-tabs-tab:hover:not(.ant-tabs-tab-active)`))
      .toContain('background: var(--gn-bg-hover) !important;');

    const active = readRule(`${UNDERLINE_ROOT} .ant-tabs-tab.ant-tabs-tab-active`);
    expect(active).toContain('background: transparent !important;');
    expect(active).toContain('box-shadow: inset 0 -2px 0 var(--gn-accent) !important;');
  });

  it('rounds the pills, spaces adjacent pills and outlines the active one', () => {
    const base = readRule(`${PILL_ROOT} .ant-tabs-tab`);
    expect(base).toContain('border-radius: 999px !important;');
    expect(base).toContain('background: transparent !important;');
    expect(base).toContain('border-right: 0 !important;');
    expect(base).toContain('box-shadow: none !important;');

    expect(readRule(`${PILL_ROOT} .ant-tabs-tab + .ant-tabs-tab`))
      .toContain('margin-left: 6px !important;');
    expect(readRule(`${PILL_ROOT} .ant-tabs-tab:hover:not(.ant-tabs-tab-active)`))
      .toContain('background: var(--gn-bg-hover) !important;');

    const active = readRule(`${PILL_ROOT} .ant-tabs-tab.ant-tabs-tab-active`);
    expect(active).toContain('background: var(--gn-bg-active) !important;');
    expect(active).toContain('box-shadow: inset 0 0 0 1px var(--gn-br-2) !important;');
  });

  it('releases the navicat right-edge pin for the left close position', () => {
    const rule = readRule(LEFT_CLOSE_SELECTOR);
    expect(rule).toContain('margin-left: 0 !important;');
    expect(rule).toContain('margin-right: 0;');
  });

  it('colors every declaration with gn theme variables', () => {
    expect(tabAppearanceCss).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(tabAppearanceCss).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
    expect(tabAppearanceCss).toContain('var(--gn-');

    collectColorDeclarations().forEach(({ property, value }) => {
      const normalized = value.replace(/!important/g, '').trim();
      expect(
        normalized.includes('var(--gn-') || normalized === 'none' || normalized === 'transparent',
        `${property}: ${value}`,
      ).toBe(true);
    });
  });
});
