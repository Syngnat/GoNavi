/**
 * A single setting that lives inside a settings-center page. The tree search
 * and the command palette match these in addition to the menu titles, so users
 * can find "代理地址" without knowing it sits under "全局代理".
 *
 * `labelKey` must be the i18n key of the text the page actually renders for
 * that setting: it is what search matches against and what the page is scanned
 * for when the user opens the hit (see settingsCenterEntryFocus).
 */
export type SettingsCenterSearchEntry = {
  /** Tree group the page belongs to (`preferences`, `services`, `config`, ...). */
  group: string;
  /** Tree item that opens the page; may be a child item such as `theme-appearance`. */
  item: string;
  labelKey: string;
  /** Extra text matched by search only, e.g. the hint shown below the setting. */
  descriptionKey?: string;
  /** Extra i18n keys (synonyms, option labels) matched by search only. */
  aliasKeys?: ReadonlyArray<string>;
};

/** Settings whose text is produced by code rather than fixed keys (e.g. one row per shortcut). */
export type SettingsCenterDynamicSearchEntries = {
  group: string;
  item: string;
  resolve: () => ReadonlyArray<{ id: string; label: string; description?: string }>;
};

export type SettingsCenterSearchEntrySource =
  | SettingsCenterSearchEntry
  | SettingsCenterDynamicSearchEntries;

/** A setting with its display text resolved for the current language. */
export type ResolvedSettingsCenterSearchEntry = {
  id: string;
  group: string;
  item: string;
  /** Text the page renders for the setting; also the text scanned for on arrival. */
  label: string;
  /** Everything search may match: label, description and aliases. */
  searchTexts: ReadonlyArray<string>;
};

/** `labelKey` alone, or `[labelKey, descriptionKey]`. */
export type SettingsCenterSearchEntrySpec = string | readonly [labelKey: string, descriptionKey: string];

/** Declares the searchable settings of one page in a compact form. */
export const defineSettingsCenterPageEntries = (
  group: string,
  item: string,
  specs: ReadonlyArray<SettingsCenterSearchEntrySpec>,
): SettingsCenterSearchEntry[] => specs.map((spec) => (
  typeof spec === 'string'
    ? { group, item, labelKey: spec }
    : { group, item, labelKey: spec[0], descriptionKey: spec[1] }
));

const isDynamicSource = (
  source: SettingsCenterSearchEntrySource,
): source is SettingsCenterDynamicSearchEntries => 'resolve' in source;

/**
 * Turns the declared entries into display text for the current language.
 * Entries whose key does not resolve (the translator echoes the key back) are
 * dropped rather than shown as a raw key.
 */
export const resolveSettingsCenterSearchEntries = (
  sources: ReadonlyArray<SettingsCenterSearchEntrySource>,
  translate: (key: string) => string,
): ResolvedSettingsCenterSearchEntry[] => sources.flatMap((source) => {
  if (isDynamicSource(source)) {
    return source.resolve()
      .filter((entry) => entry.label.trim().length > 0)
      .map((entry) => ({
        id: `${source.item}:${entry.id}`,
        group: source.group,
        item: source.item,
        label: entry.label,
        searchTexts: [entry.label, entry.description ?? ''],
      }));
  }
  const label = translate(source.labelKey);
  if (!label || label === source.labelKey) {
    return [];
  }
  return [{
    id: `${source.item}:${source.labelKey}`,
    group: source.group,
    item: source.item,
    label,
    searchTexts: [
      label,
      source.descriptionKey ? translate(source.descriptionKey) : '',
      ...(source.aliasKeys ?? []).map((key) => translate(key)),
    ],
  }];
});
