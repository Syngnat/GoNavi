import { t } from '../../i18n';
import { message } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { DeleteSQLFile, DeleteSQLDirectory, SelectSQLDirectory } from '../../../wailsjs/go/app/App';
import {
  removeExternalSQLFileBindings,
  findExternalSQLDirectoriesByPath,
  buildExternalSQLDirectoryId,
} from '../../utils/externalSqlTree';
import type { ExternalSQLDirectory } from '../../types';
import type { ExternalSqlBindingApi } from './useExternalSqlBinding';
import type { ExternalSqlExecutionApi } from './useExternalSqlExecution';
import type { UseSidebarExternalSqlWorkflowOptions } from './SidebarExternalSqlWorkflow';

export interface UseExternalSqlDirectoryActionsInput {
  removeRecentSQLFilesByPath: UseSidebarExternalSqlWorkflowOptions['removeRecentSQLFilesByPath'];
  refreshGlobalExternalSQLRootNode: UseSidebarExternalSqlWorkflowOptions['refreshGlobalExternalSQLRootNode'];
  transformExternalSQLDirectoryBindings: ExternalSqlBindingApi['transformExternalSQLDirectoryBindings'];
  removeRecentSQLFilesByDirectory: UseSidebarExternalSqlWorkflowOptions['removeRecentSQLFilesByDirectory'];
  externalSQLDirectories: UseSidebarExternalSqlWorkflowOptions['externalSQLDirectories'];
  deleteExternalSQLDirectory: UseSidebarExternalSqlWorkflowOptions['deleteExternalSQLDirectory'];
  getActiveContext: UseSidebarExternalSqlWorkflowOptions['getActiveContext'];
  saveExternalSQLDirectory: UseSidebarExternalSqlWorkflowOptions['saveExternalSQLDirectory'];
  setExpandedKeys: UseSidebarExternalSqlWorkflowOptions['setExpandedKeys'];
  setAutoExpandParent: UseSidebarExternalSqlWorkflowOptions['setAutoExpandParent'];
  externalSQLDirectorySelectionPendingRef: ExternalSqlExecutionApi['externalSQLDirectorySelectionPendingRef'];
}

