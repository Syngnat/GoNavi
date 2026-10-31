import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 守卫工具条的两条口径：
// 1) classic 与 navicat 布局的按钮尺寸 / 图标 / 字号完全一致 ——
//    navicat 不得再单独覆盖密度变量，否则切换布局主题时工具栏大小会跳变；
// 2) 字号 = 基础字体大小 × 界面缩放，两个设置任一变化都必须跟随。
const css = readFileSync(new URL('./titleBarToolBar.css', import.meta.url), 'utf8');
// 「设置 / 主题」胶囊（antd 小按钮）必须用 !important 对抗 v2-theme-01 的
// body[data-ui-version="v2"] .ant-btn-sm 全局钉死（12px !important），
// 否则胶囊字号永远停在 12px，不跟随字体大小 / 界面缩放。
const pillCss = readFileSync(new URL('./titleBarPreferencesPill.css', import.meta.url), 'utf8');

describe('titleBarToolBar 布局与设置联动口径', () => {
  it('navicat 布局不再覆盖工具条密度变量（两布局按钮大小一致）', () => {
    expect(css).not.toMatch(/data-ui-layout=['"]navicat['"][^{]*\{[^}]*--gn-titlebar-toolbar-(item-width|item-height|icon-size|label-size|gap|inline-padding)/s);
    // 按钮内图标与文字的间距同样不区分布局。
    expect(css).not.toMatch(/data-ui-layout=['"]navicat['"][^{]*gn-titlebar-toolbar[^{]*\{[^}]*gap:/s);
  });

  it('工具条与标题栏入口字号 = 基础字体大小 × 界面缩放', () => {
    expect(css).toContain(
      '--gn-titlebar-toolbar-label-size: calc((var(--gn-font-size-sm, 12px) + 1px) * var(--gn-ui-scale, 1));',
    );
    // 标题栏「驱动管理 / 关于」入口与工具条同一口径。
    expect(css.match(/font-size: calc\(\(var\(--gn-font-size-sm, 12px\) \+ 1px\) \* var\(--gn-ui-scale, 1\)\);/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(1);
  });

  it('选中项悬停仍用激活底，不被普通 hover 近白底盖住', () => {
    const activeHover = css.indexOf(
      ".gn-titlebar-toolbar .gonavi-titlebar-primary-action[data-titlebar-toolbar-item-active='true']:hover",
    );
    const genericHover = css.indexOf('.gn-titlebar-toolbar .gonavi-titlebar-primary-action:hover');
    expect(activeHover).toBeGreaterThan(genericHover);
    const rule = css.slice(activeHover, css.indexOf('}', activeHover));
    expect(rule).toContain('background: var(--gn-titlebar-toolbar-active-surface);');
  });

  it('「设置 / 主题」胶囊字号公式带 !important，压过全局 .ant-btn-sm 钉死', () => {
    expect(pillCss).toContain(
      'font-size: calc((var(--gn-font-size-sm, 12px) + 1px) * var(--gn-ui-scale, 1)) !important;',
    );
    // 常态颜色同样要压过全局 .ant-btn-text 的 color: fg-3 !important，
    // 否则胶囊文字比「驱动管理」（fg-1）偏白。
    expect(pillCss).toContain('color: var(--gn-fg-1, #0c1322) !important;');
  });
});
