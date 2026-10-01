import type { SettingsCenterSearchEntrySource } from './settingsCenterSearchEntries';
import { AI_SEARCH_ENTRIES } from './settingsSearchEntries/ai';
import { CONTENT_SEARCH_ENTRIES } from './settingsSearchEntries/content';
import { PREFERENCES_SEARCH_ENTRIES } from './settingsSearchEntries/preferences';
import { SERVICES_SEARCH_ENTRIES } from './settingsSearchEntries/services';
import { TOOLS_SEARCH_ENTRIES } from './settingsSearchEntries/tools';

/**
 * Every setting inside a settings-center page that search can find. To make a
 * new setting searchable, add its label key to the matching file under
 * `settingsSearchEntries/` (`content.ts` holds page copy such as hints and
 * descriptions); `settingsCenterSearchIndex.test.ts` checks that
 * each key exists and that each page is a real menu node.
 */
export const SETTINGS_CENTER_SEARCH_ENTRIES: ReadonlyArray<SettingsCenterSearchEntrySource> = [
  ...PREFERENCES_SEARCH_ENTRIES,
  ...SERVICES_SEARCH_ENTRIES,
  ...AI_SEARCH_ENTRIES,
  ...TOOLS_SEARCH_ENTRIES,
  ...CONTENT_SEARCH_ENTRIES,
];
