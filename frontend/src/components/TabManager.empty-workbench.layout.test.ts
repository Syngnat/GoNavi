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
});
