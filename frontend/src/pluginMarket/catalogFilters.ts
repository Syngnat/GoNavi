export interface CatalogFilters { categories: string[]; platforms: string[]; official: '' | 'official' | 'community'; author: string }
export interface MarketFilterState extends CatalogFilters { sourceIds: string[] }
export const CATALOG_CATEGORIES = ['datasource', 'ai-provider', 'exporter', 'skill', 'panel', 'command', 'ops', 'other'] as const;
/** 动态拼接的 `plugin.market.category.*` 会展开成这些字面量键，供全仓 i18n 扫描校验。 */
export const PLUGIN_MARKET_CATEGORY_TEXT_KEYS: readonly string[] = CATALOG_CATEGORIES.map((category) => `plugin.market.category.${category}`);
export const CATALOG_PLATFORMS = ['windows/amd64', 'windows/arm64', 'darwin/amd64', 'darwin/arm64', 'linux/amd64', 'linux/arm64'];
export const EMPTY_CATALOG_FILTERS: CatalogFilters = { categories: [], platforms: [], official: '', author: '' };
export function emptyMarketFilters(): MarketFilterState { return { ...EMPTY_CATALOG_FILTERS, categories: [], platforms: [], sourceIds: [] }; }
export function normalizeCatalogFilters(value: CatalogFilters): CatalogFilters {
  return { categories: Array.from(new Set(value.categories)).sort(), platforms: Array.from(new Set(value.platforms)).sort(), official: value.official, author: value.author.trim() };
}
export function activeCatalogFilters(value: CatalogFilters): boolean {
  return value.categories.length > 0 || value.platforms.length > 0 || value.official !== '' || value.author.trim() !== '';
}
export function catalogFilterKey(value: CatalogFilters): string {
  return activeCatalogFilters(value) ? JSON.stringify(normalizeCatalogFilters(value)) : '';
}
export function selectedPlatforms(next: string[], previous: string[]): string[] {
  const old = previous.length ? previous : ['current'];
  const added = next.find((value) => !old.includes(value));
  if (added === 'current') return [];
  if (added === 'all') return ['all'];
  return next.filter((value) => value !== 'all' && value !== 'current');
}
