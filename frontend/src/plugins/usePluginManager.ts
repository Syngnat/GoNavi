import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginAPI } from './api';
import { notifyPluginLifecycle } from './events';
import { refreshPluginDataSources, revokePluginDataSourceAvailability } from './dataSource/discovery';
import { invalidatePackagedSkillPreviews } from './skills/invalidation';
import { invalidatePluginAIProviders } from './aiProvider/invalidation';
import { PluginAPIError, pluginErrorText } from './apiResult';
import { usePluginRevocation } from './usePluginRevocation';
import type { PluginStatus, PluginRuntimeInfo } from './types';

export function usePluginManager() {
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [runtime, setRuntime] = useState<PluginRuntimeInfo>({ safeMode: false, managementAllowed: false, webRuntime: false });
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const { revoked, isRevoked, revoke } = usePluginRevocation();
  const alive = useRef(true);
  const revision = useRef(0);
  const actions = useRef<Record<string, number>>({});
  const intents = useRef<Record<string, boolean>>({});
  const refreshing = useRef(false);
  const available = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const version = revision.current;
    try {
      const [items, info] = await Promise.all([pluginAPI.list(), pluginAPI.runtimeInfo()]);
      if (alive.current && version === revision.current) {
        setPlugins(items.map((plugin) => intents.current[plugin.manifest.id] === undefined ? plugin
          : { ...plugin, desiredEnabled: intents.current[plugin.manifest.id] }));
        setRuntime(info); setError('');
        const running = new Set(items.filter((p) => p.state === 'running' && p.desiredEnabled).map((p) => `${p.manifest.id}:${p.generation}`));
        const changed = running.size !== available.current.size || [...running].some((id) => !available.current.has(id));
        available.current = running;
        if (changed) notifyPluginLifecycle();
      }
    } catch (cause) { if (alive.current && version === revision.current) setError(pluginErrorText(cause)); }
    finally { refreshing.current = false; if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    const action = (actions.current[id] ?? 0) + 1;
    actions.current[id] = action;
    intents.current[id] = enabled;
    if (!enabled) { revokePluginDataSourceAvailability(id); invalidatePackagedSkillPreviews(id); invalidatePluginAIProviders({ pluginId: id, reason: 'disabled' }); }
    revision.current++;
    // Revocation is optimistic and never waits behind an enable, invocation, market call or stop.
    revoke(id, !enabled);
    setPlugins((items) => items.map((p) => p.manifest.id === id ? { ...p, desiredEnabled: enabled } : p));
    setBusy((current) => ({ ...current, [id]: true }));
    setActionError('');
    try {
      const status = await pluginAPI.setEnabled(id, enabled);
      if (alive.current && actions.current[id] === action) setPlugins((items) => items.map((p) => p.manifest.id === id ? status : p));
      notifyPluginLifecycle();
    } catch (cause) { if (alive.current && actions.current[id] === action) setActionError(pluginErrorText(cause)); }
    finally {
      void refreshPluginDataSources();
      if (alive.current && actions.current[id] === action) { delete intents.current[id]; setBusy((current) => ({ ...current, [id]: false })); void refresh(); }
    }
  }, [refresh, revoke]);
  // 后端要求先停用再删除；进程收尾期间 ActiveGeneration 仍占着包，插件会以 busy 拒绝，
  // 这里做一次有界重试，让用户点一次「移除」就能完成。
  const removePluginPackage = useCallback(async (id: string, purge: boolean) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await pluginAPI.remove(id, purge);
      } catch (cause) {
        const busy = cause instanceof PluginAPIError && cause.key === 'plugin.backend.error.plugin_busy';
        if (!busy || attempt >= 5) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }, []);
  const remove = useCallback(async (id: string, purge: boolean) => {
    const wasRevoked = isRevoked(id);
    revokePluginDataSourceAvailability(id); invalidatePackagedSkillPreviews(id); invalidatePluginAIProviders({ pluginId: id, reason: 'removed' });
    revision.current++;
    const action = (actions.current[id] ?? 0) + 1;
    actions.current[id] = action;
    setBusy((current) => ({ ...current, [id]: true }));
    delete intents.current[id];
    setActionError('');
    revoke(id, true);
    try {
      // 停用是删除的前置条件，替用户完成；已停用的插件再次停用是幂等的。
      await pluginAPI.setEnabled(id, false).catch(() => undefined);
      await removePluginPackage(id, purge);
      notifyPluginLifecycle();
      if (alive.current && actions.current[id] === action) setPlugins((items) => items.filter((p) => p.manifest.id !== id));
    } catch (cause) {
      if (alive.current && actions.current[id] === action) {
        revoke(id, wasRevoked);
        setActionError(pluginErrorText(cause));
        notifyPluginLifecycle();
      }
    } finally {
      if (alive.current && actions.current[id] === action) {
        setBusy((current) => ({ ...current, [id]: false }));
        void refreshPluginDataSources();
        void refresh();
      }
    }
  }, [refresh, isRevoked, revoke, removePluginPackage]);
  return { plugins, runtime, loading, error: actionError || error, busy, revoked, refresh, setEnabled, remove };
}
export type PluginManagerState = ReturnType<typeof usePluginManager>;
