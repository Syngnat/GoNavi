import type { MarketSource } from './types';

// 缓存上一次成功读取的来源列表，让重新进入插件市场时先渲染旧数据再后台刷新。
let cachedSources: MarketSource[] = [];

export function peekMarketSources(): MarketSource[] {
  return cachedSources.slice();
}

export function storeMarketSources(sources: MarketSource[]): void {
  cachedSources = sources.slice();
}

export function clearMarketSourcesCache(): void {
  cachedSources = [];
}
