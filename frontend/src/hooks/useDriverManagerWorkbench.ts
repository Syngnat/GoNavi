import { message } from 'antd';
import { useCallback, useLayoutEffect, useRef } from 'react';

import { useStore } from '../store';
import type { TabData } from '../types';
import { buildDriverManagerWorkbenchTab } from '../utils/driverManagerTab';
import { openNativeWorkbenchTabWindow } from '../utils/nativeDetachedWindowHost';
import { blurFocusInsideSidebarContent } from './useAppSidebarCollapse';

/** 设置中心里「驱动管理」分页的 key（标题栏驱动管理按钮打开的就是它）。 */
const SETTINGS_CENTER_DRIVERS_PANE_KEY = 'drivers';

/**
 * 驱动管理当前是否正在显示：独立的驱动管理标签页，或停在「驱动管理」分页的设置中心。
 */
export const isDriverManagerVisible = (
  activeTab: Pick<TabData, 'type'> | undefined,
  settingsCenterPaneKey: string | undefined,
): boolean => (
  activeTab?.type === 'driver-manager'
  || (activeTab?.type === 'settings-center' && settingsCenterPaneKey === SETTINGS_CENTER_DRIVERS_PANE_KEY)
);

/** 打开独立的驱动管理标签页；该标签页已分离为原生窗口时同时唤起窗口。 */
export const useOpenDriverManagerWorkbench = () => {
  const addTab = useStore((state) => state.addTab);
  return useCallback(() => {
    const tab = buildDriverManagerWorkbenchTab();
    const wasDetached = useStore.getState().isWorkbenchTabDetached(tab.id);
    addTab(tab);
    if (!wasDetached) return;
    void openNativeWorkbenchTabWindow(tab.id).catch((error) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  }, [addTab]);
};

/**
 * 驱动管理显示时自动折叠左侧树，离开（关闭标签页、切到别的标签页或设置分页）时恢复。
 *
 * - 只恢复自己折叠的：进入前左侧树本来就折叠着，离开时保持折叠。
 * - 显示期间用户手动展开过左侧树，视为用户接管，离开时不再干预。
 * - 自动折叠不转移焦点（手动折叠会把焦点交给折叠按钮），只让出树内焦点。
 * - 用布局副作用在绘制前完成切换，避免左侧树闪现一帧。
 */
export const useDriverManagerSidebarAutoCollapse = (
  driverManagerVisible: boolean,
  isSidebarCollapsed: boolean,
  setIsSidebarCollapsed: (collapsed: boolean) => void,
) => {
  const previousVisibleRef = useRef(driverManagerVisible);
  const autoCollapsedRef = useRef(false);

  useLayoutEffect(() => {
    const wasVisible = previousVisibleRef.current;
    previousVisibleRef.current = driverManagerVisible;
    if (driverManagerVisible && !wasVisible) {
      if (!isSidebarCollapsed) {
        autoCollapsedRef.current = true;
        blurFocusInsideSidebarContent();
        setIsSidebarCollapsed(true);
      }
      return;
    }
    if (!driverManagerVisible && wasVisible) {
      if (autoCollapsedRef.current && isSidebarCollapsed) {
        setIsSidebarCollapsed(false);
      }
      autoCollapsedRef.current = false;
      return;
    }
    if (driverManagerVisible && !isSidebarCollapsed) {
      autoCollapsedRef.current = false;
    }
  }, [driverManagerVisible, isSidebarCollapsed, setIsSidebarCollapsed]);
};
