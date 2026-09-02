import React, { useCallback, useRef, useState } from 'react';
import { Button, Form, Input, Progress, Select, message } from 'antd';
import type { FormInstance } from 'antd/es/form';
import Modal from '../common/ResizableDraggableModal';
import type { SavedConnection, ExternalSQLDirectory } from '../../types';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import {
  buildExternalSQLDirectoryId,
  buildExternalSQLTabId,
  findExternalSQLDirectoriesByPath,
  moveExternalSQLFileBindings,
  normalizeExternalSQLPath,
  removeExternalSQLFileBindings,
  resolveExternalSQLFileBinding,
  setExternalSQLFileBinding,
} from '../../utils/externalSqlTree';
import { buildSQLFileExecutionWorkbenchTab } from '../../utils/sqlFileExecutionTab';
import type { BuildDataImportWorkbenchTabInput } from '../../utils/dataImportTab';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { uploadBrowserFile } from '../../utils/browserFileTransfer';
import { filterVisibleDatabaseNames } from '../../utils/databaseVisibility';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { resolveConnectionHostSummary } from '../../utils/tabDisplay';
import { t } from '../../i18n';
import { resolveSidebarNodeConnectionId } from '../sidebarV2Utils';
import {
  isExternalSQLDirectoryModalMode,
  type ExternalSQLFileModalMode,
} from '../sidebarCoreUtils';
import {
  OpenSQLFile,
  SelectSQLDirectory,
  ReadSQLFile,
  DBGetDatabases,
  CreateSQLFile,
  CreateSQLDirectory,
  DeleteSQLFile,
  DeleteSQLDirectory,
  RenameSQLFile,
  RenameSQLDirectory,
} from '../../../wailsjs/go/app/App';

export type SQLFileExecutionStatus = 'running' | 'done' | 'cancelled' | 'error';

export type SQLFileExecutionProgressState = {
  fileSizeMB: string;
  status: SQLFileExecutionStatus;
  executed: number;
  failed: number;
  percent: number;
  currentSQL: string;
  resultMessage: string;
};

type SQLFileExecutionState = SQLFileExecutionProgressState & {
  open: boolean;
  jobId: string;
  total: number;
};

type ActiveExecutionContext = {
  connectionId?: string;
  dbName?: string;
} | null | undefined;

type RefreshExternalSQLRootNode = (
  showLoading?: boolean,
  directoriesOverride?: ExternalSQLDirectory[],
) => Promise<void>;

