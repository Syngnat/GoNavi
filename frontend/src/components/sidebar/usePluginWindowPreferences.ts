import { useCallback, useEffect, useRef } from 'react';
import { pluginAPI } from '../../plugins/api';
import { PluginAPIError } from '../../plugins/apiResult';
import { readHostAppearance } from '../../pluginPages/hostAppearance';
import { pluginHostPreferences, serializeHostPreferences } from '../../pluginPages/hostPreferences';
import { readHostThemePalette, useHostThemePalette } from '../../pluginPages/useHostThemePalette';
import { useStore } from '../../store';

const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_REVISION_KEY = 'gonavi:plugin-window-preference-revision';
let requestRevision = 0;

function nextRequestRevision(): number {
  // Persist before dispatch so a reloaded main WebView never reuses an accepted revision.
  const stored = Number(localStorage.getItem(REQUEST_REVISION_KEY));
  if (!Number.isSafeInteger(stored) || stored < 0 || stored >= Number.MAX_SAFE_INTEGER) throw new PluginAPIError('plugin.backend.error.invalid_request');
  requestRevision = Math.max(requestRevision, stored) + 1;
  localStorage.setItem(REQUEST_REVISION_KEY, String(requestRevision));
  return requestRevision;
}

interface PreferenceQueue {
  queue: Promise<void>;
  latest?: { json: string; promise: Promise<void> };
  cancel: Set<() => void>;
}

// Wails cannot abort a dispatched RPC; the receiver fences its revision after a timeout.
export function usePluginWindowPreferences(language: string, enabled: boolean): () => Promise<void> {
 const theme = useStore(state => state.theme);
 const { palette, appearance, ready } = useHostThemePalette(enabled);
 const current = useRef<PreferenceQueue>();
 useEffect(() => {
  if (!enabled) return;
  const state: PreferenceQueue = { queue: Promise.resolve(), cancel: new Set() };
  current.current = state;
  return () => {
   current.current = undefined;
   for (const cancel of state.cancel) cancel();
   state.cancel.clear();
  };
 }, [enabled]);
 const synchronize = useCallback(() => {
  const state = current.current;
  if (!enabled || !state) return Promise.reject(new PluginAPIError('plugin.backend.error.window_unavailable'));
  const json = serializeHostPreferences(pluginHostPreferences(language, useStore.getState().theme, readHostThemePalette(), readHostAppearance()));
  if (state.latest?.json === json) return state.latest.promise;
  let active = true;
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
   cancel = () => reject(new PluginAPIError('plugin.backend.error.window_unavailable'));
   timer = setTimeout(() => reject(new PluginAPIError('plugin.backend.error.timeout')), REQUEST_TIMEOUT_MS);
  });
  state.cancel.add(cancel);
  const request = state.queue.then(() => {
   if (!active || current.current !== state) throw new PluginAPIError('plugin.backend.error.window_unavailable');
   const raw = json.slice(0, -1) + ',"requestRevision":' + nextRequestRevision() + '}';
   return pluginAPI.updateWindowPreferences(raw);
  });
  const promise = Promise.race([request, deadline]).finally(() => {
   active = false;
   clearTimeout(timer);
   state.cancel.delete(cancel);
  });
  state.latest = { json, promise };
  state.queue = promise.catch(() => { if (state.latest?.promise === promise) state.latest = undefined; });
  return promise;
 }, [enabled, language]);
 useEffect(() => {
  if (enabled && ready) void synchronize().catch(cause => console.warn('Plugin window preferences update failed', cause));
 }, [enabled, ready, language, theme, palette, appearance, synchronize]);
 return synchronize;
}
