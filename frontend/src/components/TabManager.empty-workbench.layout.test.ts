import { describe, expect, it } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';

describe('empty workbench layout', () => {
  it('keeps hero actions from overlapping recent cards in small windows', () => {
    const css = readV2ThemeCss();
    const heroSelector = 'body[data-ui-version="v2"] .gn-v2-empty-hero {';
    const firstHeroRule = css.indexOf(heroSelector);
    const heroRule = css.slice(
      css.indexOf(heroSelector, firstHeroRule + heroSelector.length),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-empty-eyebrow {'),
    );

    expect(heroRule).toContain('flex: 0 0 auto;');
  });

  it('reclaims only the docked collapsed titlebar band without moving the hero copy', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(
      /\[data-empty-workbench='true'\]\[data-collapsed-sidebar-actions-docked='true'\]\[data-security-update-banner-visible='false'\]\s*> \.ant-layout\s*\{[^}]*margin-top:\s*calc\(-1 \* var\(--gn-v2-empty-workbench-titlebar-overlap, 0px\)\);/s,
    );
    expect(css).toMatch(
      /\[data-empty-workbench='true'\]\[data-collapsed-sidebar-actions-docked='true'\]\[data-security-update-banner-visible='false'\][^{]+\.gn-v2-empty-eyebrow\s*\{[^}]*padding-left:\s*max\(/s,
    );
    expect(css).toContain('--gn-v2-empty-hero-padding-inline-start: 30px;');
    expect(css).toContain('--gn-v2-empty-hero-padding-inline-start: 24px;');
    expect(css).toContain('--gn-v2-empty-hero-padding-inline-start: 16px;');
  });
});
