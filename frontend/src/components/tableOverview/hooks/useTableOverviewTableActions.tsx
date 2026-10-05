import React, { useCallback, useMemo } from 'react';
import { message, Input } from 'antd';
import {
  buildBatchTableExportWorkbenchTab,
  buildTableExportTab,
} from '../../../utils/tableExportTab';
import { t } from '../../../i18n';
import { showCountdownDangerConfirm } from '../../common/countdownDangerConfirm';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import { DropTable, RenameTable, DBShowCreateTable } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
  type TableDataDangerActionKind,
  supportsTableTruncateAction,
} from '../../tableDataDangerActions';
import Modal from '../../common/ResizableDraggableModal';
import {
  isOverviewTablePinned,
  type SortField,
  type TableStatRow,
  formatRows,
  formatSize,
} from '../tableOverviewModel';
import { noAutoCapInputProps } from '../../../utils/inputAutoCap';
import { useStore } from '../../../store';
import { type V2TableContextMenuActionKey, V2TableContextMenuView } from '../../V2TableContextMenu';
import type { TableOverviewStateApi } from './useTableOverviewState';
import type { TableOverviewProps } from '../../TableOverview';

export interface UseTableOverviewTableActionsInput {
  tab: TableOverviewProps['tab'];
  addTab: TableOverviewStateApi['addTab'];
  schemaName: TableOverviewStateApi['schemaName'];
  buildConfig: TableOverviewStateApi['buildConfig'];
  connection: TableOverviewStateApi['connection'];
  loadData: TableOverviewStateApi['loadData'];
  allowClear: TableOverviewStateApi['allowClear'];
  pinnedSidebarTables: TableOverviewStateApi['pinnedSidebarTables'];
  setSidebarTablePinned: TableOverviewStateApi['setSidebarTablePinned'];
  addAIContext: TableOverviewStateApi['addAIContext'];
  setAIPanelVisible: TableOverviewStateApi['setAIPanelVisible'];
  sortField: TableOverviewStateApi['sortField'];
  setSortField: TableOverviewStateApi['setSortField'];
  setSortOrder: TableOverviewStateApi['setSortOrder'];
  sortOrder: TableOverviewStateApi['sortOrder'];
  tables: TableOverviewStateApi['tables'];
  sortedFiltered: TableOverviewStateApi['sortedFiltered'];
  openTable: TableOverviewStateApi['openTable'];
  openDesign: TableOverviewStateApi['openDesign'];
  openQueryForTable: TableOverviewStateApi['openQueryForTable'];
  openTableDdl: TableOverviewStateApi['openTableDdl'];
  openTableInER: TableOverviewStateApi['openTableInER'];
  handleCopyTableName: TableOverviewStateApi['handleCopyTableName'];
  handleCopyStructure: TableOverviewStateApi['handleCopyStructure'];
  handleCopyTable: TableOverviewStateApi['handleCopyTable'];
  activeShortcutPlatform: TableOverviewStateApi['activeShortcutPlatform'];
  supportsCopyTable: TableOverviewStateApi['supportsCopyTable'];
  metadataDialect: TableOverviewStateApi['metadataDialect'];
  setV2ContextMenu: TableOverviewStateApi['setV2ContextMenu'];
}

