import { describe, expect, it } from 'vitest';

import { readV2ThemeCss } from '../../test/readV2ThemeCss';

const css = readV2ThemeCss();

const ruleBody = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
};

const TAB = 'body[data-ui-version="v2"] .gn-v2-tab-strip__tab';
const TAB_CHILD = 'body[data-ui-version="v2"] .gn-v2-tab-strip__tab > *';
const SCROLL = 'body[data-ui-version="v2"] .gn-v2-tab-strip__scroll';

describe('custom workbench tab strip layout', () => {
  // 回归护栏：.gn-v2-tab-label（标签内容）只有 width/height/gap，没有
  // display:flex —— 它原本依赖 antd 的 .ant-tabs-tab / .ant-tabs-tab-btn
  // 两层 flex 包装。换成自绘外层后若不补上这层，标签会退化成普通流式盒，
  // 横向排列失效、互相重叠。
  it('gives the tab a flex row container', () => {
    const body = ruleBody(TAB);
    expect(body).toMatch(/display:\s*flex;/);
    expect(body).toMatch(/align-items:\s*center;/);
    expect(body).toMatch(/flex:\s*0 0 auto;/);
    expect(body).toMatch(/min-width:\s*0;/);
  });

  // 规格：标签固定宽度不压缩，放不下时横向滚动，滚动条隐藏（IDEA 行为）。
  it('scrolls horizontally with a hidden scrollbar', () => {
    const body = ruleBody(SCROLL);
    expect(body).toMatch(/flex:\s*1 1 auto;/);
    expect(body).toMatch(/overflow-x:\s*auto;/);
    expect(body).toMatch(/scrollbar-width:\s*none;/);
    expect(ruleBody('body[data-ui-version="v2"] .gn-v2-tab-strip__scroll::-webkit-scrollbar'))
      .toMatch(/display:\s*none;/);
  });

  // __extra 即使内容为空也会被渲染成空 div，margin-left:auto 会吃掉剩余
  // 空间，表现为标签条右侧一大片空白。
  it('keeps an empty extra slot out of the layout', () => {

    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-tab-strip__extra:empty');
    expect(ruleBody('body[data-ui-version="v2"] .gn-v2-tab-strip__extra:empty'))
      .toMatch(/display:\s*none;/);
  });

  it('lets the label fill the tab and shrink instead of overflowing', () => {
    const body = ruleBody(TAB_CHILD);
    expect(body).toMatch(/min-width:\s*0;/);
    expect(body).toMatch(/width:\s*100%;/);
    expect(body).toMatch(/height:\s*100%;/);
  });
});
