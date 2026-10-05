import { t } from '../../i18n';
import { message } from 'antd';
import {
  ReadSQLFile,
  CreateSQLFile,
  RenameSQLFile,
  CreateSQLDirectory,
  RenameSQLDirectory,
} from '../../../wailsjs/go/app/App';
import {
  buildExternalSQLTabId,
  moveExternalSQLFileBindings,
  findExternalSQLDirectoriesByPath,
  buildExternalSQLDirectoryId,
} from '../../utils/externalSqlTree';
import {
  getExternalSQLParentDirectoryPath,
  normalizeExternalSQLDirectoryName,
  normalizeExternalSQLFileName,
} from './sidebarExternalSqlHelpers';
import { isExternalSQLDirectoryModalMode } from '../sidebarCoreUtils';
import type { ExternalSQLDirectory } from '../../types';
import type { ExternalSqlExecutionApi } from './useExternalSqlExecution';
import type { ExternalSqlBindingApi } from './useExternalSqlBinding';
import type { UseSidebarExternalSqlWorkflowOptions } from './SidebarExternalSqlWorkflow';

export interface UseExternalSqlFileModalInput {
  addTab: UseSidebarExternalSqlWorkflowOptions['addTab'];
  resolveExternalSQLExecutionContext: ExternalSqlExecutionApi['resolveExternalSQLExecutionContext'];
  openSQLFileExecutionWorkbench: ExternalSqlExecutionApi['openSQLFileExecutionWorkbench'];
  setExternalSQLFileModalMode: ExternalSqlExecutionApi['setExternalSQLFileModalMode'];
  setExternalSQLFileTarget: ExternalSqlExecutionApi['setExternalSQLFileTarget'];
  externalSQLFileForm: ExternalSqlExecutionApi['externalSQLFileForm'];
  setIsExternalSQLFileModalOpen: ExternalSqlExecutionApi['setIsExternalSQLFileModalOpen'];
  refreshGlobalExternalSQLRootNode: UseSidebarExternalSqlWorkflowOptions['refreshGlobalExternalSQLRootNode'];
  updateRecentSQLFilePath: UseSidebarExternalSqlWorkflowOptions['updateRecentSQLFilePath'];
  moveRecentSQLFilesByDirectory: UseSidebarExternalSqlWorkflowOptions['moveRecentSQLFilesByDirectory'];
  externalSQLDirectories: UseSidebarExternalSqlWorkflowOptions['externalSQLDirectories'];
  deleteExternalSQLDirectory: UseSidebarExternalSqlWorkflowOptions['deleteExternalSQLDirectory'];
  saveExternalSQLDirectory: UseSidebarExternalSqlWorkflowOptions['saveExternalSQLDirectory'];
  externalSQLFileModalMode: ExternalSqlExecutionApi['externalSQLFileModalMode'];
  externalSQLFileTarget: ExternalSqlExecutionApi['externalSQLFileTarget'];
  transformExternalSQLDirectoryBindings: ExternalSqlBindingApi['transformExternalSQLDirectoryBindings'];
}

