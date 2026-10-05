import {
  CreateDatabase,
  ListDatabaseCharsets,
  ListDatabaseCollations,
  CreateSchema,
  RenameDatabase,
  DropDatabase,
  RenameTable,
  DropTable,
} from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message } from 'antd';
import { t } from '../../i18n';
import { useEffect } from 'react';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { getMetadataDialect } from './sidebarMetadataLoaders';
import type { SavedConnection } from '../../types';
import {
  getSidebarSchemaTreeKeyPrefixes,
  isSidebarSchemaTreeKey,
} from './sidebarObjectActionHelpers';
import Modal from '../common/ResizableDraggableModal';
import { showCountdownDangerConfirm } from '../common/countdownDangerConfirm';
import type { SidebarCopyExportActionsApi } from './useSidebarCopyExportActions';
import type { UseSidebarObjectActionsArgs } from './useSidebarObjectActions';

export interface UseSidebarDatabaseSchemaActionsInput {
  createDbForm: UseSidebarObjectActionsArgs['createDbForm'];
  targetConnection: UseSidebarObjectActionsArgs['targetConnection'];
  setIsCreateDbModalOpen: UseSidebarObjectActionsArgs['setIsCreateDbModalOpen'];
  loadDatabases: UseSidebarObjectActionsArgs['loadDatabases'];
  confirmSidebarMutation: SidebarCopyExportActionsApi['confirmSidebarMutation'];
  isCreateDbModalOpen: UseSidebarObjectActionsArgs['isCreateDbModalOpen'];
  setLoadingCreateDbOptions: UseSidebarObjectActionsArgs['setLoadingCreateDbOptions'];
  setCreateDbCharsets: UseSidebarObjectActionsArgs['setCreateDbCharsets'];
  setCreateDbCollations: UseSidebarObjectActionsArgs['setCreateDbCollations'];
  isPostgresSchemaDialect: UseSidebarObjectActionsArgs['isPostgresSchemaDialect'];
  setCreateSchemaTarget: UseSidebarObjectActionsArgs['setCreateSchemaTarget'];
  createSchemaForm: UseSidebarObjectActionsArgs['createSchemaForm'];
  setIsCreateSchemaModalOpen: UseSidebarObjectActionsArgs['setIsCreateSchemaModalOpen'];
  createSchemaTarget: UseSidebarObjectActionsArgs['createSchemaTarget'];
  loadTables: UseSidebarObjectActionsArgs['loadTables'];
  setRenameSchemaTarget: UseSidebarObjectActionsArgs['setRenameSchemaTarget'];
  renameSchemaForm: UseSidebarObjectActionsArgs['renameSchemaForm'];
  setIsRenameSchemaModalOpen: UseSidebarObjectActionsArgs['setIsRenameSchemaModalOpen'];
  renameSchemaTarget: UseSidebarObjectActionsArgs['renameSchemaTarget'];
  migrateVisibilityForRenamedSchema: UseSidebarObjectActionsArgs['migrateVisibilityForRenamedSchema'];
  setExpandedKeys: UseSidebarObjectActionsArgs['setExpandedKeys'];
  setLoadedKeys: UseSidebarObjectActionsArgs['setLoadedKeys'];
  getDatabaseNodeRef: UseSidebarObjectActionsArgs['getDatabaseNodeRef'];
  removeVisibilityForDeletedSchema: UseSidebarObjectActionsArgs['removeVisibilityForDeletedSchema'];
  renameDbTarget: UseSidebarObjectActionsArgs['renameDbTarget'];
  renameDbForm: UseSidebarObjectActionsArgs['renameDbForm'];
  buildRuntimeConfig: UseSidebarObjectActionsArgs['buildRuntimeConfig'];
  migrateVisibilityForRenamedDatabase: UseSidebarObjectActionsArgs['migrateVisibilityForRenamedDatabase'];
  migratePinnedDatabaseKey: UseSidebarObjectActionsArgs['migratePinnedDatabaseKey'];
  setIsRenameDbModalOpen: UseSidebarObjectActionsArgs['setIsRenameDbModalOpen'];
  setRenameDbTarget: UseSidebarObjectActionsArgs['setRenameDbTarget'];
  removeVisibilityForDeletedDatabase: UseSidebarObjectActionsArgs['removeVisibilityForDeletedDatabase'];
  closeTabsByDatabase: UseSidebarObjectActionsArgs['closeTabsByDatabase'];
  getConnectionNodeRef: UseSidebarObjectActionsArgs['getConnectionNodeRef'];
  renameTableTarget: UseSidebarObjectActionsArgs['renameTableTarget'];
  renameTableForm: UseSidebarObjectActionsArgs['renameTableForm'];
  extractObjectName: UseSidebarObjectActionsArgs['extractObjectName'];
  setIsRenameTableModalOpen: UseSidebarObjectActionsArgs['setIsRenameTableModalOpen'];
  setRenameTableTarget: UseSidebarObjectActionsArgs['setRenameTableTarget'];
}

