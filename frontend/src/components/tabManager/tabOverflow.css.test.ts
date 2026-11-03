import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabOverflowCss = readFileSync(new URL('./tabOverflow.css', import.meta.url), 'utf8');

const popupRule = tabOverflowCss.match(/\.gn-v2-tab-overflow-popup\s*\{([^}]*)\}/)?.[1] ?? '';

const kindRule = tabOverflowCss.match(/\.gn-v2-tab-overflow-kind\s*\{([^}]*)\}/)?.[1] ?? '';
const searchRule = tabOverflowCss.match(/\.gn-v2-tab-overflow-search\s*\{([^}]*)\}/)?.[1] ?? '';

describe('tab overflow popup styles', () => {
  it('pins the portaled list with position absolute and leaves offsets to the trigger', () => {
    expect(popupRule).toMatch(/position:\s*absolute;/);
    expect(popupRule).not.toMatch(/\b(?:left|top|right|bottom)\s*:/);
  });

  it('uses a fixed icon slot and a flush speed-search header', () => {
    expect(kindRule).toMatch(/flex:\s*0 0 16px;/);
    expect(kindRule).not.toMatch(/min-width:\s*44px/);
    expect(kindRule).not.toMatch(/text-transform:\s*uppercase/);
    expect(searchRule).toMatch(/border-bottom:/);
    expect(tabOverflowCss).not.toMatch(/\.is-active \.gn-v2-tab-overflow-close/);
  });

  it('keeps a wide list with a visible scrollbar and left close control', () => {
    const menuRule = tabOverflowCss.match(/\.gn-v2-tab-overflow-menu\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(menuRule).toMatch(/width:\s*min\(360px/);
    expect(menuRule).toMatch(/min-width:\s*320px;/);
    expect(tabOverflowCss).toMatch(/\.gn-v2-tab-overflow-list::-webkit-scrollbar\s*\{[^}]*width:\s*8px;/);
    expect(tabOverflowCss).toMatch(/\.gn-v2-tab-overflow-item\.is-active\s*\{[^}]*box-shadow:\s*inset 2px 0 0 var\(--gn-accent\)/);
  });
});
