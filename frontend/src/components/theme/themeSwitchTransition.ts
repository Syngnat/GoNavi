import './themeSwitchTransition.css';

const THEME_SWITCHING_ATTR = 'data-gn-theme-switching';
/** 主题相关的渲染、effect 与样式重算落地所需的余量；窗口隐藏时 rAF 不触发，因此用定时器。 */
const THEME_SWITCH_RELEASE_MS = 400;

let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 切换明暗 / 主题期间临时关闭全局 CSS 过渡。
 *
 * 大量元素的 color / background-color 过渡不走合成层，会在主线程逐帧重绘，
 * 与切换时的整树重渲染叠在一起就是明显的卡顿；颜色直接跳变反而更干脆。
 */
export const suppressThemeSwitchTransitions = (): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute(THEME_SWITCHING_ATTR, 'true');
  if (releaseTimer !== undefined) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = undefined;
    root.removeAttribute(THEME_SWITCHING_ATTR);
  }, THEME_SWITCH_RELEASE_MS);
};
