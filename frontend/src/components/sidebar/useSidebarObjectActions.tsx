import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { message } from 'antd';
import type { FormInstance } from 'antd/es/form';

import Modal from '../common/ResizableDraggableModal';
import { showCountdownDangerConfirm } from '../common/countdownDangerConfirm';
import type { SavedConnection, SavedQuery } from '../../types';
import { useStore } from '../../store';
import { t } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { buildBatchTableExportWorkbenchTab, buildTableExportTab } from '../../utils/tableExportTab';
import { buildSqlServerObjectDefinitionQueries } from '../../utils/sqlServerObjectDefinition';
import { buildStarRocksMaterializedViewPreviewSql } from '../tableDesignerSchemaSql';
import type { ExportRunResult, RunExportWithProgressOptions } from '../useExportProgressRunner';
import { getTableDataDangerActionMeta, type TableDataDangerActionKind } from '../tableDataDangerActions';
import { confirmCopyTable } from '../tableCopyAction';
import type { DatabaseCharsetOption, DatabaseCollationOption } from '../../utils/databaseCharset';
import {
  buildDuckDBMacroDDL,
  escapeSQLLiteral,
  extractSqlServerDefinitionRows,
  getCaseInsensitiveRawValue,
  getMetadataDialect,
  splitQualifiedName,
} from './sidebarMetadataLoaders';
import {
  resolveSidebarDatabaseNameForCopy,
  resolveSidebarTableNameForCopy,
} from './sidebarHelpers';
import type { SidebarTreeLoadOptions } from './useSidebarTreeLoaders';
import { normalizeMySQLViewDDLForEditing } from '../sidebarCoreUtils';
import {
  DBQuery,
  DBShowCreateTable,
  CreateDatabase,
  CreateSchema,
  DropDatabase,
  DropFunction,
  DropTable,
  DropView,
  ExportTableWithOptions,
  ListDatabaseCharsets,
  ListDatabaseCollations,
  RenameDatabase,
  RenameTable,
  RenameView,
  RevealSavedQueryInFolder,
} from '../../../wailsjs/go/app/App';
import { resolveSidebarNodeConnectionId, type SidebarTreeNode as TreeNode } from '../sidebarV2Utils';

export type SidebarMessagePublishTarget = {
  connection: SavedConnection;
  executionDbName: string;
  destination: string;
};

type RunExportWithProgress = <T extends ExportRunResult>(
  options: RunExportWithProgressOptions<T>,
) => Promise<T | null>;

type UseSidebarObjectActionsArgs = {
  connections: SavedConnection[];
  connectionIds: string[];
  connectionIdSet: Set<string>;
  tabs: any[];
  treeDataRef: MutableRefObject<TreeNode[]>;
  setTreeData: Dispatch<SetStateAction<TreeNode[]>>;
  setExpandedKeys: Dispatch<SetStateAction<React.Key[]>>;
  setLoadedKeys: Dispatch<SetStateAction<React.Key[]>>;
  addTab: (tab: any) => void;
  updateQueryTabDraft: (tabId: string, draft: any) => void;
  saveQuery: (query: SavedQuery) => Promise<SavedQuery>;
  addSqlLog: (log: any) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  createDbForm: FormInstance;
  targetConnection: any;
  isCreateDbModalOpen: boolean;
  setIsCreateDbModalOpen: Dispatch<SetStateAction<boolean>>;
  createDbCharsets: DatabaseCharsetOption[];
  setCreateDbCharsets: Dispatch<SetStateAction<DatabaseCharsetOption[]>>;
  createDbCollations: DatabaseCollationOption[];
  setCreateDbCollations: Dispatch<SetStateAction<DatabaseCollationOption[]>>;
  loadingCreateDbOptions: boolean;
  setLoadingCreateDbOptions: Dispatch<SetStateAction<boolean>>;
  createSchemaForm: FormInstance;
  createSchemaTarget: any;
  setCreateSchemaTarget: Dispatch<SetStateAction<any>>;
  setIsCreateSchemaModalOpen: Dispatch<SetStateAction<boolean>>;
  renameSchemaForm: FormInstance;
  renameSchemaTarget: any;
  setRenameSchemaTarget: Dispatch<SetStateAction<any>>;
  setIsRenameSchemaModalOpen: Dispatch<SetStateAction<boolean>>;
  renameDbForm: FormInstance;
  renameDbTarget: any;
  setRenameDbTarget: Dispatch<SetStateAction<any>>;
  setIsRenameDbModalOpen: Dispatch<SetStateAction<boolean>>;
  renameTableForm: FormInstance;
  renameTableTarget: any;
  setRenameTableTarget: Dispatch<SetStateAction<any>>;
  setIsRenameTableModalOpen: Dispatch<SetStateAction<boolean>>;
  renameViewForm: FormInstance;
  renameViewTarget: any;
  setRenameViewTarget: Dispatch<SetStateAction<any>>;
  setIsRenameViewModalOpen: Dispatch<SetStateAction<boolean>>;
  renameSavedQueryForm: FormInstance;
  renameSavedQueryTarget: SavedQuery | null;
  setRenameSavedQueryTarget: Dispatch<SetStateAction<SavedQuery | null>>;
  setIsRenameSavedQueryModalOpen: Dispatch<SetStateAction<boolean>>;
  setMessagePublishTarget: Dispatch<SetStateAction<SidebarMessagePublishTarget | null>>;
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  getConnectionNodeRef: (connRef: any) => any;
  getDatabaseNodeRef: (connRef: any, dbName: string) => any;
  extractObjectName: (fullName: string) => string;
  isPostgresSchemaDialect: (dialect: string) => boolean;
  loadDatabases: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  loadTables: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  openDesign: (node: any, initialTab: string, readOnly?: boolean) => void;
  onDoubleClick: (event: any, node: any) => void;
  runExportWithProgress: RunExportWithProgress;
  setAIPanelVisible: (visible: boolean) => void;
  addAIContext: (connectionId: string, context: { dbName: string; tableName: string; ddl: string }) => void;
  migrateSchemaVisibilityForRenamedDatabase: (
    connection: SavedConnection,
    oldDbName: string,
    newDbName: string,
  ) => Promise<SavedConnection>;
};

