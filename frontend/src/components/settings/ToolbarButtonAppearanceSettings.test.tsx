import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import type { ToolbarButtonColorOverrides } from '../../utils/toolbarAppearance';
import ToolbarButtonAppearanceSettings, {
  canResetToolbarButtonColor,
  formatToolbarButtonColorText,
  resolveToolbarButtonFallbackColor,
  resolveToolbarButtonOverrideStatus,
} from './ToolbarButtonAppearanceSettings';

describe('ToolbarButtonAppearanceSettings', () => {
  it('distinguishes theme, custom, and mixed values for the all scope', () => {
    const overrides: ToolbarButtonColorOverrides = {
      query: { 'button-bg': '#123456' },
      result: { 'button-bg': '#654321' },
    };

    expect(resolveToolbarButtonOverrideStatus({}, 'all', 'button-bg')).toBe('theme');
    expect(resolveToolbarButtonOverrideStatus({
      query: { 'button-bg': '#123456' },
      result: { 'button-bg': '#123456' },
    }, 'all', 'button-bg')).toBe('custom');
    expect(resolveToolbarButtonOverrideStatus(overrides, 'all', 'button-bg')).toBe('mixed');
    expect(resolveToolbarButtonOverrideStatus(overrides, 'query', 'button-bg')).toBe('custom');
    expect(resolveToolbarButtonOverrideStatus({
      query: { 'button-disabled-bg': '#222222' },
    }, 'query', 'button-disabled-bg')).toBe('custom');
  });

  it('uses subdued light and dark fallbacks for disabled buttons', () => {
    expect(resolveToolbarButtonFallbackColor('button', 'disabled', 'fg', false))
      .toBe('rgba(39, 48, 63, 0.42)');
    expect(resolveToolbarButtonFallbackColor('button', 'disabled', 'border', true))
      .toBe('rgba(255, 255, 255, 0.10)');
    expect(resolveToolbarButtonFallbackColor('primary', 'disabled', 'bg', false))
      .toBe('rgba(22, 163, 74, 0.32)');
    expect(resolveToolbarButtonFallbackColor('primary', 'disabled', 'fg', true))
      .toBe('rgba(255, 255, 255, 0.48)');
  });

  it('formats compact picker labels', () => {
    expect(formatToolbarButtonColorText('#abc')).toBe('#ABC');
    expect(formatToolbarButtonColorText('#abcd')).toBe('#ABCD');
    expect(formatToolbarButtonColorText('#abcdef')).toBe('#ABCDEF');
    expect(formatToolbarButtonColorText('#abcdef12')).toBe('#ABCDEF12');
    expect(formatToolbarButtonColorText('#12345')).toBe('#12345');
    expect(formatToolbarButtonColorText('rgb(255, 0, 128)')).toBe('#FF0080');
    expect(formatToolbarButtonColorText('rgba(1, 2, 3, 0.5)')).toBe('#01020380');
  });

  it('renders the client toolbar color editor with all three axes and color roles', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider preference="zh-CN" onPreferenceChange={() => undefined}>
        <ToolbarButtonAppearanceSettings />
      </I18nProvider>,
    );

    expect(markup).toContain('data-toolbar-appearance-settings="true"');
    expect(markup).toContain('aria-label="范围"');
    expect(markup).toContain('aria-label="按钮类型"');
    expect(markup).toContain('aria-label="状态"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="文字或图标颜色:');
    expect(markup).toContain('查询');
    expect(markup).toContain('结果');
    expect(markup).toContain('普通按钮');
    expect(markup).toContain('主要按钮');
    expect(markup).toContain('默认');
    expect(markup).toContain('悬停');
    expect(markup).toContain('按下');
    expect(markup).toContain('禁用');
    expect(markup).toContain('文字或图标颜色');
    expect(markup).toContain('背景颜色');
    expect(markup).toContain('边框颜色');
    expect(markup.match(/data-toolbar-color-reset=/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="文字或图标颜色: 恢复跟随主题"');
    expect(markup).toContain('客户端显式设置优先于自定义主题中的同名变量；清空后恢复主题 CSS。');
  });

  it('enables only the single-color reset actions that have client overrides', () => {
    expect(canResetToolbarButtonColor('theme')).toBe(false);
    expect(canResetToolbarButtonColor('custom')).toBe(true);
    expect(canResetToolbarButtonColor('mixed')).toBe(true);
  });
});