export const useSidebarDatabaseSchemaActions = ({
  createDbForm, targetConnection, setIsCreateDbModalOpen, loadDatabases, confirmSidebarMutation,
  isCreateDbModalOpen, setLoadingCreateDbOptions, setCreateDbCharsets, setCreateDbCollations,
  isPostgresSchemaDialect, setCreateSchemaTarget, createSchemaForm, setIsCreateSchemaModalOpen,
  createSchemaTarget, loadTables, setRenameSchemaTarget, renameSchemaForm,
  setIsRenameSchemaModalOpen, renameSchemaTarget, migrateVisibilityForRenamedSchema,
  setExpandedKeys, setLoadedKeys, getDatabaseNodeRef, removeVisibilityForDeletedSchema,
  renameDbTarget, renameDbForm, buildRuntimeConfig, migrateVisibilityForRenamedDatabase,
  migratePinnedDatabaseKey, setIsRenameDbModalOpen, setRenameDbTarget,
  removeVisibilityForDeletedDatabase, closeTabsByDatabase, getConnectionNodeRef, renameTableTarget,
  renameTableForm, extractObjectName, setIsRenameTableModalOpen, setRenameTableTarget,
}: UseSidebarDatabaseSchemaActionsInput) => {
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
        await migrateVisibilityForRenamedSchema(
          conn as SavedConnection,
          dbName,
          oldSchemaName,
          newSchemaName,
        );
        const schemaKeyPrefixes = getSidebarSchemaTreeKeyPrefixes(conn.id, dbName, oldSchemaName);
        setExpandedKeys(prev => prev.filter(k => !isSidebarSchemaTreeKey(k, schemaKeyPrefixes)));
        setLoadedKeys(prev => prev.filter(k => !isSidebarSchemaTreeKey(k, schemaKeyPrefixes)));
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
          await removeVisibilityForDeletedSchema(conn as SavedConnection, dbName, schemaName);
          const schemaKeyPrefixes = getSidebarSchemaTreeKeyPrefixes(conn.id, dbName, schemaName);
          setExpandedKeys(prev => prev.filter(k => !isSidebarSchemaTreeKey(k, schemaKeyPrefixes)));
          setLoadedKeys(prev => prev.filter(k => !isSidebarSchemaTreeKey(k, schemaKeyPrefixes)));
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
        const migratedConnection = await migrateVisibilityForRenamedDatabase(
          conn as SavedConnection,
          oldDbName,
          newDbName,
        );
        migratePinnedDatabaseKey(String(conn.id || ''), oldDbName, newDbName);
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
          const cleanedConnection = await removeVisibilityForDeletedDatabase(
            conn as SavedConnection,
            dbName,
          );
          migratePinnedDatabaseKey(String(conn.id || ''), dbName);
          closeTabsByDatabase(conn.id, dbName);
          setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${dbName}`)));
          setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${dbName}`)));
          await loadDatabases(getConnectionNodeRef(cleanedConnection), { ensureFresh: true });
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
  return {
    handleCreateDatabase, openCreateSchemaModal, handleCreateSchema, openRenameSchemaModal,
    handleRenameSchema, handleDeleteSchema, handleRenameDatabase, handleDeleteDatabase,
    handleRenameTable, handleDeleteTable,
  };
};

export type SidebarDatabaseSchemaActionsApi = ReturnType<typeof useSidebarDatabaseSchemaActions>;
