import { describe, expect, it } from 'vitest';

import { BUILTIN_CUSTOM_THEME_PRESETS } from './customThemePresets';

/**
 * 内置主题的「主要操作按钮」三态可辨性不变式。
 *
 * 回归背景：--gn-ant-primary-hover 与 --gn-ant-primary-active 原先都直接取 palette.accent2，
 * 二者取值完全相同，hover 与按下态在视觉上无任何区别；而 accent2 又是 accent 的近邻色
 * （内置主题的强调色刻意低饱和），实测 base→hover 对比度仅 1.05–1.29，
 * 其中 Deep Ocean 的 accent2 比 accent 更亮（调色板方向反了），
 * 导致「有待提交变更」这类关键状态的交互反馈几乎不可见。
 *
 * 本用例断言生成 CSS（函数返回值）里的派生结果，而不是读取源码文本：
 * 一旦有人把 hover/active 改回 accent2 或让两者相同，这里会失败。
 */

const readToken = (css: string, token: string): string => {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(css);
  if (!match) {
    throw new Error(`生成的主题 CSS 缺少 ${token}`);
  }
  return match[1].trim();
};

const parseHex = (value: string): [number, number, number] => {
  const text = value.trim().replace(/^#/, '');
  expect(text, `${value} 应为 6 位十六进制颜色`).toMatch(/^[0-9a-fA-F]{6}$/);
  return [
    Number.parseInt(text.slice(0, 2), 16),
    Number.parseInt(text.slice(2, 4), 16),
    Number.parseInt(text.slice(4, 6), 16),
  ];
};

const channelLuminance = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ([r, g, b]: [number, number, number]): number => (
  0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
);

const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

/** 填充色变化的可感知下限。低于此值时状态切换在实机上基本看不出来。 */
const MIN_STATE_DELTA = 1.25;

describe('内置主题的主要操作按钮三态', () => {
  it('每个内置主题都提供 accent / hover / active 三个不同的派生色', () => {
    expect(BUILTIN_CUSTOM_THEME_PRESETS.length).toBeGreaterThan(0);

    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const accent = readToken(preset.css, '--gn-ant-primary');
      const hover = readToken(preset.css, '--gn-ant-primary-hover');
      const active = readToken(preset.css, '--gn-ant-primary-active');

      expect(hover, `${preset.id} 的 hover 不应等于基色`).not.toBe(accent);
      expect(active, `${preset.id} 的 active 不应等于基色`).not.toBe(accent);
      expect(active, `${preset.id} 的 active 不应等于 hover（否则按下无反馈）`).not.toBe(hover);
    }
  });

  it('accent → hover → active 的对比度变化均达到可感知阈值', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const accent = readToken(preset.css, '--gn-ant-primary');
      const hover = readToken(preset.css, '--gn-ant-primary-hover');
      const active = readToken(preset.css, '--gn-ant-primary-active');

      expect(
        contrastRatio(accent, hover),
        `${preset.id} 的 base→hover 对比度不足`,
      ).toBeGreaterThanOrEqual(MIN_STATE_DELTA);
      expect(
        contrastRatio(hover, active),
        `${preset.id} 的 hover→active 对比度不足`,
      ).toBeGreaterThanOrEqual(MIN_STATE_DELTA);
    }
  });

  it('三态亮度单调递减，不出现深浅方向颠倒', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const accent = relativeLuminance(parseHex(readToken(preset.css, '--gn-ant-primary')));
      const hover = relativeLuminance(parseHex(readToken(preset.css, '--gn-ant-primary-hover')));
      const active = relativeLuminance(parseHex(readToken(preset.css, '--gn-ant-primary-active')));

      expect(hover, `${preset.id} 的 hover 不应比基色更亮`).toBeLessThan(accent);
      expect(active, `${preset.id} 的 active 不应比 hover 更亮`).toBeLessThan(hover);
    }
  });

  it('同时暴露 --gn-accent-hover / --gn-accent-active 供 CSS 直接引用', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      expect(readToken(preset.css, '--gn-accent-hover')).toBe(readToken(preset.css, '--gn-ant-primary-hover'));
      expect(readToken(preset.css, '--gn-accent-active')).toBe(readToken(preset.css, '--gn-ant-primary-active'));
    }
  });
});

