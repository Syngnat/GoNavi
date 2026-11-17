import React from 'react';
import { Alert, Button, Space } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { useImportTableCreateForm } from './ImportTableCreateForm';
import { ImportTableCreateIdentityFields } from './ImportTableCreateIdentityFields';
import { ImportTableCreateColumns } from './ImportTableCreateColumns';
import { ImportTableCreateSqlPreview } from './ImportTableCreateSqlPreview';
import type {
  ImportAutoCreateTableDraft,
  ImportTableSchemaInference,
} from './importTableTypeMapping';

export interface ImportTableCreateModalProps {
  open: boolean;
  inference: ImportTableSchemaInference | null;
  dialect: string;
  fileName?: string;
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
  onCancel: () => void;
  onConfirm: (payload: ImportAutoCreateTableDraft) => void;
}

export const ImportTableCreateModal: React.FC<ImportTableCreateModalProps> = ({
  open,
  inference,
  dialect,
  fileName,
  t,
  onCancel,
  onConfirm,
}) => {
  const form = useImportTableCreateForm({ open, inference, dialect });
  const handleConfirm = () => {
    const payload = form.buildPayload();
    if (payload) onConfirm(payload);
  };

  return (
    <Modal
      title={t('data_import.create_table.title')}
      open={open}
      onCancel={onCancel}
      width={1180}
      footer={(
        <Space>
          <Button data-import-create-table-cancel="true" onClick={onCancel}>
            {t('data_import.create_table.action.cancel')}
          </Button>
          <Button
            data-import-create-table-confirm="true"
            type="primary"
            disabled={form.confirmDisabled}
            onClick={handleConfirm}
          >
            {t('data_import.create_table.action.confirm')}
          </Button>
        </Space>
      )}
    >
      <div data-import-create-table-modal="true" style={{ display: 'grid', gap: 16 }}>
        <div style={{ color: 'var(--gn-fg-3)', fontSize: 12 }}>
          {fileName
            ? t('data_import.create_table.description_with_file', { file: fileName })
            : t('data_import.create_table.description')}
        </div>

        {inference ? (
          <div data-import-create-table-sample="true" style={{ fontSize: 12 }}>
            {t('data_import.create_table.sample_summary', {
              sampled: inference.sampledRows,
              limit: inference.sampleLimit,
            })}
          </div>
        ) : null}

        {inference && inference.warnings.length > 0 ? (
          <Alert
            data-import-create-table-warnings="true"
            type="warning"
            showIcon
            message={t('data_import.create_table.warning.title')}
            description={(
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {inference.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            )}
          />
        ) : null}

        {form.timeIndexIssue ? (
          <Alert
            data-import-create-table-time-index-error="true"
            type="error"
            showIcon
            message={form.timeIndexIssue === 'greptimedb'
              ? t('data_import.create_table.error.greptimedb_timestamp')
              : t('data_import.create_table.error.tdengine_timestamp')}
          />
        ) : null}

        {form.hasEmptyType ? (
          <Alert
            type="error"
            showIcon
            message={t('data_import.create_table.error.type_required')}
          />
        ) : null}

        <ImportTableCreateIdentityFields form={form} t={t} />
        <ImportTableCreateColumns
          columns={form.columns}
          typeOptions={form.typeOptions}
          commentsSupported={form.commentsSupported}
          t={t}
          onTypeChange={form.updateType}
          onNullableChange={form.updateNullable}
          onPrimaryKeyChange={form.updatePrimaryKey}
          onCommentChange={form.updateComment}
        />
        <ImportTableCreateSqlPreview sql={form.previewSql} t={t} />
      </div>
    </Modal>
  );
};

export default ImportTableCreateModal;
