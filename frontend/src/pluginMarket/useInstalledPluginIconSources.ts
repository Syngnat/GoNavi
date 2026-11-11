import { useEffect, useMemo, useState } from 'react';
import type { PluginStatus } from '../plugins/types';
import { resolveMarketPluginIcon } from './marketPluginIcon';
import { sourceMarketAPI } from './sourceApi';
import type { MarketSource } from './types';

// 已安装插件优先用包内图标；包内没有图标时回退到市场来源声明的 Logo，
// 这样卡片不会退化成名称首字母。按插件 id 缓存，卡片重渲染或翻页不再请求。
interface CachedIcon { urls: string[]; expiresAt: number }
const resolvedIcons = new Map<string, CachedIcon>();
const pendingIcons = new Map<string, Promise<string[]>>();
const EMPTY: ReadonlyMap<string, string[]> = new Map();
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 5 * 60_000;

// 与安装更新时的来源选择保持一致：受信任的官方来源优先。
export function installedIconSources(sources: readonly MarketSource[]): MarketSource[] {
  return sources.filter((source) => source.enabled)
    .sort((a, b) => Number(b.trustedOfficial) - Number(a.trustedOfficial) || a.sourceId.localeCompare(b.sourceId));
}

// 逐个来源询问详情：市场里同一个 id 可能只在一个来源中存在。
async function resolveFromSources(pluginId: string, sources: readonly MarketSource[]): Promise<string[]> {
  for (const source of sources) {
    try {
      const detail = await sourceMarketAPI(source.sourceId).detail(pluginId);
      const urls = await resolveMarketPluginIcon(detail, source.sourceId);
      if (urls.length) return urls;
    } catch {
      // 该来源不认识这个插件，或暂时不可用；换下一个来源继续。
    }
  }
  return [];
}

function loadIconSources(pluginId: string, sources: readonly MarketSource[]): Promise<string[]> {
  const inflight = pendingIcons.get(pluginId);
  if (inflight) return inflight;
  const created = resolveFromSources(pluginId, sources)
    .then((urls) => {
      const unique = Array.from(new Set(urls));
      resolvedIcons.set(pluginId, { urls: unique, expiresAt: Date.now() + (unique.length ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
      return unique;
    })
    .finally(() => { if (pendingIcons.get(pluginId) === created) pendingIcons.delete(pluginId); });
  pendingIcons.set(pluginId, created);
  return created;
}

/**
 * 已安装插件的市场 Logo 候选地址，按插件 id 索引。
 *
 * 返回的地址交给 `PluginLogo` 的 `remoteSources`：`<img>` 实际加载失败时会逐个
 * 回退，所以这里只负责给出候选，不预先探测。
 */
export function useInstalledPluginIconSources(
  plugins: readonly PluginStatus[],
  sources: readonly MarketSource[],
  enabled: boolean,
  retryKey: string | number = 0,
): ReadonlyMap<string, string[]> {
  const signature = plugins.map((plugin) => plugin.manifest.id).sort().join('\n');
  const sourceSignature = sources.map((source) => `${source.sourceId}:${Number(source.enabled)}:${Number(source.trustedOfficial)}`).sort().join('\n');
  const ids = useMemo(() => (signature ? signature.split('\n') : []), [signature]);
  const ordered = useMemo(
    () => installedIconSources(sources),
    // sourceSignature 已经覆盖 sourceId/enabled/trustedOfficial 的全部变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceSignature],
  );
  const key = signature + '|' + sourceSignature;
  const [state, setState] = useState<{ key: string; urls: ReadonlyMap<string, string[]> }>({ key, urls: EMPTY });

  useEffect(() => {
    if (!enabled || ids.length === 0 || ordered.length === 0) {
      setState({ key, urls: EMPTY });
      return;
    }
    const known = new Map<string, string[]>();
    const missing: string[] = [];
    for (const id of ids) {
      const cached = resolvedIcons.get(id);
      if (cached && cached.expiresAt > Date.now()) known.set(id, cached.urls);
      else missing.push(id);
    }
    setState({ key, urls: known });
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(missing.map((id) => loadIconSources(id, ordered)
      .then((urls) => [id, urls] as const)
      .catch(() => [id, [] as string[]] as const)))
      .then((rows) => {
        if (!alive) return;
        const merged = new Map(known);
        for (const [id, urls] of rows) merged.set(id, urls);
        setState({ key, urls: merged });
      });
    return () => { alive = false; };
  }, [key, enabled, retryKey, ids, ordered]);

  return state.key === key ? state.urls : EMPTY;
}
