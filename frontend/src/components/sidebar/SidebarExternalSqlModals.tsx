import React from 'react';
import { Button, Progress, Form, Input, Select } from 'antd';
import type { FormInstance } from 'antd/es/form';
import Modal from '../common/ResizableDraggableModal';
import type { SavedConnection } from '../../types';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { resolveConnectionHostSummary } from '../../utils/tabDisplay';
import { t } from '../../i18n';
import {
  type ExternalSQLFileModalMode,
  isExternalSQLDirectoryModalMode,
} from '../sidebarCoreUtils';
import {
  type SQLFileExecutionStatus,
  resolveSQLFileExecutionStatusLabel,
} from './sidebarExternalSqlHelpers';

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
