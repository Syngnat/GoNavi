import { useCallback, useEffect, useState } from 'react';
import { pluginAPI } from '../../plugins/api';
import { openPluginPageTab } from '../../pluginPages/openPluginPageTab';
import type { PluginStatus } from '../../plugins/types';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import { isWebRuntime } from '../../utils/browserFileTransfer';

export interface PluginStatusBarEntry {
  key: string;
  pluginID: string;
  title: string;
  target: 'page' | 'window';
  pageID?: string;
  pageTitle?: string;
}

const running = (plugin: PluginStatus) =>
  plugin.desiredEnabled && plugin.state === 'running' && (plugin.manifest.contributes?.navigation?.length ?? 0) > 0;

/**
 * Plugin entries declared with `navigation.location: "statusbar"`. The host
 * renders them as text buttons and owns the click target; the plugin only
 * declares the page or window it opens.
 */
export function usePluginStatusBarEntries() {
  const { language } = useI18n();
  const theme = useStore((state) => state.theme);
  const [entries, setEntries] = useState<PluginStatusBarEntry[]>([]);
  const web = isWebRuntime();

  const refresh = useCallback(async () => {
    try {
      const [items, runtime] = await Promise.all([pluginAPI.list(), pluginAPI.runtimeInfo()]);
      if (runtime.safeMode || !runtime.managementAllowed) {
        setEntries([]);
        return;
      }
      const next: PluginStatusBarEntry[] = [];
      for (const plugin of items) {
        if (!running(plugin)) continue;
        const contributes = plugin.manifest.contributes;
        const navigation = [...(contributes?.navigation ?? [])]
          .filter((item) => item.location === 'statusbar')
          .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
        for (const item of navigation) {
          if ((item.target ?? 'page') === 'window') {
            if (!plugin.manifest.window || web) continue;
            next.push({ key: plugin.manifest.id + ':' + item.id, pluginID: plugin.manifest.id, title: item.title, target: 'window' });
            continue;
          }
          const page = contributes?.pages?.find((candidate) => candidate.id === item.page);
          if (!page) continue;
          next.push({
            key: plugin.manifest.id + ':' + item.id,
            pluginID: plugin.manifest.id,
            title: item.title,
            target: 'page',
            pageID: page.id,
            pageTitle: page.title,
          });
        }
      }
      setEntries(next);
    } catch {
      setEntries([]);
    }
  }, [web]);

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const open = useCallback(async (entry: PluginStatusBarEntry) => {
    if (entry.target === 'page' && entry.pageID) {
      openPluginPageTab({ pluginID: entry.pluginID, pageID: entry.pageID, title: entry.pageTitle || entry.title });
      return;
    }
    try {
      await pluginAPI.openWindow(entry.pluginID, language, theme);
    } catch {
      // The plugin manager reports window failures; the status bar stays quiet.
    }
  }, [language, theme]);

  return { entries, open };
}
