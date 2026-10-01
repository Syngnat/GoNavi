import React from 'react';
import { CodeOutlined, FileTextOutlined, SettingOutlined } from '@ant-design/icons';

import type { SavedConnection, SavedQuery, TabData } from '../../types';
import {
  SETTINGS_CENTER_MENU_CATALOG,
  findSettingsCenterNavigationTarget,
  type SettingsCenterNavigationTarget,
} from '../settings/settingsCenterMenuCatalog';
import { requestSettingsCenterEntryFocus } from '../settings/settingsCenterEntryFocus';
import { SETTINGS_CENTER_SEARCH_ENTRIES } from '../settings/settingsCenterSearchIndex';
import { resolveSettingsCenterSearchEntries } from '../settings/settingsCenterSearchEntries';
import type { V2CommandSearchItem } from '../sidebarV2Utils';
import { matchesSidebarSearchText, normalizeSidebarSearchText } from './sidebarHelpers';

/** Result caps keep a broad keyword from flooding the palette. */
export const COMMAND_SEARCH_MAX_SETTING_RESULTS = 30;
export const COMMAND_SEARCH_MAX_TAB_RESULTS = 8;
export const COMMAND_SEARCH_MAX_SAVED_QUERY_RESULTS = 20;
const SQL_PREVIEW_LENGTH = 60;

export type CommandSearchDestinationSections = {
  /** Settings pages and the individual settings inside them. */
  settings: V2CommandSearchItem[];
  /** Tabs that are already open. */
  tabs: V2CommandSearchItem[];
  /** Saved queries, matched by name, SQL text, database and connection. */
  savedQueries: V2CommandSearchItem[];
};

export const EMPTY_COMMAND_SEARCH_DESTINATIONS: CommandSearchDestinationSections = {
  settings: [],
  tabs: [],
  savedQueries: [],
};

export type CommandSearchDestinationsArgs = {
  /** Normalized keyword of the default (non `@`, non `?`) search mode; empty shows nothing. */
  normalizedKeyword: string;
  translate: (key: string) => string;
  /** Web-only settings pages (browser auth) are hidden in the desktop app. */
  isWebRuntime: boolean;
  connections: ReadonlyArray<Pick<SavedConnection, 'id' | 'name'>>;
  tabs: ReadonlyArray<TabData>;
  savedQueries: ReadonlyArray<SavedQuery>;
  /** Missing in embedded hosts that cannot open the settings center. */
  openSettingsNavigation?: (target: SettingsCenterNavigationTarget) => void;
  activateTab: (tabId: string) => void;
  openSavedQuery: (query: SavedQuery) => void;
};

/** Best hits first: title starts with the keyword, then title contains it, then anything else. */
const relevanceOf = (title: string, normalizedKeyword: string): number => {
  const normalizedTitle = normalizeSidebarSearchText(title);
  if (normalizedTitle.startsWith(normalizedKeyword)) {
    return 0;
  }
  return normalizedTitle.includes(normalizedKeyword) ? 1 : 2;
};