const saturationOf = (value: string): number => {
  const [r, g, b] = parseHex(value).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
};

/**
 * 主操作按钮填充用的提饱和派生色。
 * 回归背景：内置主题的强调色刻意低饱和（Comfort Dark 仅 20%、Deep Ocean 28%），
 * 直接填在按钮上读起来"没有颜色"、不像可点的主操作。
 */
describe('主操作按钮的提饱和填充色', () => {
  it('accent-strong 的饱和度高于原 accent，且标签仍可读', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const accent = readToken(preset.css, '--gn-accent');
      const strong = readToken(preset.css, '--gn-accent-strong');
      const onAccent = readToken(preset.css, '--gn-on-accent');

      // 浅色主题的强调色本身已足够饱和，不提升（提了会让白色标签跌破 AA）
      if (preset.baseMode === 'dark') {
        expect(
          saturationOf(strong),
          `${preset.id} 的 accent-strong 饱和度未提升`,
        ).toBeGreaterThan(saturationOf(accent));
      } else {
        expect(saturationOf(strong)).toBeCloseTo(saturationOf(accent), 5);
      }
      expect(
        contrastRatio(onAccent, strong),
        `${preset.id} 的主按钮标签对比度不足`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('accent-strong 的三态同样逐级加深且达到可感知阈值', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const strong = readToken(preset.css, '--gn-accent-strong');
      const hover = readToken(preset.css, '--gn-accent-strong-hover');
      const active = readToken(preset.css, '--gn-accent-strong-active');

      expect(
        contrastRatio(strong, hover),
        `${preset.id} 的 strong base→hover 对比度不足`,
      ).toBeGreaterThanOrEqual(MIN_STATE_DELTA);
      expect(
        contrastRatio(hover, active),
        `${preset.id} 的 strong hover→active 对比度不足`,
      ).toBeGreaterThanOrEqual(MIN_STATE_DELTA);
    }
  });
});

/**
 * 手动事务「提交」按钮用 warn 实心填充，刻意不跟随主题强调色。
 * 回归背景：原先用 accent-soft 底 + accent-2 文字，与普通主操作同色系且文字对比极低；
 * 待提交条数徽标更是用硬编码绿底 + accent-2 文字，实测对比度仅 1.10–1.17，
 * 静止状态下数字完全看不见，只有 hover 把按钮压暗后才显现。
 */
describe('手动事务提交按钮的 warn 配色', () => {
  it('warn 前景色在每个主题下都达到正文可读级（≥4.5）', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const warn = readToken(preset.css, '--gn-warn');
      const onWarn = readToken(preset.css, '--gn-on-warn');
      expect(
        contrastRatio(onWarn, warn),
        `${preset.id} 的 warn 标签对比度不足`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('待提交条数徽标的数字在静止状态即可读（≥4.5）', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const onWarn = readToken(preset.css, '--gn-on-warn');
      const badgeHex = readToken(preset.css, '--gn-warn-badge-bg');
      expect(
        contrastRatio(onWarn, badgeHex),
        `${preset.id} 的徽标数字对比度不足`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('warn 的三态同样逐级加深且互不相同', () => {
    for (const preset of BUILTIN_CUSTOM_THEME_PRESETS) {
      const warn = readToken(preset.css, '--gn-warn');
      const hover = readToken(preset.css, '--gn-warn-hover');
      const active = readToken(preset.css, '--gn-warn-active');

      expect(hover, `${preset.id} 的 warn hover 不应等于基色`).not.toBe(warn);
      expect(active, `${preset.id} 的 warn active 不应等于 hover`).not.toBe(hover);
      expect(
        contrastRatio(warn, hover),
        `${preset.id} 的 warn base→hover 对比度不足`,
      ).toBeGreaterThanOrEqual(MIN_STATE_DELTA);
    }
  });
});
