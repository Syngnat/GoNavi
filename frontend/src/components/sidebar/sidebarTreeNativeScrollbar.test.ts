import { describe, expect, it } from 'vitest';

import { readV2ThemeCss } from '../../test/readV2ThemeCss';
import { readCssWithImports } from '../../test/readCssWithImports';

const SHARED_SCROLLBAR_SELECTOR = 'body[data-ui-version="v2"] .gonavi-settings-center-workbench-host ::-webkit-scrollbar,\nbody[data-ui-version="v2"] .gonavi-settings-center-workbench ::-webkit-scrollbar,\nbody[data-ui-version="v2"] .gonavi-settings-center-modal ::-webkit-scrollbar,\nbody[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-holder::-webkit-scrollbar';
const SHARED_TRACK_SELECTOR = 'body[data-ui-version="v2"] .gonavi-settings-center-workbench-host ::-webkit-scrollbar-track,\nbody[data-ui-version="v2"] .gonavi-settings-center-workbench ::-webkit-scrollbar-track,\nbody[data-ui-version="v2"] .gonavi-settings-center-modal ::-webkit-scrollbar-track,\nbody[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-holder::-webkit-scrollbar-track';
const SHARED_HORIZONTAL_TRACK_SELECTOR = 'body[data-ui-version="v2"] .gonavi-settings-center-workbench-host ::-webkit-scrollbar-track:horizontal,\nbody[data-ui-version="v2"] .gonavi-settings-center-workbench ::-webkit-scrollbar-track:horizontal,\nbody[data-ui-version="v2"] .gonavi-settings-center-modal ::-webkit-scrollbar-track:horizontal,\nbody[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-holder::-webkit-scrollbar-track:horizontal';

const readAppCss = (): string => (
  readCssWithImports(new URL('../../App.css', import.meta.url))
);

const readCssRuleBlock = (css: string, selector: string): string => {
  const normalizedCss = css.replace(/\r\n/g, '\n');
  const start = normalizedCss.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`missing CSS rule: ${selector}`);
  }
  const open = normalizedCss.indexOf('{', start);
  const close = normalizedCss.indexOf('}', open);
  return normalizedCss.slice(open + 1, close);
};

describe('sidebar tree native scrollbars', () => {
  it('shares the settings-center 8px bar with a visible track on both axes', () => {
    const themeCss = readV2ThemeCss();
    const appCss = readAppCss();
    const scrollbarCss = readCssRuleBlock(themeCss, SHARED_SCROLLBAR_SELECTOR);
    const trackCss = readCssRuleBlock(themeCss, SHARED_TRACK_SELECTOR);
    const horizontalTrackCss = readCssRuleBlock(themeCss, SHARED_HORIZONTAL_TRACK_SELECTOR);

    expect(themeCss).toMatch(
      /\.gonavi-settings-center-workbench-host,[\s\S]*?\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*scrollbar-width: thin;/s,
    );
    expect(scrollbarCss).toContain('width: 8px;');
    expect(scrollbarCss).toContain('height: 8px;');
    expect(trackCss).toContain('--gn-bg-panel');
    expect(trackCss).not.toContain('background: transparent;');
    expect(horizontalTrackCss).toContain('margin: 0;');
    expect(scrollbarCss).toContain('-webkit-appearance: none;');
    expect(themeCss).toMatch(
      /\.gn-v2-explorer-tree-shell \.ant-tree-list-holder::-webkit-scrollbar:horizontal \{[^}]*background: color-mix\(in srgb, var\(--gn-fg-4\) 14%, var\(--gn-bg-panel\)\);/s,
    );
    expect(themeCss).toMatch(
      /\.gn-v2-explorer-tree-shell \.ant-tree-list-scrollbar-horizontal \{[^}]*display: none !important;/s,
    );
    expect(themeCss).toMatch(
      /\.gn-v2-explorer-tree-shell \.ant-tree-list-holder::-webkit-scrollbar-thumb:horizontal \{[^}]*min-width: 36px;[^}]*background-color: color-mix\(in srgb, var\(--gn-fg-4\) 42%, var\(--gn-bg-panel\)\);/s,
    );
    // The tree never scrolls horizontally; only the vertical bar uses the skin.
    expect(themeCss).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*overflow-x: hidden !important;/s);
    expect(themeCss).not.toContain('data-horizontal-scroll-active');
    expect(appCss).toContain(
      "body[data-theme='dark']:not([data-platform='windows']) :not(:is(.gn-v2-explorer-tree-shell .ant-tree-list-holder))::-webkit-scrollbar",
    );
  });
});
