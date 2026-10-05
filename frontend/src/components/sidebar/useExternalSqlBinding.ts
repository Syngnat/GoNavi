import { message } from 'antd';
import { t } from '../../i18n';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { setExternalSQLFileBinding } from '../../utils/externalSqlTree';
import type { ExternalSQLDirectory } from '../../types';
import type { ExternalSqlExecutionApi } from './useExternalSqlExecution';
import type { UseSidebarExternalSqlWorkflowOptions } from './SidebarExternalSqlWorkflow';

export interface UseExternalSqlBindingInput {
  externalSQLBindingDatabaseRequestRef: ExternalSqlExecutionApi['externalSQLBindingDatabaseRequestRef'];
  setIsExternalSQLBindingModalOpen: ExternalSqlExecutionApi['setIsExternalSQLBindingModalOpen'];
  setExternalSQLBindingTarget: ExternalSqlExecutionApi['setExternalSQLBindingTarget'];
  setExternalSQLBindingDatabases: ExternalSqlExecutionApi['setExternalSQLBindingDatabases'];
  setExternalSQLBindingDatabaseError: ExternalSqlExecutionApi['setExternalSQLBindingDatabaseError'];
  setLoadingExternalSQLBindingDatabases: ExternalSqlExecutionApi['setLoadingExternalSQLBindingDatabases'];
  externalSQLBindingForm: ExternalSqlExecutionApi['externalSQLBindingForm'];
  connections: UseSidebarExternalSqlWorkflowOptions['connections'];
  resolveExternalSQLExecutionContext: ExternalSqlExecutionApi['resolveExternalSQLExecutionContext'];
  loadExternalSQLBindingDatabases: ExternalSqlExecutionApi['loadExternalSQLBindingDatabases'];
  externalSQLDirectories: UseSidebarExternalSqlWorkflowOptions['externalSQLDirectories'];
  saveExternalSQLDirectory: UseSidebarExternalSqlWorkflowOptions['saveExternalSQLDirectory'];
  refreshGlobalExternalSQLRootNode: UseSidebarExternalSqlWorkflowOptions['refreshGlobalExternalSQLRootNode'];
  externalSQLBindingTarget: ExternalSqlExecutionApi['externalSQLBindingTarget'];
  setSavingExternalSQLBinding: ExternalSqlExecutionApi['setSavingExternalSQLBinding'];
}

