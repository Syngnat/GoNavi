import {
  type TableDataDangerActionKind,
  getTableDataDangerActionMeta,
} from '../tableDataDangerActions';
import Modal from '../common/ResizableDraggableModal';
import { t } from '../../i18n';
import { message } from 'antd';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { resolveNodeSchemaName } from './sidebarObjectActionHelpers';
import {
  getMetadataDialect,
  splitQualifiedName,
  escapeSQLLiteral,
  extractSqlServerDefinitionRows,
} from './sidebarMetadataLoaders';
import type { SavedConnection } from '../../types';
import { buildSqlServerObjectDefinitionQueries } from '../../utils/sqlServerObjectDefinition';
import { DBQuery, DropView, RenameView } from '../../../wailsjs/go/app/App';
import { normalizeMySQLViewDDLForEditing } from '../sidebarCoreUtils';
import { buildStarRocksMaterializedViewPreviewSql } from '../tableDesignerSchemaSql';
import type { SidebarCopyExportActionsApi } from './useSidebarCopyExportActions';
import type { UseSidebarObjectActionsArgs } from './useSidebarObjectActions';

export interface UseSidebarTableAndViewActionsInput {
  buildRuntimeConfig: UseSidebarObjectActionsArgs['buildRuntimeConfig'];
  addSqlLog: UseSidebarObjectActionsArgs['addSqlLog'];
  loadTables: UseSidebarObjectActionsArgs['loadTables'];
  getDatabaseNodeRef: UseSidebarObjectActionsArgs['getDatabaseNodeRef'];
  confirmSidebarMutation: SidebarCopyExportActionsApi['confirmSidebarMutation'];
  addTab: UseSidebarObjectActionsArgs['addTab'];
  renameViewTarget: UseSidebarObjectActionsArgs['renameViewTarget'];
  renameViewForm: UseSidebarObjectActionsArgs['renameViewForm'];
  extractObjectName: UseSidebarObjectActionsArgs['extractObjectName'];
  setIsRenameViewModalOpen: UseSidebarObjectActionsArgs['setIsRenameViewModalOpen'];
  setRenameViewTarget: UseSidebarObjectActionsArgs['setRenameViewTarget'];
}

