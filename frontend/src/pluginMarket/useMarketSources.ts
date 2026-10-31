import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginErrorText } from '../plugins/apiResult';
import { marketSourcesAPI } from './sourceApi';
import { syncCatalogSources } from './catalogPageCache';
import type { MarketSource, MarketSourceConfig } from './types';

export function useMarketSources() {
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const request = useRef(0);
  const saving = useRef(false);
  const refresh = useCallback(async () => {
    if (saving.current) return;
    const token = ++request.current;
    setLoading(true); setError('');
    try { const rows = await marketSourcesAPI.list(); if (alive.current && token === request.current) { syncCatalogSources(JSON.stringify(rows)); setSources(rows); } }
    catch (cause) { if (alive.current && token === request.current) setError(pluginErrorText(cause)); }
    finally { if (alive.current && token === request.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; request.current++; }; }, [refresh]);
  const save = async (rows: MarketSourceConfig[]): Promise<boolean> => {
    if (saving.current) return false;
    const token = ++request.current;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await marketSourcesAPI.save(rows);
      if (!alive.current || token !== request.current) return false;
      syncCatalogSources(JSON.stringify(result)); setSources(result); setRevision((value) => value + 1); return true;
    } catch (cause) { if (alive.current && token === request.current) setError(pluginErrorText(cause)); return false; }
    finally { saving.current = false; if (alive.current) { setBusy(false); setLoading(false); } }
  };
  return { sources, loading, busy, error, revision, refresh, save };
}
export type MarketSources = ReturnType<typeof useMarketSources>;
