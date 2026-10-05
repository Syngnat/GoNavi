import React, { useRef, useState, useCallback } from 'react';
import { Form, message } from 'antd';
import type { ExternalSQLFileModalMode } from '../sidebarCoreUtils';
import { DBGetDatabases, OpenSQLFile } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { t } from '../../i18n';
import { filterVisibleDatabaseNames } from '../../utils/databaseVisibility';
import { buildSQLFileExecutionWorkbenchTab } from '../../utils/sqlFileExecutionTab';
import { launchDatabaseSQLImportWorkbench } from './sidebarExternalSqlLaunch';
import { normalizeSQLFileDialogData } from './sidebarExternalSqlHelpers';
import { resolveExternalSQLFileBinding } from '../../utils/externalSqlTree';
import { uploadBrowserFile } from '../../utils/browserFileTransfer';
import { resolveSidebarNodeConnectionId } from '../sidebarV2Utils';
import type {
  ActiveExecutionContext,
  UseSidebarExternalSqlWorkflowOptions,
} from './SidebarExternalSqlWorkflow';

export interface UseExternalSqlExecutionInput {
  connections: UseSidebarExternalSqlWorkflowOptions['connections'];
  addTab: UseSidebarExternalSqlWorkflowOptions['addTab'];
  openDataImportWorkbench: UseSidebarExternalSqlWorkflowOptions['openDataImportWorkbench'];
  getActiveContext: UseSidebarExternalSqlWorkflowOptions['getActiveContext'];
  isWebRuntime: Exclude<UseSidebarExternalSqlWorkflowOptions['isWebRuntime'], undefined>;
  externalSQLDirectories: UseSidebarExternalSqlWorkflowOptions['externalSQLDirectories'];
  selectedNodesRef: UseSidebarExternalSqlWorkflowOptions['selectedNodesRef'];
  connectionIds: UseSidebarExternalSqlWorkflowOptions['connectionIds'];
  activeTab: UseSidebarExternalSqlWorkflowOptions['activeTab'];
}

