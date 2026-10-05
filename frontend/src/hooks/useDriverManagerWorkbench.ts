import { message } from 'antd';
import { useCallback } from 'react';

import { useStore } from '../store';
import { buildDriverManagerWorkbenchTab } from '../utils/driverManagerTab';
import { openNativeWorkbenchTabWindow } from '../utils/nativeDetachedWindowHost';

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
