import type { MarketSourceConfig } from './types';
export const MAX_MARKET_SOURCES = 32;

export function sourceConfigError(rows: readonly MarketSourceConfig[]): string {
  if (rows.length > MAX_MARKET_SOURCES) return 'plugin.market.sources_too_many';
  const seen = new Set<string>();
  for (const row of rows) {
    try {
      const raw = row.baseUrl.trim();
      const url = new URL(raw);
      const parts = url.hostname.split('.');
      const loopbackIPv4 = parts.length === 4 && parts[0] === '127' && parts.every((part) => part !== '' && Number.isInteger(Number(part)) && Number(part) >= 0 && Number(part) <= 255);
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || loopbackIPv4;
      if (!raw || raw.length > 2048 || url.username || url.password || raw.includes('?') || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return 'plugin.market.sources_invalid';
      let path = url.pathname;
      while (path.endsWith('/')) path = path.slice(0, -1);
      if (path.endsWith('/api/v1')) path = path.slice(0, -7);
      const identity = url.origin + path;
      if (identity.length > 2048) return 'plugin.market.sources_invalid';
      if (seen.has(identity)) return 'plugin.market.sources_duplicate';
      seen.add(identity);
    } catch { return 'plugin.market.sources_invalid'; }
  }
  return '';
}
