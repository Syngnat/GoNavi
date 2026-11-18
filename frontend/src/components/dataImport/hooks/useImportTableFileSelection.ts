import React, { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { isWebRuntime, uploadBrowserFile } from '../../../utils/browserFileTransfer';
import { invokeAppWithSignal } from '../../../utils/webRpc';
import { BACKEND_CANCELLED_MESSAGE } from '../../../utils/connectionExport';
import { getFileName } from '../dataImportWorkbenchModel';
import type { DataImportWorkbenchStateApi } from './useDataImportWorkbenchState';
import type { ImportTableSelection } from './useImportTableCreateInference';

type QueryResultLike = {
  success?: boolean;
  message?: string;
  data?: unknown;
};

type DynamicImportApp = {
  SelectDataImportFile?: () => Promise<QueryResultLike>;
};

const selectDesktopImportFile = (t: DataImportWorkbenchStateApi['t']) => (
  invokeAppWithSignal<QueryResultLike>(
    'SelectDataImportFile',
    [],
    undefined,
    () => {
      const scopes = [
        typeof window === 'undefined' ? null : window,
        globalThis,
      ] as Array<typeof globalThis & { go?: { app?: { App?: DynamicImportApp } } }>;
      const binding = scopes
        .map((scope) => scope?.go?.app?.App?.SelectDataImportFile)
        .find((candidate) => typeof candidate === 'function');
      if (typeof binding !== 'function') {
        return Promise.reject(new Error(t('data_import.create_table.error.binding_unavailable')));
      }
      return binding();
    },
  )
);

const readFilePath = (raw: unknown): string => {
  if (!raw || typeof raw !== 'object') return '';
  return String((raw as Record<string, unknown>).filePath || '').trim();
};

export interface UseImportTableFileSelectionInput {
  t: DataImportWorkbenchStateApi['t'];
  enabled: boolean;
  inferring: boolean;
  selectedConnectionId: DataImportWorkbenchStateApi['selectedConnectionId'];
  selectedDbName: DataImportWorkbenchStateApi['selectedDbName'];
  importMode: DataImportWorkbenchStateApi['importMode'];
  inferFile: (selection: ImportTableSelection) => Promise<void>;
  resetInference: () => void;
}

export const useImportTableFileSelection = ({
  t,
  enabled,
  inferring,
  selectedConnectionId,
  selectedDbName,
  importMode,
  inferFile,
  resetInference,
}: UseImportTableFileSelectionInput) => {
  const [selectingFile, setSelectingFile] = useState(false);
  const webFileInputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const targetKey = [selectedConnectionId, selectedDbName, importMode].join('::');

  const resetSelection = useCallback(() => {
    requestRef.current += 1;
    setSelectingFile(false);
    resetInference();
    if (webFileInputRef.current) webFileInputRef.current.value = '';
  }, [resetInference]);

  useEffect(() => {
    resetSelection();
  }, [resetSelection, targetKey]);

  const handleStart = async () => {
    if (!enabled || selectingFile || inferring) return;
    if (isWebRuntime()) {
      const input = webFileInputRef.current;
      if (!input) return;
      input.value = '';
      input.click();
      return;
    }

    setSelectingFile(true);
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    try {
      const result = await selectDesktopImportFile(t);
      if (requestRef.current !== requestId) return;
      const filePath = readFilePath(result.data);
      if (result.success && filePath) {
        await inferFile({
          filePath,
          fileName: getFileName(filePath),
          fileSizeMB: '',
        });
        return;
      }
      if (String(result.message || '').trim() !== BACKEND_CANCELLED_MESSAGE) {
        void message.error(t('data_import.create_table.error.select_file_failed', {
          detail: result.message || '',
        }));
      }
    } catch (error: unknown) {
      if (requestRef.current !== requestId) return;
      void message.error(t('data_import.create_table.error.select_file_failed', {
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (requestRef.current === requestId) setSelectingFile(false);
    }
  };

  const handleBrowserFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !enabled) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setSelectingFile(true);
    try {
      const uploaded = await uploadBrowserFile(file, 'data-import');
      if (requestRef.current !== requestId) return;
      await inferFile({
        filePath: uploaded.filePath,
        fileName: uploaded.name || file.name,
        fileSizeMB: uploaded.fileSizeMB,
      });
    } catch (error: unknown) {
      if (requestRef.current !== requestId) return;
      void message.error(t('data_import.create_table.error.select_file_failed', {
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (requestRef.current === requestId) setSelectingFile(false);
    }
  };

  return {
    webFileInputRef,
    selectingFile,
    handleStart,
    handleBrowserFileChange,
    resetSelection,
  };
};
