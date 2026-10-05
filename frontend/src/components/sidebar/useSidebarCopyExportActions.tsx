import type { SavedConnection } from '../../types';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import { t } from '../../i18n';
import { DBShowCreateTable, ExportTableWithOptions } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message } from 'antd';
import {
  resolveSidebarTableNameForCopy,
  resolveSidebarDatabaseNameForCopy,
} from './sidebarHelpers';
import { resolveCopyObjectNameLabel } from './sidebarCopyObjectName';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { confirmCopyTable } from '../tableCopyAction';
import { resolveSidebarNodeConnectionId } from '../sidebarV2Utils';
import { buildBatchTableExportWorkbenchTab, buildTableExportTab } from '../../utils/tableExportTab';
import { useStore } from '../../store';
import type { UseSidebarObjectActionsArgs } from './useSidebarObjectActions';

export interface UseSidebarCopyExportActionsInput {
  connections: UseSidebarObjectActionsArgs['connections'];
  buildRuntimeConfig: UseSidebarObjectActionsArgs['buildRuntimeConfig'];
  loadTables: UseSidebarObjectActionsArgs['loadTables'];
  getDatabaseNodeRef: UseSidebarObjectActionsArgs['getDatabaseNodeRef'];
  connectionIds: UseSidebarObjectActionsArgs['connectionIds'];
  addTab: UseSidebarObjectActionsArgs['addTab'];
  runExportWithProgress: UseSidebarObjectActionsArgs['runExportWithProgress'];
  openDesign: UseSidebarObjectActionsArgs['openDesign'];
  onDoubleClick: UseSidebarObjectActionsArgs['onDoubleClick'];
  addAIContext: UseSidebarObjectActionsArgs['addAIContext'];
  setAIPanelVisible: UseSidebarObjectActionsArgs['setAIPanelVisible'];
}