export const useExternalSqlBinding = ({
  externalSQLBindingDatabaseRequestRef, setIsExternalSQLBindingModalOpen,
  setExternalSQLBindingTarget, setExternalSQLBindingDatabases, setExternalSQLBindingDatabaseError,
  setLoadingExternalSQLBindingDatabases, externalSQLBindingForm, connections,
  resolveExternalSQLExecutionContext, loadExternalSQLBindingDatabases, externalSQLDirectories,
  saveExternalSQLDirectory, refreshGlobalExternalSQLRootNode, externalSQLBindingTarget,
  setSavingExternalSQLBinding,
}: UseExternalSqlBindingInput) => {
  const closeExternalSQLBindingModal = () => {
    externalSQLBindingDatabaseRequestRef.current += 1;
    setIsExternalSQLBindingModalOpen(false);
    setExternalSQLBindingTarget(null);
    setExternalSQLBindingDatabases([]);
    setExternalSQLBindingDatabaseError('');
    setLoadingExternalSQLBindingDatabases(false);
    externalSQLBindingForm.resetFields();
  };

  const openExternalSQLBindingModal = (fileNode: any) => {
    const filePath = String(fileNode?.dataRef?.path || '').trim();
    const directoryId = String(fileNode?.dataRef?.directoryId || '').trim();
    if (!filePath || !directoryId) {
      message.error(t('sidebar.message.sql_file_path_incomplete'));
      return;
    }
    const fallbackContext = resolveExternalSQLExecutionContext();
    const fileConnectionId = String(fileNode?.dataRef?.connectionId || '').trim();
    const fallbackConnectionId = String(fallbackContext.connectionId || '').trim();
    const connectionId = [fileConnectionId, fallbackConnectionId]
      .find((candidate) => connections.some((connection) => connection.id === candidate)) || '';
    const dbName = connectionId === fileConnectionId
      ? String(fileNode?.dataRef?.dbName || '').trim()
      : String(fallbackContext.dbName || '').trim();
    setExternalSQLBindingTarget(fileNode);
    externalSQLBindingForm.setFieldsValue({
      connectionId: connectionId || undefined,
      dbName: dbName || undefined,
    });
    setIsExternalSQLBindingModalOpen(true);
    if (connectionId) {
      void loadExternalSQLBindingDatabases(connectionId, dbName);
    } else {
      setExternalSQLBindingDatabases([]);
      setExternalSQLBindingDatabaseError('');
    }
  };

  const handleExternalSQLBindingConnectionChange = (connectionId: string) => {
    externalSQLBindingForm.setFieldsValue({ dbName: undefined });
    void loadExternalSQLBindingDatabases(connectionId);
  };

  const saveExternalSQLBindingTarget = async (
    target: { connectionId: string; dbName: string } | null,
  ) => {
    const filePath = String(externalSQLBindingTarget?.dataRef?.path || '').trim();
    const directoryId = String(externalSQLBindingTarget?.dataRef?.directoryId || '').trim();
    const directory = externalSQLDirectories.find((item) => item.id === directoryId);
    if (!filePath || !directory) {
      message.error(t('sidebar.message.external_sql_directory_not_found'));
      return false;
    }
    if (target) {
      const connection = connections.find((item) => item.id === target.connectionId);
      if (!connection || !getDataSourceCapabilities(connection.config).supportsQueryEditor) {
        message.error(t('sidebar.message.connection_config_not_found'));
        return false;
      }
    }
    const nextDirectory = setExternalSQLFileBinding(directory, filePath, target);
    saveExternalSQLDirectory(nextDirectory);
    const nextDirectories = externalSQLDirectories.map((item) => (
      item.id === directoryId ? nextDirectory : item
    ));
    await refreshGlobalExternalSQLRootNode(false, nextDirectories);
    return true;
  };

  const handleExternalSQLBindingOk = async () => {
    try {
      const values = await externalSQLBindingForm.validateFields();
      setSavingExternalSQLBinding(true);
      const saved = await saveExternalSQLBindingTarget({
        connectionId: String(values.connectionId || '').trim(),
        dbName: String(values.dbName || '').trim(),
      });
      if (!saved) return;
      message.success(t('sidebar.message.external_sql_file_binding_saved'));
      closeExternalSQLBindingModal();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        message.error(error instanceof Error ? error.message : t('common.unknown'));
      }
    } finally {
      setSavingExternalSQLBinding(false);
    }
  };

  const handleClearExternalSQLBinding = async () => {
    try {
      setSavingExternalSQLBinding(true);
      const saved = await saveExternalSQLBindingTarget(null);
      if (!saved) return;
      message.success(t('sidebar.message.external_sql_file_binding_cleared'));
      closeExternalSQLBindingModal();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('common.unknown'));
    } finally {
      setSavingExternalSQLBinding(false);
    }
  };

  const transformExternalSQLDirectoryBindings = (
    transform: (directory: ExternalSQLDirectory) => ExternalSQLDirectory,
  ): ExternalSQLDirectory[] | undefined => {
    let changed = false;
    const nextDirectories = externalSQLDirectories.map((directory) => {
      const nextDirectory = transform(directory);
      if (nextDirectory !== directory) {
        changed = true;
        saveExternalSQLDirectory(nextDirectory);
      }
      return nextDirectory;
    });
    return changed ? nextDirectories : undefined;
  };
  return {
    closeExternalSQLBindingModal, openExternalSQLBindingModal,
    handleExternalSQLBindingConnectionChange, handleExternalSQLBindingOk,
    handleClearExternalSQLBinding, transformExternalSQLDirectoryBindings,
  };
};

export type ExternalSqlBindingApi = ReturnType<typeof useExternalSqlBinding>;
