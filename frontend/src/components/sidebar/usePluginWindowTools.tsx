import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginAPI } from '../../plugins/api';
import { PluginAPIError, pluginErrorText } from '../../plugins/apiResult';
import { PLUGIN_LIFECYCLE_EVENT } from '../../plugins/events';
import { subscribePluginContributionInvalidation } from '../../plugins/invalidation';
import type { PluginStatus } from '../../plugins/types';
import { openPluginPageTab } from '../../pluginPages/openPluginPageTab';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import { isWebRuntime } from '../../utils/browserFileTransfer';
import { TitlebarPluginIcon } from '../titlebar/gonaviTitlebarIcons';
import { PluginLogo } from '../pluginManager/PluginLogo';
import type { TitleBarQuickAction } from '../TitleBarQuickActions';
import { usePluginWindowPreferences } from './usePluginWindowPreferences';

const REQUEST_TIMEOUT_MS = 10000;
const STARTUP_INTERVAL_MS = 1000;
const STARTUP_WINDOW_MS = 15000;
const identity = (plugin: PluginStatus) => `${plugin.digest}:${plugin.generation}`;
// 顶栏只放插件自己声明的入口：contributes.navigation（location 仅允许 tools）指向的页面。
// 过去按 pages / window 推断，装完插件就会凭空多出一个按钮；那些入口继续留在插件管理里打开。
const toolPage = (plugin: PluginStatus) => {
  const contributes = plugin.manifest.contributes;
  const entries = (contributes?.navigation ?? [])
    .filter((entry) => entry.location === 'tools')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  for (const entry of entries) {
    const page = contributes?.pages?.find((candidate) =>
      candidate.id === entry.page && candidate.id.trim() && (candidate.html?.source || candidate.body !== undefined));
    if (page) return page;
  }
  return undefined;
};

function boundedRequest<T>(request: Promise<T>): { promise: Promise<T>; cancel: () => void } {
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => reject(new PluginAPIError('plugin.backend.error.timeout'));
    timer = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  });
  return { promise: Promise.race([request, deadline]).finally(() => clearTimeout(timer)), cancel };
}

function useWindowToolCatalog(web: boolean) {
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [error, setError] = useState('');
  const current = useRef({ alive: false, epoch: 0, plugins: [] as PluginStatus[], installedTools: new Set<string>(), revoked: new Map<string, string | null>() });
  const startup = useRef<ReturnType<typeof setTimeout>>();
  const until = useRef(0);
  const cancelRequest = useRef<() => void>();
  const publish = useCallback((items: PluginStatus[]) => { current.current.plugins = items; setPlugins(items); }, []);
  const refresh = useCallback(async (background = false) => {
    if (!current.current.alive) return;
    clearTimeout(startup.current);
    if (!background) { until.current = Date.now() + STARTUP_WINDOW_MS; publish([]); }
    const ticket = ++current.current.epoch;
    cancelRequest.current?.();
    try {
      const request = boundedRequest(Promise.all([pluginAPI.list(), pluginAPI.runtimeInfo()]));
      cancelRequest.current = request.cancel;
      const [items, runtime] = await request.promise;
      if (!current.current.alive || ticket !== current.current.epoch) return;
      const allowed = !runtime.safeMode && runtime.managementAllowed;
      const canOpen = (plugin: PluginStatus) => Boolean(toolPage(plugin));
      const available = allowed ? items.filter((plugin) => {
        const pin = identity(plugin); const id = plugin.manifest.id;
        if (current.current.revoked.has(id)) {
          const revoked = current.current.revoked.get(id);
          if (revoked === null) { current.current.revoked.set(id, pin); return false; }
          if (revoked === pin) return false;
          current.current.revoked.delete(id);
        }
        return Boolean(canOpen(plugin)) && plugin.desiredEnabled && plugin.state === 'running';
      }) : [];
      current.current.installedTools = new Set(available.map((plugin) => plugin.manifest.id));
      publish(available); setError('');
      if (allowed && items.some((plugin) => canOpen(plugin) && plugin.desiredEnabled && plugin.state === 'starting')
          && Date.now() + STARTUP_INTERVAL_MS <= until.current) {
        startup.current = setTimeout(() => { void refresh(true); }, STARTUP_INTERVAL_MS);
      }
    } catch (cause) {
      if (current.current.alive && ticket === current.current.epoch) { publish([]); setError(pluginErrorText(cause)); }
    }
  }, [publish, web]);
  useEffect(() => {
    current.current.alive = true;
    const update = () => { void refresh(); };
    const unsubscribe = subscribePluginContributionInvalidation((event) => {
      current.current.epoch++; cancelRequest.current?.(); clearTimeout(startup.current);
      if (event.reason === 'root') {
        current.current.installedTools.clear();
        for (const plugin of current.current.plugins) current.current.revoked.set(plugin.manifest.id, identity(plugin));
      } else if (event.pluginId) {
        current.current.installedTools.delete(event.pluginId);
        const plugin = current.current.plugins.find((item) => item.manifest.id === event.pluginId);
        current.current.revoked.set(event.pluginId, plugin ? identity(plugin) : current.current.revoked.get(event.pluginId) ?? null);
      }
      publish(current.current.plugins.filter((plugin) => event.reason !== 'root' && plugin.manifest.id !== event.pluginId));
    });
    window.addEventListener('focus', update); window.addEventListener(PLUGIN_LIFECYCLE_EVENT, update);
    update();
    return () => {
      current.current.alive = false; current.current.epoch++; cancelRequest.current?.(); clearTimeout(startup.current);
      window.removeEventListener('focus', update); window.removeEventListener(PLUGIN_LIFECYCLE_EVENT, update); unsubscribe();
    };
  }, [publish, refresh, web]);
  const isCurrent = (plugin: PluginStatus) => current.current.alive
    && current.current.plugins.some((item) => item.manifest.id === plugin.manifest.id && identity(item) === identity(plugin));
  return { plugins, error, refresh, isCurrent, hasInstalledTools: current.current.installedTools.size > 0 };
}

