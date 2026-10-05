import React from 'react';
import type { SavedConnection, ExternalSQLDirectory } from '../../types';
import type { BuildDataImportWorkbenchTabInput } from '../../utils/dataImportTab';
import { launchDatabaseSQLImportWorkbench } from './sidebarExternalSqlLaunch';
import { useExternalSqlExecution } from './useExternalSqlExecution';
import { useExternalSqlBinding } from './useExternalSqlBinding';
import { useExternalSqlFileModal } from './useExternalSqlFileModal';
import { useExternalSqlDirectoryActions } from './useExternalSqlDirectoryActions';
export { launchDatabaseSQLImportWorkbench } from './sidebarExternalSqlLaunch';

export type { SQLFileExecutionStatus } from './sidebarExternalSqlHelpers';
export {
  buildSQLFileExecutionFooter,
  SQLFileExecutionProgressContent,
  ExternalSQLFileModal,
  ExternalSQLBindingModal,
  SQLFileExecutionModal,
} from './SidebarExternalSqlModals';
export type { SQLFileExecutionProgressState } from './SidebarExternalSqlModals';

export type ActiveExecutionContext = {
  connectionId?: string;
  dbName?: string;
} | null | undefined;

type RefreshExternalSQLRootNode = (
  showLoading?: boolean,
  directoriesOverride?: ExternalSQLDirectory[],
) => Promise<void>;

export type UseSidebarExternalSqlWorkflowOptions = {
  connections: SavedConnection[];
  externalSQLDirectories: ExternalSQLDirectory[];
  activeTab: {
    connectionId?: string;
    dbName?: string;
  } | null;
  connectionIds: string[];
  selectedNodesRef: React.MutableRefObject<any[]>;
  addTab: (tab: any) => void;
  openDataImportWorkbench: (input: BuildDataImportWorkbenchTabInput) => void;
  saveExternalSQLDirectory: (directory: ExternalSQLDirectory) => void;
  deleteExternalSQLDirectory: (directoryId: string) => void;
  updateRecentSQLFilePath: (previousPath: string, nextPath: string) => void;
  removeRecentSQLFilesByPath: (filePath: string) => void;
  moveRecentSQLFilesByDirectory: (previousDirectoryPath: string, nextDirectoryPath: string) => void;
  removeRecentSQLFilesByDirectory: (directoryPath: string) => void;
  refreshGlobalExternalSQLRootNode: RefreshExternalSQLRootNode;
  setExpandedKeys: React.Dispatch<React.SetStateAction<React.Key[]>>;
  setAutoExpandParent: React.Dispatch<React.SetStateAction<boolean>>;
  getActiveContext: () => ActiveExecutionContext;
  isWebRuntime?: boolean;
};