type UseSidebarExternalSqlWorkflowOptions = {
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

export const launchDatabaseSQLImportWorkbench = (
  node: any,
  openDataImportWorkbench: (input: BuildDataImportWorkbenchTabInput) => void,
): boolean => {
  const connectionId = node?.type === 'connection'
    ? String(node?.key || '').trim()
    : String(node?.dataRef?.id || '').trim();
  if (!connectionId) return false;

  openDataImportWorkbench({
    connectionId,
    dbName: String(node?.dataRef?.dbName || '').trim(),
    mode: 'database',
  });
  return true;
};

type ExternalSQLFileModalProps = {
  open: boolean;
  mode: ExternalSQLFileModalMode;
  form: FormInstance;
  onOk: () => void;
  onCancel: () => void;
};

type SQLFileExecutionModalProps = {
  title: React.ReactNode;
  state: SQLFileExecutionState;
  modalPanelStyle: React.CSSProperties;
  onCancelExecution: () => void;
  onClose: () => void;
};

type ExternalSQLBindingModalProps = {
  open: boolean;
  form: FormInstance;
  connections: SavedConnection[];
  filePath: string;
  databaseOptions: string[];
  loadingDatabases: boolean;
  databaseLoadError: string;
  hasExplicitBinding: boolean;
  saving: boolean;
  onConnectionChange: (connectionId: string) => void;
  onClearBinding: () => void;
  onOk: () => void;
  onCancel: () => void;
};

const normalizeExternalSQLFileName = (rawName: unknown): string => {
  const name = String(rawName || '').trim();
  if (!name) return '';
  return /\.sql$/i.test(name) ? name : `${name}.sql`;
};

const normalizeExternalSQLDirectoryName = (rawName: unknown): string => {
  return String(rawName || '').trim();
};

const getExternalSQLParentDirectoryPath = (node: any): string => {
  const path = String(node?.dataRef?.path || '').trim();
  if (node?.type === 'external-sql-directory' || node?.type === 'external-sql-folder') {
    return path;
  }
  if (node?.type === 'external-sql-file') {
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return index > 0 ? path.slice(0, index) : '';
  }
  return '';
};

const normalizeSQLFileDialogData = (data: unknown): { content: string; filePath: string; fileName: string; isLargeFile: boolean; fileSizeMB?: string } => {
  if (data && typeof data === 'object') {
    const payload = data as Record<string, unknown>;
    const filePath = String(payload.filePath || '').trim();
    return {
      content: String(payload.content ?? ''),
      filePath,
      fileName: String(payload.name || filePath.split(/[\\/]/).filter(Boolean).pop() || t('sidebar.sql_file_exec.title')).trim(),
      isLargeFile: payload.isLargeFile === true,
      fileSizeMB: String(payload.fileSizeMB || '').trim() || undefined,
    };
  }
  return {
    content: String(data || ''),
    filePath: '',
    fileName: t('sidebar.sql_file_exec.title'),
    isLargeFile: false,
  };
};

const resolveSQLFileExecutionStatusLabel = (status: SQLFileExecutionStatus): string => {
  switch (status) {
    case 'done':
      return `✅ ${t('sidebar.sql_file_exec.status.done')}`;
    case 'cancelled':
      return `⚠️ ${t('sidebar.sql_file_exec.status.cancelled')}`;
    case 'error':
      return `❌ ${t('sidebar.sql_file_exec.status.error')}`;
    case 'running':
    default:
      return t('sidebar.sql_file_exec.status.running');
  }
};

export const buildSQLFileExecutionFooter = ({
  status,
  onCancelExecution,
  onClose,
}: {
  status: SQLFileExecutionStatus;
  onCancelExecution: () => void;
  onClose: () => void;
}): React.ReactNode[] => {
  if (status === 'running') {
    return [
      <Button key="cancel" danger onClick={onCancelExecution}>
        {t('sidebar.sql_file_exec.cancel')}
      </Button>,
    ];
  }

  return [
    <Button key="close" type="primary" onClick={onClose}>
      {t('sidebar.action.close')}
    </Button>,
  ];
};

export const SQLFileExecutionProgressContent: React.FC<SQLFileExecutionProgressState> = ({
  fileSizeMB,
  status,
  executed,
  failed,
  percent,
  currentSQL,
  resultMessage,
}) => (
  <>
    <div style={{ marginBottom: 16 }}>
      <Progress
        percent={Math.round(percent)}
        status={status === 'error' ? 'exception' : status === 'done' ? 'success' : 'active'}
        strokeColor={status === 'cancelled' ? '#faad14' : undefined}
      />
    </div>
    <div style={{ fontSize: 13, lineHeight: '22px', marginBottom: 8 }}>
      <div>{t('sidebar.sql_file_exec.file_size')}<strong>{fileSizeMB} MB</strong></div>
      <div>{t('sidebar.sql_file_exec.status_label')}<strong>{resolveSQLFileExecutionStatusLabel(status)}</strong></div>
      <div>
        {t('sidebar.sql_file_exec.executed_label')}
        <strong style={{ color: '#52c41a' }}>{executed}</strong>
        {t('sidebar.sql_file_exec.statements_separator')}
        <strong style={{ color: failed > 0 ? '#ff4d4f' : undefined }}>{failed}</strong>
        {t('sidebar.sql_file_exec.statements_suffix')}
      </div>
    </div>
    {currentSQL && status === 'running' && (
      <div style={{ fontSize: 12, color: 'rgba(128,128,128,0.8)', background: 'rgba(128,128,128,0.06)', borderRadius: 6, padding: '6px 10px', marginTop: 8, fontFamily: 'var(--gn-font-mono)', wordBreak: 'break-all', maxHeight: 60, overflow: 'hidden' }}>
        {currentSQL}
      </div>
    )}
    {resultMessage && status !== 'running' && (
      <div style={{ fontSize: 12, marginTop: 12, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'rgba(128,128,128,0.06)', borderRadius: 6, padding: '8px 12px' }}>
        {resultMessage}
      </div>
    )}
  </>
);

export const ExternalSQLFileModal: React.FC<ExternalSQLFileModalProps> = ({
  open,
  mode,
  form,
  onOk,
  onCancel,
}) => (
  <Modal
    title={
      mode === 'create'
        ? t('sidebar.external_sql_modal.title.create_file')
        : mode === 'rename'
          ? t('sidebar.external_sql_modal.title.rename_file')
          : mode === 'create-directory'
            ? t('sidebar.external_sql_modal.title.create_directory')
            : t('sidebar.external_sql_modal.title.rename_directory')
    }
    open={open}
    onOk={onOk}
    onCancel={onCancel}
    okText={t(mode === 'create' || mode === 'create-directory' ? 'sidebar.external_sql_modal.action.create' : 'sidebar.external_sql_modal.action.rename')}
    cancelText={t('common.cancel')}
  >
    <Form form={form} layout="vertical">
      <Form.Item
        name="name"
        label={isExternalSQLDirectoryModalMode(mode) ? t('sidebar.external_sql_modal.field.directory_name') : t('sidebar.external_sql_modal.field.sql_file_name')}
        rules={[
          { required: true, message: isExternalSQLDirectoryModalMode(mode) ? t('sidebar.external_sql_modal.validation.directory_name_required') : t('sidebar.external_sql_modal.validation.sql_file_name_required') },
          {
            validator: async (_, value) => {
              const name = String(value || '').trim();
              if (!name) return;
              if (/[\\/]/.test(name) || name === '.' || name === '..') {
                throw new Error(isExternalSQLDirectoryModalMode(mode) ? t('sidebar.external_sql_modal.validation.directory_name_no_separator') : t('sidebar.external_sql_modal.validation.sql_file_name_no_separator'));
              }
            },
          },
        ]}
        extra={isExternalSQLDirectoryModalMode(mode) ? t('sidebar.external_sql_modal.help.directory') : t('sidebar.external_sql_modal.help.sql_file')}
      >
        <Input {...noAutoCapInputProps} placeholder={isExternalSQLDirectoryModalMode(mode) ? t('sidebar.external_sql_modal.placeholder.directory_name') : t('sidebar.external_sql_modal.placeholder.sql_file_name')} />
      </Form.Item>
    </Form>
  </Modal>
);

export const ExternalSQLBindingModal: React.FC<ExternalSQLBindingModalProps> = ({
  open,
  form,
  connections,
  filePath,
  databaseOptions,
  loadingDatabases,
  databaseLoadError,
  hasExplicitBinding,
  saving,
  onConnectionChange,
  onClearBinding,
  onOk,
  onCancel,
}) => {
  const connectionOptions = connections
    .filter((connection) => getDataSourceCapabilities(connection.config).supportsQueryEditor)
    .map((connection) => {
      const host = resolveConnectionHostSummary(connection.config);
      return {
        value: connection.id,
        label: host ? `${connection.name || connection.id} (${host})` : connection.name || connection.id,
      };
    });

  return (
    <Modal
      title={t('sidebar.external_sql_binding.title')}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={saving}
      maskClosable={!saving}
      closable={!saving}
    >
      <div
        title={filePath}
        style={{ marginBottom: 16, color: 'var(--gn-text-secondary)', wordBreak: 'break-all' }}
      >
        {filePath}
      </div>
      <Form form={form} layout="vertical">
        <Form.Item
          name="connectionId"
          label={t('data_export.label.connection')}
          rules={[{ required: true, message: t('sidebar.message.select_connection_or_database_first') }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={connectionOptions}
            placeholder={t('data_export.workbench.placeholder.select_connection')}
            onChange={onConnectionChange}
          />
        </Form.Item>
        <Form.Item
          name="dbName"
          label={t('data_export.label.database')}
          extra={databaseLoadError || undefined}
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            loading={loadingDatabases}
            disabled={!form.getFieldValue('connectionId') || loadingDatabases}
            options={databaseOptions.map((database) => ({ value: database, label: database }))}
            placeholder={loadingDatabases
              ? t('data_export.workbench.placeholder.loading_databases')
              : t('data_export.workbench.placeholder.select_database')}
          />
        </Form.Item>
      </Form>
      {hasExplicitBinding && (
        <Button type="link" style={{ paddingInline: 0 }} disabled={saving} onClick={onClearBinding}>
          {t('sidebar.external_sql_binding.clear_override')}
        </Button>
      )}
    </Modal>
  );
};

export const SQLFileExecutionModal: React.FC<SQLFileExecutionModalProps> = ({
  title,
  state,
  modalPanelStyle,
  onCancelExecution,
  onClose,
}) => (
  <Modal
    title={title}
    open={state.open}
    centered
    closable={state.status !== 'running'}
    maskClosable={false}
    footer={buildSQLFileExecutionFooter({
      status: state.status,
      onCancelExecution,
      onClose,
    })}
    onCancel={() => {
      if (state.status !== 'running') {
        onClose();
      }
    }}
    styles={{ content: modalPanelStyle, header: { background: 'transparent', borderBottom: 'none' }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
  >
    <SQLFileExecutionProgressContent
      fileSizeMB={state.fileSizeMB}
      status={state.status}
      executed={state.executed}
      failed={state.failed}
      percent={state.percent}
      currentSQL={state.currentSQL}
      resultMessage={state.resultMessage}
    />
  </Modal>
);

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
    void node;
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
