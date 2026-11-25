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
import { confirmCopyTables } from '../tableCopyAction';
import { confirmCopyDatabase } from '../databaseCopyAction';
import { resolveSidebarNodeConnectionId } from '../sidebarV2Utils';
import { dispatchSidebarTableCreated } from '../../utils/sidebarDatabaseRefresh';
import { buildBatchTableExportWorkbenchTab, buildTableExportTab } from '../../utils/tableExportTab';
import { useStore } from '../../store';
import type { UseSidebarObjectActionsArgs } from './useSidebarObjectActions';
import type { SidebarTableClipboardTarget } from './useSidebarTableClipboard';

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

  const handleCopyViews = async (
    viewNodes: any[],
    target?: SidebarTableClipboardTarget,
  ) => {
    const conn = viewNodes[0]?.dataRef;
    const viewNames = viewNodes
      .map((node) => String(node?.dataRef?.viewName || node?.title || '').trim())
      .filter(Boolean);
    if (!conn || viewNames.length === 0) return;
    if (target && target.connectionId !== String(conn.id || '')) {
      message.warning(t('sidebar.view_clipboard.same_connection_required'));
      return;
    }
    if (!viewNodes.every((node) => (
      String(node?.dataRef?.id || '') === String(conn.id || '')
      && String(node?.dataRef?.dbName || '') === String(conn.dbName || '')
      && String(node?.dataRef?.schemaName || '') === String(conn.schemaName || '')
    ))) {
      message.warning(t('table_copy.message.mixed_sources'));
      return;
    }
    if (!getDataSourceCapabilities(conn.config).supportsCopyTable) {
      message.warning(t('sidebar.view_clipboard.unsupported'));
      return;
    }
    const copyViewMethod = (window as any).go?.app?.App?.CopyView;
    if (typeof copyViewMethod !== 'function') {
      message.error(t('sidebar.view_clipboard.unsupported'));
      return;
    }

    const targetDBName = String(target?.database || conn.dbName || '').trim();
    const targetSchemaName = String(target?.schema || '').trim();
    const targetLabel = viewNames.length === 1
      ? viewNames[0]
      : t('table_copy.message.selection_count', { count: viewNames.length });
    if (!await confirmSidebarMutation(
      conn,
      [targetDBName, targetSchemaName, targetLabel].filter(Boolean).join(' / '),
    )) return;

    const config = buildRuntimeConfig(conn, targetDBName);
    const copiedTargets: string[] = [];
    for (const viewName of viewNames) {
      const result = await copyViewMethod(
        buildRpcConnectionConfig(config) as any,
        String(conn.dbName || ''),
        String(conn.schemaName || ''),
        viewName,
        targetDBName,
        targetSchemaName,
      );
      if (!result?.success) {
        message.error(result?.message || t('sidebar.view_clipboard.unsupported'));
        return;
      }
      const targetName = String(result.data || '').trim();
      if (targetName) {
        copiedTargets.push(targetName);
        dispatchSidebarTableCreated({
          connectionId: String(conn.id || ''),
          dbName: targetDBName,
          schemaName: targetSchemaName,
          tableName: targetName,
        });
      }
    }
    if (copiedTargets.length === 1) {
      message.success(t('db.backend.message.view_copied', {
        source: viewNames[0],
        target: [targetDBName, targetSchemaName, copiedTargets[0]].filter(Boolean).join('.'),
      }));
    } else if (copiedTargets.length > 1) {
      message.success(t('sidebar.view_clipboard.copy_done_multiple', {
        count: copiedTargets.length,
      }));
    }
  };

  const handleCopyTables = async (
    nodes: any[],
    target?: SidebarTableClipboardTarget,
  ) => {
    const selectedNodes = Array.isArray(nodes) ? nodes : [];
    const viewNodes = selectedNodes.filter((node) => (
      node?.type === 'view' || node?.type === 'materialized-view'
    ));
    if (viewNodes.length > 0) {
      const hasTableNodes = selectedNodes.some((node) => node?.type === 'table');
      if (hasTableNodes) {
        message.warning(t('table_copy.message.mixed_sources'));
        return;
      }
      await handleCopyViews(viewNodes, target);
      return;
    }
    const tableNodes = selectedNodes.filter((node) => {
      const tableName = String(node?.dataRef?.tableName || node?.title || '').trim();
      return Boolean(node?.dataRef && tableName);
    });
    if (tableNodes.length === 0) return;
    const conn = tableNodes[0]?.dataRef;
    const tableNames = tableNodes
      .map((node) => String(node?.dataRef?.tableName || node?.title || '').trim())
      .filter(Boolean);
    if (!conn || tableNames.length === 0) return;
    if (!tableNodes.every((node) => (
      String(node?.dataRef?.id || '') === String(conn?.id || '')
      && String(node?.dataRef?.dbName || '') === String(conn?.dbName || '')
      && String(node?.dataRef?.schemaName || '') === String(conn?.schemaName || '')
    ))) {
      message.warning(t('table_copy.message.mixed_sources'));
      return;
    }
    if (!getDataSourceCapabilities(conn.config).supportsCopyTable) {
      message.warning(t('table_copy.message.unsupported'));
      return;
    }

    const targetLabel = tableNames.length === 1
      ? tableNames[0]
      : t('table_copy.message.selection_count', { count: tableNames.length });
    if (!await confirmSidebarMutation(conn, [conn.dbName, targetLabel].filter(Boolean).join(' / '))) return;
    const config = buildRuntimeConfig(conn, conn.dbName);
    confirmCopyTables({
      config: buildRpcConnectionConfig(config) as any,
      dbName: String(conn.dbName || ''),
      sourceSchemaName: String(conn.schemaName || ''),
      sourceTableNames: tableNames,
      onSuccess: async (targetTableNames) => {
        dispatchSidebarTableCreated({
          connectionId: String(conn.id || ''),
          dbName: String(conn.dbName || ''),
          schemaName: String(conn.schemaName || ''),
          tableName: String(targetTableNames[0] || ''),
        });
      },
    });
  };

  const handleCopyTable = async (
    node: any,
    target?: SidebarTableClipboardTarget,
  ) => handleCopyTables([node], target);

  // 整库复制：与复制表同一套交互（确认 → 执行 → 刷新树）。
  const handleCopyDatabase = async (node: any) => {
    const conn = node?.dataRef;
    if (!conn) return;
    const database = String(node?.title || conn?.dbName || '').trim();
    if (!database) return;
    if (!await confirmSidebarMutation(conn, database)) return;
    const config = buildRuntimeConfig(conn, database);
    confirmCopyDatabase({
      config: buildRpcConnectionConfig(config) as any,
      dbName: database,
      onSuccess: async () => {
        // 新库是同一个连接下的兄弟节点，刷新该节点的表清单即可带出新库。
        await loadTables(getDatabaseNodeRef(conn, database), { ensureFresh: true });
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
    confirmSidebarMutation, handleCopyStructure, handleCopyTableName, handleCopyTable, handleCopyTables,
    handleCopyDatabase, handleCopyDatabaseName, handleExport, openExportDialog, handleCopyTableAsInsert,
    openTableDdlInDesigner, openTableInERView, injectTablePromptToAI,
  };
};

export type SidebarCopyExportActionsApi = ReturnType<typeof useSidebarCopyExportActions>;