export const useExternalSqlExecution = ({
  connections, addTab, openDataImportWorkbench, getActiveContext, isWebRuntime,
  externalSQLDirectories, selectedNodesRef, connectionIds, activeTab,
}: UseExternalSqlExecutionInput) => {
  const externalSQLDirectorySelectionPendingRef = useRef(false);
  const [isExternalSQLFileModalOpen, setIsExternalSQLFileModalOpen] = useState(false);
  const [externalSQLFileForm] = Form.useForm();
  const [externalSQLFileModalMode, setExternalSQLFileModalMode] = useState<ExternalSQLFileModalMode>('create');
  const [externalSQLFileTarget, setExternalSQLFileTarget] = useState<any>(null);
  const [isExternalSQLBindingModalOpen, setIsExternalSQLBindingModalOpen] = useState(false);
  const [externalSQLBindingForm] = Form.useForm();
  const [externalSQLBindingTarget, setExternalSQLBindingTarget] = useState<any>(null);
  const [externalSQLBindingDatabases, setExternalSQLBindingDatabases] = useState<string[]>([]);
  const [externalSQLBindingDatabaseError, setExternalSQLBindingDatabaseError] = useState('');
  const [loadingExternalSQLBindingDatabases, setLoadingExternalSQLBindingDatabases] = useState(false);
  const [savingExternalSQLBinding, setSavingExternalSQLBinding] = useState(false);
  const externalSQLBindingDatabaseRequestRef = useRef(0);
  const browserSQLFileInputRef = useRef<HTMLInputElement>(null);
  const browserSQLExecutionContextRef = useRef<ActiveExecutionContext>(null);

  const loadExternalSQLBindingDatabases = useCallback(async (
    connectionId: string,
    preferredDbName = '',
  ) => {
    const requestId = ++externalSQLBindingDatabaseRequestRef.current;
    const connection = connections.find((item) => item.id === String(connectionId || '').trim());
    setExternalSQLBindingDatabaseError('');
    if (!connection) {
      setExternalSQLBindingDatabases([]);
      setLoadingExternalSQLBindingDatabases(false);
      return;
    }

    setLoadingExternalSQLBindingDatabases(true);
    const fallbackNames = [preferredDbName, String(connection.config.database || '').trim()].filter(Boolean);
    try {
      const result = await DBGetDatabases(buildRpcConnectionConfig(connection.config) as any);
      if (requestId !== externalSQLBindingDatabaseRequestRef.current) return;
      if (!result.success) {
        setExternalSQLBindingDatabases(Array.from(new Set(fallbackNames)));
        setExternalSQLBindingDatabaseError(result.message || t('data_export.message.load_databases_failed'));
        return;
      }
      const names = (Array.isArray(result.data) ? result.data : [])
        .map((row: any) => String(row?.Database || row?.database || Object.values(row || {})[0] || '').trim())
        .filter(Boolean);
      const visibleNames = filterVisibleDatabaseNames(connection, names);
      setExternalSQLBindingDatabases(
        Array.from(new Set([...fallbackNames, ...visibleNames]))
          .sort((left, right) => left.localeCompare(right)),
      );
    } catch (error) {
      if (requestId !== externalSQLBindingDatabaseRequestRef.current) return;
      setExternalSQLBindingDatabases(Array.from(new Set(fallbackNames)));
      setExternalSQLBindingDatabaseError(
        error instanceof Error ? error.message : t('data_export.message.load_databases_failed'),
      );
    } finally {
      if (requestId === externalSQLBindingDatabaseRequestRef.current) {
        setLoadingExternalSQLBindingDatabases(false);
      }
    }
  }, [connections]);

  const selectSQLFileForExecution = useCallback(async () => {
    const backendApp = typeof window !== 'undefined' ? (window as any).go?.app?.App : undefined;
    if (typeof backendApp?.SelectSQLFileForExecution === 'function') {
      return backendApp.SelectSQLFileForExecution();
    }
    return OpenSQLFile();
  }, []);

  const openSQLFileExecutionWorkbench = useCallback(({
    connectionId,
    dbName,
    filePath,
    fileName,
    fileSizeMB,
  }: {
    connectionId: string;
    dbName?: string;
    filePath: string;
    fileName?: string;
    fileSizeMB?: string;
  }): boolean => {
    const normalizedConnectionId = String(connectionId || '').trim();
    const normalizedFilePath = String(filePath || '').trim();
    if (!normalizedConnectionId || !normalizedFilePath) {
      return false;
    }
    const conn = connections.find((item) => item.id === normalizedConnectionId);
    if (!conn) {
      message.error(t('sidebar.message.connection_config_not_found'));
      return false;
    }
    addTab(buildSQLFileExecutionWorkbenchTab({
      connectionId: normalizedConnectionId,
      dbName: String(dbName || '').trim() || undefined,
      filePath: normalizedFilePath,
      fileName: String(fileName || '').trim() || undefined,
      fileSizeMB: String(fileSizeMB || '').trim() || undefined,
      autoStart: false,
    }));
    return true;
  }, [addTab, connections]);

  const handleRunSQLFile = (node: any) => {
    if (!launchDatabaseSQLImportWorkbench(node, openDataImportWorkbench)) {
      message.warning(t('sidebar.message.select_connection_or_database_first'));
    }
  };

  const handleOpenSQLFileFromToolbar = async () => {
    const ctx = getActiveContext();
    if (!ctx?.connectionId) {
      message.warning(t('sidebar.message.select_connection_or_database_first'));
      return;
    }
    if (isWebRuntime) {
      const input = browserSQLFileInputRef.current;
      if (!input) {
        message.error(t('sidebar.message.read_file_failed', { error: 'Browser file upload is unavailable' }));
        return;
      }
      browserSQLExecutionContextRef.current = ctx;
      input.value = '';
      input.click();
      return;
    }
    const res = await selectSQLFileForExecution();
    if (res.success) {
      const data = normalizeSQLFileDialogData(res.data);
      if (!data.filePath) {
        message.error(t('sidebar.message.sql_file_path_incomplete'));
        return;
      }
      const fileBinding = resolveExternalSQLFileBinding(
        externalSQLDirectories,
        data.filePath,
        {
          connectionId: String(ctx?.connectionId || '').trim(),
          dbName: String(ctx?.dbName || '').trim(),
        },
      );
      const connectionId = fileBinding
        ? fileBinding.connectionId
        : ctx.connectionId;
      const dbName = fileBinding
        ? fileBinding.dbName
        : String(ctx.dbName || '').trim();
      openSQLFileExecutionWorkbench({
        connectionId,
        dbName,
        filePath: data.filePath,
        fileName: data.fileName,
        fileSizeMB: data.fileSizeMB,
      });
    } else if (res.message !== '已取消') {
      message.error(t('sidebar.message.read_file_failed', { error: res.message }));
    }
  };

  const handleBrowserSQLFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const ctx = browserSQLExecutionContextRef.current;
    browserSQLExecutionContextRef.current = null;
    event.target.value = '';
    if (!file || !ctx?.connectionId) return;
    try {
      const uploaded = await uploadBrowserFile(file, 'sql-execution');
      openSQLFileExecutionWorkbench({
        connectionId: ctx.connectionId,
        dbName: String(ctx.dbName || '').trim(),
        filePath: uploaded.filePath,
        fileName: uploaded.name || file.name,
        fileSizeMB: uploaded.fileSizeMB,
      });
    } catch (error: any) {
      message.error(t('sidebar.message.read_file_failed', {
        error: error?.message || String(error),
      }));
    }
  };

  const resolveExternalSQLExecutionContext = (): { connectionId: string; dbName: string } => {
    const activeStoreContext = getActiveContext();
    const selectedConnectionId = selectedNodesRef.current
      .map((node) => resolveSidebarNodeConnectionId(node, connectionIds))
      .find(Boolean) || '';
    return {
      connectionId: String(
        activeStoreContext?.connectionId
        || activeTab?.connectionId
        || selectedConnectionId
        || '',
      ).trim(),
      dbName: String(
        activeStoreContext?.dbName
        || activeTab?.dbName
        || '',
      ).trim(),
    };
  };
  return {
    externalSQLDirectorySelectionPendingRef, isExternalSQLFileModalOpen,
    setIsExternalSQLFileModalOpen, externalSQLFileForm, externalSQLFileModalMode,
    setExternalSQLFileModalMode, externalSQLFileTarget, setExternalSQLFileTarget,
    isExternalSQLBindingModalOpen, setIsExternalSQLBindingModalOpen, externalSQLBindingForm,
    externalSQLBindingTarget, setExternalSQLBindingTarget, externalSQLBindingDatabases,
    setExternalSQLBindingDatabases, externalSQLBindingDatabaseError,
    setExternalSQLBindingDatabaseError, loadingExternalSQLBindingDatabases,
    setLoadingExternalSQLBindingDatabases, savingExternalSQLBinding, setSavingExternalSQLBinding,
    externalSQLBindingDatabaseRequestRef, browserSQLFileInputRef, loadExternalSQLBindingDatabases,
    openSQLFileExecutionWorkbench, handleRunSQLFile, handleOpenSQLFileFromToolbar,
    handleBrowserSQLFileChange, resolveExternalSQLExecutionContext,
  };
};

export type ExternalSqlExecutionApi = ReturnType<typeof useExternalSqlExecution>;
