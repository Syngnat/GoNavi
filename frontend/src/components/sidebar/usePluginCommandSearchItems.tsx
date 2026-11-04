import { useCallback, useEffect, useState } from 'react';
import { AppstoreOutlined } from '@ant-design/icons';
import { pluginAPI } from '../../plugins/api';
import { openPluginPageTab } from '../../pluginPages/openPluginPageTab';
import type { PluginNavigation, PluginStatus } from '../../plugins/types';
import { useStore } from '../../store';
import { isWebRuntime } from '../../utils/browserFileTransfer';
import type { V2CommandSearchItem } from './sidebarV2CommandSearch';

interface PluginCommandEntry {
  key: string;
  plugin: PluginStatus;
  navigation: PluginNavigation;
}

const running = (plugin: PluginStatus) =>
  plugin.desiredEnabled && plugin.state === 'running' && (plugin.manifest.contributes?.navigation?.length ?? 0) > 0;

/**
 * One search entry per `navigation.location: "command"` declaration. The host
 * only provides the entry: clicking it opens the plugin's page or window, and
 * the plugin renders whatever command surface it wants there.
 */
export function usePluginCommandSearchItems(): V2CommandSearchItem[] {
  const language = useStore((state) => state.languagePreference);
  const theme = useStore((state) => state.theme);
  const [entries, setEntries] = useState<PluginCommandEntry[]>([]);
  const web = isWebRuntime();

  const refresh = useCallback(async () => {
    try {
      const [items, runtime] = await Promise.all([pluginAPI.list(), pluginAPI.runtimeInfo()]);
      if (runtime.safeMode || !runtime.managementAllowed) {
        setEntries([]);
        return;
      }
      const next: PluginCommandEntry[] = [];
      for (const plugin of items) {
        if (!running(plugin)) continue;
        for (const navigation of plugin.manifest.contributes?.navigation ?? []) {
          if (navigation.location !== 'command') continue;
          next.push({ key: plugin.manifest.id + ':' + navigation.id, plugin, navigation });
        }
      }
      setEntries(next);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (typeof window === 'undefined') return undefined;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return entries
    .map((entry): V2CommandSearchItem | null => {
      const target = entry.navigation.target ?? 'page';
      if (target === 'window') {
        if (!entry.plugin.manifest.window || web) return null;
        return {
          key: 'plugin-command:' + entry.key,
          kind: 'action',
          title: entry.navigation.title,
          meta: entry.plugin.manifest.name,
          icon: <AppstoreOutlined />,
          onRun: () => { void pluginAPI.openWindow(entry.plugin.manifest.id, language, theme); },
        };
      }
      const page = entry.plugin.manifest.contributes?.pages?.find((candidate) => candidate.id === entry.navigation.page);
      if (!page) return null;
      return {
        key: 'plugin-command:' + entry.key,
        kind: 'action',
        title: entry.navigation.title,
        meta: entry.plugin.manifest.name,
        icon: <AppstoreOutlined />,
        onRun: () => openPluginPageTab({
          pluginID: entry.plugin.manifest.id,
          pageID: page.id,
          title: entry.navigation.title || page.title,
        }),
      };
    })
    .filter((item): item is V2CommandSearchItem => item !== null);
}
