import { useCallback, useRef, useState } from 'react';
import { message } from 'antd';
import { buildImportParserOptions } from '../../importPreview/importPreviewModel';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { invokeAppWithSignal, isWebRPCAbortError } from '../../../utils/webRpc';
import type { DataImportWorkbenchStateApi } from './useDataImportWorkbenchState';
import type {
  ImportInferredColumn,
  ImportTableSchemaInference,
} from '../importTableTypeMapping';

type QueryResultLike = {
  success?: boolean;
  message?: string;
  data?: unknown;
};

export type ImportTableSelection = {
  filePath: string;
  fileName: string;
  fileSizeMB: string;
};

type DynamicImportApp = {
  InferImportTableSchema?: (
    config: unknown,
    dbName: string,
    filePath: string,
    options: unknown,
  ) => Promise<QueryResultLike>;
};

const resolveInferenceBinding = () => {
  const scopes = [
    typeof window === 'undefined' ? null : window,
    globalThis,
  ] as Array<typeof globalThis & { go?: { app?: { App?: DynamicImportApp } } }>;
  return scopes
    .map((scope) => scope?.go?.app?.App?.InferImportTableSchema)
    .find((binding) => typeof binding === 'function');
};

const readRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const readOptionalInteger = (value: unknown): number | undefined => {
  const numberValue = Math.trunc(Number(value));
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
};

const normalizeInference = (raw: unknown): ImportTableSchemaInference | null => {
  const record = readRecord(raw);
  if (!record || !Array.isArray(record.columns)) return null;
  const columns = record.columns.reduce<ImportInferredColumn[]>((result, value) => {
    const column = readRecord(value);
    if (!column) return result;
    const name = String(column.name || '').trim();
    if (!name) return result;
    result.push({
      name,
      sourceName: String(column.sourceName || name),
      logicalType: String(column.logicalType || 'text'),
      nullable: column.nullable !== false,
      maxLength: readOptionalInteger(column.maxLength),
      precision: readOptionalInteger(column.precision),
      scale: readOptionalInteger(column.scale),
    });
    return result;
  }, []);
  if (columns.length === 0) return null;
  return {
    tableName: String(record.tableName || '').trim(),
    columns,
    warnings: Array.isArray(record.warnings)
      ? record.warnings.map((warning) => String(warning || '').trim()).filter(Boolean)
      : [],
    sampledRows: Math.max(0, Number(record.sampledRows) || 0),
    sampleLimit: Math.max(0, Number(record.sampleLimit) || 0),
  };
};

const requestImportSchemaInference = (
  selection: ImportTableSelection,
  selectedDbName: string,
  selectedConnectionConfig: NonNullable<DataImportWorkbenchStateApi['selectedConnectionConfig']>,
  activePreferences: DataImportWorkbenchStateApi['activePreferences'],
  continueOnError: boolean,
  signal: AbortSignal,
  t: DataImportWorkbenchStateApi['t'],
) => {
  const config = {
    ...selectedConnectionConfig,
    port: Number(selectedConnectionConfig.port),
    password: selectedConnectionConfig.password || '',
    database: selectedConnectionConfig.database || '',
    useSSH: selectedConnectionConfig.useSSH || false,
    ssh: selectedConnectionConfig.ssh || {
      host: '',
      port: 22,
      user: '',
      password: '',
      keyPath: '',
    },
  };
  const parserOptions = buildImportParserOptions(
    activePreferences,
    continueOnError,
    selectedConnectionConfig,
  );
  const rpcConfig = buildRpcConnectionConfig(config) as unknown;
  return invokeAppWithSignal<QueryResultLike>(
    'InferImportTableSchema',
    [rpcConfig, selectedDbName, selection.filePath, parserOptions],
    signal,
    () => {
      const binding = resolveInferenceBinding();
      if (typeof binding !== 'function') {
        return Promise.reject(new Error(t('data_import.create_table.error.binding_unavailable')));
      }
      return binding(rpcConfig, selectedDbName, selection.filePath, parserOptions);
    },
  );
};

export interface UseImportTableCreateInferenceInput {
  t: DataImportWorkbenchStateApi['t'];
  selectedDbName: DataImportWorkbenchStateApi['selectedDbName'];
  selectedConnectionConfig: DataImportWorkbenchStateApi['selectedConnectionConfig'];
  activePreferences: DataImportWorkbenchStateApi['activePreferences'];
  continueOnError: DataImportWorkbenchStateApi['continueOnError'];
}

export const useImportTableCreateInference = ({
  t,
  selectedDbName,
  selectedConnectionConfig,
  activePreferences,
  continueOnError,
}: UseImportTableCreateInferenceInput) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [inference, setInference] = useState<ImportTableSchemaInference | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ImportTableSelection | null>(null);
  const [inferring, setInferring] = useState(false);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const resetInference = useCallback(() => {
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setInferring(false);
    setModalOpen(false);
    setInference(null);
    setPendingSelection(null);
  }, []);

  const inferFile = useCallback(async (selection: ImportTableSelection) => {
    if (!selectedConnectionConfig) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInferring(true);
    try {
      const result = await requestImportSchemaInference(
        selection,
        selectedDbName,
        selectedConnectionConfig,
        activePreferences,
        continueOnError,
        controller.signal,
        t,
      );
      if (requestRef.current !== requestId) return;
      if (!result.success) {
        void message.error(t('data_import.create_table.error.infer_failed', {
          detail: result.message || '',
        }));
        return;
      }
      const parsed = normalizeInference(result.data);
      if (!parsed) {
        void message.error(t('data_import.create_table.error.empty_columns'));
        return;
      }
      setPendingSelection(selection);
      setInference(parsed);
      setModalOpen(true);
    } catch (error: unknown) {
      if (requestRef.current !== requestId) return;
      if (isWebRPCAbortError(error)) return;
      void message.error(t('data_import.create_table.error.infer_failed', {
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (requestRef.current === requestId) {
        setInferring(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  }, [
    activePreferences,
    continueOnError,
    selectedConnectionConfig,
    selectedDbName,
    t,
  ]);

  return {
    modalOpen,
    inference,
    pendingSelection,
    inferring,
    inferFile,
    resetInference,
    closeModal: resetInference,
  };
};
