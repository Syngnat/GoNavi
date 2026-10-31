import { maskAccountKey, type AccountKeyItem } from './aiPluginProviderAccountApi';

export const ACCOUNT_KEY_PAGE_SIZE = 5;

export const matchAccountKey = (item: AccountKeyItem, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.name, item.id, item.groupName, item.key, maskAccountKey(item.key)].join('\n').toLowerCase();
  return haystack.includes(needle);
};

export interface AccountKeyPage {
  slice: AccountKeyItem[];
  total: number;
  pages: number;
  page: number;
  from: number;
  to: number;
}

export const pageAccountKeys = (
  items: AccountKeyItem[],
  query: string,
  page: number,
  size = ACCOUNT_KEY_PAGE_SIZE,
): AccountKeyPage => {
  const matched = items.filter((item) => matchAccountKey(item, query));
  const total = matched.length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  const slice = matched.slice(start, start + size);
  return { slice, total, pages, page: current, from: total === 0 ? 0 : start + 1, to: start + slice.length };
};