export const useSidebarCopyExportActions = ({
  connections, buildRuntimeConfig, loadTables, getDatabaseNodeRef, connectionIds, addTab,
  runExportWithProgress, openDesign, onDoubleClick, addAIContext, setAIPanelVisible,
}: UseSidebarCopyExportActionsInput) => {
  const resolveActionConnection = (connRef: any): SavedConnection | null => {
    const connectionId = String(connRef?.id || connRef?.connectionId || '').trim();
    return connections.find((connection) => connection.id === connectionId)
      || (connRef?.config ? connRef as SavedConnection : null);
  };

  const confirmSidebarMutation = (
    connRef: any,
    target: string,
  ): Promise<boolean> => confirmProductionMutation(
    resolveActionConnection(connRef),
    t('connection.production_risk.action.execute_sql'),
    target,
    t,
  );

  const handleCopyStructure = async (node: any) => {
    const { config, dbName, tableName } = node.dataRef;
    const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, dbName, tableName);
    if (res.success) {
      navigator.clipboard.writeText(res.data as string);
      message.success(t('table_overview.message.copy_structure_success'));
    } else {
      message.error(res.message);
    }
  };

  const handleCopyTableName = async (node: any) => {
    const objectName = resolveSidebarTableNameForCopy(node);
    const label = resolveCopyObjectNameLabel(node);
    if (!objectName) {
      message.warning(t('sidebar.copy_object_name.empty', { label }));
      return;
    }
    try {
      await navigator.clipboard.writeText(objectName);
      message.success(t('sidebar.copy_object_name.copied', { label }));
    } catch (e: any) {
      message.error(t('sidebar.copy_object_name.failed', { label, error: e?.message || String(e) }));
    }
  };

  const handleCopyTable = async (node: any) => {
    const conn = node?.dataRef;
    const tableName = String(conn?.tableName || node?.title || '').trim();
    if (!conn || !tableName) return;
    if (!getDataSourceCapabilities(conn.config).supportsCopyTable) {
      message.warning(t('table_copy.message.unsupported'));
      return;
    }

    if (!await confirmSidebarMutation(
      conn,
      [conn.dbName, tableName].filter(Boolean).join(' / '),
    )) return;
    const config = buildRuntimeConfig(conn, conn.dbName);
    confirmCopyTable({
      config: buildRpcConnectionConfig(config) as any,
      dbName: String(conn.dbName || ''),
      sourceSchemaName: String(conn.schemaName || ''),
      sourceTableName: tableName,
      onSuccess: async () => {
        await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
      },
    });
  };

  const handleCopyDatabaseName = async (node: any) => {
    const databaseName = resolveSidebarDatabaseNameForCopy(node);
    const label = t('sidebar.copy_object_name.label.database');
    if (!databaseName) {
      message.warning(t('sidebar.copy_object_name.empty', { label }));
      return;
    }
    try {
      await navigator.clipboard.writeText(databaseName);
      message.success(t('sidebar.copy_object_name.copied', { label }));
    } catch (e: any) {
      message.error(t('sidebar.copy_object_name.failed', { label, error: e?.message || String(e) }));
    }
  };

  const openTableSQLExportWorkbench = async (node: any, mode: 'backup' | 'dataOnly') => {
    const tableName = String(node?.dataRef?.tableName || node?.title || '').trim();
    if (!tableName) {
      message.warning(t('sidebar.message.table_export_target_missing'));
      return;
    }
    const connectionId = resolveSidebarNodeConnectionId(node, connectionIds)
      || String(node?.dataRef?.id || '').trim();
    const dbName = String(node?.dataRef?.dbName || '').trim();
    const launchKey = `table-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    addTab(buildBatchTableExportWorkbenchTab({
      connectionId,
      dbName,
      initialObjectNames: [tableName],
      contentMode: mode,
      includeDropIfExists: false,
      ...(mode === 'backup' ? { launchKey } : { requestKey: launchKey }),
      title: t('file.backend.dialog.export_table', { table: tableName }),
    }));
  };

  const handleExport = async (node: any, options: { format: string; xlsxMaxRowsPerSheet?: number }) => {
    if (options.format === 'sql') {
      await openTableSQLExportWorkbench(node, 'backup');
      return;
    }
    const { config, dbName, tableName } = node.dataRef;
    const rowCount = Number(node?.dataRef?.rowCount);
    const totalRowsKnown = Number.isFinite(rowCount) && rowCount > 0;
    await runExportWithProgress({
      title: t('file.backend.dialog.export_table', { table: tableName }),
      targetName: tableName,
      format: options.format,
      totalRows: totalRowsKnown ? rowCount : undefined,
      run: (jobId) => ExportTableWithOptions(
        buildRpcConnectionConfig(config) as any,
        dbName,
        tableName,
        {
          ...options,
          jobId,
          totalRowsHint: totalRowsKnown ? rowCount : 0,
          totalRowsKnown,
        } as any,
      ),
    });
  };

  const openExportDialog = async (node: any) => {
    const tableName = String(node?.dataRef?.tableName || node?.title || '').trim();
    if (!tableName) {
      message.warning(t('sidebar.message.table_export_target_missing'));
      return;
    }
    const connectionId = resolveSidebarNodeConnectionId(node, connectionIds) || String(node?.dataRef?.id || '').trim();
    const dbName = String(node?.dataRef?.dbName || '').trim();
    addTab(buildTableExportTab({
      connectionId,
      dbName,
      tableName,
      title: t('file.backend.dialog.export_table', { table: tableName }),
      objectType: node?.type === 'view' ? 'view' : (node?.type === 'materialized-view' ? 'materialized-view' : 'table'),
      schemaName: typeof node?.dataRef?.schemaName === 'string' ? node.dataRef.schemaName : undefined,
      sidebarLocateKey: typeof node?.key === 'string' ? node.key : undefined,
      rowCountByScope: Number.isFinite(Number(node?.dataRef?.rowCount)) && Number(node?.dataRef?.rowCount) > 0
        ? { all: Math.trunc(Number(node.dataRef.rowCount)) }
        : undefined,
    }));
  };

  const handleCopyTableAsInsert = async (node: any) => {
    await openTableSQLExportWorkbench(node, 'dataOnly');
  };

  const openTableDdlInDesigner = (node: any) => {
    openDesign(node, 'ddl', true);
  };

  const openTableInERView = (node: any) => {
    onDoubleClick(null, node);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('gonavi:data-grid:set-view-mode', {
        detail: {
          connectionId: node.dataRef?.id,
          dbName: node.dataRef?.dbName,
          schemaName: String(node.dataRef?.schemaName || '').trim() || undefined,
          tableName: node.dataRef?.tableName,
          viewMode: 'er',
        },
      }));
    }, 0);
  };

  const injectTablePromptToAI = async (node: any, promptKind: 'explain' | 'query') => {
    const conn = node.dataRef;
    const tableName = String(conn?.tableName || node?.title || '').trim();
    if (!conn?.id || !conn?.dbName || !tableName) {
      message.warning(t('sidebar.message.ai_table_context_missing'));
      return;
    }
    const tableRef = `${conn.dbName}.${tableName}`;

    let ddl = '';
    try {
      const res = await DBShowCreateTable(buildRpcConnectionConfig(conn.config) as any, conn.dbName, tableName);
      if (res.success) {
        ddl = String(res.data || '').trim();
        addAIContext(conn.id, { dbName: conn.dbName, tableName, ddl });
      }
    } catch {
      // AI 入口仍可基于表名工作，DDL 获取失败不阻断打开面板。
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
  };
  return {
    confirmSidebarMutation, handleCopyStructure, handleCopyTableName, handleCopyTable,
    handleCopyDatabaseName, handleExport, openExportDialog, handleCopyTableAsInsert,
    openTableDdlInDesigner, openTableInERView, injectTablePromptToAI,
  };
};

export type SidebarCopyExportActionsApi = ReturnType<typeof useSidebarCopyExportActions>;
