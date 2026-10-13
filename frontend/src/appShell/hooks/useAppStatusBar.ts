import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../../store';
import { DEFAULT_ABOUT_INFO, type AboutInfo } from '../../hooks/appUpdate/appUpdateTypes';

/**
 * 底部全局状态栏的数据汇总：活动上下文（连接 / 库 / Schema）、活动标签页
 * 标题、应用版本。版本走 GetAppInfo 静默加载一次，失败时退回默认值。
 */

export interface AppStatusBarModel {
  connectionName: string;
  dbName: string;
  schemaName: string;
  activeTabTitle: string;
  version: string;
}

const normalizeVersion = (value: unknown): string => {
  const version = String(value || '').trim();
  return version.startsWith('v') || version === '' ? version : `v${version}`;
};

export const useAppStatusBar = (): AppStatusBarModel => {
  const connections = useStore(state => state.connections);
  const activeContext = useStore(state => state.activeContext);
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);
  const [version, setVersion] = useState<string>(DEFAULT_ABOUT_INFO.version);

  useEffect(() => {
    let cancelled = false;
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.GetAppInfo !== 'function') return undefined;
    void (async () => {
      try {
        const res = await backendApp.GetAppInfo();
        if (cancelled || !res?.success) return;
        const data = (res.data || {}) as Partial<AboutInfo>;
        setVersion(normalizeVersion(data.version));
      } catch {
        // 版本号拿不到就保持为空，状态栏不弹错误。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const connection = connections.find(c => c.id === activeContext?.connectionId);
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    return {
      connectionName: connection?.name || activeContext?.connectionId || '',
      dbName: String(activeContext?.dbName || ''),
      schemaName: String(activeContext?.schemaName || ''),
      activeTabTitle: activeTab?.title || '',
      version,
    };
  }, [activeContext?.connectionId, activeContext?.dbName, activeContext?.schemaName, activeTabId, connections, tabs, version]);
};