export const useExternalSqlDirectoryActions = ({
  removeRecentSQLFilesByPath, refreshGlobalExternalSQLRootNode,
  transformExternalSQLDirectoryBindings, removeRecentSQLFilesByDirectory, externalSQLDirectories,
  deleteExternalSQLDirectory, getActiveContext, saveExternalSQLDirectory, setExpandedKeys,
  setAutoExpandParent, externalSQLDirectorySelectionPendingRef,
}: UseExternalSqlDirectoryActionsInput) => {
  const handleDeleteExternalSQLFile = (node: any) => {
    const filePath = String(node?.dataRef?.path || '').trim();
    const fileName = String(node?.dataRef?.name || node?.title || t('sidebar.sql_file.default_name')).trim();
    if (!filePath) {
      message.error(t('sidebar.message.external_sql_file_delete_target_missing'));
      return;
    }

    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_sql_file.title'),
      content: t('sidebar.modal.confirm_delete_sql_file.content', { name: fileName }),
      okText: t('sidebar.action.delete'),
      cancelText: t('sidebar.action.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const res = await DeleteSQLFile(filePath);
        if (!res.success) {
          message.error(t('sidebar.message.delete_sql_file_failed', { error: res.message }));
          return;
        }
        removeRecentSQLFilesByPath(filePath);
        const nextDirectories = transformExternalSQLDirectoryBindings(
          (directory) => removeExternalSQLFileBindings(directory, filePath),
        );
        await refreshGlobalExternalSQLRootNode(false, nextDirectories);
        message.success(t('sidebar.message.sql_file_deleted'));
      },
    });
  };

  const handleDeleteExternalSQLDirectory = (node: any) => {
    const directoryPath = String(node?.dataRef?.path || '').trim();
    const directoryName = String(node?.dataRef?.name || node?.title || t('sidebar.sql_directory.default_name')).trim();
    if (!directoryPath) {
      message.error(t('sidebar.message.external_sql_directory_delete_target_missing'));
      return;
    }

    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_sql_directory.title'),
      content: t('sidebar.modal.confirm_delete_sql_directory.content', { name: directoryName }),
      okText: t('sidebar.action.delete'),
      cancelText: t('sidebar.action.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const res = await DeleteSQLDirectory(directoryPath);
        if (!res.success) {
          message.error(t('sidebar.message.delete_sql_directory_failed', { error: res.message }));
          return;
        }

        removeRecentSQLFilesByDirectory(directoryPath);

        if (node?.type === 'external-sql-directory') {
          const matchingDirectories = findExternalSQLDirectoriesByPath(
            externalSQLDirectories,
            directoryPath,
          );
          if (matchingDirectories.length > 0) {
            const matchingDirectoryIds = new Set(matchingDirectories.map((directory) => directory.id));
            matchingDirectories.forEach((directory) => deleteExternalSQLDirectory(directory.id));
            const nextDirectories = externalSQLDirectories.filter((item) => !matchingDirectoryIds.has(item.id));
            await refreshGlobalExternalSQLRootNode(false, nextDirectories);
          } else {
            await refreshGlobalExternalSQLRootNode(false);
          }
        } else {
          const nextDirectories = transformExternalSQLDirectoryBindings(
            (directory) => removeExternalSQLFileBindings(directory, directoryPath),
          );
          await refreshGlobalExternalSQLRootNode(false, nextDirectories);
        }
        message.success(t('sidebar.message.sql_directory_deleted'));
      },
    });
  };

  const handleAddExternalSQLDirectory = async (node: any) => {
    if (externalSQLDirectorySelectionPendingRef.current) return;
    externalSQLDirectorySelectionPendingRef.current = true;
    void node;
    try {
      const currentDirectory = externalSQLDirectories[0]?.path || '';
      const selection = await SelectSQLDirectory(currentDirectory);
      if (!selection.success) {
        if (selection.message !== '已取消') {
          message.error(t('sidebar.message.select_sql_directory_failed', { error: selection.message }));
        }
        return;
      }

      const payload = (selection.data && typeof selection.data === 'object') ? selection.data as Record<string, unknown> : {};
      const path = String(payload.path || '').trim();
      const name = String(payload.name || '').trim();
      if (!path) {
        message.error(t('sidebar.message.sql_directory_path_invalid'));
        return;
      }

      const activeContext = getActiveContext();
      const connectionId = String(activeContext?.connectionId || '').trim();
      const dbName = String(activeContext?.dbName || '').trim();
      const directoryId = buildExternalSQLDirectoryId(connectionId, dbName, path);
      const nextDirectory: ExternalSQLDirectory = {
        id: directoryId,
        name: name || path.split(/[\\/]/).filter(Boolean).pop() || t('sidebar.sql_directory.default_name'),
        path,
        ...(connectionId ? { connectionId } : {}),
        ...(dbName ? { dbName } : {}),
        createdAt: Date.now(),
      };
      saveExternalSQLDirectory(nextDirectory);

      const nextDirectories = [
        ...externalSQLDirectories.filter((item) => item.id !== directoryId),
        nextDirectory,
      ];
      setExpandedKeys((prev) => Array.from(new Set([...prev, 'external-sql-root'])));
      setAutoExpandParent(false);
      await refreshGlobalExternalSQLRootNode(false, nextDirectories);
      message.success(t('sidebar.message.external_sql_directory_added'));
    } catch (error) {
      message.error(t('sidebar.message.select_sql_directory_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      externalSQLDirectorySelectionPendingRef.current = false;
    }
  };

  const handleRemoveExternalSQLDirectory = async (node: any) => {
    const directoryPath = String(node?.dataRef?.path || '').trim();
    if (!directoryPath) {
      message.error(t('sidebar.message.external_sql_directory_not_found'));
      return;
    }
    const matchingDirectories = findExternalSQLDirectoriesByPath(
      externalSQLDirectories,
      directoryPath,
    );
    matchingDirectories.forEach((directory) => deleteExternalSQLDirectory(directory.id));
    const matchingDirectoryIds = new Set(matchingDirectories.map((directory) => directory.id));
    const nextDirectories = externalSQLDirectories.filter((item) => !matchingDirectoryIds.has(item.id));
    await refreshGlobalExternalSQLRootNode(false, nextDirectories);
    message.success(t('sidebar.message.external_sql_directory_removed'));
  };

  const handleRefreshExternalSQLDirectory = async (node: any) => {
    void node;
    await refreshGlobalExternalSQLRootNode(true);
    message.success(t('sidebar.message.external_sql_directory_refreshed'));
  };
  return {
    handleDeleteExternalSQLFile, handleDeleteExternalSQLDirectory, handleAddExternalSQLDirectory,
    handleRemoveExternalSQLDirectory, handleRefreshExternalSQLDirectory,
  };
};

export type ExternalSqlDirectoryActionsApi = ReturnType<typeof useExternalSqlDirectoryActions>;
