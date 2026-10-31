import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginAPI } from './api';
import { collectPluginConnectionActions, type PluginConnectionActionEntry } from './connectionActions';
import { PLUGIN_LIFECYCLE_EVENT } from './events';

const STARTUP_POLL_INTERVAL_MS = 1500;
const STARTUP_POLL_TIMEOUT_MS = 60000;

/** Prefetch synchronous menu entries and follow startup independently of the manager UI. */
export function usePluginConnectionActions() {
  const [actions, setActions] = useState<PluginConnectionActionEntry[]>([]);
  const loading = useRef(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const startupDeadline = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const reload = useCallback(async function reload() {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (loading.current) { pending.current = true; return; }
    loading.current = true;
    try {
      do {
        pending.current = false;
        try {
          const plugins = await pluginAPI.list();
          if (alive.current && !pending.current) {
            setActions(collectPluginConnectionActions(plugins));
            if (plugins.some((plugin) => plugin.desiredEnabled && plugin.state === 'starting')) {
              if (!startupDeadline.current) startupDeadline.current = Date.now() + STARTUP_POLL_TIMEOUT_MS;
            } else {
              startupDeadline.current = 0;
            }
          }
        } catch {
          if (alive.current && !pending.current) setActions([]);
        }
        const remaining = startupDeadline.current - Date.now();
        if (alive.current && !pending.current && remaining > 0) {
          timer.current = setTimeout(() => void reload(), Math.min(STARTUP_POLL_INTERVAL_MS, remaining));
        }
      } while (pending.current && alive.current);
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const onFocus = () => { void reload(); };
    const onLifecycle = () => { void reload(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener(PLUGIN_LIFECYCLE_EVENT, onLifecycle);
    return () => {
      alive.current = false;
      startupDeadline.current = 0;
      clearTimeout(timer.current);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(PLUGIN_LIFECYCLE_EVENT, onLifecycle);
    };
  }, [reload]);

  return { actions, reload };
}