export const useTableOverviewTableActions = ({
  tab, addTab, schemaName, buildConfig, connection, loadData, allowClear, pinnedSidebarTables,
  setSidebarTablePinned, addAIContext, setAIPanelVisible, sortField, setSortField, setSortOrder,
  sortOrder, tables, sortedFiltered, openTable, openDesign, openQueryForTable, openTableDdl,
  openTableInER, handleCopyTableName, handleCopyStructure, handleCopyTable, activeShortcutPlatform,
  supportsCopyTable, metadataDialect, setV2ContextMenu,
}: UseTableOverviewTableActionsInput) => {
  const openTableSQLExportWorkbench = useCallback(async (tableName: string, mode: 'backup' | 'dataOnly') => {
      const normalizedTableName = String(tableName || '').trim();
      if (!normalizedTableName) return;
      const launchKey = `table-overview-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      addTab(buildBatchTableExportWorkbenchTab({
          connectionId: tab.connectionId,
          dbName: tab.dbName,
          initialObjectNames: [normalizedTableName],
          contentMode: mode,
          includeDropIfExists: false,
          ...(mode === 'backup' ? { launchKey } : { requestKey: launchKey }),
          title: t('file.backend.dialog.export_table', { table: normalizedTableName }),
      }));
  }, [addTab, tab.connectionId, tab.dbName]);

  const openExportDialog = useCallback(async (tableName: string, totalRows?: number) => {
      addTab(buildTableExportTab({
          connectionId: tab.connectionId,
          dbName: tab.dbName,
          tableName,
          schemaName: schemaName || undefined,
          title: t('file.backend.dialog.export_table', { table: tableName }),
          objectType: 'table',
          rowCountByScope: Number.isFinite(Number(totalRows)) && Number(totalRows) > 0
              ? { all: Math.trunc(Number(totalRows)) }
              : undefined,
      }));
  }, [addTab, schemaName, tab.connectionId, tab.dbName]);

  const handleCopyTableAsInsert = useCallback(async (tableName: string) => {
      await openTableSQLExportWorkbench(tableName, 'dataOnly');
  }, [openTableSQLExportWorkbench]);

  const handleDeleteTable = useCallback((tableName: string) => {
      const config = buildConfig();
      if (!config) return;
      showCountdownDangerConfirm({
          title: t('table_overview.modal.delete_table.title'),
          content: t('table_overview.modal.delete_table.content', { table: tableName }),
          onOk: async () => {
              if (!await confirmProductionMutation(
                  connection,
                  t('connection.production_risk.action.execute_sql'),
                  [tab.dbName, tableName].filter(Boolean).join(' / '),
                  t,
              )) return;
              const res = await DropTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName);
              if (res.success) {
                  await loadData();
                  message.success(t('table_overview.message.delete_table_success'));
              } else {
                  message.error(t('table_overview.message.delete_table_failed', { detail: res.message }));
              }
          },
      });
  }, [buildConfig, connection, loadData, t, tab.dbName]);

  const handleTableDataDangerAction = useCallback((tableName: string, action: TableDataDangerActionKind) => {
      if (action === 'clear' && !allowClear) return;
      const config = buildConfig();
      if (!config) return;

      const actionLabel = t(`table_overview.table_data_action.${action}.label`);
      Modal.confirm({
          title: t('table_overview.modal.table_data_action.title', { action: actionLabel }),
          content: t('table_overview.modal.table_data_action.content', {
              action: actionLabel,
              table: tableName,
          }),
          okText: t('common.continue'),
          cancelText: t('common.cancel'),
          okButtonProps: { danger: true },
          onOk: async () => {
              if (!await confirmProductionMutation(
                  connection,
                  t('connection.production_risk.action.execute_sql'),
                  [tab.dbName, tableName].filter(Boolean).join(' / '),
                  t,
              )) return;
              const app = (window as any).go.app.App;
              const methodName = action === 'truncate' ? 'TruncateTables' : 'ClearTables';
              const hide = message.loading(t('table_overview.message.table_data_action_loading', {
                  action: actionLabel,
                  table: tableName,
              }), 0);
              try {
                  const res = await app[methodName](buildRpcConnectionConfig(config) as any, tab.dbName || '', [tableName]);
                  hide();
                  if (res.success) {
                      await loadData();
                      message.success(t('table_overview.message.table_data_action_success', { action: actionLabel }));
                  } else {
                      message.error(t('table_overview.message.table_data_action_failed', { action: actionLabel, detail: res.message }));
                      return Promise.reject();
                  }
              } catch (e: any) {
                  hide();
                  message.error(t('table_overview.message.table_data_action_failed', {
                      action: actionLabel,
                      detail: e?.message || String(e),
                  }));
                  return Promise.reject();
              }
          },
      });
  }, [allowClear, buildConfig, connection, loadData, t, tab.dbName]);

  const toggleOverviewTablePinned = useCallback((tableName: string, pinned?: boolean) => {
      if (!connection?.id || !tab.dbName || !tableName) return;
      const currentlyPinned = isOverviewTablePinned(
          pinnedSidebarTables,
          connection.id,
          tab.dbName,
          schemaName,
          tableName,
      );
      const shouldPin = pinned ?? !currentlyPinned;
      setSidebarTablePinned(connection.id, tab.dbName, tableName, schemaName, shouldPin);
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-table-pin-changed', {
          detail: {
              connectionId: connection.id,
              dbName: tab.dbName,
          },
      }));
      message.success(shouldPin ? t('table_overview.message.pinned') : t('table_overview.message.unpinned'));
  }, [connection?.id, pinnedSidebarTables, schemaName, setSidebarTablePinned, t, tab.dbName]);

  const handleRenameTable = useCallback((tableName: string) => {
      const config = buildConfig();
      if (!config) return;
      let newName = tableName;
      Modal.confirm({
          title: t('table_overview.modal.rename_table.title'),
          content: (
              <Input
                  {...noAutoCapInputProps}
                  defaultValue={tableName}
                  onChange={e => { newName = e.target.value; }}
                  placeholder={t('table_overview.modal.rename_table.placeholder')}
                  autoFocus
                  style={{ marginTop: 8 }}
              />
          ),
          onOk: async () => {
              const trimmed = newName.trim();
              if (!trimmed) { message.error(t('table_overview.validation.table_name_required')); return Promise.reject(); }
              if (trimmed === tableName) { message.warning(t('table_overview.validation.table_name_unchanged')); return; }
              if (!await confirmProductionMutation(
                  connection,
                  t('connection.production_risk.action.execute_sql'),
                  [tab.dbName, `${tableName} -> ${trimmed}`].filter(Boolean).join(' / '),
                  t,
              )) return;
              const res = await RenameTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName, trimmed);
              if (res.success) {
                  await loadData();
                  message.success(t('table_overview.message.rename_table_success'));
              } else {
                  message.error(t('table_overview.message.rename_table_failed', { detail: res.message }));
              }
          },
      });
  }, [buildConfig, connection, loadData, t, tab.dbName]);

  const openCreateStarRocksRollup = useCallback((tableName: string) => {
      if (!connection) return;
      const safeTable = String(tableName || 'table_name').trim();
      const quotedTable = safeTable.includes('`') ? safeTable : safeTable.split('.').map(part => `\`${part.replace(/`/g, '``')}\``).join('.');
      addTab({
          id: `query-create-starrocks-rollup-${Date.now()}`,
          title: t('sidebar.v2_table_menu.new_rollup', { keyword: 'Rollup' }),
          type: 'query',
          connectionId: connection.id,
          dbName: tab.dbName,
          schemaName: schemaName || undefined,
          query: `ALTER TABLE ${quotedTable}\nADD ROLLUP rollup_name (column1, column2);`,
      });
  }, [addTab, connection, schemaName, t, tab.dbName]);

  const injectTablePromptToAI = useCallback(async (tableName: string, promptKind: 'explain' | 'query') => {
      const dbName = tab.dbName || '';
      if (!connection?.id || !dbName || !tableName) {
          message.warning(t('sidebar.message.ai_table_context_missing'));
          return;
      }
      const tableRef = `${dbName}.${tableName}`;

      let ddl = '';
      const config = buildConfig();
      if (config) {
          try {
              const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, dbName, tableName);
              if (res.success) {
                  ddl = String(res.data || '').trim();
                  addAIContext(connection.id, { dbName, tableName, ddl });
              }
          } catch {
              // AI 入口仍可基于表名工作，DDL 获取失败不阻断打开面板。
          }
      }

      const prompt = promptKind === 'explain'
          ? [
              t('sidebar.ai_prompt.explain.intro', { table: tableRef }),
              t('sidebar.ai_prompt.explain.detail'),
              ddl ? `\n\`\`\`sql\n${ddl}\n\`\`\`` : '',
          ].filter(Boolean).join('\n')
          : [
              t('sidebar.ai_prompt.query.intro', { table: tableRef }),
              t('sidebar.ai_prompt.query.detail'),
              ddl ? `\n\`\`\`sql\n${ddl}\n\`\`\`` : '',
          ].filter(Boolean).join('\n');

      const wasClosed = !useStore.getState().aiPanelVisible;
      if (wasClosed) setAIPanelVisible(true);
      setTimeout(() => {
          window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt } }));
      }, wasClosed ? 350 : 0);
  }, [addAIContext, buildConfig, connection?.id, setAIPanelVisible, tab.dbName]);

  // --- Theme ---
  // v2 背景/边框/强调色交给 CSS token（跟自定义主题）；legacy 仍用 darkMode 近似色。
  const textPrimary = 'var(--gn-fg-1)';
  const textSecondary = 'var(--gn-fg-3)';
  const textMuted = 'var(--gn-fg-4)';
  const accentColor = 'var(--gn-accent)';
  const containerBg = undefined;

  const toggleSort = (field: SortField) => {
      if (sortField === field) {
          setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
      } else {
          setSortField(field);
          setSortOrder(field === 'name' || field === 'comment' || field === 'engine' ? 'asc' : 'desc');
      }
  };

  const getSortMenuLabel = (field: SortField, labelKey: string) => {
      const suffix = sortField === field ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : '';
      return `${t(labelKey)}${suffix}`;
  };

  const sortMenuItems = [
      { key: 'name', label: getSortMenuLabel('name', 'table_overview.sort.name'), onClick: () => toggleSort('name') },
      { key: 'comment', label: getSortMenuLabel('comment', 'table_overview.metric.comment'), onClick: () => toggleSort('comment') },
      { key: 'rows', label: getSortMenuLabel('rows', 'table_overview.sort.rows'), onClick: () => toggleSort('rows') },
      { key: 'dataSize', label: getSortMenuLabel('dataSize', 'table_overview.sort.size'), onClick: () => toggleSort('dataSize') },
      { key: 'indexSize', label: getSortMenuLabel('indexSize', 'table_overview.metric.index_size'), onClick: () => toggleSort('indexSize') },
      { key: 'engine', label: getSortMenuLabel('engine', 'table_overview.metric.engine'), onClick: () => toggleSort('engine') },
      { key: 'updateTime', label: getSortMenuLabel('updateTime', 'table_overview.metric.updated_at'), onClick: () => toggleSort('updateTime') },
      { key: 'createTime', label: getSortMenuLabel('createTime', 'table_overview.metric.created_at'), onClick: () => toggleSort('createTime') },
  ];

  const hasKnownTableSize = useCallback((table: TableStatRow) => table.dataSize >= 0 || table.indexSize >= 0, []);
  const getCombinedTableSize = useCallback((table: TableStatRow) => (
      Math.max(0, table.dataSize) + Math.max(0, table.indexSize)
  ), []);
  const totalRows = useMemo(() => {
      const knownRows = tables.filter(table => table.rows >= 0);
      return knownRows.length > 0 ? knownRows.reduce((sum, table) => sum + table.rows, 0) : -1;
  }, [tables]);
  const totalSize = useMemo(() => {
      const knownSizes = tables.filter(hasKnownTableSize);
      return knownSizes.length > 0 ? knownSizes.reduce((sum, table) => sum + getCombinedTableSize(table), 0) : -1;
  }, [getCombinedTableSize, hasKnownTableSize, tables]);
  const maxCombinedSize = useMemo(() => sortedFiltered.reduce((max, table) => {
      return Math.max(max, getCombinedTableSize(table));
  }, 0), [getCombinedTableSize, sortedFiltered]);
  const allowTruncate = supportsTableTruncateAction(connection?.config?.type || '', connection?.config?.driver);

  const renderToolbarSummary = () => {
      const countToken = '__COUNT__';
      const rowsToken = '__ROWS__';
      const sizeToken = '__SIZE__';
      const template = t('table_overview.toolbar.summary', {
          count: countToken,
          rows: rowsToken,
          size: sizeToken,
      });
      const parts = template.split(/(__COUNT__|__ROWS__|__SIZE__)/g);

      return parts.map((part, index) => {
          if (part === countToken) {
              return <strong key={`count-${index}`}>{tables.length}</strong>;
          }
          if (part === rowsToken) {
              return <strong key={`rows-${index}`}>{formatRows(totalRows)}</strong>;
          }
          if (part === sizeToken) {
              return <strong key={`size-${index}`}>{formatSize(totalSize)}</strong>;
          }
          return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
      });
  };

  const handleV2TableContextMenuAction = useCallback((table: TableStatRow, action: V2TableContextMenuActionKey) => {
      const tableName = table.name;
      switch (action) {
          case 'open-data':
          case 'open-new-tab':
              openTable(tableName);
              return;
          case 'pin-table':
              toggleOverviewTablePinned(tableName, true);
              return;
          case 'unpin-table':
              toggleOverviewTablePinned(tableName, false);
              return;
          case 'design-table':
              openDesign(tableName);
              return;
          case 'new-query':
              openQueryForTable(tableName);
              return;
          case 'view-ddl':
              openTableDdl(tableName);
              return;
          case 'view-er':
              openTableInER(tableName);
              return;
          case 'copy-table-name':
              void handleCopyTableName(tableName);
              return;
          case 'copy-structure':
              void handleCopyStructure(tableName);
              return;
          case 'copy-table':
              handleCopyTable(tableName);
              return;
          case 'copy-insert':
              void handleCopyTableAsInsert(tableName);
              return;
          case 'rename-table':
              handleRenameTable(tableName);
              return;
          case 'new-rollup':
              openCreateStarRocksRollup(tableName);
              return;
          case 'backup-table':
              void openTableSQLExportWorkbench(tableName, 'backup');
              return;
          case 'refresh-stats':
              void loadData();
              return;
          case 'export-data':
              void openExportDialog(tableName, tables.find((item) => item.name === tableName)?.rows);
              return;
          case 'ai-explain':
              void injectTablePromptToAI(tableName, 'explain');
              return;
          case 'ai-generate-query':
              void injectTablePromptToAI(tableName, 'query');
              return;
          case 'truncate-table':
              void handleTableDataDangerAction(tableName, 'truncate');
              return;
          case 'clear-table':
              void handleTableDataDangerAction(tableName, 'clear');
              return;
          case 'drop-table':
              handleDeleteTable(tableName);
              return;
          default:
              return;
      }
  }, [
      handleCopyStructure,
      handleCopyTable,
      handleCopyTableAsInsert,
      handleCopyTableName,
      handleDeleteTable,
      handleRenameTable,
      handleTableDataDangerAction,
      openExportDialog,
      injectTablePromptToAI,
      loadData,
      openCreateStarRocksRollup,
      openDesign,
      openQueryForTable,
      openTableSQLExportWorkbench,
      openTable,
      openTableDdl,
      openTableInER,
      tables,
      toggleOverviewTablePinned,
  ]);

  const renderV2OverviewTableContextMenu = useCallback((table: TableStatRow) => (
      <V2TableContextMenuView
          tableName={table.name}
          shortcutPlatform={activeShortcutPlatform}
          stats={{
              rowCount: table.rows,
              dataLength: table.dataSize,
              indexLength: table.indexSize,
              engine: table.engine,
          }}
          isPinned={isOverviewTablePinned(pinnedSidebarTables, connection?.id, tab.dbName, schemaName, table.name)}
          supportsTruncate={allowTruncate}
          supportsClear={allowClear}
          supportsCopyTable={supportsCopyTable}
          supportsStarRocksRollup={metadataDialect === 'starrocks'}
          onAction={(action) => {
              setV2ContextMenu(null);
              handleV2TableContextMenuAction(table, action);
          }}
      />
  ), [activeShortcutPlatform, allowClear, allowTruncate, connection?.id, handleV2TableContextMenuAction, metadataDialect, pinnedSidebarTables, schemaName, supportsCopyTable, tab.dbName]);
  return {
    textPrimary, textSecondary, textMuted, accentColor, containerBg, toggleSort, sortMenuItems,
    hasKnownTableSize, getCombinedTableSize, maxCombinedSize, renderToolbarSummary,
    renderV2OverviewTableContextMenu,
  };
};

export type TableOverviewTableActionsApi = ReturnType<typeof useTableOverviewTableActions>;