const resolveCopyObjectNameLabel = (node: any): string => {
  if (node?.type === 'view') return t('sidebar.copy_object_name.label.view');
  if (node?.type === 'materialized-view') return t('sidebar.copy_object_name.label.materialized_view');
  if (node?.type === 'sequence') return t('sidebar.copy_object_name.label.sequence');
  if (node?.type === 'package') return t('sidebar.copy_object_name.label.package');
  if (node?.type === 'db-event') return t('sidebar.copy_object_name.label.event');
  return t('sidebar.copy_object_name.label.table');
};

const quoteMySqlIdentifier = (raw: string): string => `\`${String(raw || '').replace(/`/g, '``')}\``;

const buildMySqlEventReference = (eventName: string, schemaName?: string): string => {
  const parsed = splitQualifiedName(eventName);
  const name = parsed.objectName || eventName;
  const schema = parsed.schemaName || String(schemaName || '').trim();
  return [schema, name]
    .filter(Boolean)
    .map(quoteMySqlIdentifier)
    .join('.');
};

const ensureSidebarObjectEditSqlTerminator = (sql: string): string => {
  const normalized = String(sql || '').trim();
  if (!normalized) return '';
  return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

const extractMySqlEventCreateSql = (rows: any[]): string => {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  for (const row of rows) {
    const keys = Object.keys(row || {});
    const sqlKey = keys.find(key => key.toLowerCase().includes('create event'));
    if (!sqlKey) continue;
    const definition = row[sqlKey];
    if (definition !== undefined && definition !== null && String(definition).trim()) {
      return String(definition);
    }
  }
  return '';
};

export const useSidebarObjectActions = ({
  connections,
  connectionIds,
  connectionIdSet,
  tabs,
  treeDataRef,
  setTreeData,
  setExpandedKeys,
  setLoadedKeys,
  addTab,
  updateQueryTabDraft,
  saveQuery,
  addSqlLog,
  closeTabsByDatabase,
  createDbForm,
  targetConnection,
  isCreateDbModalOpen,
  setIsCreateDbModalOpen,
  createDbCharsets,
  setCreateDbCharsets,
  createDbCollations,
  setCreateDbCollations,
  loadingCreateDbOptions,
  setLoadingCreateDbOptions,
  createSchemaForm,
  createSchemaTarget,
  setCreateSchemaTarget,
  setIsCreateSchemaModalOpen,
  renameSchemaForm,
  renameSchemaTarget,
  setRenameSchemaTarget,
  setIsRenameSchemaModalOpen,
  renameDbForm,
  renameDbTarget,
  setRenameDbTarget,
  setIsRenameDbModalOpen,
  renameTableForm,
  renameTableTarget,
  setRenameTableTarget,
  setIsRenameTableModalOpen,
  renameViewForm,
  renameViewTarget,
  setRenameViewTarget,
  setIsRenameViewModalOpen,
  renameSavedQueryForm,
  renameSavedQueryTarget,
  setRenameSavedQueryTarget,
  setIsRenameSavedQueryModalOpen,
  setMessagePublishTarget,
  buildRuntimeConfig,
  getConnectionNodeRef,
  getDatabaseNodeRef,
  extractObjectName,
  isPostgresSchemaDialect,
  loadDatabases,
  loadTables,
  openDesign,
  onDoubleClick,
  runExportWithProgress,
  setAIPanelVisible,
  addAIContext,
  migrateSchemaVisibilityForRenamedDatabase,
}: UseSidebarObjectActionsArgs) => {
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

  const handleCreateDatabase = async () => {
    try {
      const values = await createDbForm.validateFields();
      const conn = targetConnection.dataRef;
      const config = {
        ...conn.config,
        port: Number(conn.config.port),
        password: conn.config.password || '',
        database: (conn.config.type === 'oracle' || conn.config.type === 'dameng') ? (conn.config.database || '') : '',
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
      };
      if (!await confirmSidebarMutation(conn, values.name)) return;

      const res = await CreateDatabase(
        buildRpcConnectionConfig(config) as any,
        values.name,
        String(values.charset || ''),
        String(values.collation || ''),
      );
      if (res.success) {
        setIsCreateDbModalOpen(false);
        createDbForm.resetFields();
        await loadDatabases(targetConnection, { ensureFresh: true });
        message.success(t('sidebar.message.database_created'));
      } else {
        message.error(t('sidebar.message.operation_create_failed', { error: res.message }));
      }
    } catch (e) {
      // Validate failed
    }
  };

  useEffect(() => {
    if (!isCreateDbModalOpen || !targetConnection?.dataRef?.config) return;
    if (!getDataSourceCapabilities(targetConnection.dataRef.config).supportsCreateDatabaseCharset) return;
    let cancelled = false;
    const conn = targetConnection.dataRef;
    const config = {
      ...conn.config,
      port: Number(conn.config.port),
      password: conn.config.password || '',
      database: '',
      useSSH: conn.config.useSSH || false,
      ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };
    setLoadingCreateDbOptions(true);
    Promise.all([
      ListDatabaseCharsets(buildRpcConnectionConfig(config) as any),
      ListDatabaseCollations(buildRpcConnectionConfig(config) as any),
    ])
      .then(([charsetsResult, collationsResult]) => {
        if (cancelled) return;
        if (charsetsResult?.success) {
          setCreateDbCharsets(Array.isArray(charsetsResult.data) ? charsetsResult.data : []);
        }
        if (collationsResult?.success) {
          setCreateDbCollations(Array.isArray(collationsResult.data) ? collationsResult.data : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          message.error(t('sidebar.message.create_db_options_load_failed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCreateDbOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCreateDbModalOpen, targetConnection, t]);

  const openCreateSchemaModal = (node: any) => {
    const dialect = getMetadataDialect(node?.dataRef as SavedConnection);
    if (!isPostgresSchemaDialect(dialect)) {
      message.warning(t('sidebar.message.schema_create_unsupported'));
      return;
    }
    setCreateSchemaTarget(node);
    createSchemaForm.resetFields();
    setIsCreateSchemaModalOpen(true);
  };

  const handleCreateSchema = async () => {
    try {
      const values = await createSchemaForm.validateFields();
      const node = createSchemaTarget;
      const conn = node?.dataRef;
      const dbName = String(conn?.dbName || node?.title || '').trim();
      if (!conn || !dbName) {
        message.error(t('sidebar.message.schema_target_missing'));
        return;
      }
      if (!await confirmSidebarMutation(conn, [dbName, values.name].filter(Boolean).join(' / '))) return;

      const res = await CreateSchema(buildRpcConnectionConfig(conn.config, { database: dbName }) as any, dbName, values.name);
      if (res.success) {
        setIsCreateSchemaModalOpen(false);
        setCreateSchemaTarget(null);
        createSchemaForm.resetFields();
        await loadTables(node, { ensureFresh: true });
        message.success(t('sidebar.message.schema_created'));
      } else {
        message.error(t('sidebar.message.operation_create_failed', { error: res.message }));
      }
    } catch (e) {
      // Validate failed
    }
  };

  const openRenameSchemaModal = (node: any) => {
    const dialect = getMetadataDialect(node?.dataRef as SavedConnection);
    const schemaName = String(node?.dataRef?.schemaName || '').trim();
    if (!isPostgresSchemaDialect(dialect) || !schemaName) {
      message.warning(t('sidebar.message.schema_edit_unsupported'));
      return;
    }
    setRenameSchemaTarget(node);
    renameSchemaForm.setFieldsValue({ newName: schemaName });
    setIsRenameSchemaModalOpen(true);
  };

  const handleRenameSchema = async () => {
    try {
      const values = await renameSchemaForm.validateFields();
      const node = renameSchemaTarget;
      const conn = node?.dataRef;
      const dbName = String(conn?.dbName || '').trim();
      const oldSchemaName = String(conn?.schemaName || '').trim();
      const newSchemaName = String(values?.newName || '').trim();
      if (!conn || !dbName || !oldSchemaName || !newSchemaName) {
        message.error(t('sidebar.message.schema_target_edit_missing'));
        return;
      }
      if (oldSchemaName === newSchemaName) {
        message.warning(t('sidebar.message.schema_name_unchanged'));
        return;
      }
      if (!await confirmSidebarMutation(conn, [dbName, oldSchemaName, newSchemaName].filter(Boolean).join(' / '))) return;

      const res = await (window as any).go.app.App.RenameSchema(
        buildRpcConnectionConfig(conn.config, { database: dbName }) as any,
        dbName,
        oldSchemaName,
        newSchemaName,
      );
      if (res.success) {
        const schemaKeyPrefix = `${conn.id}-${dbName}-schema-${oldSchemaName || 'default'}`;
        setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(schemaKeyPrefix)));
        setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(schemaKeyPrefix)));
        await loadTables(getDatabaseNodeRef(conn, dbName), { ensureFresh: true });
        setIsRenameSchemaModalOpen(false);
        setRenameSchemaTarget(null);
        renameSchemaForm.resetFields();
        message.success(t('sidebar.message.schema_renamed'));
      } else {
        message.error(t('sidebar.message.rename_failed', { error: res.message }));
      }
    } catch (e) {
      // Validate failed
    }
  };

  const handleDeleteSchema = (node: any) => {
    const conn = node?.dataRef;
    const dbName = String(conn?.dbName || '').trim();
    const schemaName = String(conn?.schemaName || '').trim();
    if (!conn || !dbName || !schemaName) {
      message.error(t('sidebar.message.schema_target_delete_missing'));
      return;
    }
    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_schema.title'),
      content: t('sidebar.modal.confirm_delete_schema.content', { name: schemaName }),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await confirmSidebarMutation(conn, [dbName, schemaName].filter(Boolean).join(' / '))) return;
        const res = await (window as any).go.app.App.DropSchema(
          buildRpcConnectionConfig(conn.config, { database: dbName }) as any,
          dbName,
          schemaName,
        );
        if (res.success) {
          const schemaKeyPrefix = `${conn.id}-${dbName}-schema-${schemaName || 'default'}`;
          setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(schemaKeyPrefix)));
          setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(schemaKeyPrefix)));
          await loadTables(getDatabaseNodeRef(conn, dbName), { ensureFresh: true });
          message.success(t('sidebar.message.schema_deleted'));
        } else {
          message.error(t('sidebar.message.delete_failed', { error: res.message }));
        }
      },
    });
  };

  const handleRenameDatabase = async () => {
    if (!renameDbTarget) return;
    try {
      const values = await renameDbForm.validateFields();
      const conn = renameDbTarget.dataRef;
      const oldDbName = String(conn.dbName || '').trim();
      const newDbName = String(values.newName || '').trim();
      if (!oldDbName || !newDbName) {
        message.error(t('sidebar.message.database_name_required'));
        return;
      }
      if (oldDbName === newDbName) {
        message.warning(t('sidebar.message.database_name_unchanged'));
        return;
      }
      if (!await confirmSidebarMutation(conn, `${oldDbName} -> ${newDbName}`)) return;

      const config = buildRuntimeConfig(conn, conn.dbName);
      const res = await RenameDatabase(buildRpcConnectionConfig(config) as any, oldDbName, newDbName);
      if (res.success) {
        const migratedConnection = await migrateSchemaVisibilityForRenamedDatabase(
          conn as SavedConnection,
          oldDbName,
          newDbName,
        );
        setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${oldDbName}`)));
        setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${oldDbName}`)));
        await loadDatabases(
          { key: migratedConnection.id, dataRef: migratedConnection },
          { ensureFresh: true },
        );
        setIsRenameDbModalOpen(false);
        setRenameDbTarget(null);
        renameDbForm.resetFields();
        message.success(t('sidebar.message.database_renamed'));
      } else {
        message.error(t('sidebar.message.operation_rename_failed', { error: res.message }));
      }
    } catch (e) {
      // Validate failed
    }
  };

  const handleDeleteDatabase = (node: any) => {
    const conn = node.dataRef;
    const dbName = String(conn.dbName || '').trim();
    if (!dbName) return;
    showCountdownDangerConfirm({
      title: t('sidebar.modal.confirm_delete_database.title'),
      content: t('sidebar.modal.confirm_delete_database.content', { name: dbName }),
      onOk: async () => {
        if (!await confirmSidebarMutation(conn, dbName)) return;
        const config = buildRuntimeConfig(conn, conn.dbName);
        const res = await DropDatabase(buildRpcConnectionConfig(config) as any, dbName);
        if (res.success) {
          closeTabsByDatabase(conn.id, dbName);
          setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${dbName}`)));
          setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${dbName}`)));
          await loadDatabases(getConnectionNodeRef(conn), { ensureFresh: true });
          message.success(t('sidebar.message.database_deleted'));
        } else {
          message.error(t('sidebar.message.operation_drop_failed', { error: res.message }));
        }
      },
    });
  };

  const handleRenameTable = async () => {
    if (!renameTableTarget) return;
    try {
      const values = await renameTableForm.validateFields();
      const conn = renameTableTarget.dataRef;
      const oldTableName = String(conn.tableName || '').trim();
      const newTableName = String(values.newName || '').trim();
      if (!oldTableName || !newTableName) {
        message.error(t('sidebar.message.table_name_required'));
        return;
      }
      if (extractObjectName(oldTableName) === newTableName || oldTableName === newTableName) {
        message.warning(t('sidebar.message.table_name_unchanged'));
        return;
      }
      if (!await confirmSidebarMutation(conn, [conn.dbName, `${oldTableName} -> ${newTableName}`].filter(Boolean).join(' / '))) return;
      const config = buildRuntimeConfig(conn, conn.dbName);
      const res = await RenameTable(buildRpcConnectionConfig(config) as any, conn.dbName, oldTableName, newTableName);
      if (res.success) {
        await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
        setIsRenameTableModalOpen(false);
        setRenameTableTarget(null);
        renameTableForm.resetFields();
        message.success(t('sidebar.message.table_renamed'));
      } else {
        message.error(t('sidebar.message.rename_failed', { error: res.message }));
      }
    } catch (e) {
      // Validate failed
    }
  };

  const handleDeleteTable = (node: any) => {
    const conn = node.dataRef;
    const tableName = String(conn.tableName || '').trim();
    if (!tableName) return;
    showCountdownDangerConfirm({
      title: t('sidebar.modal.confirm_delete_table.title'),
      content: t('sidebar.modal.confirm_delete_table.content', { name: tableName }),
      onOk: async () => {
        if (!await confirmSidebarMutation(conn, [conn.dbName, tableName].filter(Boolean).join(' / '))) return;
        const config = buildRuntimeConfig(conn, conn.dbName);
        const res = await DropTable(buildRpcConnectionConfig(config) as any, conn.dbName, tableName);
        if (res.success) {
          await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
          message.success(t('sidebar.message.table_deleted'));
        } else {
          message.error(t('sidebar.message.delete_failed', { error: res.message }));
        }
      },
    });
  };

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
    const { viewName, dbName, id, schemaName } = node.dataRef;
    const isMaterialized = node.type === 'materialized-view' || node.dataRef?.objectKind === 'materialized-view';
    addTab({
      id: `view-def-${id}-${dbName}-${viewName}`,
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
      objectType: 'view',
    });
  };

  const openCreateView = (node: any) => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
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
      query: template,
    });
  };

  const openCreateStarRocksMaterializedView = (node: any) => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
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

  const openRenameSavedQueryModal = (query: SavedQuery) => {
    setRenameSavedQueryTarget(query);
    renameSavedQueryForm.setFieldsValue({ name: query.name || t('query_editor.save_modal.unnamed') });
    setIsRenameSavedQueryModalOpen(true);
  };

  const handleRenameSavedQuery = async () => {
    if (!renameSavedQueryTarget) return;
    try {
      const values = await renameSavedQueryForm.validateFields();
      const nextName = String(values.name || '').trim();
      if (!nextName) {
        message.error(t('query_editor.save_modal.name_required'));
        return;
      }
      if (nextName === renameSavedQueryTarget.name) {
        message.warning(t('sidebar.message.saved_query_name_unchanged'));
        return;
      }

      const backendApp = (window as any).go?.app?.App;
      let persisted: SavedQuery;
      if (typeof backendApp?.RenameSavedQuery === 'function') {
        const renamed = await backendApp.RenameSavedQuery(renameSavedQueryTarget.id, nextName);
        persisted = {
          ...renameSavedQueryTarget,
          ...(renamed || {}),
          name: String(renamed?.name || nextName),
        };
        const latestState = useStore.getState();
        latestState.replaceSavedQueries(latestState.savedQueries.map(query => (
          query.id === persisted.id ? { ...query, ...persisted } : query
        )));
      } else {
        persisted = await saveQuery({
          ...renameSavedQueryTarget,
          name: nextName,
        });
      }
      const updateSavedQueryNode = (list: TreeNode[]): TreeNode[] =>
        list.map(node => {
          if (node.type === 'saved-query' && node.dataRef?.id === renameSavedQueryTarget.id) {
            return {
              ...node,
              title: persisted.name,
              dataRef: { ...(node.dataRef || renameSavedQueryTarget), ...persisted },
            };
          }
          return node.children ? { ...node, children: updateSavedQueryNode(node.children) } : node;
        });
      const nextTreeData = updateSavedQueryNode(treeDataRef.current);
      treeDataRef.current = nextTreeData;
      setTreeData(nextTreeData);
      tabs
        .filter(tab => tab.type === 'query' && (tab.savedQueryId === renameSavedQueryTarget.id || tab.id === renameSavedQueryTarget.id))
        .forEach(tab => updateQueryTabDraft(tab.id, { title: persisted.name }));
      message.success(t('sidebar.message.saved_query_renamed'));
      setIsRenameSavedQueryModalOpen(false);
      setRenameSavedQueryTarget(null);
      renameSavedQueryForm.resetFields();
    } catch (e) {
      message.error(t('sidebar.message.saved_query_rename_failed', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  const handleRevealSavedQueryInFolder = useCallback(async (query: SavedQuery) => {
    if (!query?.id) return;
    try {
      const res = await RevealSavedQueryInFolder(query.id);
      if (res?.success) {
        message.success(res.message || t('sidebar.message.saved_query_revealed'));
        return;
      }
      message.error(res?.message || t('sidebar.message.saved_query_reveal_failed', {
        error: t('common.unknown'),
      }));
    } catch (error) {
      message.error(t('sidebar.message.saved_query_reveal_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const isSavedQueryUnmatched = useCallback((query: SavedQuery): boolean => {
    return query.bindingStatus === 'orphan' || !connectionIdSet.has(query.connectionId);
  }, [connectionIdSet]);

  const handleRebindSavedQuery = useCallback(async (query: SavedQuery, target: SavedConnection) => {
    if (!query?.id || !target?.id) return;
    try {
      const backendApp = (window as any).go?.app?.App;
      let persisted: SavedQuery;
      if (typeof backendApp?.RebindSavedQuery === 'function') {
        persisted = await backendApp.RebindSavedQuery(query.id, target.id);
        await saveQuery(persisted);
      } else {
        persisted = await saveQuery({
          ...query,
          connectionId: target.id,
          originalConnectionId: query.originalConnectionId || query.connectionId,
          bindingStatus: 'active',
        });
      }
      message.success(t('sidebar.message.saved_query_rebind_success', {
        name: target.name || target.id,
      }));
      tabs
        .filter(tab => tab.type === 'query' && (tab.savedQueryId === query.id || tab.id === query.id))
        .forEach(tab => updateQueryTabDraft(tab.id, {
          title: persisted.name,
          connectionId: persisted.connectionId,
          dbName: persisted.dbName,
        }));
    } catch (error) {
      message.error(t('sidebar.message.saved_query_rebind_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [saveQuery, tabs, updateQueryTabDraft]);

  const openRoutineDefinition = (node: any) => {
    const { routineName, routineType, dbName, id } = node.dataRef;
    const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
    addTab({
      id: `routine-def-${id}-${dbName}-${routineName}`,
      title: t('sidebar.tab.routine_definition', { type: typeLabel, name: routineName }),
      type: 'routine-def',
      connectionId: id,
      dbName,
      routineName,
      routineType,
    });
  };

  const openEventDefinition = (node: any) => {
    const { eventName, dbName, id } = node.dataRef;
    addTab({
      id: `event-def-${id}-${dbName}-${eventName}`,
      title: t('sidebar.tab.event', { name: eventName }),
      type: 'event-def',
      connectionId: id,
      dbName,
      eventName,
    });
  };

  const openEditEvent = async (node: any) => {
    const conn = node.dataRef;
    const eventName = String(conn?.eventName || '').trim();
    const dbName = String(conn?.dbName || '').trim();
    const id = String(conn?.id || '').trim();
    if (!eventName) return;

    const objectLabel = t('definition_viewer.object.event');
    const header = [
      `-- ${t('definition_viewer.edit.comment_title', { object: objectLabel, name: eventName })}`,
      `-- ${t('definition_viewer.edit.comment_compatibility')}`,
    ].join('\n') + '\n';
    let template = `${header}-- ${t('definition_viewer.edit.comment_empty_definition', { name: eventName })}\n`;

    try {
      const dialect = getMetadataDialect(conn as SavedConnection);
      if (dialect === 'mysql') {
        const config = buildRuntimeConfig(conn, dbName);
        const eventRef = buildMySqlEventReference(eventName, conn?.schemaName || dbName);
        const result = await DBQuery(
          buildRpcConnectionConfig(config) as any,
          dbName,
          `SHOW CREATE EVENT ${eventRef}`,
        );
        if (result.success) {
          const createSql = extractMySqlEventCreateSql(result.data as any[]);
          if (createSql) {
            template = `${header}${ensureSidebarObjectEditSqlTerminator(createSql)}`;
          }
        }
      }
    } catch {
      // 降级使用空编辑模板，避免把 SHOW 语句当成可编辑定义。
    }

    addTab({
      id: `query-edit-event-${Date.now()}`,
      title: t('sidebar.tab.edit_event', { name: eventName }),
      type: 'query',
      connectionId: id,
      dbName,
      query: template,
      queryMode: 'object-edit',
    });
  };

  const openSequenceDefinition = (node: any) => {
    const { sequenceName, dbName, id } = node.dataRef;
    addTab({
      id: `sequence-def-${id}-${dbName}-${sequenceName}`,
      title: t('sidebar.tab.sequence_definition', { name: sequenceName }),
      type: 'sequence-def',
      connectionId: id,
      dbName,
      sequenceName,
    });
  };

  const openPackageDefinition = (node: any) => {
    const { packageName, dbName, id } = node.dataRef;
    addTab({
      id: `package-def-${id}-${dbName}-${packageName}`,
      title: t('sidebar.tab.package_definition', { name: packageName }),
      type: 'package-def',
      connectionId: id,
      dbName,
      packageName,
    });
  };

  const openEditRoutine = async (node: any) => {
    const conn = node.dataRef;
    const { routineName, routineType, dbName, id } = conn;
    const dialect = getMetadataDialect(conn as SavedConnection);
    const tabTypeKey = routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function';
    const tabTypeLabel = t(tabTypeKey);
    const sqlTemplateHeader = `-- ${t('sidebar.sql_template.edit_routine', { type: tabTypeLabel, name: routineName })}`;
    let template = sqlTemplateHeader;

    try {
      const config = buildRuntimeConfig(conn, dbName);
      let query = '';
      const parsedRoutine = splitQualifiedName(routineName);
      const name = parsedRoutine.objectName || routineName;
      const schema = parsedRoutine.schemaName;

      switch (dialect) {
        case 'mysql':
        case 'starrocks':
          query = `SHOW CREATE ${routineType} \`${name.replace(/`/g, '``')}\``;
          break;
        case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': case 'opengauss': case 'gaussdb': {
          const schemaRef = schema || 'public';
          query = `SELECT pg_get_functiondef(p.oid) AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${escapeSQLLiteral(schemaRef)}' AND p.proname = '${escapeSQLLiteral(name)}' LIMIT 1`;
          break;
        }
        case 'sqlserver':
          query = '';
          break;
        case 'oracle': case 'dm': {
          const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : '';
          if (owner) {
            query = `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${escapeSQLLiteral(name).toUpperCase()}' AND TYPE = '${routineType}' ORDER BY LINE`;
          } else {
            query = `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${escapeSQLLiteral(name).toUpperCase()}' AND TYPE = '${routineType}' ORDER BY LINE`;
          }
          break;
        }
        case 'duckdb': {
          const schemaRef = schema || 'main';
          query = `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${escapeSQLLiteral(schemaRef)}' AND function_name = '${escapeSQLLiteral(name)}' LIMIT 1`;
          break;
        }
      }
      const queries = dialect === 'sqlserver'
        ? buildSqlServerObjectDefinitionQueries('routine', routineName, dbName, 'routine_definition')
        : [query].filter(Boolean);
      for (const queryText of queries) {
        const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, queryText);
        if (result.success && Array.isArray(result.data) && result.data.length > 0) {
          if (dialect === 'oracle' || dialect === 'dm') {
            const lines = result.data.map((row: any) => row.text || row.TEXT || Object.values(row)[0] || '').join('');
            if (lines) {
              template = `${sqlTemplateHeader}\nCREATE OR REPLACE ${lines}`;
              break;
            }
          } else if (dialect === 'duckdb') {
            const row = result.data[0] as Record<string, any>;
            const ddl = buildDuckDBMacroDDL(
              String(getCaseInsensitiveRawValue(row, ['schema_name']) || schema || '').trim(),
              String(getCaseInsensitiveRawValue(row, ['function_name']) || name || '').trim(),
              getCaseInsensitiveRawValue(row, ['parameters']),
              getCaseInsensitiveRawValue(row, ['macro_definition']),
            );
            if (ddl) {
              template = `${sqlTemplateHeader}\n${ddl}`;
              break;
            }
          } else {
            const row = result.data[0] as Record<string, any>;
            const def = dialect === 'sqlserver'
              ? extractSqlServerDefinitionRows(result.data, ['routine_definition', 'definition'])
              : row.routine_definition || row.ROUTINE_DEFINITION || Object.values(row).find(v => typeof v === 'string' && String(v).length > 10) || '';
            if (def) {
              template = `${sqlTemplateHeader}\n${def}`;
              break;
            }
          }
        }
      }
    } catch { /* 降级使用模板 */ }

    addTab({
      id: `query-edit-routine-${Date.now()}`,
      title: t('sidebar.tab.edit_routine', { type: tabTypeLabel, name: routineName }),
      type: 'query',
      connectionId: id,
      dbName,
      query: template,
      queryMode: 'object-edit',
    });
  };

  const openCreateRoutine = (node: any, type: 'FUNCTION' | 'PROCEDURE') => {
    const conn = node.dataRef;
    const { dbName, id } = conn;
    const dialect = getMetadataDialect(conn as SavedConnection);
    const isProc = type === 'PROCEDURE';
    let template: string;

    switch (dialect) {
      case 'mysql':
      case 'starrocks':
        template = isProc
          ? `DELIMITER $$\nCREATE PROCEDURE proc_name(IN param1 INT)\nBEGIN\n    SELECT * FROM table_name WHERE id = param1;\nEND$$\nDELIMITER ;`
          : `DELIMITER $$\nCREATE FUNCTION func_name(param1 INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n    RETURN param1 * 2;\nEND$$\nDELIMITER ;`;
        break;
      case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': case 'opengauss': case 'gaussdb':
        template = isProc
          ? `CREATE OR REPLACE PROCEDURE proc_name(param1 integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    -- procedure body\nEND;\n$$;`
          : `CREATE OR REPLACE FUNCTION func_name(param1 integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RETURN param1 * 2;\nEND;\n$$;`;
        break;
      case 'sqlserver':
        template = isProc
          ? `CREATE PROCEDURE dbo.proc_name\n    @param1 INT\nAS\nBEGIN\n    SELECT * FROM table_name WHERE id = @param1;\nEND;`
          : `CREATE FUNCTION dbo.func_name(@param1 INT)\nRETURNS INT\nAS\nBEGIN\n    RETURN @param1 * 2;\nEND;`;
        break;
      case 'oracle': case 'dm':
        template = isProc
          ? `CREATE OR REPLACE PROCEDURE proc_name(param1 IN NUMBER)\nIS\nBEGIN\n    -- procedure body\n    NULL;\nEND;`
          : `CREATE OR REPLACE FUNCTION func_name(param1 IN NUMBER)\nRETURN NUMBER\nIS\nBEGIN\n    RETURN param1 * 2;\nEND;`;
        break;
      case 'duckdb':
        template = isProc
          ? `-- ${t('sidebar.sql_template.duckdb_procedure_unsupported')}\n-- ${t('sidebar.sql_template.duckdb_macro_hint')}\nCREATE MACRO func_name(param1) AS (param1 * 2);`
          : `CREATE MACRO func_name(param1) AS (param1 * 2);`;
        break;
      default:
        template = isProc
          ? `CREATE PROCEDURE proc_name()\nBEGIN\n    -- procedure body\nEND;`
          : `CREATE FUNCTION func_name()\nRETURNS INTEGER\nBEGIN\n    RETURN 0;\nEND;`;
    }

    addTab({
      id: `query-create-routine-${Date.now()}`,
      title: isProc ? t('sidebar.tab.create_procedure') : t('sidebar.tab.create_function'),
      type: 'query',
      connectionId: id,
      dbName,
      query: template,
    });
  };

  const handleDropRoutine = (node: any) => {
    const conn = node.dataRef;
    const routineName = String(conn.routineName || '').trim();
    const routineType = String(conn.routineType || 'FUNCTION').trim();
    if (!routineName) return;
    const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_routine.title', { type: typeLabel }),
      content: t('sidebar.modal.confirm_delete_routine.content', { type: typeLabel, name: routineName }),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await confirmSidebarMutation(conn, [conn.dbName, routineName].filter(Boolean).join(' / '))) return;
        const config = buildRuntimeConfig(conn, conn.dbName);
        const res = await DropFunction(buildRpcConnectionConfig(config) as any, conn.dbName, routineName, routineType);
        if (res.success) {
          await loadTables(getDatabaseNodeRef(conn, conn.dbName), { ensureFresh: true });
          message.success(t('sidebar.message.routine_deleted', { type: typeLabel }));
        } else {
          message.error(t('sidebar.message.delete_failed', { error: res.message }));
        }
      },
    });
  };

  const resolveMessagePublishTarget = (node: any): SidebarMessagePublishTarget | null => {
    const connectionId = String(node?.dataRef?.id || '').trim();
    const liveConnection = connections.find((item) => item.id === connectionId);
    const sourceConnection = (liveConnection || node?.dataRef) as SavedConnection | undefined;
    if (!sourceConnection?.config) return null;
    const capabilities = getDataSourceCapabilities(sourceConnection.config);
    if (!capabilities.supportsMessagePublish) return null;

    return {
      connection: sourceConnection,
      executionDbName: String(node?.dataRef?.dbName || ''),
      destination: String(node?.dataRef?.tableName || node?.title || '').trim(),
    };
  };

  const openMessagePublishModal = (node: any) => {
    const target = resolveMessagePublishTarget(node);
    if (!target) {
      message.warning(t('sidebar.message.message_publish_unsupported'));
      return;
    }
    setMessagePublishTarget(target);
  };

  const handleMessagePublishSuccess = (result: { destination: string; affectedRows: number }) => {
    const destination = String(result.destination || '').trim() || t('sidebar.message.message_publish_target_fallback');
    if (result.affectedRows > 0) {
      message.success(t('sidebar.message.message_publish_success_with_count', {
        destination,
        count: result.affectedRows,
      }));
    } else {
      message.success(t('sidebar.message.message_publish_success', { destination }));
    }
    setMessagePublishTarget(null);
  };

  return {
    handleCopyStructure,
    handleCopyTable,
    handleCopyTableName,
    handleCopyDatabaseName,
    handleExport,
    openExportDialog,
    handleCopyTableAsInsert,
    openTableDdlInDesigner,
    openTableInERView,
    injectTablePromptToAI,
    handleCreateDatabase,
    openCreateSchemaModal,
    handleCreateSchema,
    openRenameSchemaModal,
    handleRenameSchema,
    handleDeleteSchema,
    handleRenameDatabase,
    handleDeleteDatabase,
    handleRenameTable,
    handleDeleteTable,
    handleTableDataDangerAction,
    openViewDefinition,
    openEditView,
    openCreateView,
    openCreateStarRocksMaterializedView,
    openCreateStarRocksExternalCatalog,
    openCreateStarRocksRollup,
    handleDropView,
    handleRenameView,
    openRenameSavedQueryModal,
    handleRenameSavedQuery,
    handleRevealSavedQueryInFolder,
    isSavedQueryUnmatched,
    handleRebindSavedQuery,
    openRoutineDefinition,
    openEventDefinition,
    openEditEvent,
    openSequenceDefinition,
    openPackageDefinition,
    openEditRoutine,
    openCreateRoutine,
    handleDropRoutine,
    resolveMessagePublishTarget,
    openMessagePublishModal,
    handleMessagePublishSuccess,
  };
};
