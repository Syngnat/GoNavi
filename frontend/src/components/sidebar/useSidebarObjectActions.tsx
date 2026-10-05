import { type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { FormInstance } from 'antd/es/form';
import type { SavedConnection, SavedQuery } from '../../types';
import type { ExportRunResult, RunExportWithProgressOptions } from '../useExportProgressRunner';
import type { DatabaseCharsetOption, DatabaseCollationOption } from '../../utils/databaseCharset';
import type { SidebarTreeLoadOptions } from './useSidebarTreeLoaders';
import { type SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import { useSidebarCopyExportActions } from './useSidebarCopyExportActions';
import { useSidebarDatabaseSchemaActions } from './useSidebarDatabaseSchemaActions';
import { useSidebarTableAndViewActions } from './useSidebarTableAndViewActions';
import { useSidebarSavedQueryActions } from './useSidebarSavedQueryActions';
import { useSidebarRoutineActions } from './useSidebarRoutineActions';
import { useSidebarMessageQueueActions } from './useSidebarMessageQueueActions';

export type SidebarMessagePublishTarget = {
  connection: SavedConnection;
  executionDbName: string;
  destination: string;
  exchange?: string;
};

type RunExportWithProgress = <T extends ExportRunResult>(
  options: RunExportWithProgressOptions<T>,
) => Promise<T | null>;

export type UseSidebarObjectActionsArgs = {
  connections: SavedConnection[];
  connectionIds: string[];
  connectionIdSet: Set<string>;
  tabs: any[];
  treeDataRef: MutableRefObject<TreeNode[]>;
  setTreeData: Dispatch<SetStateAction<TreeNode[]>>;
  setExpandedKeys: Dispatch<SetStateAction<React.Key[]>>;
  setLoadedKeys: Dispatch<SetStateAction<React.Key[]>>;
  addTab: (tab: any) => void;
  updateQueryTabDraft: (tabId: string, draft: any) => void;
  saveQuery: (query: SavedQuery) => Promise<SavedQuery>;
  addSqlLog: (log: any) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  createDbForm: FormInstance;
  targetConnection: any;
  isCreateDbModalOpen: boolean;
  setIsCreateDbModalOpen: Dispatch<SetStateAction<boolean>>;
  createDbCharsets: DatabaseCharsetOption[];
  setCreateDbCharsets: Dispatch<SetStateAction<DatabaseCharsetOption[]>>;
  createDbCollations: DatabaseCollationOption[];
  setCreateDbCollations: Dispatch<SetStateAction<DatabaseCollationOption[]>>;
  loadingCreateDbOptions: boolean;
  setLoadingCreateDbOptions: Dispatch<SetStateAction<boolean>>;
  createSchemaForm: FormInstance;
  createSchemaTarget: any;
  setCreateSchemaTarget: Dispatch<SetStateAction<any>>;
  setIsCreateSchemaModalOpen: Dispatch<SetStateAction<boolean>>;
  renameSchemaForm: FormInstance;
  renameSchemaTarget: any;
  setRenameSchemaTarget: Dispatch<SetStateAction<any>>;
  setIsRenameSchemaModalOpen: Dispatch<SetStateAction<boolean>>;
  renameDbForm: FormInstance;
  renameDbTarget: any;
  setRenameDbTarget: Dispatch<SetStateAction<any>>;
  setIsRenameDbModalOpen: Dispatch<SetStateAction<boolean>>;
  renameTableForm: FormInstance;
  renameTableTarget: any;
  setRenameTableTarget: Dispatch<SetStateAction<any>>;
  setIsRenameTableModalOpen: Dispatch<SetStateAction<boolean>>;
  renameViewForm: FormInstance;
  renameViewTarget: any;
  setRenameViewTarget: Dispatch<SetStateAction<any>>;
  setIsRenameViewModalOpen: Dispatch<SetStateAction<boolean>>;
  renameSavedQueryForm: FormInstance;
  renameSavedQueryTarget: SavedQuery | null;
  setRenameSavedQueryTarget: Dispatch<SetStateAction<SavedQuery | null>>;
  setIsRenameSavedQueryModalOpen: Dispatch<SetStateAction<boolean>>;
  setMessagePublishTarget: Dispatch<SetStateAction<SidebarMessagePublishTarget | null>>;
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  getConnectionNodeRef: (connRef: any) => any;
  getDatabaseNodeRef: (connRef: any, dbName: string) => any;
  extractObjectName: (fullName: string) => string;
  isPostgresSchemaDialect: (dialect: string) => boolean;
  loadDatabases: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  loadTables: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  openDesign: (node: any, initialTab: string, readOnly?: boolean) => void;
  onDoubleClick: (event: any, node: any) => void;
  runExportWithProgress: RunExportWithProgress;
  setAIPanelVisible: (visible: boolean) => void;
  addAIContext: (connectionId: string, context: { dbName: string; tableName: string; ddl: string }) => void;
  migrateVisibilityForRenamedDatabase: (
    connection: SavedConnection,
    oldDbName: string,
    newDbName: string,
  ) => Promise<SavedConnection>;
  removeVisibilityForDeletedDatabase: (
    connection: SavedConnection,
    dbName: string,
  ) => Promise<SavedConnection>;
  migrateVisibilityForRenamedSchema: (
    connection: SavedConnection,
    dbName: string,
    oldSchemaName: string,
    newSchemaName: string,
  ) => Promise<SavedConnection>;
  removeVisibilityForDeletedSchema: (
    connection: SavedConnection,
    dbName: string,
    schemaName: string,
  ) => Promise<SavedConnection>;
  migratePinnedDatabaseKey: (
    connectionId: string,
    oldDbName: string,
    newDbName?: string,
  ) => void;
};

export const useSidebarObjectActions = ({
  connections,
  connectionIds,
  connectionIdSet,
  tabs,
  treeDataRef,
  setTreeData,
  setExpandedKeys,
  setLoadedKeys,
  addTab,
  updateQueryTabDraft,
  saveQuery,
  addSqlLog,
  closeTabsByDatabase,
  createDbForm,
  targetConnection,
  isCreateDbModalOpen,
  setIsCreateDbModalOpen,
  createDbCharsets,
  setCreateDbCharsets,
  createDbCollations,
  setCreateDbCollations,
  loadingCreateDbOptions,
  setLoadingCreateDbOptions,
  createSchemaForm,
  createSchemaTarget,
  setCreateSchemaTarget,
  setIsCreateSchemaModalOpen,
  renameSchemaForm,
  renameSchemaTarget,
  setRenameSchemaTarget,
  setIsRenameSchemaModalOpen,
  renameDbForm,
  renameDbTarget,
  setRenameDbTarget,
  setIsRenameDbModalOpen,
  renameTableForm,
  renameTableTarget,
  setRenameTableTarget,
  setIsRenameTableModalOpen,
  renameViewForm,
  renameViewTarget,
  setRenameViewTarget,
  setIsRenameViewModalOpen,
  renameSavedQueryForm,
  renameSavedQueryTarget,
  setRenameSavedQueryTarget,
  setIsRenameSavedQueryModalOpen,
  setMessagePublishTarget,
  buildRuntimeConfig,
  getConnectionNodeRef,
  getDatabaseNodeRef,
  extractObjectName,
  isPostgresSchemaDialect,
  loadDatabases,
  loadTables,
  openDesign,
  onDoubleClick,
  runExportWithProgress,
  setAIPanelVisible,
  addAIContext,
  migrateVisibilityForRenamedDatabase,
  removeVisibilityForDeletedDatabase,
  migrateVisibilityForRenamedSchema,
  removeVisibilityForDeletedSchema,
  migratePinnedDatabaseKey,
}: UseSidebarObjectActionsArgs) => {
  const {
    confirmSidebarMutation, handleCopyStructure, handleCopyTableName, handleCopyTable,
    handleCopyDatabaseName, handleExport, openExportDialog, handleCopyTableAsInsert,
    openTableDdlInDesigner, openTableInERView, injectTablePromptToAI,
  } = useSidebarCopyExportActions({
    connections, buildRuntimeConfig, loadTables, getDatabaseNodeRef, connectionIds, addTab,
    runExportWithProgress, openDesign, onDoubleClick, addAIContext, setAIPanelVisible,
  });

  const {
    handleCreateDatabase, openCreateSchemaModal, handleCreateSchema, openRenameSchemaModal,
    handleRenameSchema, handleDeleteSchema, handleRenameDatabase, handleDeleteDatabase,
    handleRenameTable, handleDeleteTable,
  } = useSidebarDatabaseSchemaActions({
    createDbForm, targetConnection, setIsCreateDbModalOpen, loadDatabases, confirmSidebarMutation,
    isCreateDbModalOpen, setLoadingCreateDbOptions, setCreateDbCharsets, setCreateDbCollations,
    isPostgresSchemaDialect, setCreateSchemaTarget, createSchemaForm, setIsCreateSchemaModalOpen,
    createSchemaTarget, loadTables, setRenameSchemaTarget, renameSchemaForm,
    setIsRenameSchemaModalOpen, renameSchemaTarget, migrateVisibilityForRenamedSchema,
    setExpandedKeys, setLoadedKeys, getDatabaseNodeRef, removeVisibilityForDeletedSchema,
    renameDbTarget, renameDbForm, buildRuntimeConfig, migrateVisibilityForRenamedDatabase,
    migratePinnedDatabaseKey, setIsRenameDbModalOpen, setRenameDbTarget,
    removeVisibilityForDeletedDatabase, closeTabsByDatabase, getConnectionNodeRef,
    renameTableTarget, renameTableForm, extractObjectName, setIsRenameTableModalOpen,
    setRenameTableTarget,
  });

  const {
    handleTableDataDangerAction, openViewDefinition, openEditView, openCreateView,
    openCreateStarRocksMaterializedView, openCreateStarRocksExternalCatalog,
    openCreateStarRocksRollup, handleDropView, handleRenameView,
  } = useSidebarTableAndViewActions({
    buildRuntimeConfig, addSqlLog, loadTables, getDatabaseNodeRef, confirmSidebarMutation, addTab,
    renameViewTarget, renameViewForm, extractObjectName, setIsRenameViewModalOpen,
    setRenameViewTarget,
  });

  const {
    openRenameSavedQueryModal, handleRenameSavedQuery, handleRevealSavedQueryInFolder,
    isSavedQueryUnmatched, handleRebindSavedQuery,
  } = useSidebarSavedQueryActions({
    setRenameSavedQueryTarget, renameSavedQueryForm, setIsRenameSavedQueryModalOpen,
    renameSavedQueryTarget, saveQuery, treeDataRef, setTreeData, tabs, updateQueryTabDraft,
    connectionIdSet,
  });

  const {
    openRoutineDefinition, openEventDefinition, openEditEvent, openSequenceDefinition,
    openPackageDefinition, openEditRoutine, openCreateRoutine, handleDropRoutine,
    handleCompileOracleObject,
  } = useSidebarRoutineActions({
    addTab, buildRuntimeConfig, loadTables, getDatabaseNodeRef, confirmSidebarMutation,
  });

  const {
    resolveMessagePublishTarget, openMessageQueueWorkbench, openMessagePublishModal,
    handleMessagePublishSuccess,
  } = useSidebarMessageQueueActions({ connections, addTab, setMessagePublishTarget });

  return {
    handleCopyStructure,
    handleCopyTable,
    handleCopyTableName,
    handleCopyDatabaseName,
    handleExport,
    openExportDialog,
    handleCopyTableAsInsert,
    openTableDdlInDesigner,
    openTableInERView,
    injectTablePromptToAI,
    handleCreateDatabase,
    openCreateSchemaModal,
    handleCreateSchema,
    openRenameSchemaModal,
    handleRenameSchema,
    handleDeleteSchema,
    handleRenameDatabase,
    handleDeleteDatabase,
    handleRenameTable,
    handleDeleteTable,
    handleTableDataDangerAction,
    openViewDefinition,
    openEditView,
    openCreateView,
    openCreateStarRocksMaterializedView,
    openCreateStarRocksExternalCatalog,
    openCreateStarRocksRollup,
    handleDropView,
    handleRenameView,
    openRenameSavedQueryModal,
    handleRenameSavedQuery,
    handleRevealSavedQueryInFolder,
    isSavedQueryUnmatched,
    handleRebindSavedQuery,
    openRoutineDefinition,
    openEventDefinition,
    openEditEvent,
    openSequenceDefinition,
    openPackageDefinition,
    openEditRoutine,
    openCreateRoutine,
    handleDropRoutine,
    handleCompileOracleObject,
    resolveMessagePublishTarget,
    openMessageQueueWorkbench,
    openMessagePublishModal,
    handleMessagePublishSuccess,
  };
};
