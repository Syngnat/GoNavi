import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginAPI } from '../plugins/api';
import { PluginAPIError, pluginErrorText } from '../plugins/apiResult';
import type { PluginPage, PluginStatus } from '../plugins/types';
import { PLUGIN_LIFECYCLE_EVENT } from '../plugins/events';
import { subscribePluginContributionInvalidation } from '../plugins/invalidation';

const REFRESH_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;

export interface PluginPageTarget {
  loading: boolean;
  error: string;
  status?: PluginStatus;
  page?: PluginPage;
  available: boolean;
}

const documentHidden = (): boolean => (
  typeof document !== 'undefined' && document.visibilityState === 'hidden'
);

/**
 * Resolves one page declaration and keeps its plugin status fresh. Polling pauses while the
 * window is hidden and refreshes immediately on return, so a background page tab costs
 * nothing. Disabling, removing or replacing the plugin turns the tab into the unavailable
 * state without a remount, and the bridge stops because the host unmounts the frame.
 */
export function usePluginPageTarget(pluginID: string, pageID: string): PluginPageTarget {
  const [status, setStatus] = useState<PluginStatus | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const current = useRef({ alive: false, epoch: 0, status: undefined as PluginStatus | undefined, revoked: undefined as string | null | undefined });
  const cancel = useRef<() => void>();
  const refresh = useCallback(async () => {
    const ticket = ++current.current.epoch;
    cancel.current?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      cancel.current = () => reject(new PluginAPIError('plugin.backend.error.timeout'));
      timer = setTimeout(cancel.current, REQUEST_TIMEOUT_MS);
    });
    try {
      const plugins = await Promise.race([pluginAPI.list(), deadline]);
      if (!current.current.alive || ticket !== current.current.epoch) return;
      let next = plugins.find((plugin) => plugin.manifest.id === pluginID);
      if (next && current.current.revoked !== undefined) {
        const pin = `${next.digest}:${next.generation}`;
        if (current.current.revoked === null) current.current.revoked = pin;
        if (current.current.revoked === pin) next = undefined;
        else current.current.revoked = undefined;
      }
      current.current.status = next;
      setStatus(next);
      setError('');
    } catch (cause) {
      if (current.current.alive && ticket === current.current.epoch) {
        current.current.status = undefined; setStatus(undefined); setError(pluginErrorText(cause));
      }
    } finally {
      clearTimeout(timer);
      if (ticket === current.current.epoch) cancel.current = undefined;
      if (current.current.alive && ticket === current.current.epoch) setLoading(false);
    }
  }, [pluginID]);
  useEffect(() => {
    current.current.alive = true;
    const unsubscribe = subscribePluginContributionInvalidation((event) => {
      if (event.reason !== 'root' && event.pluginId !== pluginID) return;
      current.current.epoch++; cancel.current?.(); cancel.current = undefined;
      const old = current.current.status;
      current.current.revoked = old ? `${old.digest}:${old.generation}` : current.current.revoked ?? null;
      current.current.status = undefined; setStatus(undefined); setError(''); setLoading(false);
    });
    void refresh();
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(() => { if (!cancel.current) void refresh(); }, REFRESH_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (documentHidden()) {
        stop();
        return;
      }
      void refresh();
      start();
    };
    const onFocus = () => {
      if (!documentHidden()) void refresh();
    };
    if (!documentHidden()) start();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
    const onLifecycle = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener(PLUGIN_LIFECYCLE_EVENT, onLifecycle);
    return () => {
      current.current.alive = false; current.current.epoch++; cancel.current?.(); cancel.current = undefined; unsubscribe();
      stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(PLUGIN_LIFECYCLE_EVENT, onLifecycle);
    };
  }, [refresh]);
  const resolvedStatus = status?.manifest.id === pluginID ? status : undefined;
  const page = resolvedStatus?.manifest.contributes?.pages?.find((candidate) => candidate.id === pageID);
  const running = resolvedStatus?.state === 'running' && resolvedStatus.desiredEnabled === true;
  return { loading, error, status: resolvedStatus, page, available: Boolean(page) && running };
}
