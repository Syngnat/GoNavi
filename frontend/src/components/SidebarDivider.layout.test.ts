import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';

const readCssFile = (relativePath: string): string => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
);

const readCssRule = (css: string, selector: string): string => {
  const start = css.indexOf(selector);
  const openingBrace = css.indexOf('{', start + selector.length);
  const closingBrace = css.indexOf('}', openingBrace + 1);
  expect(start, 'Missing CSS rule for ' + selector).toBeGreaterThanOrEqual(0);
  expect(openingBrace).toBeGreaterThan(start);
  expect(closingBrace).toBeGreaterThan(openingBrace);
  return css.slice(start, closingBrace + 1);
};

describe('sidebar divider layout', () => {
  it('uses one outer divider for expanded V2 and keeps the collapsed rail divider', () => {
    const appCss = readCssFile('../App.css');
    const v2ThemeCss = readV2ThemeCss();
    const siderRule = readCssRule(v2ThemeCss, 'body[data-ui-version="v2"] .ant-layout-sider');
    const sidebarRule = readCssRule(v2ThemeCss, 'body[data-ui-version="v2"] .gn-v2-sidebar-redesign');
    const railRule = readCssRule(v2ThemeCss, 'body[data-ui-version="v2"] .gn-v2-connection-rail');
    const expandedRailRule = readCssRule(
      appCss,
      "body[data-ui-version='v2'] .ant-layout-sider[data-sidebar-collapsed='false'] .gn-v2-connection-rail",
    );
    const collapsedSiderRule = readCssRule(
      appCss,
      "body[data-ui-version] .ant-layout-sider[data-sidebar-collapsed='true']",
    );

    expect(siderRule).toContain('border-right: 0.5px solid var(--gn-br-1) !important;');
    expect(sidebarRule).not.toContain('border-right:');
    expect(railRule).toContain('border-right: 0.5px solid var(--gn-br-1);');
    expect(railRule).toContain('display: flex;');
    expect(expandedRailRule).toContain('display: none;');
    expect(collapsedSiderRule).toContain('border-right: 0 !important;');
  });
});
