import React from 'react';
import { RightOutlined } from '@ant-design/icons';
import {
  sanitizeTabEnvironmentAccentThickness,
  type RecentConnectionTarget,
  type RecentSQLFile,
} from '../../store';
import type { TabData, SavedConnection, ExternalSQLDirectory } from '../../types';
import { t } from '../../i18n';
import {
  resolveExternalSQLFileBinding,
  normalizeExternalSQLPath,
} from '../../utils/externalSqlTree';
import { getDbIcon } from '../DatabaseIcons';
import {
  resolveConnectionIconType,
  resolveConnectionAccentColor,
} from '../../utils/connectionVisual';
import { dispatchSidebarLocateConnection } from '../../utils/sidebarLocate';

export const isBackgroundTaskWorkbenchTab = (tab: Pick<TabData, 'type'>): boolean => (
  tab.type === 'table-export' || tab.type === 'data-import' || tab.type === 'data-sync'
);

/** Settings center keeps its UI/state in the main App bridge; do not detach it. */
export const isMainWindowBoundWorkbenchTab = (tab: Pick<TabData, 'type'>): boolean => (
  tab.type === 'settings-center' || isBackgroundTaskWorkbenchTab(tab)
);

export const resolveQueryTabRenameMenuState = (
  tab: Pick<TabData, 'type' | 'filePath'>,
): { visible: boolean; disabled: boolean } => ({
  visible: tab.type === 'query',
  disabled: Boolean(tab.filePath),
});

export const isRunningDataImportWorkbenchTab = (
  tab: Pick<TabData, 'type' | 'dataImportRunning'>,
): boolean => tab.type === 'data-import' && tab.dataImportRunning === true;

export const TAB_WORKBENCH_CLASS_NAME = 'tab-workbench';
export const TAB_ENVIRONMENT_ACCENT_CSS_HEIGHT = 'var(--gn-tab-environment-accent-thickness, 2px)';

export const buildTabWorkbenchStyle = (
  v2TabWidth: number,
  tabEnvironmentAccentThickness: unknown,
): React.CSSProperties => ({
  ...({ '--gn-v2-tab-width': `${v2TabWidth}px` }),
  '--gn-tab-environment-accent-thickness': `${sanitizeTabEnvironmentAccentThickness(tabEnvironmentAccentThickness)}px`,
} as React.CSSProperties);

export const V2_WORKBENCH_TAB_MIN_WIDTH = 112;
export const V2_WORKBENCH_TAB_MAX_WIDTH = 260;
const V2_WORKBENCH_TAB_WIDTH_GUARD = 1;

export const resolveV2WorkbenchTabWidth = (availableWidth: number, tabCount: number): number => {
  const normalizedTabCount = Number.isFinite(tabCount) ? Math.floor(tabCount) : 0;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0 || normalizedTabCount <= 0) {
    return V2_WORKBENCH_TAB_MAX_WIDTH;
  }

  const equalShare = Math.floor(
    (availableWidth - V2_WORKBENCH_TAB_WIDTH_GUARD) / normalizedTabCount,
  );
  return Math.min(
    V2_WORKBENCH_TAB_MAX_WIDTH,
    Math.max(V2_WORKBENCH_TAB_MIN_WIDTH, equalShare),
  );
};

export type RecentConnectionShortcut = {
  connection: SavedConnection;
  dbName?: string;
};

export const dispatchRecentConnectionShortcut = (
  shortcut: Pick<RecentConnectionShortcut, 'connection' | 'dbName'>,
  eventTarget?: Pick<Window, 'dispatchEvent'> | null,
): boolean => dispatchSidebarLocateConnection({
  connectionId: shortcut.connection.id,
  ...(shortcut.dbName ? { dbName: shortcut.dbName } : {}),
}, eventTarget);

export type PinnedTableShortcut = {
  connection: SavedConnection;
  dbName: string;
  schemaName?: string;
  tableName: string;
};

type LinkedExternalSQLDirectoryShortcut = {
  connection: SavedConnection;
  dbName?: string;
  directory: ExternalSQLDirectory;
};

export const RECENT_WORKBENCH_ITEM_LIMIT = 6;