const sortByRelevance = <T extends { title: string }>(items: T[], normalizedKeyword: string): T[] => (
  items
    .map((item, index) => ({ item, index, rank: relevanceOf(item.title, normalizedKeyword) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item)
);

const buildSettingsItems = (args: CommandSearchDestinationsArgs): V2CommandSearchItem[] => {
  const { normalizedKeyword, translate, isWebRuntime, openSettingsNavigation } = args;
  if (!openSettingsNavigation) {
    return [];
  }
  const sectionTitle = translate('sidebar.command_search.section.settings');
  const groupTitleOf = (group: string): string => {
    const groupNode = SETTINGS_CENTER_MENU_CATALOG.find((node) => node.group === group && !node.item);
    return groupNode ? translate(groupNode.titleKey) : '';
  };
  const availablePages = SETTINGS_CENTER_MENU_CATALOG.filter((node) => !node.webOnly || isWebRuntime);
  const isAvailable = (group: string, item: string): boolean => availablePages.some(
    (node) => node.group === group && node.item === item,
  );

  const menuItems: V2CommandSearchItem[] = availablePages.flatMap((node) => {
    const title = translate(node.titleKey);
    if (!matchesSidebarSearchText(`${title} ${translate(node.descriptionKey)}`, normalizedKeyword)) {
      return [];
    }
    return [{
      key: `settings-menu:${node.group}/${node.item ?? ''}`,
      kind: 'action' as const,
      title,
      meta: [sectionTitle, groupTitleOf(node.group)].filter(Boolean).join(' › '),
      icon: <SettingOutlined />,
      onRun: () => openSettingsNavigation(node.target),
    }];
  });

  const entryItems: V2CommandSearchItem[] = resolveSettingsCenterSearchEntries(
    SETTINGS_CENTER_SEARCH_ENTRIES,
    translate,
  ).flatMap((entry) => {
    const target = findSettingsCenterNavigationTarget(entry.group, entry.item);
    if (!target || !isAvailable(entry.group, entry.item)) {
      return [];
    }
    if (!entry.searchTexts.some((text) => text && matchesSidebarSearchText(text, normalizedKeyword))) {
      return [];
    }
    const page = availablePages.find((node) => node.group === entry.group && node.item === entry.item);
    return [{
      key: `settings-entry:${entry.id}`,
      kind: 'action' as const,
      title: entry.label,
      meta: [sectionTitle, groupTitleOf(entry.group), page ? translate(page.titleKey) : '']
        .filter(Boolean)
        .join(' › '),
      icon: <SettingOutlined />,
      onRun: () => {
        openSettingsNavigation(target);
        requestSettingsCenterEntryFocus({ text: entry.label });
      },
    }];
  });

  return sortByRelevance([...menuItems, ...entryItems], normalizedKeyword)
    .slice(0, COMMAND_SEARCH_MAX_SETTING_RESULTS);
};

const describeContext = (
  connectionName: string | undefined,
  dbName: string | undefined,
): string => [connectionName, dbName].filter(Boolean).join(' · ');

const buildTabItems = (args: CommandSearchDestinationsArgs): V2CommandSearchItem[] => {
  const { normalizedKeyword, connections, tabs, activateTab } = args;
  const connectionNameById = new Map(connections.map((connection) => [connection.id, connection.name]));
  return tabs
    .flatMap((tab) => {
      const context = describeContext(connectionNameById.get(tab.connectionId), tab.dbName);
      const haystack = [tab.title, context, tab.tableName].filter(Boolean).join(' ');
      if (!tab.title || !matchesSidebarSearchText(haystack, normalizedKeyword)) {
        return [];
      }
      return [{
        key: `tab:${tab.id}`,
        kind: 'action' as const,
        title: tab.title,
        meta: context,
        icon: <FileTextOutlined />,
        onRun: () => activateTab(tab.id),
      }];
    })
    .slice(0, COMMAND_SEARCH_MAX_TAB_RESULTS);
};

const previewSql = (sql: string): string => {
  const flattened = String(sql || '').replace(/\s+/g, ' ').trim();
  return flattened.length > SQL_PREVIEW_LENGTH ? `${flattened.slice(0, SQL_PREVIEW_LENGTH)}…` : flattened;
};

const buildSavedQueryItems = (args: CommandSearchDestinationsArgs): V2CommandSearchItem[] => {
  const { normalizedKeyword, connections, savedQueries, openSavedQuery, translate } = args;
  const connectionNameById = new Map(connections.map((connection) => [connection.id, connection.name]));
  return savedQueries
    .flatMap((query) => {
      const title = String(query.name || '').trim() || translate('query_editor.save_modal.unnamed');
      const context = describeContext(connectionNameById.get(query.connectionId), query.dbName);
      const haystack = [title, query.sql, context].filter(Boolean).join(' ');
      if (!matchesSidebarSearchText(haystack, normalizedKeyword)) {
        return [];
      }
      return [{
        key: `saved-query:${query.id}`,
        kind: 'action' as const,
        title,
        meta: [context, previewSql(query.sql)].filter(Boolean).join(' — '),
        icon: <CodeOutlined />,
        onRun: () => openSavedQuery(query),
      }];
    })
    .slice(0, COMMAND_SEARCH_MAX_SAVED_QUERY_RESULTS);
};

/**
 * Everything the palette can jump to beyond the sidebar tree: settings pages
 * and the settings inside them, open tabs and saved queries. Nothing is shown
 * for an empty keyword so the default view stays the short curated list.
 */
export const buildCommandSearchDestinationSections = (
  args: CommandSearchDestinationsArgs,
): CommandSearchDestinationSections => {
  if (!args.normalizedKeyword) {
    return EMPTY_COMMAND_SEARCH_DESTINATIONS;
  }
  return {
    settings: buildSettingsItems(args),
    tabs: buildTabItems(args),
    savedQueries: buildSavedQueryItems(args),
  };
};
