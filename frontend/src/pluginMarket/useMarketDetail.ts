import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginAPIError, pluginErrorText } from '../plugins/apiResult';
import { marketAPI } from './api';
import { sourceMarketAPI } from './sourceApi';
import type { MarketPlugin, MarketRating } from './types';

export function useMarketDetail(id: string, sourceId?: string, scoped = false) {
  const client = useMemo(() => scoped && sourceId ? sourceMarketAPI(sourceId) : marketAPI, [scoped, sourceId]);
  const [plugin, setPlugin] = useState<MarketPlugin | null>(null);
  const [ratings, setRatings] = useState<MarketRating[]>([]);
  const [error, setError] = useState('');
  const [ratingsError, setRatingsError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const token = ++request.current;
    setLoading(true); setError(''); setRatingsError('');
    try {
      const [detail, reviews] = await Promise.allSettled([client.detail(id), client.ratings(id)]);
      if (detail.status === 'rejected') throw detail.reason;
      if (sourceId && detail.value.sourceId !== sourceId) throw new PluginAPIError('plugin.market.error.source_changed');
      if (request.current === token) {
        setPlugin(detail.value);
        if (reviews.status === 'fulfilled') setRatings(reviews.value);
        else setRatingsError(pluginErrorText(reviews.reason));
      }
    } catch (cause) { if (request.current === token) setError(pluginErrorText(cause)); }
    finally { if (request.current === token) setLoading(false); }
  }, [id, sourceId, client]);
  useEffect(() => { setPlugin(null); setRatings([]); void load(); return () => { request.current++; }; }, [load]);
  return { plugin, ratings, error, ratingsError, loading, load };
}
