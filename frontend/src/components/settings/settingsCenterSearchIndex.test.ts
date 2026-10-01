import { describe, expect, it } from 'vitest';

import { t } from '../../i18n';
import {
  findSettingsCenterNavigationTarget,
  SETTINGS_CENTER_MENU_CATALOG,
} from './settingsCenterMenuCatalog';
import { SETTINGS_CENTER_SEARCH_ENTRIES } from './settingsCenterSearchIndex';
import {
  resolveSettingsCenterSearchEntries,
  type SettingsCenterSearchEntry,
} from './settingsCenterSearchEntries';

const staticEntries = SETTINGS_CENTER_SEARCH_ENTRIES.filter(
  (entry): entry is SettingsCenterSearchEntry => 'labelKey' in entry,
);

const isResolved = (key: string): boolean => {
  const text = t(key);
  return text.length > 0 && text !== key;
};

describe('settings center search index', () => {
  it('only references i18n keys that exist', () => {
    const missing = staticEntries.flatMap((entry) => [
      entry.labelKey,
      ...(entry.descriptionKey ? [entry.descriptionKey] : []),
      ...(entry.aliasKeys ?? []),
    ]).filter((key) => !isResolved(key));

    expect(missing).toEqual([]);
  });

  it('never uses a label with placeholders, which the page cannot render verbatim', () => {
    const interpolated = staticEntries
      .map((entry) => entry.labelKey)
      .filter((key) => t(key).includes('{{'));

    expect(interpolated).toEqual([]);
  });

  it('attaches every entry to a page that is a menu node', () => {
    const unknownPages = SETTINGS_CENTER_SEARCH_ENTRIES
      .filter((entry) => !findSettingsCenterNavigationTarget(entry.group, entry.item))
      .map((entry) => `${entry.group}/${entry.item}`);

    expect(unknownPages).toEqual([]);
  });

  it('does not declare the same label twice on one page', () => {
    const seen = new Set<string>();
    const duplicates = staticEntries.flatMap((entry) => {
      const id = `${entry.group}/${entry.item}/${entry.labelKey}`;
      if (seen.has(id)) {
        return [id];
      }
      seen.add(id);
      return [];
    });

    expect(duplicates).toEqual([]);
  });

  it('resolves dynamic entries, such as one row per shortcut', () => {
    const resolved = resolveSettingsCenterSearchEntries(SETTINGS_CENTER_SEARCH_ENTRIES, t);
    const shortcuts = resolved.filter((entry) => entry.item === 'shortcut-settings');

    expect(shortcuts.length).toBeGreaterThan(10);
    expect(shortcuts.every((entry) => entry.label.trim().length > 0)).toBe(true);
    expect(resolved.some((entry) => entry.item === 'ai-tools' && entry.label === 'execute_sql')).toBe(true);
  });
});

describe('settings center menu catalog', () => {
  it('uses i18n keys that exist', () => {
    const missing = SETTINGS_CENTER_MENU_CATALOG
      .flatMap((node) => [node.titleKey, node.descriptionKey])
      .filter((key) => !isResolved(key));

    expect(missing).toEqual([]);
  });

  it('has unique keys per group', () => {
    const ids = SETTINGS_CENTER_MENU_CATALOG.map((node) => `${node.group}/${node.item ?? ''}`);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
