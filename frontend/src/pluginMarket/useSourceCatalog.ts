import { useEffect, useMemo, useRef, useState } from 'react';
import { pluginErrorText } from '../plugins/apiResult';
import { sourceMarketAPI } from './sourceApi';
import { searchSourceCatalog } from './sourceSearchApi';
import { catalogFilterKey, normalizeCatalogFilters, EMPTY_CATALOG_FILTERS, type CatalogFilters } from './catalogFilters';
import { marketErrorText } from './marketErrors';
import { peekCatalogPage, requestCatalogPage } from './catalogPageCache';
import type { CatalogPage, MarketPlugin, MarketSort } from './types';

type Navigation = { identity: string; cursors: string[]; index: number };
type View = { key: string; items: MarketPlugin[]; nextCursor: string; loading: boolean; refreshing: boolean; error: string; warning: string; stale: boolean; cachedAt: string };
const emptyView: View = { key: '', items: [], nextCursor: '', loading: true, refreshing: false, error: '', warning: '', stale: false, cachedAt: '' };
function pageView(key: string, trusted: boolean, page?: CatalogPage): View {
  if (!page) return { ...emptyView, key };
  const warningOnly = page.error === 'cache_unavailable' && !page.stale;
  return { key, items: page.items.map((item) => ({ ...item, official: trusted && item.official })), nextCursor: page.nextCursor ?? '',
    loading: false, refreshing: false, stale: Boolean(page.stale), cachedAt: page.cachedAt ?? '',
    warning: warningOnly ? marketErrorText('cache_unavailable') : '', error: page.error && !warningOnly ? marketErrorText(page.error) : '' };
}
function cachedView(key: string, trusted: boolean): View {
  const entry = peekCatalogPage(key);
  const result = pageView(key, trusted, entry?.page);
  return entry && 'failure' in entry ? { ...result, loading: false, stale: Boolean(entry.page), error: pluginErrorText(entry.failure) } : result;
}

export function useSourceCatalog(sourceId: string, trustedOfficial: boolean, query: string, sort: MarketSort, revision: number, filters: CatalogFilters = EMPTY_CATALOG_FILTERS) {
  const client = useMemo(() => sourceMarketAPI(sourceId), [sourceId]);
  const filterKey = catalogFilterKey(filters);
  const normalizedFilters = useMemo(() => normalizeCatalogFilters(filters), [filterKey]);
  const identity = JSON.stringify([sourceId, query, sort, filterKey]);
  const [navigation, setNavigation] = useState<Navigation>({ identity, cursors: [''], index: 0 });
  const active = navigation.identity === identity ? navigation : { identity, cursors: [''], index: 0 };
  const cursor = active.cursors[active.index];
  const key = JSON.stringify(filterKey ? [sourceId, trustedOfficial, query, sort, cursor, filterKey] : [sourceId, trustedOfficial, query, sort, cursor]);
  const [view, setView] = useState<View>(() => cachedView(key, trustedOfficial));
  const [refresh, setRefresh] = useState(0);
  const previousRefresh = useRef({ revision, refresh });
  const request = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    if (navigation.identity !== identity) setNavigation({ identity, cursors: [''], index: 0 });
    const token = ++request.current;
    const force = previousRefresh.current.revision !== revision || previousRefresh.current.refresh !== refresh;
    previousRefresh.current = { revision, refresh };
    const cached = peekCatalogPage(key);
    const reusable = !force && cached && cached.validUntil > Date.now();
    pending.current = !reusable;
    setView({ ...cachedView(key, trustedOfficial), loading: !reusable && !cached?.page, refreshing: !reusable && Boolean(cached?.page) });
    if (reusable) return () => { request.current++; pending.current = false; };
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const page = await requestCatalogPage(key, () => filterKey ? searchSourceCatalog(sourceId, query, sort, cursor, normalizedFilters) : client.catalog(query, sort, cursor), { force, signal: controller.signal, sourceId });
        if (token === request.current) setView(pageView(key, trustedOfficial, page));
      } catch (cause) {
        if (token !== request.current || controller.signal.aborted) return;
        const retained = peekCatalogPage(key)?.page ?? cached?.page;
        setView({ ...pageView(key, trustedOfficial, retained), loading: false, refreshing: false, stale: Boolean(retained), error: pluginErrorText(cause) });
      } finally { if (token === request.current) pending.current = false; }
    }, 250);
    return () => { clearTimeout(timer); request.current++; pending.current = false; controller.abort(); };
  }, [client, identity, cursor, key, query, sort, sourceId, trustedOfficial, revision, refresh, filterKey, normalizedFilters]);
  const current = view.key === key ? view : cachedView(key, trustedOfficial);
  const canNext = Boolean(current.nextCursor && !current.error && !current.stale && !active.cursors.includes(current.nextCursor));
  const next = () => {
    if (!canNext || pending.current || current.loading || current.refreshing) return;
    pending.current = true;
    setNavigation({ identity, cursors: [...active.cursors.slice(0, active.index + 1), current.nextCursor], index: active.index + 1 });
  };
  const previous = () => {
    if (!active.index || pending.current || current.loading || current.refreshing) return;
    pending.current = true; setNavigation({ ...active, index: active.index - 1 });
  };
  return { ...current, page: active.index + 1, canNext, next, previous, reload: () => setRefresh((value) => value + 1) };
}
