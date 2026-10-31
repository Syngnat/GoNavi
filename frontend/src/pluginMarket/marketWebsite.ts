import { safeHTTPURL } from './decode';

export function marketPluginWebsiteURL(source: string, id: string): string {
  if (!safeHTTPURL(source) || !/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') return '';
  try {
    const url = new URL(source);
    if (url.search || url.hash || url.username || url.password) return '';
    let prefix = url.pathname;
    while (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
    if (prefix.endsWith('/api/v1')) prefix = prefix.slice(0, -7);
    url.pathname = prefix + '/plugins/' + encodeURIComponent(id);
    return url.toString();
  } catch { return ''; }
}
