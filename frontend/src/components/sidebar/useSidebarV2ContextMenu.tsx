import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  V2DatabaseContextMenuView,
  V2ConnectionGroupContextMenuView,
  V2ConnectionContextMenuView,
  V2SchemaContextMenuView,
  V2TableContextMenuView,
  V2TableGroupContextMenuView,
  type V2DatabaseContextMenuActionKey,
  type V2ConnectionGroupContextMenuActionKey,
  type V2ConnectionContextMenuActionKey,
  type V2SchemaContextMenuActionKey,
  type V2TableContextMenuActionKey,
  type V2TableContextMenuStats,
  type V2TableGroupContextMenuActionKey,
} from '../V2TableContextMenu';
import type { SavedConnection } from '../../types';
import { t } from '../../i18n';
import { DBQuery } from '../../../wailsjs/go/app/App';
import { getCaseInsensitiveRawValue, getCaseInsensitiveValue, getMetadataDialect, splitQualifiedName, buildSidebarTableStatusSQL, escapeSQLLiteral, shouldHideSchemaPrefix } from './sidebarMetadataLoaders';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { resolveConnectionHostSummary } from '../../utils/tabDisplay';
import { resolveConnectionIconType } from '../../utils/connectionVisual';
import { formatSidebarRowCount } from './sidebarHelpers';
import { isSidebarTablePinned, type SidebarTreeNode as TreeNode, type V2RailConnectionGroup } from '../sidebarV2Utils';
import { getTableDataDangerActionMeta, supportsTableTruncateAction } from '../tableDataDangerActions';
import {
  SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT,
  SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH,
  resolveSidebarContextMenuPosition,
} from '../sidebarCoreUtils';
import { isShortcutMatch, type ShortcutPlatform } from '../../utils/shortcuts';

export type SidebarContextMenuState = {
  x: number;
  y: number;
  sourceX?: number;
  sourceY?: number;
  items: any;
  kind?: 'v2-table' | 'v2-database' | 'v2-schema' | 'v2-table-group' | 'v2-connection' | 'v2-connection-group';
  node?: any;
  rootClassName?: string;
  overlayStyle?: React.CSSProperties;
  maxHeight?: number;
};

type SidebarV2ContextMenuOptions = {
  connections: SavedConnection[];
  connectionTags: Array<{ id: string; name: string; connectionIds: string[] }>;
  activeShortcutPlatform: ShortcutPlatform;
  flattenConnectionNodes: (nodes: TreeNode[]) => TreeNode[];
  v2TreeMetrics: {
    databaseTableCounts: Map<React.Key, number>;
    objectGroupCounts: Map<React.Key, number>;
  };
  tableSortPreference: Record<string, any>;
  pinnedSidebarTables: any[];
  getConnectionNodeForAction: (conn: SavedConnection) => TreeNode;
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  extractObjectName: (fullName: string) => string;
  isPostgresSchemaDialect: (dialect: string) => boolean;
  loadTables: (node: any) => Promise<void>;
  getDatabaseNodeRef: (connRef: any, dbName: string) => any;
  handleExportSchemaSQL: (node: any, includeData: boolean) => Promise<void>;
  handleDeleteSchema: (node: any) => void;
  openRenameSchemaModal: (node: any) => void;
  openSchemaVisibilitySettings: (node: any) => void;
  resolveMessagePublishTarget: (node: any) => unknown;
  addSqlLog: (log: any) => void;
  handleV2TableContextMenuAction: (node: any, action: V2TableContextMenuActionKey) => void;
  handleV2TableGroupContextMenuAction: (node: any, action: V2TableGroupContextMenuActionKey) => void;
  handleV2DatabaseContextMenuAction: (node: any, action: V2DatabaseContextMenuActionKey) => void;
  handleV2ConnectionContextMenuAction: (node: any, action: V2ConnectionContextMenuActionKey) => void;
  handleV2ConnectionGroupContextMenuAction: (group: V2RailConnectionGroup, action: V2ConnectionGroupContextMenuActionKey) => void;
};

