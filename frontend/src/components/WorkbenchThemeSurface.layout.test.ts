import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readWorkbenchCss = (): string => readFileSync(
  new URL('../styles/v2-theme-workbench.css', import.meta.url),
  'utf8',
);

const readV2ThemeCss = (): string => readFileSync(
  new URL('../v2-theme.css', import.meta.url),
  'utf8',
);

const readSection = (css: string, startMarker: string, endMarker: string): string => {
  const start = css.indexOf(startMarker);
  const end = css.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
};

const readRule = (css: string, selector: string): string => {
  const start = css.indexOf(selector);
  const openingBrace = css.indexOf('{', start + selector.length);
  const closingBrace = css.indexOf('}', openingBrace + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(openingBrace).toBeGreaterThan(start);
  expect(closingBrace).toBeGreaterThan(openingBrace);
  return css.slice(start, closingBrace + 1);
};

describe('V2 workbench theme surfaces', () => {
  it('keeps Redis and Nacos workbench backgrounds on the secondary theme panel', () => {
    const css = readWorkbenchCss();
    const v2ThemeCss = readV2ThemeCss();
    const redisRootCss = readSection(
      v2ThemeCss,
      'body[data-ui-version="v2"] .redis-viewer-workbench',
      'body[data-ui-version="v2"] .redis-tree-expander-button:hover',
    );
    const redisCss = readSection(
      css,
      '/* ─── V2 Redis workbench ─ */',
      '/* ─── V2 Nacos workbench',
    );
    const nacosCss = readSection(
      css,
      '/* ─── V2 Nacos workbench',
      '/* ─── Nacos service discovery:',
    );

    expect(redisCss).toContain('background: var(--gn-bg-panel-2)');
    expect(redisCss).not.toMatch(/background:\s*var\(--gn-bg-panel\)(?:\s*!important)?;/);
    expect(redisRootCss).toContain('background: var(--gn-bg-panel-2) !important;');
    expect(redisRootCss).not.toContain('background: var(--gn-bg-app) !important;');
    expect(nacosCss).toContain('background: var(--gn-bg-panel-2)');
    expect(nacosCss).not.toMatch(/background:\s*var\(--gn-bg-panel\)(?:\s*!important)?;/);
  });

  it('keeps sidebar and Nacos filter inputs on their surrounding theme surface', () => {
    const css = readWorkbenchCss();
    const v2ThemeCss = readV2ThemeCss();
    const explorerSearchCss = readSection(
      v2ThemeCss,
      'body[data-ui-version="v2"] .gn-v2-explorer-search',
      'body[data-ui-version="v2"] .gn-v2-explorer-filter-tabs',
    );
    const nacosFilterCss = readSection(
      css,
      '/* Filter row: grow with left pane width so long DataId/Group names fit better */',
      '.gn-nacos-selection-toolbar',
    );

    expect(explorerSearchCss).toContain('background: var(--gn-bg-panel-2)');
    expect(explorerSearchCss).not.toContain('background: var(--gn-bg-input)');
    expect(nacosFilterCss).toContain('background: var(--gn-bg-panel-2) !important;');
  });

  it('keeps Redis key-tree and value-detail vertical tracks independent', () => {
    const css = readWorkbenchCss();
    const redisCss = readSection(
      css,
      '/* ─── V2 Redis workbench ─ */',
      '/* ─── V2 Nacos workbench',
    );
    const rootRule = readRule(redisCss, 'body[data-ui-version="v2"] .gn-v2-redis-workbench');
    const sidebarRule = readRule(redisCss, 'body[data-ui-version="v2"] .gn-v2-redis-sidebar');
    const valuePaneRule = readRule(redisCss, 'body[data-ui-version="v2"] .gn-v2-redis-value-pane');
    const valueLayoutRule = readRule(redisCss, 'body[data-ui-version="v2"] .gn-v2-redis-value-layout');
    const valueTopRule = readRule(redisCss, 'body[data-ui-version="v2"] .gn-v2-redis-value-top');
    const dividerRule = readRule(
      redisCss,
      'body[data-ui-version="v2"] .gn-v2-redis-workbench > .redis-resizable-divider',
    );

    expect(rootRule).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(sidebarRule).toContain('grid-row: 1;');
    expect(sidebarRule).toContain('grid-template-rows: max-content minmax(0, 1fr);');
    expect(sidebarRule).not.toContain('grid-template-rows: subgrid;');
    expect(valuePaneRule).toContain('display: block !important;');
    expect(valuePaneRule).toContain('grid-column: 3;');
    expect(valuePaneRule).toContain('grid-row: 1;');
    expect(valuePaneRule).toContain('min-height: 0;');
    expect(valuePaneRule).not.toContain('display: contents !important;');
    expect(valueLayoutRule).toContain('display: flex !important;');
    expect(valueLayoutRule).not.toContain('display: contents !important;');
    expect(valueTopRule).toContain('height: auto;');
    expect(valueTopRule).not.toContain('grid-column:');
    expect(valueTopRule).not.toContain('grid-row:');
    expect(dividerRule).toContain('grid-row: 1;');
    expect(dividerRule).not.toContain('grid-row: 1 / 3;');
  });
});