export const buildRecentConnectionShortcuts = (
  connections: SavedConnection[],
  recentTargets: RecentConnectionTarget[],
): RecentConnectionShortcut[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  const seenConnectionIds = new Set<string>();
  const result: RecentConnectionShortcut[] = [];

  const append = (connection: SavedConnection, preferredDbName?: string) => {
    const dbName = String(preferredDbName || connection.config.database || '').trim() || undefined;
    const key = `${connection.id}::${dbName || ''}`;
    if (seen.has(key) || result.length >= RECENT_WORKBENCH_ITEM_LIMIT) return;
    seen.add(key);
    seenConnectionIds.add(connection.id);
    result.push({ connection, ...(dbName ? { dbName } : {}) });
  };

  recentTargets.forEach((target) => {
    const connection = connectionById.get(target.connectionId);
    if (connection) {
      append(connection, target.dbName);
    }
  });
  connections.forEach((connection) => {
    if (!seenConnectionIds.has(connection.id)) {
      append(connection);
    }
  });
  return result;
};

export const RecentConnectionShortcutItem: React.FC<{
  shortcut: RecentConnectionShortcut;
  onOpen: (shortcut: RecentConnectionShortcut) => void;
}> = ({ shortcut, onOpen }) => (
  <button
    type="button"
    className="gn-v2-empty-recent-item"
    onClick={() => onOpen(shortcut)}
  >
    {getDbIcon(
      resolveConnectionIconType(shortcut.connection),
      resolveConnectionAccentColor(shortcut.connection),
      22,
    )}
    <span>
      <strong title={shortcut.connection.name}>{shortcut.connection.name}</strong>
      <small>{shortcut.dbName || t('tab_manager.empty.recent.connection.default_database')}</small>
    </span>
    <RightOutlined className="gn-v2-empty-recent-arrow" />
  </button>
);

export const buildPinnedTableShortcuts = (
  connections: SavedConnection[],
  pinnedTableKeys: string[],
): PinnedTableShortcut[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  const result: PinnedTableShortcut[] = [];

  for (const rawKey of pinnedTableKeys) {
    if (result.length >= RECENT_WORKBENCH_ITEM_LIMIT) break;
    try {
      const parsed = JSON.parse(rawKey);
      if (!Array.isArray(parsed) || parsed.length !== 4) continue;
      const [rawConnectionId, rawDbName, rawSchemaName, rawTableName] = parsed;
      const connectionId = String(rawConnectionId || '').trim();
      const dbName = String(rawDbName || '').trim();
      const schemaName = String(rawSchemaName || '').trim();
      const tableName = String(rawTableName || '').trim();
      const connection = connectionById.get(connectionId);
      const key = `${connectionId}::${dbName}::${schemaName}::${tableName}`;
      if (!connection || !dbName || !tableName || seen.has(key)) continue;
      seen.add(key);
      result.push({
        connection,
        dbName,
        ...(schemaName ? { schemaName } : {}),
        tableName,
      });
    } catch {
      // 旧版本或损坏的本地偏好不应阻塞工作台首页。
    }
  }
  return result;
};

export const buildRecentSQLFileShortcuts = (
  connections: SavedConnection[],
  directories: ExternalSQLDirectory[],
  recentFiles: RecentSQLFile[],
): RecentSQLFile[] => {
  const connectionIds = new Set(connections.map((connection) => connection.id));
  const seenFilePaths = new Set<string>();
  return [...recentFiles]
    .map((file) => {
      const binding = resolveExternalSQLFileBinding(directories, file.filePath, {
        connectionId: file.connectionId,
        dbName: file.dbName,
      });
      return binding
        ? { ...file, connectionId: binding.connectionId, dbName: binding.dbName }
        : file;
    })
    .filter((file) => connectionIds.has(file.connectionId))
    .sort((left, right) => right.openedAt - left.openedAt)
    .filter((file) => {
      const normalizedPath = normalizeExternalSQLPath(file.filePath);
      const filePathKey = /^[a-z]:\//iu.test(normalizedPath) || normalizedPath.startsWith('//')
        ? normalizedPath.toLowerCase()
        : normalizedPath;
      if (!filePathKey || seenFilePaths.has(filePathKey)) return false;
      seenFilePaths.add(filePathKey);
      return true;
    })
    .slice(0, RECENT_WORKBENCH_ITEM_LIMIT);
};

export const buildLinkedExternalSQLDirectoryShortcuts = (
  connections: SavedConnection[],
  directories: ExternalSQLDirectory[],
): LinkedExternalSQLDirectoryShortcut[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  return [...directories]
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .flatMap((directory) => {
      const connectionId = String(directory.connectionId || '').trim();
      const connection = connectionById.get(connectionId);
      if (!connection) return [];
      const dbName = String(directory.dbName || connection.config.database || '').trim() || undefined;
      return [{ connection, ...(dbName ? { dbName } : {}), directory }];
    })
    .slice(0, RECENT_WORKBENCH_ITEM_LIMIT);
};