export const useExternalSqlFileModal = ({
  addTab, resolveExternalSQLExecutionContext, openSQLFileExecutionWorkbench,
  setExternalSQLFileModalMode, setExternalSQLFileTarget, externalSQLFileForm,
  setIsExternalSQLFileModalOpen, refreshGlobalExternalSQLRootNode, updateRecentSQLFilePath,
  moveRecentSQLFilesByDirectory, externalSQLDirectories, deleteExternalSQLDirectory,
  saveExternalSQLDirectory, externalSQLFileModalMode, externalSQLFileTarget,
  transformExternalSQLDirectoryBindings,
}: UseExternalSqlFileModalInput) => {
  const openExternalSQLFile = async (fileNode: any) => {
    const hasExplicitBinding = fileNode?.dataRef?.hasExplicitBinding === true;
    const fileContext = {
      connectionId: String(fileNode?.dataRef?.connectionId || '').trim(),
      dbName: String(fileNode?.dataRef?.dbName || '').trim(),
    };
    const fallbackContext = resolveExternalSQLExecutionContext();
    const connectionId = hasExplicitBinding
      ? fileContext.connectionId
      : fileContext.connectionId || fallbackContext.connectionId;
    const dbName = hasExplicitBinding
      ? fileContext.dbName
      : fileContext.dbName || fallbackContext.dbName;
    const filePath = String(fileNode?.dataRef?.path || '').trim();
    const fileName = String(fileNode?.dataRef?.name || fileNode?.title || t('sidebar.sql_file.default_name')).trim() || t('sidebar.sql_file.default_name');
    if (!filePath) {
      message.error(t('sidebar.message.sql_file_path_incomplete'));
      return;
    }
    const res = await ReadSQLFile(filePath);
    if (!res.success) {
      if (res.message !== '已取消') {
        message.error(t('sidebar.message.read_sql_file_failed', { error: res.message }));
      }
      return;
    }

    const data = res.data;
    if (data && typeof data === 'object' && data.isLargeFile) {
      if (!connectionId) {
        message.warning(t('sidebar.message.select_host_before_large_sql_file'));
        return;
      }
      openSQLFileExecutionWorkbench({
        connectionId,
        dbName,
        filePath: String((data as Record<string, unknown>).filePath || '').trim() || filePath,
        fileName,
        fileSizeMB: String((data as Record<string, unknown>).fileSizeMB || '').trim() || undefined,
      });
      return;
    }

    addTab({
      id: buildExternalSQLTabId(connectionId, dbName, filePath),
      title: fileName,
      type: 'query',
      connectionId,
      dbName: dbName || undefined,
      query: String(data || ''),
      filePath,
    });
  };

  const openCreateExternalSQLFileModal = (node: any) => {
    const directoryPath = getExternalSQLParentDirectoryPath(node);
    if (!directoryPath) {
      message.error(t('sidebar.message.external_sql_file_parent_missing'));
      return;
    }
    setExternalSQLFileModalMode('create');
    setExternalSQLFileTarget(node);
    externalSQLFileForm.setFieldsValue({ name: 'new-query.sql' });
    setIsExternalSQLFileModalOpen(true);
  };

  const openRenameExternalSQLFileModal = (node: any) => {
    const currentName = String(node?.dataRef?.name || node?.title || '').trim();
    if (!currentName) {
      message.error(t('sidebar.message.external_sql_file_rename_target_missing'));
      return;
    }
    setExternalSQLFileModalMode('rename');
    setExternalSQLFileTarget(node);
    externalSQLFileForm.setFieldsValue({ name: currentName });
    setIsExternalSQLFileModalOpen(true);
  };

  const openCreateExternalSQLDirectoryModal = (node: any) => {
    const directoryPath = getExternalSQLParentDirectoryPath(node);
    if (!directoryPath) {
      message.error(t('sidebar.message.external_sql_directory_parent_missing'));
      return;
    }
    setExternalSQLFileModalMode('create-directory');
    setExternalSQLFileTarget(node);
    externalSQLFileForm.setFieldsValue({ name: 'new-folder' });
    setIsExternalSQLFileModalOpen(true);
  };

  const openRenameExternalSQLDirectoryModal = (node: any) => {
    const currentName = String(node?.dataRef?.name || node?.title || '').trim();
    if (!currentName) {
      message.error(t('sidebar.message.external_sql_directory_rename_target_missing'));
      return;
    }
    setExternalSQLFileModalMode('rename-directory');
    setExternalSQLFileTarget(node);
    externalSQLFileForm.setFieldsValue({ name: currentName });
    setIsExternalSQLFileModalOpen(true);
  };

  const closeExternalSQLFileModal = () => {
    setIsExternalSQLFileModalOpen(false);
    setExternalSQLFileTarget(null);
    externalSQLFileForm.resetFields();
  };

  const handleExternalSQLFileModalOk = async () => {
    try {
      const values = await externalSQLFileForm.validateFields();
      const isDirectoryMode = isExternalSQLDirectoryModalMode(externalSQLFileModalMode);
      const name = isDirectoryMode
        ? normalizeExternalSQLDirectoryName(values.name)
        : normalizeExternalSQLFileName(values.name);
      if (!name) {
        message.error(t(isDirectoryMode ? 'sidebar.message.sql_directory_name_required' : 'sidebar.message.sql_file_name_required'));
        return;
      }

      if (externalSQLFileModalMode === 'create') {
        const directoryPath = getExternalSQLParentDirectoryPath(externalSQLFileTarget);
        if (!directoryPath) {
          message.error(t('sidebar.message.external_sql_file_parent_missing'));
          return;
        }
        const res = await CreateSQLFile(directoryPath, name);
        if (!res.success) {
          message.error(t('sidebar.message.create_sql_file_failed', { error: res.message }));
          return;
        }
        await refreshGlobalExternalSQLRootNode(false);
        message.success(t('sidebar.message.sql_file_created'));
      } else if (externalSQLFileModalMode === 'rename') {
        const filePath = String(externalSQLFileTarget?.dataRef?.path || '').trim();
        if (!filePath) {
          message.error(t('sidebar.message.external_sql_file_rename_target_missing'));
          return;
        }
        const res = await RenameSQLFile(filePath, name);
        if (!res.success) {
          message.error(t('sidebar.message.rename_sql_file_failed', { error: res.message }));
          return;
        }
        const payload = (res.data && typeof res.data === 'object') ? res.data as Record<string, unknown> : {};
        const nextFilePath = String(payload.filePath || '').trim();
        let nextDirectories: ExternalSQLDirectory[] | undefined;
        if (nextFilePath) {
          updateRecentSQLFilePath(filePath, nextFilePath);
          nextDirectories = transformExternalSQLDirectoryBindings(
            (directory) => moveExternalSQLFileBindings(directory, filePath, nextFilePath),
          );
        }
        await refreshGlobalExternalSQLRootNode(false, nextDirectories);
        message.success(t('sidebar.message.sql_file_renamed'));
      } else if (externalSQLFileModalMode === 'create-directory') {
        const directoryPath = getExternalSQLParentDirectoryPath(externalSQLFileTarget);
        if (!directoryPath) {
          message.error(t('sidebar.message.external_sql_directory_parent_missing'));
          return;
        }
        const res = await CreateSQLDirectory(directoryPath, name);
        if (!res.success) {
          message.error(t('sidebar.message.create_sql_directory_failed', { error: res.message }));
          return;
        }
        await refreshGlobalExternalSQLRootNode(false);
        message.success(t('sidebar.message.sql_directory_created'));
      } else {
        const directoryPath = String(externalSQLFileTarget?.dataRef?.path || '').trim();
        if (!directoryPath) {
          message.error(t('sidebar.message.external_sql_directory_rename_target_missing'));
          return;
        }
        const res = await RenameSQLDirectory(directoryPath, name);
        if (!res.success) {
          message.error(t('sidebar.message.rename_sql_directory_failed', { error: res.message }));
          return;
        }

        const payload = (res.data && typeof res.data === 'object') ? res.data as Record<string, unknown> : {};
        const nextPath = String(payload.directoryPath || payload.path || '').trim();
        if (nextPath) {
          moveRecentSQLFilesByDirectory(directoryPath, nextPath);
        }
        if (externalSQLFileTarget?.type === 'external-sql-directory') {
          const nextName = String(payload.name || name).trim();
          const matchingDirectories = findExternalSQLDirectoriesByPath(
            externalSQLDirectories,
            directoryPath,
          );
          if (!nextPath || matchingDirectories.length === 0) {
            message.error(t('sidebar.message.external_sql_directory_rename_sync_failed'));
            await refreshGlobalExternalSQLRootNode(false);
            return;
          }
          // A directory is a physical resource, while every connection/database
          // association is a separate binding. Keep all bindings in sync after
          // the physical path moves so each one still opens SQL in its own context.
          const nextDirectoriesById = new Map<string, ExternalSQLDirectory>();
          matchingDirectories.forEach((directory) => {
            const connectionId = String(directory.connectionId || '').trim();
            const dbName = String(directory.dbName || '').trim();
            const movedDirectory = moveExternalSQLFileBindings(directory, directoryPath, nextPath);
            const nextDirectory: ExternalSQLDirectory = {
              ...movedDirectory,
              id: buildExternalSQLDirectoryId(connectionId, dbName, nextPath),
              name: nextName || nextPath.split(/[\\/]/).filter(Boolean).pop() || t('sidebar.sql_directory.default_name'),
              path: nextPath,
              ...(connectionId ? { connectionId } : {}),
              ...(dbName ? { dbName } : {}),
              createdAt: Number(directory.createdAt) || Date.now(),
            };
            nextDirectoriesById.set(nextDirectory.id, nextDirectory);
          });
          const matchingDirectoryIds = new Set(matchingDirectories.map((directory) => directory.id));
          const nextDirectories = [
            ...externalSQLDirectories.filter((item) => !matchingDirectoryIds.has(item.id)),
            ...nextDirectoriesById.values(),
          ];
          matchingDirectories.forEach((directory) => deleteExternalSQLDirectory(directory.id));
          nextDirectoriesById.forEach((directory) => saveExternalSQLDirectory(directory));
          await refreshGlobalExternalSQLRootNode(false, nextDirectories);
        } else {
          const nextDirectories = nextPath
            ? transformExternalSQLDirectoryBindings(
                (directory) => moveExternalSQLFileBindings(directory, directoryPath, nextPath),
              )
            : undefined;
          await refreshGlobalExternalSQLRootNode(false, nextDirectories);
        }
        message.success(t('sidebar.message.sql_directory_renamed'));
      }

      closeExternalSQLFileModal();
    } catch {
      // Validate failed
    }
  };
  return {
    openExternalSQLFile, openCreateExternalSQLFileModal, openRenameExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal, openRenameExternalSQLDirectoryModal,
    closeExternalSQLFileModal, handleExternalSQLFileModalOk,
  };
};

export type ExternalSqlFileModalApi = ReturnType<typeof useExternalSqlFileModal>;
