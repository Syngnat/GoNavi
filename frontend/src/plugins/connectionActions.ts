import type { PluginConnectionAction, PluginStatus } from './types';

export interface PluginConnectionActionEntry {
  pluginID: string;
  pluginName: string;
  action: PluginConnectionAction;
}

export type PluginConnectionActionScope = 'connection' | 'database' | 'collection';

/** Only running, desired-enabled packages contribute host menu entries. */
export function collectPluginConnectionActions(plugins: readonly PluginStatus[]): PluginConnectionActionEntry[] {
  const entries: PluginConnectionActionEntry[] = [];
  for (const plugin of plugins) {
    if (plugin.state !== 'running' || !plugin.desiredEnabled) continue;
    for (const action of plugin.manifest.contributes?.connectionActions ?? []) {
      if (action.target?.type !== 'window' && action.target?.type !== 'page') continue;
      entries.push({
        pluginID: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        action,
      });
    }
  }
  return entries;
}

export function filterPluginConnectionActions(
  entries: readonly PluginConnectionActionEntry[],
  connectionType: string,
  scope: PluginConnectionActionScope,
): PluginConnectionActionEntry[] {
  const normalized = String(connectionType || '').trim().toLowerCase();
  if (!normalized) return [];
  return entries.filter((entry) => {
    const types = entry.action.connectionTypes.map((value) => String(value).trim().toLowerCase());
    if (!types.includes(normalized)) return false;
    const scopes = entry.action.scopes?.length ? entry.action.scopes : ['connection'];
    return scopes.includes(scope);
  });
}
