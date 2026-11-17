import { resolveSqlDialect } from '../../../utils/sqlDialect';
import type { DataImportWorkbenchStateApi } from './useDataImportWorkbenchState';
import { useImportTableCreateInference } from './useImportTableCreateInference';
import { useImportTableFileSelection } from './useImportTableFileSelection';
import type { ImportTableCreatePayload } from '../importTableTypeMapping';

export interface UseImportTableCreateFlowInput {
  t: DataImportWorkbenchStateApi['t'];
  enabled: boolean;
  selectedConnectionId: DataImportWorkbenchStateApi['selectedConnectionId'];
  selectedDbName: DataImportWorkbenchStateApi['selectedDbName'];
  selectedConnectionConfig: DataImportWorkbenchStateApi['selectedConnectionConfig'];
  importMode: DataImportWorkbenchStateApi['importMode'];
  activePreferences: DataImportWorkbenchStateApi['activePreferences'];
  continueOnError: DataImportWorkbenchStateApi['continueOnError'];
  applyAutoCreateTable: DataImportWorkbenchStateApi['applyAutoCreateTable'];
}

export const useImportTableCreateFlow = ({
  t,
  enabled,
  selectedConnectionId,
  selectedDbName,
  selectedConnectionConfig,
  importMode,
  activePreferences,
  continueOnError,
  applyAutoCreateTable,
}: UseImportTableCreateFlowInput) => {
  const inference = useImportTableCreateInference({
    t,
    selectedDbName,
    selectedConnectionConfig,
    activePreferences,
    continueOnError,
  });
  const selection = useImportTableFileSelection({
    t,
    enabled,
    inferring: inference.inferring,
    selectedConnectionId,
    selectedDbName,
    importMode,
    inferFile: inference.inferFile,
    resetInference: inference.resetInference,
  });
  const cancelFlow = selection.resetSelection;

  const handleConfirm = (payload: ImportTableCreatePayload) => {
    if (!inference.pendingSelection || !inference.inference) return;
    applyAutoCreateTable({
      ...payload,
      typeRow: inference.typeRow,
      commentRow: inference.commentRow,
    }, inference.pendingSelection);
    inference.closeModal();
  };
  const dialect = selectedConnectionConfig
    ? resolveSqlDialect(
        selectedConnectionConfig.type,
        selectedConnectionConfig.driver,
        selectedConnectionConfig,
      )
    : '';
  return {
    webFileInputRef: selection.webFileInputRef,
    modalOpen: inference.modalOpen,
    inference: inference.inference,
    pendingSelection: inference.pendingSelection,
    dialect,
    busy: selection.selectingFile || inference.inferring,
    handleStart: selection.handleStart,
    handleBrowserFileChange: selection.handleBrowserFileChange,
    handleConfirm,
    handleCancel: cancelFlow,
    typeRow: inference.typeRow,
    commentRow: inference.commentRow,
    reinferring: inference.inferring && inference.modalOpen,
    applyRows: inference.applyRows,
  };
};

export type ImportTableCreateFlowApi = ReturnType<typeof useImportTableCreateFlow>;
