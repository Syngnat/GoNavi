import { useEffect, useState } from 'react';
import { resolveMarketPluginIcon } from './marketPluginIcon';
import type { MarketPlugin } from './types';

// 远程图标按「来源 + 插件 + 版本 + 官方标记 + 图标路径」缓存，卡片重渲染或从详情返回都不再请求。
interface CachedIcon { urls: string[]; expiresAt: number }
const resolvedIcons = new Map<string, CachedIcon>();
const pendingIcons = new Map<string, Promise<string[]>>();
const EMPTY: string[] = [];
// 冷启动时 WebView/后端可能尚未就绪，详情请求失败后短暂重试，避免首屏永久回退到通用图标。
const RETRY_DELAYS_MS = [500, 1500, 4000];
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 5 * 60_000;

function manifestIconPath(plugin: MarketPlugin): string {
  const icon = plugin.manifest?.icon?.trim();
  if (icon) return icon;
  return plugin.manifest?.contributes?.aiProviders?.find((provider) => provider.icon)?.icon ?? '';
}

export function marketIconCacheKey(plugin: MarketPlugin, sourceId: string | undefined): string {
  return [sourceId ?? '', plugin.id, plugin.version, plugin.official ? 'official' : '', plugin.sourceUrl ?? '', manifestIconPath(plugin)].join('|');
}

export function useMarketPluginIcon(plugin: MarketPlugin, sourceId: string | undefined, enabled = true, retryKey: string | number = 0): string[] {
  const key = marketIconCacheKey(plugin, sourceId);
  const [image, setImage] = useState(() => {
    const cached = enabled ? resolvedIcons.get(key) : undefined;
    return { key, urls: cached && cached.expiresAt > Date.now() ? cached.urls : EMPTY };
  });
  const src = enabled && image.key === key ? image.urls : EMPTY;
  useEffect(() => {
    if (!enabled) {
      setImage({ key, urls: EMPTY });
      return;
    }
    const cached = resolvedIcons.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      setImage({ key, urls: cached.urls });
      return;
    }
    let alive = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      let request = pendingIcons.get(key);
      if (!request) {
        const created = resolveMarketPluginIcon(plugin, sourceId)
          .then((urls) => {
            const unique = Array.from(new Set(urls));
            resolvedIcons.set(key, { urls: unique, expiresAt: Date.now() + (unique.length ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
            return unique;
          })
          .finally(() => { if (pendingIcons.get(key) === created) pendingIcons.delete(key); });
        request = created;
        pendingIcons.set(key, created);
      }
      void request.then((urls) => {
        if (alive) setImage({ key, urls });
      }).catch(() => {
        if (!alive) return;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          setImage({ key, urls: EMPTY });
          return;
        }
        attempt += 1;
        timer = setTimeout(load, delay);
      });
    };
    setImage({ key, urls: EMPTY });
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, enabled, retryKey, plugin.id, plugin.version, plugin.sourceUrl, plugin.official, plugin.manifest?.icon, sourceId]);
  return src;
}
