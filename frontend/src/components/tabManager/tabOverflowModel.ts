import type { SavedConnection, TabData } from '../../types';
import {
  buildTabDisplayModel,
  getConnectionGroupName,
  getTabDisplayKindLabel,
  type TabDisplayElementKey,
  type TabDisplayModel,
  type TabDisplaySettings,
  type TabDisplayTranslate,
} from '../../utils/tabDisplay';

export type TabOverflowRow = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  searchText: string;
  active: boolean;
};

const displayPartValue = (model: TabDisplayModel, key: TabDisplayElementKey): string => {
  const part = [...model.primaryParts, ...model.secondaryParts].find((item) => item.key === key);
  return String(part?.value || '').trim();
};

export const resolveTabOverflowTitle = (model: TabDisplayModel, fallback = ''): string => (
  displayPartValue(model, 'object') || model.primaryText.trim() || fallback
);

export const resolveTabOverflowSubtitle = (
  model: TabDisplayModel,
  extras?: { connectionName?: string; database?: string },
): string => (
  [
    displayPartValue(model, 'connection') || String(extras?.connectionName || '').trim(),
    displayPartValue(model, 'database') || String(extras?.database || '').trim(),
  ].filter(Boolean).join(' · ')
);

export const buildTabOverflowRows = (
  tabs: TabData[],
  options: {
    connections: SavedConnection[];
    tabDisplay?: Partial<TabDisplaySettings> | null;
    connectionGroupNameById: Map<string, string>;
    activeTabId?: string | null;
    translate: TabDisplayTranslate;
  },
): TabOverflowRow[] => {
  const connectionById = new Map(options.connections.map((connection) => [connection.id, connection]));
  return tabs.map((tab) => {
    const model = buildTabDisplayModel(
      tab,
      connectionById.get(tab.connectionId),
      options.tabDisplay,
      options.translate,
      getConnectionGroupName(options.connectionGroupNameById, tab.connectionId),
    );
    const kind = getTabDisplayKindLabel(tab);
    const title = resolveTabOverflowTitle(model, String(tab.title || '').trim());
    const subtitle = resolveTabOverflowSubtitle(model, {
      connectionName: connectionById.get(tab.connectionId)?.name,
      database: tab.dbName,
    });
    return {
      id: tab.id,
      kind,
      title,
      subtitle,
      searchText: [kind, title, subtitle, model.fullTitle].join(' ').toLowerCase(),
      active: tab.id === options.activeTabId,
    };
  });
};

export const filterTabOverflowRows = (rows: TabOverflowRow[], query: string): TabOverflowRow[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.searchText.includes(needle));
};

export const closeWorkbenchTabOverflowPopup = (): void => {
  window.setTimeout(() => {
    document.querySelector<HTMLButtonElement>('.gn-v2-main-tabs .ant-tabs-nav-more[aria-expanded="true"]')?.click();
  }, 0);
};
