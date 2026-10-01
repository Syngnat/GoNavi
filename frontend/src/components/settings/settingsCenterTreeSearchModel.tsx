import React from 'react';

import { t as translateCurrentLanguage } from '../../i18n';
import type { SettingsCenterTreeGroup, SettingsCenterTreeItem } from './SettingsCenterTreeNav';
import { requestSettingsCenterEntryFocus } from './settingsCenterEntryFocus';
import {
  resolveSettingsCenterSearchEntries,
  type ResolvedSettingsCenterSearchEntry,
  type SettingsCenterSearchEntrySource,
} from './settingsCenterSearchEntries';

export type SettingsCenterTreeSearchOptions = {
  /** Settings inside pages to match in addition to the menu titles. */
  entries?: ReadonlyArray<SettingsCenterSearchEntrySource>;
  translate?: (key: string) => string;
};

export const normalizeSettingsCenterSearchQuery = (query: string): string => (
  query.trim().toLocaleLowerCase()
);

const includesQuery = (text: string, normalizedQuery: string): boolean => (
  text.toLocaleLowerCase().includes(normalizedQuery)
);

const nodeMatches = (
  node: { title: string; description: string },
  normalizedQuery: string,
): boolean => (
  includesQuery(node.title, normalizedQuery) || includesQuery(node.description, normalizedQuery)
);

/** Entries whose label, description or aliases contain the query, keyed by `group/item`. */
const matchEntriesByItem = (
  entries: ReadonlyArray<SettingsCenterSearchEntrySource>,
  normalizedQuery: string,
  translate: (key: string) => string,
): Map<string, ResolvedSettingsCenterSearchEntry[]> => {
  const matched = new Map<string, ResolvedSettingsCenterSearchEntry[]>();
  resolveSettingsCenterSearchEntries(entries, translate).forEach((entry) => {
    if (!entry.searchTexts.some((text) => text && includesQuery(text, normalizedQuery))) {
      return;
    }
    const mapKey = `${entry.group}/${entry.item}`;
    matched.set(mapKey, [...(matched.get(mapKey) ?? []), entry]);
  });
  return matched;
};

const buildEntryNodes = (
  groupKey: string,
  item: SettingsCenterTreeItem,
  matchedByItem: ReadonlyMap<string, ReadonlyArray<ResolvedSettingsCenterSearchEntry>>,
): SettingsCenterTreeItem[] => (
  (matchedByItem.get(`${groupKey}/${item.key}`) ?? []).map(({ id, label }) => ({
    key: `entry:${id}`,
    kind: 'entry' as const,
    title: label,
    // The owning menu, so a hit reads as "设置项 - 所在菜单" in the tooltip.
    description: item.title,
    onClick: () => {
      item.onClick();
      requestSettingsCenterEntryFocus({ text: label });
    },
  }))
);

/** `item` with its whole subtree, plus the matching settings of every page in it. */
const attachEntryNodes = (
  groupKey: string,
  item: SettingsCenterTreeItem,
  matchedByItem: ReadonlyMap<string, ReadonlyArray<ResolvedSettingsCenterSearchEntry>>,
): SettingsCenterTreeItem => {
  const children = item.children?.map((child) => attachEntryNodes(groupKey, child, matchedByItem));
  const entryNodes = buildEntryNodes(groupKey, item, matchedByItem);
  const childrenUnchanged = !children || children.every((child, index) => child === item.children?.[index]);
  if (entryNodes.length === 0 && childrenUnchanged) {
    return item;
  }
  return { ...item, children: [...(children ?? []), ...entryNodes] };
};

const filterSettingsCenterTreeItems = (
  groupKey: string,
  items: ReadonlyArray<SettingsCenterTreeItem>,
  normalizedQuery: string,
  matchedByItem: ReadonlyMap<string, ReadonlyArray<ResolvedSettingsCenterSearchEntry>>,
): SettingsCenterTreeItem[] => items.flatMap((item) => {
  // A matching node keeps its whole subtree so the user still sees its context.
  if (nodeMatches(item, normalizedQuery)) {
    return [attachEntryNodes(groupKey, item, matchedByItem)];
  }
  const children = item.children
    ? filterSettingsCenterTreeItems(groupKey, item.children, normalizedQuery, matchedByItem)
    : [];
  const merged = [...children, ...buildEntryNodes(groupKey, item, matchedByItem)];
  return merged.length > 0 ? [{ ...item, children: merged }] : [];
});

/**
 * Keep groups / items whose title or description contains the query, plus the
 * ancestors that lead to them. Settings inside pages (`options.entries`) that
 * match are added as leaf nodes under the page that owns them. Keys and
 * `onClick` handlers are preserved, so selection and activation keep working
 * on the filtered tree.
 */
export const filterSettingsCenterTreeGroups = (
  groups: ReadonlyArray<SettingsCenterTreeGroup>,
  query: string,
  options: SettingsCenterTreeSearchOptions = {},
): ReadonlyArray<SettingsCenterTreeGroup> => {
  const normalizedQuery = normalizeSettingsCenterSearchQuery(query);
  if (!normalizedQuery) {
    return groups;
  }
  const matchedByItem = matchEntriesByItem(
    options.entries ?? [],
    normalizedQuery,
    options.translate ?? ((key) => translateCurrentLanguage(key)),
  );
  return groups.flatMap((group) => {
    if (nodeMatches(group, normalizedQuery)) {
      return [{
        ...group,
        items: group.items.map((item) => attachEntryNodes(group.key, item, matchedByItem)),
      }];
    }
    const items = filterSettingsCenterTreeItems(group.key, group.items, normalizedQuery, matchedByItem);
    return items.length > 0 ? [{ ...group, items }] : [];
  });
};

/** Characters kept before a hit deep inside a long label, so the ellipsis never hides it. */
const SNIPPET_LEAD_LENGTH = 8;

/**
 * Wrap the first occurrence of the query in `<mark>` so hits are visible. A hit
 * far into a long label (page copy such as hints) is shown with only a short
 * lead-in, since the tree row truncates the end of the text.
 */
export const renderSettingsCenterTreeLabel = (
  title: string,
  normalizedQuery: string,
): React.ReactNode => {
  if (!normalizedQuery) {
    return title;
  }
  const start = title.toLocaleLowerCase().indexOf(normalizedQuery);
  if (start < 0) {
    return title;
  }
  const end = start + normalizedQuery.length;
  const leadStart = start > SNIPPET_LEAD_LENGTH ? start - SNIPPET_LEAD_LENGTH : 0;
  return (
    <>
      {leadStart > 0 ? '…' : ''}
      {title.slice(leadStart, start)}
      <mark className="gonavi-settings-center-tree-highlight">{title.slice(start, end)}</mark>
      {title.slice(end)}
    </>
  );
};
