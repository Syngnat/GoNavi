import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dropdown enter box', () => {
  it('keeps antd enter motion from collapsing the popup to an empty rect', () => {
    const css = readFileSync(new URL('./v2-theme-02-select-dropdown.css', import.meta.url), 'utf8');
    const rule = css.slice(
      css.indexOf('body[data-ui-version="v2"] :is('),
      css.indexOf('.ant-slide-up-leave'),
    );
    expect(rule).toContain('.ant-slide-up-enter,');
    expect(rule).toContain('.ant-zoom-big-appear');
    expect(rule).toContain('transform: none !important;');
    expect(rule).toContain('opacity: 1 !important;');
  });
});
