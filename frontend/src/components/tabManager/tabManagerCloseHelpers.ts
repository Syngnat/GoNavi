import React from 'react';
import type { TabData } from '../../types';
import { t } from '../../i18n';

export const getTabObjectLabel = (tab: TabData): string => {
  if (tab.tableName) return tab.tableName;
  if (tab.viewName) return tab.viewName;
  if (tab.eventName) return tab.eventName;
  if (tab.routineName) return tab.routineName;
  if (tab.sequenceName) return tab.sequenceName;
  if (tab.packageName) return tab.packageName;
  if (tab.databaseLinkName) return tab.databaseLinkName;
  if (tab.triggerName) return tab.triggerName;
  if (tab.resourcePath) return tab.resourcePath;
  if (tab.filePath) return tab.filePath;
  if (tab.type === 'driver-manager') return t('app.tools.entry.drivers.title');
  if (tab.type === 'settings-center') return t('app.settings.title');
  if (tab.type === 'sql-analysis' || tab.type === 'sql-audit' || tab.type === 'dml-snapshot' || tab.type === 'user-management') return tab.title;
  if (tab.type === 'message-queue') return tab.messageQueueTarget || tab.dbName || '';
  if (tab.type.startsWith('redis')) return `db${tab.redisDB ?? 0}`;
  return '';
};

export const getCloseOtherTabIds = (tabs: TabData[], id: string): string[] =>
  tabs.filter((tab) => tab.id !== id).map((tab) => tab.id);

export const getCloseTabsToLeftIds = (tabs: TabData[], id: string): string[] => {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index <= 0) return [];
  return tabs.slice(0, index).map((tab) => tab.id);
};

export const getCloseTabsToRightIds = (tabs: TabData[], id: string): string[] => {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0 || index >= tabs.length - 1) return [];
  return tabs.slice(index + 1).map((tab) => tab.id);
};

/** Close only the target set confirmed by the user, even if tabs change later. */
export const closeConfirmedWorkbenchTabs = (
  targetIds: readonly string[],
  closeTab: (id: string) => void,
): void => {
  Array.from(new Set(targetIds.map((id) => String(id || '').trim()).filter(Boolean)))
    .forEach((id) => closeTab(id));
};

export const stopTabHoverDragPropagation = (event: React.SyntheticEvent<HTMLElement>) => {
  event.stopPropagation();
};
