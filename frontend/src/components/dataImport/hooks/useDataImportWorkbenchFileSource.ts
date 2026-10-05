import React, { useCallback } from 'react';
import { message } from 'antd';
import { isDatabaseVisible } from '../../../utils/databaseVisibility';
import { isWebRuntime, uploadBrowserFile } from '../../../utils/browserFileTransfer';
import { SelectSQLFileForExecution, ImportData } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { getFileName } from '../dataImportWorkbenchModel';
import { BACKEND_CANCELLED_MESSAGE } from '../../../utils/connectionExport';
import type { DataImportWorkbenchStateApi } from './useDataImportWorkbenchState';

export interface UseDataImportWorkbenchFileSourceInput {
  wasImportingRef: DataImportWorkbenchStateApi['wasImportingRef'];
  setHistoryRefreshToken: DataImportWorkbenchStateApi['setHistoryRefreshToken'];
  setImporting: DataImportWorkbenchStateApi['setImporting'];
  syncWorkbenchTab: DataImportWorkbenchStateApi['syncWorkbenchTab'];
  selectedConnectionId: DataImportWorkbenchStateApi['selectedConnectionId'];
  selectedDbName: DataImportWorkbenchStateApi['selectedDbName'];
  importMode: DataImportWorkbenchStateApi['importMode'];
  selectedTableName: DataImportWorkbenchStateApi['selectedTableName'];
  capabilityAllowsImport: DataImportWorkbenchStateApi['capabilityAllowsImport'];
  selectedConnectionConfig: DataImportWorkbenchStateApi['selectedConnectionConfig'];
  selectedConnection: DataImportWorkbenchStateApi['selectedConnection'];
  loadingDatabases: DataImportWorkbenchStateApi['loadingDatabases'];
  loadingTables: DataImportWorkbenchStateApi['loadingTables'];
  tableImportOptionsValid: DataImportWorkbenchStateApi['tableImportOptionsValid'];
  browserFileInputRef: DataImportWorkbenchStateApi['browserFileInputRef'];
  fileSelectionRequestRef: DataImportWorkbenchStateApi['fileSelectionRequestRef'];
  setSelectingFile: DataImportWorkbenchStateApi['setSelectingFile'];
  setFilePath: DataImportWorkbenchStateApi['setFilePath'];
  setFileName: DataImportWorkbenchStateApi['setFileName'];
  setFileSizeMB: DataImportWorkbenchStateApi['setFileSizeMB'];
  t: DataImportWorkbenchStateApi['t'];
  darkMode: DataImportWorkbenchStateApi['darkMode'];
}

export const useDataImportWorkbenchFileSource = ({
  wasImportingRef, setHistoryRefreshToken, setImporting, syncWorkbenchTab, selectedConnectionId,
  selectedDbName, importMode, selectedTableName, capabilityAllowsImport, selectedConnectionConfig,
  selectedConnection, loadingDatabases, loadingTables, tableImportOptionsValid, browserFileInputRef,
  fileSelectionRequestRef, setSelectingFile, setFilePath, setFileName, setFileSizeMB, t, darkMode,
}: UseDataImportWorkbenchFileSourceInput) => {
  const handleImportingChange = useCallback((nextImporting: boolean) => {
    if (wasImportingRef.current !== nextImporting) {
      setHistoryRefreshToken((current) => current + 1);
    }
    wasImportingRef.current = nextImporting;
    setImporting(nextImporting);
    syncWorkbenchTab({
      connectionId: selectedConnectionId,
      dbName: selectedDbName || undefined,
      tableName: importMode === 'table' ? selectedTableName || undefined : undefined,
      dataImportMode: importMode,
      dataImportRunning: nextImporting,
    });
  }, [importMode, selectedConnectionId, selectedDbName, selectedTableName, syncWorkbenchTab]);

  const handleSelectFile = async () => {
    if (!capabilityAllowsImport || !selectedConnectionConfig || !selectedConnection || loadingDatabases || loadingTables) return;
    if (importMode === 'table' && !tableImportOptionsValid) return;
    if (importMode === 'table' && (!selectedDbName || !selectedTableName)) return;
    if (selectedDbName && !isDatabaseVisible(selectedConnection, selectedDbName)) return;
    if (isWebRuntime()) {
      const input = browserFileInputRef.current;
      if (!input) return;
      input.value = '';
      input.click();
      return;
    }
    const requestId = fileSelectionRequestRef.current + 1;
    fileSelectionRequestRef.current = requestId;
    setSelectingFile(true);
    try {
      const res = importMode === 'database'
        ? await SelectSQLFileForExecution()
        : await ImportData(
            buildRpcConnectionConfig(selectedConnectionConfig) as any,
            selectedDbName,
            selectedTableName,
          );
      if (fileSelectionRequestRef.current !== requestId) return;
      const nextFilePath = String(res?.data?.filePath || '').trim();
      if (res.success && nextFilePath) {
        setFilePath(nextFilePath);
        setFileName(getFileName(nextFilePath));
        setFileSizeMB(importMode === 'database'
          ? String(res?.data?.fileSizeMB || '').trim()
          : '');
        return;
      }
      if (String(res?.message || '').trim() !== BACKEND_CANCELLED_MESSAGE) {
        void message.error(t('data_import.workbench.message.select_file_failed', {
          detail: res?.message || '',
        }));
      }
    } catch (error: any) {
      if (fileSelectionRequestRef.current !== requestId) return;
      void message.error(t('data_import.workbench.message.select_file_failed', {
        detail: error?.message || String(error),
      }));
    } finally {
      if (fileSelectionRequestRef.current === requestId) setSelectingFile(false);
    }
  };

  const handleBrowserFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const requestId = fileSelectionRequestRef.current + 1;
    fileSelectionRequestRef.current = requestId;
    setSelectingFile(true);
    try {
      const uploaded = await uploadBrowserFile(
        file,
        importMode === 'database' ? 'sql-execution' : 'data-import',
      );
      if (fileSelectionRequestRef.current !== requestId) return;
      setFilePath(uploaded.filePath);
      setFileName(uploaded.name || file.name);
      setFileSizeMB(uploaded.fileSizeMB);
    } catch (error: any) {
      if (fileSelectionRequestRef.current !== requestId) return;
      void message.error(t('data_import.workbench.message.select_file_failed', {
        detail: error?.message || String(error),
      }));
    } finally {
      if (fileSelectionRequestRef.current === requestId) setSelectingFile(false);
    }
  };

  const shellBackground = `var(--gn-bg-panel-2, ${darkMode ? '#101319' : '#f5f7fb'})`;
  const panelBackground = `var(--gn-bg-panel, ${darkMode ? '#161b22' : '#ffffff'})`;
  const panelBorder = `1px solid var(--gn-br-1, ${darkMode
    ? 'rgba(255,255,255,0.08)'
    : 'rgba(15,23,42,0.08)'})`;
  const selectedFileBackground = `var(--gn-bg-subtle, var(--gn-bg-panel-2, ${darkMode
    ? 'rgba(255,255,255,0.04)'
    : '#f8fafc'}))`;
  return {
    handleImportingChange, handleSelectFile, handleBrowserFileChange, shellBackground,
    panelBackground, panelBorder, selectedFileBackground,
  };
};

export type DataImportWorkbenchFileSourceApi = ReturnType<typeof useDataImportWorkbenchFileSource>;