export const useSidebarTableAndViewActions = ({
  buildRuntimeConfig, addSqlLog, loadTables, getDatabaseNodeRef, confirmSidebarMutation, addTab,
  renameViewTarget, renameViewForm, extractObjectName, setIsRenameViewModalOpen,
  setRenameViewTarget,
}: UseSidebarTableAndViewActionsInput) => {
  const handleTableDataDangerAction = async (node: any, action: TableDataDangerActionKind) => {
    const conn = node.dataRef;
    const tableName = String(conn.tableName || '').trim();
    if (!tableName) return;

    const { label, progressLabel } = getTableDataDangerActionMeta(action);
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t('sidebar.modal.confirm_table_data_action.title', { action: label }),
        content: t('sidebar.modal.confirm_table_data_action.content', { action: label, table: tableName }),
        okText: t('sidebar.action.continue'),
        cancelText: t('common.cancel'),
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;
    if (!await confirmSidebarMutation(conn, [conn.dbName, tableName].filter(Boolean).join(' / '))) return;

    const config = buildRuntimeConfig(conn, conn.dbName);
    const app = (window as any).go.app.App;
    const methodName = action === 'truncate' ? 'TruncateTables' : 'ClearTables';
    const hide = message.loading(t('sidebar.message.table_data_action_loading', {
      action: progressLabel,
      table: tableName,
    }), 0);
    const startTime = Date.now();
    try {
      const res = await app[methodName](buildRpcConnectionConfig(config) as any, conn.dbName, [tableName]);
      hide();
      const duration = Date.now() - startTime;
      const executedSQLs = Array.isArray(res.data?.executedSQLs) ? res.data.executedSQLs : [];
      const logSql = executedSQLs.length > 0
        ? executedSQLs.join(';\n') + ';'
        : `/* ${label} ${tableName} */`;

      if (res.success) {
        addSqlLog({
          id: Date.now().toString(),
          timestamp: Date.now(),
          sql: logSql,
          status: 'success',
          duration,
          message: res.message,
          dbName: conn.dbName,
          affectedRows: res.data?.count || 0,
        });
        await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
        message.success(t('sidebar.message.table_data_action_success', { action: progressLabel }));
        return;
      }

      addSqlLog({
        id: Date.now().toString(),
        timestamp: Date.now(),
        sql: logSql,
        status: 'error',
        duration,
        message: res.message,
        dbName: conn.dbName,
      });
      if (res.message !== '已取消') {
        message.error(t('sidebar.message.table_data_action_failed', {
          action: progressLabel,
          error: res.message,
        }));
      }
    } catch (e: any) {
      const duration = Date.now() - startTime;
      const errMsg = e?.message || String(e);
      hide();
      addSqlLog({
        id: Date.now().toString(),
        timestamp: Date.now(),
        sql: `/* ${label} ${tableName} - ERROR */`,
        status: 'error',
        duration,
        message: errMsg,
        dbName: conn.dbName,
      });
      message.error(t('sidebar.message.table_data_action_failed', {
        action: progressLabel,
        error: errMsg,
      }));
    }
  };

  const openViewDefinition = (node: any) => {
    const { viewName, dbName, id } = node.dataRef;
    const schemaName = resolveNodeSchemaName(node);
    const isMaterialized = node.type === 'materialized-view' || node.dataRef?.objectKind === 'materialized-view';
    addTab({
      id: `view-def-${id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${viewName}`,
      title: t(isMaterialized ? 'sidebar.tab.materialized_view_definition' : 'sidebar.tab.view_definition', { name: viewName }),
      type: 'view-def',
      connectionId: id,
      dbName,
      viewName,
      viewKind: isMaterialized ? 'materialized' : 'view',
      schemaName,
      sidebarLocateKey: String(node.key || ''),
    });
  };

  const openEditView = async (node: any) => {
    const conn = node.dataRef;
    const { viewName, dbName, id } = conn;
    const schemaName = resolveNodeSchemaName(node);
    const dialect = getMetadataDialect(conn as SavedConnection);
    const sqlTemplateHeader = `-- ${t('sidebar.sql_template.edit_view', { name: viewName })}`;
    let template = `${sqlTemplateHeader}\n-- ${t('sidebar.sql_template.modify_then_execute')}\nCREATE OR REPLACE VIEW ${viewName} AS\nSELECT * FROM your_table;`;

    try {
      const config = buildRuntimeConfig(conn, dbName);
      let queries: string[] = [];
      switch (dialect) {
        case 'mysql':
        case 'starrocks':
          queries = [`SHOW CREATE VIEW \`${viewName.replace(/`/g, '``')}\``];
          break;
        case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': case 'opengauss': case 'gaussdb': {
          const parts = splitQualifiedName(viewName);
          const schema = parts.schemaName || 'public';
          const name = parts.objectName || viewName;
          queries = [`SELECT pg_get_viewdef('${escapeSQLLiteral(schema)}.${escapeSQLLiteral(name)}'::regclass, true) AS view_definition`];
          break;
        }
        case 'sqlserver':
          queries = buildSqlServerObjectDefinitionQueries('view', viewName, dbName, 'view_definition');
          break;
        case 'sqlite':
          queries = [`SELECT sql AS view_definition FROM sqlite_master WHERE type='view' AND name='${escapeSQLLiteral(viewName)}'`];
          break;
        case 'duckdb': {
          const parts = splitQualifiedName(viewName);
          const viewSchema = escapeSQLLiteral(parts.schemaName || 'main');
          const viewObject = escapeSQLLiteral(parts.objectName || viewName);
          queries = [`SELECT view_definition FROM information_schema.views WHERE table_schema='${viewSchema}' AND table_name='${viewObject}' LIMIT 1`];
          break;
        }
      }
      for (const query of queries) {
        const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, query);
        if (result.success && Array.isArray(result.data) && result.data.length > 0) {
          const row = result.data[0] as Record<string, any>;
          const def = dialect === 'sqlserver'
            ? extractSqlServerDefinitionRows(result.data, ['view_definition', 'definition'])
            : row.view_definition || row.VIEW_DEFINITION || Object.values(row).find(v => typeof v === 'string' && String(v).length > 10) || '';
          if (def) {
            if (dialect === 'mysql') {
              template = `${sqlTemplateHeader}\n${normalizeMySQLViewDDLForEditing(viewName, def)}`;
            } else if (dialect === 'sqlserver') {
              template = /^\s*create\s+view\b/i.test(String(def))
                ? `${sqlTemplateHeader}\n${def}`
                : `${sqlTemplateHeader}\nCREATE VIEW ${viewName} AS\n${def}`;
            } else {
              template = `${sqlTemplateHeader}\nCREATE OR REPLACE VIEW ${viewName} AS\n${def}`;
            }
            break;
          }
        }
      }
    } catch { /* 降级使用模板 */ }

    addTab({
      id: `query-edit-view-${Date.now()}`,
      title: t('sidebar.tab.edit_view', { name: viewName }),
      type: 'query',
      connectionId: id,
      dbName,
      query: template,
      queryMode: 'object-edit',
      viewName,
      schemaName,
      objectType: 'view',
      sidebarLocateKey: String(node.key || ''),
    });
  };

  const openCreateView = (node: any) => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
    const schemaName = resolveNodeSchemaName(node);
    const dialect = getMetadataDialect(conn as SavedConnection);
    let template: string;
    switch (dialect) {
      case 'mysql':
      case 'starrocks':
        template = `CREATE VIEW \`view_name\` AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
        break;
      case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': case 'opengauss': case 'gaussdb':
        template = `CREATE OR REPLACE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
        break;
      case 'sqlserver':
        template = `CREATE VIEW dbo.view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
        break;
      case 'oracle': case 'dm':
        template = `CREATE OR REPLACE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
        break;
      case 'sqlite':
      case 'duckdb':
        template = `CREATE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
        break;
      default:
        template = `CREATE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
    }
    addTab({
      id: `query-create-view-${Date.now()}`,
      title: t('sidebar.tab.create_view'),
      type: 'query',
      connectionId: id,
      dbName,
      schemaName,
      query: template,
    });
  };

  const openCreateStarRocksMaterializedView = (node: any) => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
    const schemaName = resolveNodeSchemaName(node);
    const schemaPrefix = String(conn.schemaName || dbName || '').trim();
    const mvName = schemaPrefix ? `${schemaPrefix}.mv_name` : 'mv_name';
    const template = buildStarRocksMaterializedViewPreviewSql({
      name: mvName,
      query: 'SELECT\n  column1,\n  COUNT(*) AS cnt\nFROM table_name\nGROUP BY column1',
      distributionColumnNames: ['column1'],
      refreshClause: 'REFRESH ASYNC',
      properties: '"replication_num" = "1"',
    });
    addTab({
      id: `query-create-starrocks-mv-${Date.now()}`,
      title: t('sidebar.v2_database_menu.new_materialized_view'),
      type: 'query',
      connectionId: id,
      dbName,
      schemaName,
      query: template,
    });
  };

  const openCreateStarRocksExternalCatalog = (node: any) => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
    addTab({
      id: `query-create-starrocks-catalog-${Date.now()}`,
      title: t('sidebar.v2_database_menu.new_external_catalog'),
      type: 'query',
      connectionId: id,
      dbName,
      query: `CREATE EXTERNAL CATALOG catalog_name\nPROPERTIES (\n  "type" = "hive",\n  "hive.metastore.uris" = "thrift://127.0.0.1:9083"\n);`,
    });
  };

  const openCreateStarRocksRollup = (node: any) => {
    const conn = node.dataRef;
    const { tableName, dbName, id } = conn;
    const schemaName = resolveNodeSchemaName(node);
    const safeTable = String(tableName || 'table_name').trim();
    const safeTableParts = [splitQualifiedName(safeTable).schemaName, splitQualifiedName(safeTable).objectName].filter(Boolean);
    const quotedTable = safeTable.includes('`')
      ? safeTable
      : (safeTableParts.length > 0 ? safeTableParts : [safeTable]).map(part => `\`${part.replace(/`/g, '``')}\``).join('.');
    addTab({
      id: `query-create-starrocks-rollup-${Date.now()}`,
      title: t('sidebar.v2_table_menu.new_rollup', { keyword: 'Rollup' }),
      type: 'query',
      connectionId: id,
      dbName,
      schemaName,
      query: `ALTER TABLE ${quotedTable}\nADD ROLLUP rollup_name (column1, column2);`,
    });
  };

  const handleDropView = (node: any) => {
    const conn = node.dataRef;
    const viewName = String(conn.viewName || '').trim();
    if (!viewName) return;
    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_view.title'),
      content: t('sidebar.modal.confirm_delete_view.content', { name: viewName }),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await confirmSidebarMutation(conn, [conn.dbName, viewName].filter(Boolean).join(' / '))) return;
        const config = buildRuntimeConfig(conn, conn.dbName);
        const res = await DropView(buildRpcConnectionConfig(config) as any, conn.dbName, viewName);
        if (res.success) {
          await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
          message.success(t('sidebar.message.view_deleted'));
        } else {
          message.error(t('sidebar.message.delete_failed', { error: res.message }));
        }
      },
    });
  };

  const handleRenameView = async () => {
    if (!renameViewTarget) return;
    try {
      const values = await renameViewForm.validateFields();
      const conn = renameViewTarget.dataRef;
      const oldViewName = String(conn.viewName || '').trim();
      const newViewName = String(values.newName || '').trim();
      if (!oldViewName || !newViewName) {
        message.error(t('sidebar.message.view_name_required'));
        return;
      }
      if (extractObjectName(oldViewName) === newViewName || oldViewName === newViewName) {
        message.warning(t('sidebar.message.view_name_unchanged'));
        return;
      }
      if (!await confirmSidebarMutation(conn, [conn.dbName, `${oldViewName} -> ${newViewName}`].filter(Boolean).join(' / '))) return;
      const config = buildRuntimeConfig(conn, conn.dbName);
      const res = await RenameView(buildRpcConnectionConfig(config) as any, conn.dbName, oldViewName, newViewName);
      if (res.success) {
        await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
        setIsRenameViewModalOpen(false);
        setRenameViewTarget(null);
        renameViewForm.resetFields();
        message.success(t('sidebar.message.view_renamed'));
      } else {
        message.error(t('sidebar.message.rename_failed', { error: res.message }));
      }
    } catch (e) {
      // Validate failed
    }
  };
  return {
    handleTableDataDangerAction, openViewDefinition, openEditView, openCreateView,
    openCreateStarRocksMaterializedView, openCreateStarRocksExternalCatalog,
    openCreateStarRocksRollup, handleDropView, handleRenameView,
  };
};

export type SidebarTableAndViewActionsApi = ReturnType<typeof useSidebarTableAndViewActions>;