export const useSidebarExternalSqlWorkflow = ({
  connections,
  externalSQLDirectories,
  activeTab,
  connectionIds,
  selectedNodesRef,
  addTab,
  openDataImportWorkbench,
  saveExternalSQLDirectory,
  deleteExternalSQLDirectory,
  updateRecentSQLFilePath,
  removeRecentSQLFilesByPath,
  moveRecentSQLFilesByDirectory,
  removeRecentSQLFilesByDirectory,
  refreshGlobalExternalSQLRootNode,
  setExpandedKeys,
  setAutoExpandParent,
  getActiveContext,
  isWebRuntime = false,
}: UseSidebarExternalSqlWorkflowOptions) => {
  const {
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
  } = useExternalSqlExecution({
    connections, addTab, openDataImportWorkbench, getActiveContext, isWebRuntime,
    externalSQLDirectories, selectedNodesRef, connectionIds, activeTab,
  });

  const {
    closeExternalSQLBindingModal, openExternalSQLBindingModal,
    handleExternalSQLBindingConnectionChange, handleExternalSQLBindingOk,
    handleClearExternalSQLBinding, transformExternalSQLDirectoryBindings,
  } = useExternalSqlBinding({
    externalSQLBindingDatabaseRequestRef, setIsExternalSQLBindingModalOpen,
    setExternalSQLBindingTarget, setExternalSQLBindingDatabases, setExternalSQLBindingDatabaseError,
    setLoadingExternalSQLBindingDatabases, externalSQLBindingForm, connections,
    resolveExternalSQLExecutionContext, loadExternalSQLBindingDatabases, externalSQLDirectories,
    saveExternalSQLDirectory, refreshGlobalExternalSQLRootNode, externalSQLBindingTarget,
    setSavingExternalSQLBinding,
  });

  const {
    openExternalSQLFile, openCreateExternalSQLFileModal, openRenameExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal, openRenameExternalSQLDirectoryModal,
    closeExternalSQLFileModal, handleExternalSQLFileModalOk,
  } = useExternalSqlFileModal({
    addTab, resolveExternalSQLExecutionContext, openSQLFileExecutionWorkbench,
    setExternalSQLFileModalMode, setExternalSQLFileTarget, externalSQLFileForm,
    setIsExternalSQLFileModalOpen, refreshGlobalExternalSQLRootNode, updateRecentSQLFilePath,
    moveRecentSQLFilesByDirectory, externalSQLDirectories, deleteExternalSQLDirectory,
    saveExternalSQLDirectory, externalSQLFileModalMode, externalSQLFileTarget,
    transformExternalSQLDirectoryBindings,
  });

  const {
    handleDeleteExternalSQLFile, handleDeleteExternalSQLDirectory, handleAddExternalSQLDirectory,
    handleRemoveExternalSQLDirectory, handleRefreshExternalSQLDirectory,
  } = useExternalSqlDirectoryActions({
    removeRecentSQLFilesByPath, refreshGlobalExternalSQLRootNode,
    transformExternalSQLDirectoryBindings, removeRecentSQLFilesByDirectory, externalSQLDirectories,
    deleteExternalSQLDirectory, getActiveContext, saveExternalSQLDirectory, setExpandedKeys,
    setAutoExpandParent, externalSQLDirectorySelectionPendingRef,
  });

  return {
    handleRunSQLFile,
    handleOpenSQLFileFromToolbar,
    openExternalSQLFile,
    openExternalSQLBindingModal,
    openCreateExternalSQLFileModal,
    openRenameExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal,
    openRenameExternalSQLDirectoryModal,
    handleExternalSQLFileModalOk,
    handleDeleteExternalSQLFile,
    handleDeleteExternalSQLDirectory,
    handleAddExternalSQLDirectory,
    handleRemoveExternalSQLDirectory,
    handleRefreshExternalSQLDirectory,
    browserSQLFileInputProps: {
      ref: browserSQLFileInputRef,
      type: 'file' as const,
      accept: '.sql,.sql.gz',
      style: { display: 'none' },
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        void handleBrowserSQLFileChange(event);
      },
    },
    externalSQLFileModalProps: {
      open: isExternalSQLFileModalOpen,
      mode: externalSQLFileModalMode,
      form: externalSQLFileForm,
      onOk: handleExternalSQLFileModalOk,
      onCancel: closeExternalSQLFileModal,
    },
    externalSQLBindingModalProps: {
      open: isExternalSQLBindingModalOpen,
      form: externalSQLBindingForm,
      connections,
      filePath: String(externalSQLBindingTarget?.dataRef?.path || '').trim(),
      databaseOptions: externalSQLBindingDatabases,
      loadingDatabases: loadingExternalSQLBindingDatabases,
      databaseLoadError: externalSQLBindingDatabaseError,
      hasExplicitBinding: externalSQLBindingTarget?.dataRef?.hasExplicitBinding === true,
      saving: savingExternalSQLBinding,
      onConnectionChange: handleExternalSQLBindingConnectionChange,
      onClearBinding: () => { void handleClearExternalSQLBinding(); },
      onOk: () => { void handleExternalSQLBindingOk(); },
      onCancel: () => {
        if (!savingExternalSQLBinding) closeExternalSQLBindingModal();
      },
    },
  };
};
