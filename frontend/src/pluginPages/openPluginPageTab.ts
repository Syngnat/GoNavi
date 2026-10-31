import { t } from '../i18n';
import { useStore } from '../store';
import type { TabData } from '../types';
import type { PluginPageLaunch } from './launch';

export interface PluginPageTabInput {
  pluginID: string;
  pageID: string;
  title: string;
  /** A connection-action instance gets its own tab; plain navigation keeps one per page. */
  instanceKey?: string;
  launch?: PluginPageLaunch;
}

/** Deterministic identity: one page per plugin, or one instance per launch key. */
export const pluginPageTabId = (pluginID: string, pageID: string, instanceKey?: string): string =>
  'plugin-page:' + pluginID + ':' + pageID + (instanceKey ? ':' + instanceKey : '');

export function buildPluginPageTab({ pluginID, pageID, title, instanceKey, launch }: PluginPageTabInput): TabData {
  const label = title.trim() || t('plugin.pages.title');
  return {
    id: pluginPageTabId(pluginID, pageID, instanceKey),
    title: label,
    type: 'plugin-page',
    connectionId: launch?.connectionId ?? '',
    pluginPage: { pluginID, pageID, title: label, ...(launch ? { launch } : {}) },
  };
}

/** addTab updates a tab with the same id in place, so an open page is focused, not duplicated. */
export function openPluginPageTab(input: PluginPageTabInput): void {
  useStore.getState().addTab(buildPluginPageTab(input));
}
