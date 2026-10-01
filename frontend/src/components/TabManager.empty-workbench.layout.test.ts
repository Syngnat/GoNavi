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

  it('does not overlap the docked titlebar band and keeps the hero copy edge configurable', () => {
    const css = readV2ThemeCss();

    expect(css).not.toContain('--gn-v2-empty-workbench-titlebar-overlap');
    expect(css).not.toContain('data-collapsed-sidebar-actions-docked');
    expect(css).toContain('--gn-v2-empty-hero-padding-inline-start: 30px;');
    expect(css).toContain('--gn-v2-empty-hero-padding-inline-start: 24px;');
    expect(css).toContain('--gn-v2-empty-hero-padding-inline-start: 16px;');
  });
});
