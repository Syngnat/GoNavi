import { useCallback, useMemo } from 'react';

import { t } from '../../i18n';
import { useWorkbenchTabs } from '../../hooks/useWorkbenchTabs';
import { useStore } from '../../store';
import type { SavedQuery } from '../../types';
import type { SettingsCenterNavigationTarget } from '../settings/settingsCenterMenuCatalog';
import type { V2CommandSearchItem } from '../sidebarV2Utils';
import {
  EMPTY_COMMAND_SEARCH_DESTINATIONS,
  buildCommandSearchDestinationSections,
  type CommandSearchDestinationSections,
} from './commandSearchDestinations';
import { parseV2CommandSearchQuery } from './sidebarHelpers';

type UseCommandSearchDestinationsArgs = {
  isOpen: boolean;
  /** The palette's raw input, before `@` / `?` prefixes are interpreted. */
  searchValue: string;
  isWebRuntime?: boolean;
  onOpenSettingsNavigation?: (target: SettingsCenterNavigationTarget) => void;
  /** The palette's own result groups, in display order after the destinations. */
  aiItems: V2CommandSearchItem[];
  treeItems: V2CommandSearchItem[];
  actionItems: V2CommandSearchItem[];
  recentItems: V2CommandSearchItem[];
};

/**
 * Adds settings, open tabs and saved queries to the command palette and
 * returns the combined keyboard-navigation order. The order here must match the
 * order the panel renders its sections in.
 */
export const useCommandSearchDestinations = ({
  isOpen,
  searchValue,
  isWebRuntime = false,
  onOpenSettingsNavigation,
  aiItems,
  treeItems,
  actionItems,
  recentItems,
}: UseCommandSearchDestinationsArgs): {
  destinationSections: CommandSearchDestinationSections;
  flatItems: V2CommandSearchItem[];
} => {
  const connections = useStore((state) => state.connections);
  const savedQueries = useStore((state) => state.savedQueries);
  const addTab = useStore((state) => state.addTab);
  const setActiveTab = useStore((state) => state.setActiveTab);
  const tabs = useWorkbenchTabs();

  const openSavedQuery = useCallback((query: SavedQuery) => {
    // Same tab the sidebar tree opens for a saved query, so it reuses that tab if open.
    addTab({
      id: query.id,
      title: String(query.name || '').trim() || t('query_editor.save_modal.unnamed'),
      type: 'query',
      connectionId: query.connectionId,
      dbName: query.dbName,
      query: query.sql,
      savedQueryId: query.id,
    });
  }, [addTab]);

  const query = useMemo(() => parseV2CommandSearchQuery(searchValue), [searchValue]);
  const destinationSections = useMemo(() => {
    if (!isOpen || query.mode !== 'default') {
      return EMPTY_COMMAND_SEARCH_DESTINATIONS;
    }
    return buildCommandSearchDestinationSections({
      normalizedKeyword: query.normalizedKeyword,
      translate: (key) => t(key),
      isWebRuntime,
      connections,
      tabs,
      savedQueries,
      openSettingsNavigation: onOpenSettingsNavigation,
      activateTab: setActiveTab,
      openSavedQuery,
    });
  }, [
    connections,
    isOpen,
    isWebRuntime,
    onOpenSettingsNavigation,
    openSavedQuery,
    query.mode,
    query.normalizedKeyword,
    savedQueries,
    setActiveTab,
    tabs,
  ]);

  const flatItems = useMemo(() => [
    ...aiItems,
    ...treeItems,
    ...destinationSections.tabs,
    ...destinationSections.savedQueries,
    ...destinationSections.settings,
    ...actionItems,
    ...recentItems,
  ], [actionItems, aiItems, destinationSections, recentItems, treeItems]);

  return { destinationSections, flatItems };
};