export const handleSidebarV2ContextMenuShortcut = ({
  event,
  contextMenu,
  shortcutPlatform,
  onTableAction,
  onClose,
}: {
  event: KeyboardEvent;
  contextMenu: SidebarContextMenuState | null;
  shortcutPlatform: ShortcutPlatform;
  onTableAction: (node: any, action: V2TableContextMenuActionKey) => void;
  onClose: () => void;
}): boolean => {
  if (event.key === 'Escape') {
    onClose();
    return true;
  }
  if (event.defaultPrevented || contextMenu?.kind !== 'v2-table' || !contextMenu.node) {
    return false;
  }

  const copyShortcut = shortcutPlatform === 'mac' ? 'Meta+C' : 'Ctrl+C';
  if (!isShortcutMatch(event, copyShortcut)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  onClose();
  onTableAction(contextMenu.node, 'copy-table-name');
  return true;
};

export const useSidebarV2ContextMenu = ({
  connections,
  connectionTags,
  activeShortcutPlatform,
  flattenConnectionNodes,
  v2TreeMetrics,
  tableSortPreference,
  pinnedSidebarTables,
  getConnectionNodeForAction,
  buildRuntimeConfig,
  extractObjectName,
  isPostgresSchemaDialect,
  loadTables,
  getDatabaseNodeRef,
  handleExportSchemaSQL,
  handleDeleteSchema,
  openRenameSchemaModal,
  openSchemaVisibilitySettings,
  resolveMessagePublishTarget,
  addSqlLog,
  handleV2TableContextMenuAction,
  handleV2TableGroupContextMenuAction,
  handleV2DatabaseContextMenuAction,
  handleV2ConnectionContextMenuAction,
  handleV2ConnectionGroupContextMenuAction,
}: SidebarV2ContextMenuOptions) => {
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const contextMenuPortalRef = useRef<HTMLDivElement | null>(null);
  const [v2TableContextMenuStats, setV2TableContextMenuStats] = useState<Record<string, V2TableContextMenuStats>>({});

  const openV2ConnectionContextMenu = (
      event: React.MouseEvent,
      connOrNode: SavedConnection | TreeNode,
  ) => {
      event.preventDefault();
      event.stopPropagation();
      const node = (connOrNode as TreeNode).type === 'connection'
          ? connOrNode as TreeNode
          : getConnectionNodeForAction(connOrNode as SavedConnection);
      if (!node?.key || !node?.dataRef) return;
      const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
      setContextMenu({
          x: position.x,
          y: position.y,
          sourceX: event.clientX,
          sourceY: event.clientY,
          items: [],
          kind: 'v2-connection',
          node,
          rootClassName: 'gn-v2-table-context-menu-popup',
          overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
          maxHeight: position.maxHeight,
      });
  };

  const getV2TreeMetaText = (node: any): string => {
      if (node.type === 'tag') {
          const count = flattenConnectionNodes(node.children || []).length;
          return count > 0 ? count.toLocaleString() : '';
      }
      if (node.type === 'database') {
          const count = v2TreeMetrics.databaseTableCounts.get(node.key) || 0;
          return count > 0 ? count.toLocaleString() : '';
      }
      if (node.type === 'object-group') {
          const count = v2TreeMetrics.objectGroupCounts.get(node.key) || 0;
          return count > 0 ? count.toLocaleString() : '';
      }
      if (node.type === 'redis-db') {
          const keyCount = Number(node?.dataRef?.redisKeyCount);
          if (Number.isFinite(keyCount) && keyCount > 0) {
              return keyCount.toLocaleString();
          }
          // Fallback for nodes built before redisKeyCount was tracked; avoid
          // matching an alias by only reading a trailing count suffix.
          const match = String(node.title || '').match(/\((\d+)\)\s*$/);
          return match?.[1] || '';
      }
      if (node.type === 'table') {
          const rowCount = Number(node?.dataRef?.rowCount);
          return Number.isFinite(rowCount) && rowCount >= 0 ? formatSidebarRowCount(rowCount) : '';
      }
      return '';
  };

  const getV2TableContextMenuStatsKey = (node: any): string => {
      const id = String(node?.dataRef?.id || '');
      const dbName = String(node?.dataRef?.dbName || '');
      const tableName = String(node?.dataRef?.tableName || node?.title || '');
      return `${id}::${dbName}::${tableName}`;
  };

  const readNumericMetadataValue = (row: Record<string, any>, keys: string[]): number | undefined => {
      const value = getCaseInsensitiveRawValue(row, keys);
      if (value === undefined || value === null || value === '') return undefined;
      const normalized = Number(String(value).replace(/,/g, ''));
      return Number.isFinite(normalized) ? normalized : undefined;
  };

  const buildV2TableStatusSQL = (node: any): string => {
      const conn = node.dataRef as SavedConnection & { dbName?: string; tableName?: string; schemaName?: string };
      const dialect = getMetadataDialect(conn);
      const dbName = String(conn?.dbName || '').trim();
      const tableName = String(conn?.tableName || node?.title || '').trim();
      const objectName = extractObjectName(tableName);
      const schemaName = String(conn?.schemaName || splitQualifiedName(tableName).schemaName || '').trim();
      switch (dialect) {
          case 'mysql':
          case 'starrocks':
              return [
                  'SELECT TABLE_ROWS AS table_rows, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length, ENGINE AS engine',
                  'FROM information_schema.tables',
                  `WHERE table_schema = '${escapeSQLLiteral(dbName)}'`,
                  `AND table_name = '${escapeSQLLiteral(objectName)}'`,
                  'LIMIT 1',
              ].join('\n');
          case 'postgres':
          case 'kingbase':
          case 'vastbase':
          case 'highgo':
          case 'opengauss':
          case 'gaussdb': {
              const schema = schemaName || 'public';
              return [
                  "SELECT c.reltuples::bigint AS table_rows, pg_total_relation_size(c.oid) AS data_length, pg_indexes_size(c.oid) AS index_length, 'heap' AS engine",
                  'FROM pg_class c',
                  'JOIN pg_namespace n ON n.oid = c.relnamespace',
                  "WHERE c.relkind = 'r'",
                  `AND n.nspname = '${escapeSQLLiteral(schema)}'`,
                  `AND c.relname = '${escapeSQLLiteral(objectName)}'`,
                  'LIMIT 1',
              ].join('\n');
          }
          case 'sqlserver': {
              const safeTable = tableName.replace(/'/g, "''");
              return [
                  'SELECT SUM(p.rows) AS table_rows, SUM(a.total_pages) * 8 * 1024 AS data_length, SUM(a.used_pages) * 8 * 1024 AS index_length, NULL AS engine',
                  'FROM sys.tables t',
                  'JOIN sys.indexes i ON t.object_id = i.object_id',
                  'JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id',
                  'JOIN sys.allocation_units a ON p.partition_id = a.container_id',
                  `WHERE t.object_id = OBJECT_ID('${safeTable}')`,
              ].join('\n');
          }
          case 'clickhouse':
              return [
                  'SELECT total_rows AS table_rows, total_bytes AS data_length, 0 AS index_length, engine AS engine',
                  'FROM system.tables',
                  `WHERE database = '${escapeSQLLiteral(dbName)}'`,
                  `AND name = '${escapeSQLLiteral(objectName)}'`,
                  'LIMIT 1',
              ].join('\n');
          case 'oracle':
          case 'dm': {
              const owner = (schemaName || dbName || '').toUpperCase();
              return [
                  'SELECT num_rows AS table_rows, 0 AS data_length, 0 AS index_length, NULL AS engine',
                  'FROM all_tables',
                  `WHERE owner = '${escapeSQLLiteral(owner)}'`,
                  `AND table_name = '${escapeSQLLiteral(objectName.toUpperCase())}'`,
                  'FETCH FIRST 1 ROWS ONLY',
              ].join('\n');
          }
          case 'sqlite':
          case 'duckdb':
              return `SELECT COUNT(*) AS table_rows, 0 AS data_length, 0 AS index_length, NULL AS engine FROM ${tableName}`;
          default:
              return '';
      }
  };

  const renderV2TableContextMenu = (node: any) => {
      const tableName = String(node?.dataRef?.tableName || node?.title || '').trim();
      const statsKey = getV2TableContextMenuStatsKey(node);
      const stats = v2TableContextMenuStats[statsKey];
      const isStarRocks = getMetadataDialect(node.dataRef as SavedConnection) === 'starrocks';
      const supportsCopyTable = getDataSourceCapabilities(node.dataRef?.config).supportsCopyTable;
      const supportsMessagePublish = Boolean(resolveMessagePublishTarget(node));
      const isPinned = isSidebarTablePinned(
          pinnedSidebarTables,
          String(node?.dataRef?.id || ''),
          String(node?.dataRef?.dbName || ''),
          tableName,
          String(node?.dataRef?.schemaName || ''),
      );
      return (
          <V2TableContextMenuView
              tableName={tableName}
              shortcutPlatform={activeShortcutPlatform}
              stats={stats}
              isPinned={isPinned}
              supportsTruncate={supportsTableTruncateAction(node.dataRef?.config?.type, node.dataRef?.config?.driver)}
              supportsCopyTable={supportsCopyTable}
              supportsStarRocksRollup={isStarRocks}
              supportsMessagePublish={supportsMessagePublish}
              onAction={(action) => {
                  setContextMenu(null);
                  handleV2TableContextMenuAction(node, action);
              }}
          />
      );
  };

  const renderV2TableGroupContextMenu = (node: any) => {
      const groupData = node.dataRef || {};
      const sortPreferenceKey = `${groupData.id}-${groupData.dbName}`;
      const currentSort = tableSortPreference[sortPreferenceKey] || 'name';
      return (
          <V2TableGroupContextMenuView
              shortcutPlatform={activeShortcutPlatform}
              dbName={String(groupData.dbName || '')}
              count={Array.isArray(node.children) ? node.children.length : 0}
              currentSort={currentSort}
              onAction={(action) => {
                  setContextMenu(null);
                  handleV2TableGroupContextMenuAction(node, action);
              }}
          />
      );
  };

  const renderV2DatabaseContextMenu = (node: any) => {
      const dialect = getMetadataDialect(node.dataRef as SavedConnection);
      const capabilities = getDataSourceCapabilities((node.dataRef as SavedConnection)?.config);
      return (
          <V2DatabaseContextMenuView
              dbName={String(node.dataRef?.dbName || node.title || '')}
              shortcutPlatform={activeShortcutPlatform}
              dialect={dialect}
              supportsSchemaActions={isPostgresSchemaDialect(dialect)}
              supportsSchemaVisibility={shouldHideSchemaPrefix(node.dataRef as SavedConnection)}
              supportsStarRocksActions={dialect === 'starrocks'}
              supportsRenameDatabase={capabilities.supportsRenameDatabase}
              supportsDropDatabase={capabilities.supportsDropDatabase}
              onAction={(action) => {
                  setContextMenu(null);
                  if (action === 'schema-visibility') {
                      openSchemaVisibilitySettings(node);
                      return;
                  }
                  handleV2DatabaseContextMenuAction(node, action);
              }}
          />
      );
  };

  const handleV2SchemaContextMenuAction = (node: any, action: V2SchemaContextMenuActionKey) => {
      switch (action) {
          case 'rename-schema':
              openRenameSchemaModal(node);
              return;
          case 'refresh-schema':
              void loadTables(getDatabaseNodeRef(node?.dataRef, String(node?.dataRef?.dbName || '').trim()));
              return;
          case 'export-schema':
              void handleExportSchemaSQL(node, false);
              return;
          case 'backup-schema-sql':
              void handleExportSchemaSQL(node, true);
              return;
          case 'drop-schema':
              handleDeleteSchema(node);
              return;
          default:
              return;
      }
  };

  const renderV2SchemaContextMenu = (node: any) => (
      <V2SchemaContextMenuView
          dbName={String(node?.dataRef?.dbName || '')}
          schemaName={String(node?.dataRef?.schemaName || node?.title || '')}
          shortcutPlatform={activeShortcutPlatform}
          onAction={(action) => {
              setContextMenu(null);
              handleV2SchemaContextMenuAction(node, action);
          }}
      />
  );

  const renderV2ConnectionContextMenu = (node: any) => {
      const conn = node.dataRef as SavedConnection;
      const capabilities = getDataSourceCapabilities(conn?.config);
      const currentTagId = connectionTags.find((tag) => tag.connectionIds.includes(String(conn.id || node.key)))?.id || '';
      return (
          <V2ConnectionContextMenuView
              connectionName={String(conn?.name || node.title || t('connection.unnamed'))}
              shortcutPlatform={activeShortcutPlatform}
              hostSummary={resolveConnectionHostSummary(conn?.config)}
              driverLabel={resolveConnectionIconType(conn)}
              isRedis={conn?.config?.type === 'redis'}
              supportsCreateDatabase={capabilities.supportsCreateDatabase}
              tags={connectionTags.map((tag) => ({
                  id: tag.id,
                  name: tag.name,
                  selected: tag.id === currentTagId,
              }))}
              onAction={(action) => {
                  setContextMenu(null);
                  handleV2ConnectionContextMenuAction(node, action);
              }}
          />
      );
  };

  const renderV2ConnectionGroupContextMenu = (group: V2RailConnectionGroup) => (
      <V2ConnectionGroupContextMenuView
          groupName={group.name}
          count={group.connections.length}
          onAction={(action) => {
              setContextMenu(null);
              handleV2ConnectionGroupContextMenuAction(group, action);
          }}
      />
  );

  const renderV2SidebarContextMenuContent = (menu: SidebarContextMenuState) => {
      if (!menu.node) return null;
      if (menu.kind === 'v2-table') return renderV2TableContextMenu(menu.node);
      if (menu.kind === 'v2-database') return renderV2DatabaseContextMenu(menu.node);
      if (menu.kind === 'v2-schema') return renderV2SchemaContextMenu(menu.node);
      if (menu.kind === 'v2-table-group') return renderV2TableGroupContextMenu(menu.node);
      if (menu.kind === 'v2-connection') return renderV2ConnectionContextMenu(menu.node);
      if (menu.kind === 'v2-connection-group') return renderV2ConnectionGroupContextMenu(menu.node);
      return null;
  };

  useEffect(() => {
      if (!contextMenu?.kind) return;
      const onPointerDown = (event: MouseEvent) => {
          const target = event.target instanceof Node ? event.target : null;
          if (target && contextMenuPortalRef.current?.contains(target)) return;
          setContextMenu(null);
      };
      const onKeyDown = (event: KeyboardEvent) => {
          handleSidebarV2ContextMenuShortcut({
              event,
              contextMenu,
              shortcutPlatform: activeShortcutPlatform,
              onTableAction: handleV2TableContextMenuAction,
              onClose: () => setContextMenu(null),
          });
      };
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKeyDown, true);
      return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown, true);
      };
  }, [activeShortcutPlatform, contextMenu, handleV2TableContextMenuAction]);

  useEffect(() => {
      if (!contextMenu?.kind) return;
      const frame = requestAnimationFrame(() => {
          const portal = contextMenuPortalRef.current;
          if (!portal) return;
          const rect = portal.getBoundingClientRect();
          const content = portal.querySelector('.gn-v2-table-context-menu') as HTMLElement | null;
          const measuredHeight = Math.max(rect.height, content?.scrollHeight || 0);
          const position = resolveSidebarContextMenuPosition(contextMenu.sourceX ?? contextMenu.x, contextMenu.sourceY ?? contextMenu.y, {
              width: rect.width || SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH,
              height: measuredHeight || SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT,
          });
          setContextMenu(prev => {
              if (!prev?.kind) return prev;
              if (prev.x === position.x && prev.y === position.y && prev.maxHeight === position.maxHeight) return prev;
              return { ...prev, x: position.x, y: position.y, maxHeight: position.maxHeight };
          });
      });
      return () => cancelAnimationFrame(frame);
  }, [contextMenu?.kind, contextMenu?.x, contextMenu?.y]);

  const fetchV2TableContextMenuStats = async (node: any) => {
      const statsKey = getV2TableContextMenuStatsKey(node);
      if (!statsKey || v2TableContextMenuStats[statsKey]?.loading) return;
      const sql = buildV2TableStatusSQL(node);
      if (!sql) {
          setV2TableContextMenuStats(prev => ({ ...prev, [statsKey]: { unavailable: true } }));
          return;
      }

      setV2TableContextMenuStats(prev => ({ ...prev, [statsKey]: { ...prev[statsKey], loading: true } }));
      const startTime = Date.now();
      try {
          const conn = node.dataRef;
          const res = await DBQuery(buildRuntimeConfig(conn, conn.dbName) as any, conn.dbName || '', sql);
          if (!res.success || !Array.isArray(res.data) || res.data.length === 0) {
              setV2TableContextMenuStats(prev => ({ ...prev, [statsKey]: { unavailable: true } }));
              return;
          }
          const row = res.data[0] as Record<string, any>;
          setV2TableContextMenuStats(prev => ({
              ...prev,
              [statsKey]: {
                  rowCount: readNumericMetadataValue(row, ['table_rows', 'TABLE_ROWS', 'rows', 'num_rows', 'reltuples', 'total_rows']),
                  dataLength: readNumericMetadataValue(row, ['data_length', 'DATA_LENGTH', 'total_bytes']),
                  indexLength: readNumericMetadataValue(row, ['index_length', 'INDEX_LENGTH']),
                  engine: getCaseInsensitiveValue(row, ['engine', 'ENGINE']),
              },
          }));
          addSqlLog({
              id: `${Date.now()}-table-stats`,
              timestamp: Date.now(),
              sql,
              status: 'success',
              duration: Date.now() - startTime,
              dbName: conn.dbName,
          });
      } catch (error: any) {
          setV2TableContextMenuStats(prev => ({ ...prev, [statsKey]: { unavailable: true } }));
          addSqlLog({
              id: `${Date.now()}-table-stats-error`,
              timestamp: Date.now(),
              sql,
              status: 'error',
              duration: Date.now() - startTime,
              message: error?.message || String(error),
              dbName: node?.dataRef?.dbName,
          });
      }
  };

  const refreshV2TableContextMenuStats = (node: any) => {
      const statsKey = getV2TableContextMenuStatsKey(node);
      setV2TableContextMenuStats(prev => ({ ...prev, [statsKey]: { loading: true } }));
      void fetchV2TableContextMenuStats(node);
  };


  return {
      contextMenu,
      setContextMenu,
      contextMenuPortalRef,
      openV2ConnectionContextMenu,
      getV2TreeMetaText,
      renderV2SidebarContextMenuContent,
      fetchV2TableContextMenuStats,
      refreshV2TableContextMenuStats,
  };
};
