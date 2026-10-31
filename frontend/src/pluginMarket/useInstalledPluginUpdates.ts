import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginAPIError } from '../plugins/apiResult';
import type { PluginStatus } from '../plugins/types';
import { marketSourcesAPI } from './sourceApi';
import { loadMarketVersions } from './versionsApi';
import { findInstalledPluginUpdate, preferredInstalledPluginUpdate, type InstalledPluginIdentity, type InstalledPluginUpdate } from './installedPluginUpdates';
import type { MarketSource } from './types';

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_CONCURRENCY = 4;

export function useInstalledPluginUpdates(plugins: readonly PluginStatus[], enabled: boolean) {
  const signature = JSON.stringify(plugins.map(({ manifest }) => [manifest.id, manifest.version]).sort());
  const installed = useMemo<InstalledPluginIdentity[]>(() => (JSON.parse(signature) as [string, string][]).map(([id, version]) => ({ id, version })), [signature]);
  const [updates, setUpdates] = useState<ReadonlyMap<string, InstalledPluginUpdate>>(new Map());
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [sourcesKnown, setSourcesKnown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  const flight = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  const currentReload = useRef<() => Promise<void>>(() => Promise.resolve());
  const reload = useCallback((): Promise<void> => {
    if (!enabled || installed.length === 0) return Promise.resolve();
    if (flight.current) { pending.current = true; return flight.current; }
    const ticket = ++epoch.current;
    setLoading(true); setFailed(false); setSourcesKnown(false);
    const check = async () => {
      try {
        const rows = (await marketSourcesAPI.list()).filter((source) => source.enabled);
        if (ticket !== epoch.current) return;
        setSources(rows); setSourcesKnown(true);
        const candidates = new Map<string, InstalledPluginUpdate[]>();
        const jobs = installed.flatMap((plugin) => rows.map((source) => ({ plugin, source })));
        let cursor = 0; let errors = false;
        const worker = async () => {
          while (ticket === epoch.current && cursor < jobs.length) {
            const { plugin, source } = jobs[cursor++];
            try {
              const page = await loadMarketVersions(plugin.id, source.sourceId, true);
              const update = findInstalledPluginUpdate(plugin, source, page.versions);
              if (update) candidates.set(plugin.id, [...(candidates.get(plugin.id) ?? []), update]);
              if (page.warning) errors = true;
            } catch (cause) {
              if (!(cause instanceof PluginAPIError && cause.key === 'plugin.backend.error.not_found')) errors = true;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(UPDATE_CHECK_CONCURRENCY, jobs.length) }, worker));
        if (ticket !== epoch.current || pending.current) return;
        const found = new Map<string, InstalledPluginUpdate>();
        for (const [id, choices] of candidates) {
          const selected = preferredInstalledPluginUpdate(choices);
          if (selected) found.set(id, selected);
        }
        setUpdates(found); setChecked(true); setFailed(errors);
      } catch {
        if (ticket === epoch.current && !pending.current) { setUpdates(new Map()); setSources([]); setSourcesKnown(false); setFailed(true); setChecked(true); }
      } finally { if (ticket === epoch.current && !pending.current) setLoading(false); }
    };
    const task = check().finally(() => {
      flight.current = null;
      if (pending.current) { pending.current = false; void currentReload.current(); }
    });
    flight.current = task;
    return task;
  }, [enabled, installed]);
  currentReload.current = reload;
  useEffect(() => {
    setUpdates(new Map()); setSources([]); setSourcesKnown(false); setChecked(false); setFailed(false); setLoading(false);
    void reload();
    if (!enabled || installed.length === 0) return () => { epoch.current++; pending.current = false; };
    const onFocus = () => { void reload(); };
    const timer = setInterval(onFocus, UPDATE_CHECK_INTERVAL_MS);
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    return () => { epoch.current++; pending.current = false; clearInterval(timer); if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus); };
  }, [enabled, installed, reload]);
  return { updates, sources, sourcesKnown, loading, checked, failed, reload };
}
