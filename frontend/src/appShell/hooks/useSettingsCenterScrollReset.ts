import { useEffect } from 'react';
import { useStore } from '../../store';
import { SETTINGS_CENTER_WORKBENCH_TAB_ID } from '../../utils/settingsCenterTab';

const SETTINGS_HOST_SELECTOR = '.gonavi-settings-center-workbench-host';

/**
 * 设置中心作为工作区页签常驻（隐藏页签不销毁，见 workbenchTabLifecycle），
 * 内容区滚动位置会跨「切走再切回」残留——重新打开设置中心时顶部出现
 * 大段空白（此前点击面板下方选项时浏览器把焦点按钮滚进了视野）。
 * 重新激活设置页签时把内容区的滚动容器复位到顶部（左树导航位置保留）。
 */
export const useSettingsCenterScrollReset = () => {
  const settingsTabActive = useStore(
    (state) => state.activeTabId === SETTINGS_CENTER_WORKBENCH_TAB_ID,
  );

  useEffect(() => {
    if (!settingsTabActive) return undefined;
    const rafId = requestAnimationFrame(() => {
      const host = document.querySelector(SETTINGS_HOST_SELECTOR);
      if (!host) return;
      // 内容区滚动容器没有统一的类名（主题面板、总览、快捷键面板各不相同），
      // 按计算样式识别竖向可滚动元素；命中数量很小，一次性开销可忽略。
      host.querySelectorAll<HTMLElement>('div').forEach((el) => {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === 'auto' || overflowY === 'scroll') el.scrollTop = 0;
      });
    });
    return () => cancelAnimationFrame(rafId);
  }, [settingsTabActive]);
};

export default useSettingsCenterScrollReset;
