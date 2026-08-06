import { t as translateCatalog } from '../i18n/catalog';
import { SUPPORTED_LANGUAGES } from '../i18n/resolveLanguage';
import type { I18nParams } from '../i18n/types';

const UNTITLED_QUERY_DATABASE_PLACEHOLDER = '__GONAVI_QUERY_DATABASE__';
export const QUERY_TAB_RENAME_REQUEST_EVENT = 'gonavi:request-query-tab-rename';
const UNTITLED_QUERY_TITLE_KEYS = [
  'query.new',
  'sidebar.tab.new_query',
  'table_overview.menu.new_query',
] as const;

export type QueryTabTitleTranslate = (key: string, params?: I18nParams) => string;

const UNTITLED_QUERY_TITLES = new Set(
  SUPPORTED_LANGUAGES.flatMap((language) => UNTITLED_QUERY_TITLE_KEYS
    .map((key) => translateCatalog(language, key).trim())
    .filter(Boolean)),
);

const UNTITLED_QUERY_DATABASE_TITLE_PREFIXES = Array.from(
  new Set(
    SUPPORTED_LANGUAGES
      .map((language) => {
        const databaseScopedTitle = translateCatalog(
          language,
          'sidebar.tab.new_query_database',
          { database: UNTITLED_QUERY_DATABASE_PLACEHOLDER },
        ).trim();
        const placeholderIndex = databaseScopedTitle.indexOf(UNTITLED_QUERY_DATABASE_PLACEHOLDER);
        return placeholderIndex > 0 ? databaseScopedTitle.slice(0, placeholderIndex).trim() : '';
      })
      .filter(Boolean),
  ),
);

const hasUntitledDatabaseQueryPrefix = (value: string): boolean => (
  UNTITLED_QUERY_DATABASE_TITLE_PREFIXES.some((prefix) => value.startsWith(prefix))
);

export const isLocalizedUntitledQueryTitle = (value: unknown): boolean => {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return true;
  }
  return UNTITLED_QUERY_TITLES.has(rawValue) || hasUntitledDatabaseQueryPrefix(rawValue);
};

export const resolveLocalizedUntitledQueryTitle = (
  title: unknown,
  database: unknown,
  translate: QueryTabTitleTranslate,
): string | null => {
  const rawTitle = String(title || '').trim();
  if (!rawTitle) {
    return translate('sidebar.tab.new_query');
  }
  if (UNTITLED_QUERY_TITLES.has(rawTitle)) {
    return translate('sidebar.tab.new_query');
  }
  if (hasUntitledDatabaseQueryPrefix(rawTitle)) {
    const databaseName = String(database || '').trim();
    if (databaseName) {
      return translate('sidebar.tab.new_query_database', { database: databaseName });
    }
    return translate('sidebar.tab.new_query');
  }
  return null;
};
