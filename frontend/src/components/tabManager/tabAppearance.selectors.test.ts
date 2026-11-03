// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom 环境下 import.meta.url 是 http URL 读不到文件，按仓库既有写法用 cwd 定位源码。
const tabAppearanceCss = readFileSync(
  resolve(process.cwd(), 'src/components/tabManager/tabAppearance.css'),
  'utf8',
);

const WORKBENCH_ROOT = "body[data-ui-version='v2'] .gn-v2-tab-workbench";
const UNDERLINE_ROOT =
  `${WORKBENCH_ROOT}[data-tab-appearance='underline'] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-nav-list`;
const PILL_ROOT = `${WORKBENCH_ROOT}[data-tab-appearance='pill'] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-nav-list`;
const LEFT_CLOSE_SELECTOR =
  `${WORKBENCH_ROOT}[data-tab-close-position='left'] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-nav-list .gn-v2-tab-close`;

const normalizeSelector = (selector: string) => selector.replace(/'/g, '"');

const ruleCountInSource = [...tabAppearanceCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\{/g)].length;

// 与真实 DOM 同构的探针：外观属性挂在工作台根节点，关闭按钮在 .tab-dnd-label 内。
const renderWorkbench = (appearance: string, closePosition: string) => `
  <div class="tab-workbench gn-v2-tab-workbench" data-tab-appearance="${appearance}" data-tab-close-position="${closePosition}">
    <div class="main-tabs gn-v2-main-tabs">
      <div class="ant-tabs-nav">
        <div class="ant-tabs-nav-wrap">
          <div class="ant-tabs-nav-list">
            <div class="ant-tabs-tab ant-tabs-tab-active">
              <div class="ant-tabs-tab-btn">
                <span class="tab-dnd-label gn-v2-tab-label" data-tab-close-position="${closePosition}">
                  <button type="button" class="gn-v2-tab-close"></button>
                </span>
              </div>
            </div>
            <div class="ant-tabs-tab">
              <div class="ant-tabs-tab-btn">
                <span class="tab-dnd-label gn-v2-tab-label" data-tab-close-position="${closePosition}">
                  <button type="button" class="gn-v2-tab-close"></button>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

const mountWorkbenchFixtures = (): CSSStyleSheet => {
  document.body.setAttribute('data-ui-version', 'v2');
  document.body.setAttribute('data-ui-layout', 'classic');
  document.body.innerHTML = [
    renderWorkbench('card', 'right'),
    renderWorkbench('underline', 'right'),
    renderWorkbench('pill', 'left'),
  ].join('');
  const style = document.createElement('style');
  style.textContent = tabAppearanceCss;
  document.head.append(style);
  const sheet = style.sheet;
  if (!sheet) throw new Error('tabAppearance.css was not parsed as a stylesheet');
  return sheet;
};

const readParsedSelectors = (sheet: CSSStyleSheet) =>
  [...sheet.cssRules].map((rule) => normalizeSelector((rule as CSSStyleRule).selectorText));

describe('main workbench tab appearance selectors', () => {
  it('parses every rule and never targets the card workbench', () => {
    const sheet = mountWorkbenchFixtures();
    const rules = [...sheet.cssRules] as CSSStyleRule[];

    expect(rules.length).toBe(ruleCountInSource);
    expect(rules.length).toBeGreaterThan(0);
    rules.forEach((rule) => {
      // :hover 规则在静态 DOM 下无法命中，解析是否完整由 rules.length === ruleCountInSource 覆盖。
      if (rule.selectorText.includes(':hover')) return;
      const matched = [...document.querySelectorAll(rule.selectorText)];
      expect(matched.length, rule.selectorText).toBeGreaterThan(0);
      matched.forEach((element) => {
        expect(element.closest("[data-tab-appearance='card']"), rule.selectorText).toBeNull();
      });
    });
  });

  it('spaces only the pill tabs that follow another tab', () => {
    const matched = [...document.querySelectorAll(`${PILL_ROOT} .ant-tabs-tab + .ant-tabs-tab`)];

    expect(matched).toHaveLength(1);
    expect(matched[0].classList.contains('ant-tabs-tab')).toBe(true);
  });

  it('releases the right-edge pin only for the left close position', () => {
    mountWorkbenchFixtures();

    const leftCloseButtons = [...document.querySelectorAll(LEFT_CLOSE_SELECTOR)];
    expect(leftCloseButtons).toHaveLength(2);
    expect(leftCloseButtons[0].parentElement?.getAttribute('data-tab-close-position')).toBe('left');

    const rightCloseButtons = [
      ...document.querySelectorAll("[data-tab-close-position='right'] .gn-v2-tab-close"),
    ];
    expect(rightCloseButtons.length).toBeGreaterThan(0);
    rightCloseButtons.forEach((close) => {
      expect(close.matches(LEFT_CLOSE_SELECTOR)).toBe(false);
    });
  });

  it('declares the selectors the workbench DOM relies on', () => {
    const selectors = readParsedSelectors(mountWorkbenchFixtures());

    expect(selectors).toContain(normalizeSelector(LEFT_CLOSE_SELECTOR));
    expect(selectors).toContain(`${normalizeSelector(UNDERLINE_ROOT)} .ant-tabs-tab.ant-tabs-tab-active`);
    expect(selectors).toContain(`${normalizeSelector(PILL_ROOT)} .ant-tabs-tab + .ant-tabs-tab`);
    expect(selectors).toContain(`${normalizeSelector(PILL_ROOT)} .ant-tabs-tab.ant-tabs-tab-active`);
  });
});