function useWindowToolOpen(catalog: ReturnType<typeof useWindowToolCatalog>, language: string, synchronize: () => Promise<void>) {
  const pending = useRef(new Map<string, { pin: string; cancel: () => void }>());
  const [busy, setBusy] = useState(new Set<string>());
  const [failure, setFailure] = useState<{ plugin: PluginStatus; text: string }>();
  useEffect(() => {
    for (const [id, request] of pending.current) {
      if (!catalog.plugins.some((plugin) => plugin.manifest.id === id && identity(plugin) === request.pin)) {
        pending.current.delete(id); request.cancel();
      }
    }
    setBusy(new Set(pending.current.keys()));
    setFailure((old) => old && catalog.isCurrent(old.plugin) ? old : undefined);
  }, [catalog.plugins]);
  useEffect(() => () => {
    for (const request of pending.current.values()) request.cancel();
    pending.current.clear();
  }, []);
  const open = async (plugin: PluginStatus) => {
    const id = plugin.manifest.id;
    if (!catalog.isCurrent(plugin) || pending.current.has(id)) return;
    setFailure(undefined);
    const page = toolPage(plugin);
    if (page) {
      openPluginPageTab({ pluginID: id, pageID: page.id, title: page.title });
      return;
    }
    const request = boundedRequest(synchronize().then(() => {
      if (!catalog.isCurrent(plugin) || pending.current.get(id) !== operation) throw new PluginAPIError('plugin.backend.error.window_unavailable');
      return pluginAPI.openWindow(id, language, useStore.getState().theme);
    }));
    const operation = { pin: identity(plugin), cancel: request.cancel };
    pending.current.set(id, operation); setBusy(new Set(pending.current.keys()));
    try { await request.promise; }
    catch (cause) {
      if (catalog.isCurrent(plugin) && pending.current.get(id) === operation) setFailure({ plugin, text: pluginErrorText(cause) });
    } finally {
      if (pending.current.get(id) === operation) {
        pending.current.delete(id); setBusy(new Set(pending.current.keys()));
      }
    }
  };
  return { busy, failure, open };
}

export function usePluginWindowTools(): TitleBarQuickAction[] {
  const { language, t } = useI18n();
  const web = isWebRuntime();
  const catalog = useWindowToolCatalog(web);
  const synchronize = usePluginWindowPreferences(language, !web && catalog.plugins.some(plugin => !toolPage(plugin)));
  const invocation = useWindowToolOpen(catalog, language, synchronize);
  const icon = <TitlebarPluginIcon size="100%" />;
  // 入口位置不取决于页面或窗口；点击时再按插件声明选择打开目标。
  const tools: TitleBarQuickAction[] = catalog.plugins.map((plugin) => ({
    afterAI: true,
    key: 'plugin-window-' + plugin.manifest.id, label: plugin.manifest.name,
    icon: <PluginLogo pluginId={plugin.manifest.id} name={plugin.manifest.name}
      version={plugin.manifest.version} variant="toolbar" fallback={icon} />,
    disabled: invocation.busy.has(plugin.manifest.id), onClick: () => { void invocation.open(plugin); },
  }));
  const actions: TitleBarQuickAction[] = tools;
  const error = catalog.error || invocation.failure?.text;
  if (error && catalog.hasInstalledTools) actions.push(
    { key: 'plugin-window-failure', label: error, disabled: true },
    { key: 'plugin-window-retry', label: t('common.retry'), onClick: () => {
      if (invocation.failure && catalog.isCurrent(invocation.failure.plugin)) void invocation.open(invocation.failure.plugin);
      else void catalog.refresh();
    } },
  );
  return actions;
}
