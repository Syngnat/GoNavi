import React, { useState, useCallback, useRef, useDeferredValue, useMemo, useEffect } from 'react';
import { message } from 'antd';
import { useStore } from '../../../store';
import { getShortcutPlatform } from '../../../utils/shortcuts';
import { isMacLikePlatform } from '../../../utils/appearance';
import {
  type TableStatRow,
  type SortField,
  type SortOrder,
  type ViewMode,
  type OverviewContextMenuState,
  getMetadataDialect,
  isSchemaScopedTableOverviewDialect,
  parseTableStats,
  buildTableStatusSQL,
  usesTableListOverview,
  getTableOverviewDisplayName,
  isOverviewTablePinned,
  type OverviewTableSection,
  resolveOverviewContextMenuPosition,
  OVERVIEW_CONTEXT_MENU_WIDTH,
  OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT,
} from '../tableOverviewModel';
import {
  TABLE_OVERVIEW_RENDER_BATCH_SIZE,
  buildTableOverviewSearchIndex,
  filterAndSortTableOverviewRows,
  prioritizePinnedTableOverviewRows,
  resolveTableOverviewVisibleRows,
} from '../../../utils/tableOverviewFilter';
import { getDataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import { ensureTableStatsServerVersion } from '../../sidebar/sidebarTableStatsVersion';
import { supportsTableClearAction } from '../../tableDataDangerActions';
import { isConnectionDataEditRestricted } from '../../../utils/connectionReadOnly';
import { useAutoFetchVisibility } from '../../../utils/autoFetchVisibility';
import {
  DBGetTables,
  DBRefreshTableStats,
  DBQuery,
  DBShowCreateTable,
} from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { extractTableNameFromMetadataRow } from '../../../utils/tableMetadataRows';
import { t } from '../../../i18n';
import { resolveTableSelectQuery } from '../../../utils/objectQueryTemplates';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import { confirmCopyTable } from '../../tableCopyAction';
import type { TableOverviewProps } from '../../TableOverview';

export interface UseTableOverviewStateInput {
  tab: TableOverviewProps['tab'];
}

export const useTableOverviewState = ({ tab }: UseTableOverviewStateInput) => {
  const connections = useStore(state => state.connections);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const addAIContext = useStore(state => state.addAIContext);
  const pinnedSidebarTables = useStore(state => state.pinnedSidebarTables);
  const setSidebarTablePinned = useStore(state => state.setSidebarTablePinned);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const darkMode = theme === 'dark';

  const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
  const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());

  const [tables, setTables] = useState<TableStatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const viewMode: ViewMode = queryOptions.tableOverviewViewMode || ('card');
  const setViewMode = useCallback((nextViewMode: ViewMode) => {
      setQueryOptions({ tableOverviewViewMode: nextViewMode });
  }, [setQueryOptions]);
  const [v2ContextMenu, setV2ContextMenu] = useState<OverviewContextMenuState | null>(null);
  const v2ContextMenuPortalRef = useRef<HTMLDivElement | null>(null);
  const [visibleTableLimit, setVisibleTableLimit] = useState(TABLE_OVERVIEW_RENDER_BATCH_SIZE);
  const deferredSearchText = useDeferredValue(searchText);
  const isSearchPending = searchText !== deferredSearchText;

  const connection = useMemo(() => connections.find(c => c.id === tab.connectionId), [connections, tab.connectionId]);
  const metadataDialect = useMemo(
      () => getMetadataDialect(connection?.config?.type || '', connection?.config?.driver, connection?.config?.oceanBaseProtocol),
      [connection?.config?.driver, connection?.config?.oceanBaseProtocol, connection?.config?.type]
  );
  const schemaName = String((tab as any).schemaName || '').trim();
  const overviewSchemaName = isSchemaScopedTableOverviewDialect(metadataDialect)
      ? (schemaName || 'public')
      : '';
  const dataSourceCapabilities = getDataSourceCapabilities(connection?.config);
  const supportsDesignWrite = !dataSourceCapabilities.forceReadOnlyStructureDesigner;
  const supportsCopyTable = dataSourceCapabilities.supportsCopyTable;
  const allowClear = supportsTableClearAction(
      connection?.config?.type || '',
      connection?.config?.driver,
  ) && !isConnectionDataEditRestricted(connection?.config);
  const autoFetchVisible = useAutoFetchVisibility();
  const loadDataRequestIdRef = useRef(0);

  const loadData = useCallback(async () => {
      const requestId = loadDataRequestIdRef.current + 1;
      loadDataRequestIdRef.current = requestId;
      const isLatestRequest = () => loadDataRequestIdRef.current === requestId;
      if (!connection) {
          setLoading(false);
          return;
      }
      setLoading(true);
      try {
          const config = {
              ...connection.config,
              port: Number(connection.config.port),
              password: connection.config.password || '',
              database: connection.config.database || '',
              useSSH: connection.config.useSSH || false,
              ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
          };
          if (usesTableListOverview(metadataDialect, connection?.config?.type)) {
              const res = await DBGetTables(buildRpcConnectionConfig(config) as any, tab.dbName || '');
              if (!isLatestRequest()) return;
              if (res.success && Array.isArray(res.data)) {
                  setTables(parseTableStats(metadataDialect, res.data));
                  if (metadataDialect === 'sqlite' || metadataDialect === 'sqlite3') {
                      setLoading(false);
                      const tableNames = res.data
                          .map((row: Record<string, any>) => extractTableNameFromMetadataRow(row))
                          .filter((tableName: string) => tableName !== '');
                      const refreshed = await DBRefreshTableStats(
                          buildRpcConnectionConfig(config) as any,
                          tab.dbName || '',
                          tableNames,
                      ).catch(() => null);
                      if (!isLatestRequest()) return;
                      if (refreshed?.success && Array.isArray(refreshed.data)) {
                          setTables(parseTableStats(metadataDialect, refreshed.data));
                      }
                  }
              } else {
                  message.error(t('table_overview.message.load_tables_failed', {
                      detail: res.message || t('table_overview.message.unknown_error'),
                  }));
              }
              return;
          }
          const sql = buildTableStatusSQL(metadataDialect, tab.dbName || '', schemaName, connection?.config?.type, await ensureTableStatsServerVersion(connection));
          const res = await DBQuery(buildRpcConnectionConfig(config) as any, tab.dbName || '', sql);
          if (!isLatestRequest()) return;
          if (res.success && Array.isArray(res.data)) {
              setTables(parseTableStats(metadataDialect, res.data));
          } else {
              message.error(t('table_overview.message.load_tables_failed', {
                  detail: res.message || t('table_overview.message.unknown_error'),
              }));
          }
      } catch (e: any) {
          if (!isLatestRequest()) return;
          message.error(t('table_overview.message.load_tables_failed', {
              detail: e?.message || String(e),
          }));
      } finally {
          if (isLatestRequest()) {
              setLoading(false);
          }
      }
  }, [connection, metadataDialect, schemaName, t, tab.dbName]);

  useEffect(() => {
      if (!autoFetchVisible) {
          return;
      }
      void loadData();
  }, [autoFetchVisible, loadData]);

  const tableSearchIndex = useMemo(
      () => buildTableOverviewSearchIndex(tables, (table) => getTableOverviewDisplayName(metadataDialect, table.name)),
      [metadataDialect, tables],
  );

  const sortedFiltered = useMemo(() => (
      filterAndSortTableOverviewRows(tableSearchIndex, deferredSearchText, sortField, sortOrder)
  ), [deferredSearchText, sortField, sortOrder, tableSearchIndex]);

  const pinnedOverview = useMemo(() => (
      prioritizePinnedTableOverviewRows(
          sortedFiltered,
          (table) => isOverviewTablePinned(pinnedSidebarTables, connection?.id, tab.dbName, schemaName, table.name),
      )
  ), [connection?.id, pinnedSidebarTables, schemaName, sortedFiltered, tab.dbName]);

  useEffect(() => {
      setVisibleTableLimit(TABLE_OVERVIEW_RENDER_BATCH_SIZE);
  }, [deferredSearchText, sortField, sortOrder, viewMode, tables, pinnedSidebarTables]);

  const visibleOverview = useMemo(() => (
      resolveTableOverviewVisibleRows(pinnedOverview.orderedRows, visibleTableLimit)
  ), [pinnedOverview.orderedRows, visibleTableLimit]);

  const visibleTables = visibleOverview.visibleRows;

  const visibleTableSections = useMemo<OverviewTableSection[]>(() => {
      if (pinnedOverview.pinnedRows.length === 0) {
          return [{ key: 'all', kind: 'all', rows: visibleTables }];
      }
      const visiblePinnedNames = new Set(
          visibleTables
              .filter((table) => isOverviewTablePinned(pinnedSidebarTables, connection?.id, tab.dbName, schemaName, table.name))
              .map((table) => table.name),
      );
      const pinnedRows = pinnedOverview.pinnedRows.filter((table) => visiblePinnedNames.has(table.name));
      const regularRows = visibleTables.filter((table) => !visiblePinnedNames.has(table.name));
      return [
          ...(pinnedRows.length > 0 ? [{ key: 'pinned', kind: 'pinned' as const, rows: pinnedRows }] : []),
          ...(regularRows.length > 0 ? [{ key: 'all', kind: 'all' as const, rows: regularRows }] : []),
      ];
  }, [connection?.id, pinnedOverview.pinnedRows, pinnedSidebarTables, schemaName, tab.dbName, visibleTables]);

  const v2ContextMenuTable = useMemo(
      () => (v2ContextMenu ? tables.find(table => table.name === v2ContextMenu.tableName) || null : null),
      [tables, v2ContextMenu],
  );

  const openV2OverviewContextMenu = useCallback((event: React.MouseEvent, table: TableStatRow) => {

      event.preventDefault();
      event.stopPropagation();
      const position = resolveOverviewContextMenuPosition(event.clientX, event.clientY);
      setV2ContextMenu({
          tableName: table.name,
          x: position.x,
          y: position.y,
          sourceX: event.clientX,
          sourceY: event.clientY,
          maxHeight: position.maxHeight,
      });
  }, [true]);

  useEffect(() => {
      if (!v2ContextMenu) return;
      const onPointerDown = (event: MouseEvent) => {
          const target = event.target instanceof Node ? event.target : null;
          if (target && v2ContextMenuPortalRef.current?.contains(target)) return;
          setV2ContextMenu(null);
      };
      const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Escape') return;
          setV2ContextMenu(null);
      };
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
      };
  }, [v2ContextMenu]);

  useEffect(() => {
      if (!v2ContextMenu) return;
      const frame = requestAnimationFrame(() => {
          const portal = v2ContextMenuPortalRef.current;
          if (!portal) return;
          const rect = portal.getBoundingClientRect();
          const content = portal.querySelector('.gn-v2-table-context-menu') as HTMLElement | null;
          const measuredHeight = Math.max(rect.height, content?.scrollHeight || 0);
          const position = resolveOverviewContextMenuPosition(v2ContextMenu.sourceX, v2ContextMenu.sourceY, {
              width: rect.width || OVERVIEW_CONTEXT_MENU_WIDTH,
              height: measuredHeight || OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT,
          });
          setV2ContextMenu(prev => {
              if (!prev) return prev;
              if (prev.x === position.x && prev.y === position.y && prev.maxHeight === position.maxHeight) return prev;
              return { ...prev, x: position.x, y: position.y, maxHeight: position.maxHeight };
          });
      });
      return () => cancelAnimationFrame(frame);
  }, [v2ContextMenu]);

  const openTable = useCallback((tableName: string) => {
      if (!connection) return;
      setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '', schemaName: schemaName || undefined });
      addTab({
          id: `${connection.id}-${tab.dbName}${schemaName ? `-${schemaName}` : ''}-${tableName}`,
          title: tableName,
          type: 'table',
          connectionId: connection.id,
          dbName: tab.dbName,
          tableName,
          schemaName: schemaName || undefined,
          objectType: 'table',
      });
  }, [connection, schemaName, tab.dbName, addTab, setActiveContext]);

  const openDesign = useCallback((tableName: string) => {
      if (!connection) return;
      setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '', schemaName: schemaName || undefined });
      const structureOnly = !supportsDesignWrite;
      addTab({
          id: `design-${connection.id}-${tab.dbName}${schemaName ? `-${schemaName}` : ''}-${tableName}`,
          title: t(
              structureOnly ? 'table_overview.tab.table_structure_title' : 'table_overview.tab.design_table_title',
              { table: tableName },
          ),
          type: 'design',
          connectionId: connection.id,
          dbName: tab.dbName,
          tableName,
          schemaName: schemaName || undefined,
          initialTab: 'columns',
          readOnly: structureOnly,
      });
  }, [connection, schemaName, tab.dbName, addTab, setActiveContext, supportsDesignWrite, t]);

  const openTableObjectDesigner = useCallback((tableName: string) => {
      if (!connection) return;
      setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '', schemaName: schemaName || undefined });
      addTab({
          id: `${connection.id}-${tab.dbName}${schemaName ? `-${schemaName}` : ''}-${tableName}`,
          title: tableName,
          type: 'table',
          connectionId: connection.id,
          dbName: tab.dbName,
          tableName,
          schemaName: schemaName || undefined,
          initialViewMode: 'fields',
          initialViewModeRequestId: String(Date.now()),
          objectType: 'table',
      });
  }, [connection, schemaName, tab.dbName, addTab, setActiveContext]);

  const openTableByDefaultAction = useCallback((tableName: string) => {
      if (tableDoubleClickAction === 'open-design') {
          openTableObjectDesigner(tableName);
          return;
      }
      openTable(tableName);
  }, [openTable, openTableObjectDesigner, tableDoubleClickAction]);

  const openTableDdl = useCallback((tableName: string) => {
      if (!connection) return;
      setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '', schemaName: schemaName || undefined });
      addTab({
          id: `design-${connection.id}-${tab.dbName}${schemaName ? `-${schemaName}` : ''}-${tableName}`,
          title: t('table_overview.tab.table_structure_title', { table: tableName }),
          type: 'design',
          connectionId: connection.id,
          dbName: tab.dbName,
          tableName,
          schemaName: schemaName || undefined,
          initialTab: 'ddl',
          readOnly: true,
      });
  }, [connection, schemaName, tab.dbName, addTab, setActiveContext, t]);

  const openQueryForTable = useCallback((tableName: string) => {
      if (!connection) return;
      void (async () => {
          setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '', schemaName: schemaName || undefined });
          const queryTemplate = await resolveTableSelectQuery({
              dbType: metadataDialect,
              tableName,
              dbName: String(tab.dbName || ''),
              connectionConfig: connection.config,
          });
          addTab({
              id: `query-${Date.now()}`,
              title: t('table_overview.menu.new_query'),
              type: 'query',
              connectionId: connection.id,
              dbName: tab.dbName,
              schemaName: schemaName || undefined,
              query: queryTemplate,
          });
      })();
  }, [addTab, connection, metadataDialect, schemaName, setActiveContext, t, tab.dbName]);

  const openTableInER = useCallback((tableName: string) => {
      if (!connection) return;
      openTable(tableName);
      setTimeout(() => {
          window.dispatchEvent(new CustomEvent('gonavi:data-grid:set-view-mode', {
              detail: {
                  connectionId: connection.id,
                  dbName: tab.dbName,
                  schemaName: schemaName || undefined,
                  tableName,
                  viewMode: 'er',
              },
          }));
      }, 0);
  }, [connection, openTable, schemaName, tab.dbName]);

  const buildConfig = useCallback(() => {
      if (!connection) return null;
      return {
          ...connection.config,
          port: Number(connection.config.port),
          password: connection.config.password || '',
          database: connection.config.database || '',
          useSSH: connection.config.useSSH || false,
          ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
      };
  }, [connection]);

  const handleCopyStructure = useCallback(async (tableName: string) => {
      const config = buildConfig();
      if (!config) return;
      const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName);
      if (res.success) {
          navigator.clipboard.writeText(res.data as string);
          message.success(t('table_overview.message.copy_structure_success'));
      } else {
          message.error(t('table_overview.message.copy_structure_failed', {
              detail: res.message || t('table_overview.message.unknown_error'),
          }));
      }
  }, [buildConfig, t, tab.dbName]);

  const handleCopyTableName = useCallback(async (tableName: string) => {
      const name = String(tableName || '').trim();
      if (!name) {
          message.warning(t('table_overview.message.copy_table_name_empty'));
          return;
      }
      try {
          await navigator.clipboard.writeText(name);
          message.success(t('table_overview.message.copy_table_name_success'));
      } catch (e: any) {
          message.error(t('table_overview.message.copy_table_name_failed', {
              detail: e?.message || String(e),
          }));
      }
  }, [t]);

  const handleCopyTable = useCallback(async (tableName: string) => {
      if (!supportsCopyTable) {
          message.warning(t('table_copy.message.unsupported'));
          return;
      }
      const config = buildConfig();
      if (!config) return;
      if (!await confirmProductionMutation(
          connection,
          t('connection.production_risk.action.execute_sql'),
          [tab.dbName, tableName].filter(Boolean).join(' / '),
          t,
      )) return;
      confirmCopyTable({
          config: buildRpcConnectionConfig(config) as any,
          dbName: tab.dbName || '',
          sourceSchemaName: schemaName,
          sourceTableName: tableName,
          onSuccess: async () => {
              await loadData();
          },
      });
  }, [buildConfig, connection, loadData, schemaName, supportsCopyTable, t, tab.dbName]);
  return {
    addTab, setAIPanelVisible, addAIContext, pinnedSidebarTables, setSidebarTablePinned, darkMode,
    activeShortcutPlatform, tables, loading, searchText, setSearchText, sortField, setSortField,
    sortOrder, setSortOrder, viewMode, setViewMode, v2ContextMenu, setV2ContextMenu,
    v2ContextMenuPortalRef, setVisibleTableLimit, deferredSearchText, isSearchPending, connection,
    metadataDialect, schemaName, overviewSchemaName, supportsCopyTable, allowClear, loadData,
    sortedFiltered, pinnedOverview, visibleOverview, visibleTables, visibleTableSections,
    v2ContextMenuTable, openV2OverviewContextMenu, openTable, openDesign, openTableByDefaultAction,
    openTableDdl, openQueryForTable, openTableInER, buildConfig, handleCopyStructure,
    handleCopyTableName, handleCopyTable,
  };
};

export type TableOverviewStateApi = ReturnType<typeof useTableOverviewState>;
