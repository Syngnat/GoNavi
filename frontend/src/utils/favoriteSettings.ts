export const QUICK_PREFERENCE_KEYS = {
  layout: 'app.theme.appearance.navicat_layout_title', scale: 'app.theme.appearance.ui_scale_title',
  collapse: 'app.theme.appearance.workbench_sidebar_auto_collapse_title', singleDatabase: 'app.theme.appearance.single_database_expansion_title',
  doubleClick: 'app.theme.data_table.table_double_click_action', log: 'app.theme.data_table.show_sql_execution_log',
  rows: 'app.theme.data_table.row_number', borders: 'app.theme.data_table.vertical_borders', density: 'app.theme.data_table.density',
  motion: 'app.theme.appearance.reduce_motion', lowSpec: 'app.theme.appearance.low_spec_mode',
} as const;
export type QuickPreference = keyof typeof QUICK_PREFERENCE_KEYS;
export const DEFAULT_FAVORITE_SETTINGS: string[] = ['layout', 'scale', 'collapse', 'singleDatabase', 'doubleClick', 'log', 'rows', 'density'];
export function sanitizeFavoriteSettings(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_FAVORITE_SETTINGS];
  return [...new Set(value.filter((id): id is string => typeof id === 'string'
    && (Object.prototype.hasOwnProperty.call(QUICK_PREFERENCE_KEYS, id) || /^entry:[a-z0-9-]+\/[a-z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(id))))].slice(0, 100);
}
export function toggleFavoriteSetting(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter(value => value !== id) : sanitizeFavoriteSettings([...current, id]);
}
export function moveFavoriteSetting(current: readonly string[], id: string, offset: -1 | 1): string[] {
  const next = [...current];
  const index = next.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
