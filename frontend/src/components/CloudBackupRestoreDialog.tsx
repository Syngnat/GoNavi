import React, { useState } from 'react';
import { Alert, Space, Typography } from 'antd';

import { getCurrentLanguage, t as translate, type I18nParams } from '../i18n';
import CloudBackupCategorySelector from './CloudBackupCategorySelector';
import Modal from './common/ResizableDraggableModal';

export type CloudBackupRestoreCategory = {
  id: string;
  itemCount: number;
  files?: string[];
  connections?: Array<{
    id: string;
    name: string;
    host?: string;
  }>;
  restartRequired?: boolean;
};

export type CloudBackupRestorePreview = {
  createdAt: string;
  connectionCount: number;
  fileCount: number;
  files: string[];
  restartRequired?: boolean;
  categories: CloudBackupRestoreCategory[];
  confirmationToken?: string;
};

export type CloudBackupRestoreResult = Omit<CloudBackupRestorePreview, 'confirmationToken'>;

type CloudBackupRestoreBindings = {
  CloudBackupPreviewRestore?: () => Promise<CloudBackupRestorePreview>;
  CloudBackupRestore?: (request: { confirmationToken: string; categories: string[] }) => Promise<CloudBackupRestoreResult>;
};

type Translate = (key: string, params?: I18nParams) => string;

type ShowCloudBackupRestoreDialogOptions = {
  bindings?: CloudBackupRestoreBindings | null;
  preview?: CloudBackupRestorePreview | null;
  t?: Translate;
};

export type CloudBackupRestoreDialogOutcome = {
  cancelled: boolean;
  result?: CloudBackupRestoreResult;
};

const getBindings = (): CloudBackupRestoreBindings | null => {
  if (typeof window === 'undefined') return null;
  return ((window as any).go?.app?.App || null) as CloudBackupRestoreBindings | null;
};

const fallback = (t: Translate, key: string, value: string, params?: I18nParams): string => {
  const translated = t(key, params);
  return translated === key ? value : translated;
};

const defaultTranslate: Translate = (key, params) => translate(key, params, getCurrentLanguage());

const formatTimestamp = (value?: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

type RestoreSelectionProps = {
  categories: CloudBackupRestoreCategory[];
  initialSelection: string[];
  t: Translate;
  createdAt: string;
  onChange: (selection: string[]) => void;
};

const RestoreSelection: React.FC<RestoreSelectionProps> = ({
  categories,
  initialSelection,
  t,
  createdAt,
  onChange,
}) => {
  const [selection, setSelection] = useState(initialSelection);
  const description = fallback(
    t,
    'app.cloud_backup.restore.description',
    'Connections and saved queries are merged by ID; other selected settings are replaced by the cloud backup.',
  );

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Alert type="warning" showIcon message={description} />
      <Typography.Text type="secondary">
        {fallback(t, 'app.cloud_backup.restore.backup_time', `Backup time: ${formatTimestamp(createdAt)}`, { time: formatTimestamp(createdAt) })}
      </Typography.Text>
      <CloudBackupCategorySelector
        categories={categories}
        selected={selection}
        title={fallback(t, 'app.cloud_backup.restore.choose', 'Choose what to restore')}
        t={t}
        showCounts
        onChange={(nextSelection) => {
          setSelection(nextSelection);
          onChange(nextSelection);
        }}
      />
      {selection.length === 0 ? (
        <Typography.Text type="danger">
          {fallback(t, 'app.cloud_backup.restore.selection_required', 'Select at least one category to restore.')}
        </Typography.Text>
      ) : null}
    </Space>
  );
};

export async function showCloudBackupRestoreDialog({
  bindings = getBindings(),
  preview: providedPreview,
  t = defaultTranslate,
}: ShowCloudBackupRestoreDialogOptions = {}): Promise<CloudBackupRestoreDialogOutcome> {
  if (!bindings?.CloudBackupPreviewRestore || !bindings.CloudBackupRestore) {
    throw new Error(fallback(t, 'app.cloud_backup.unavailable', 'Cloud backup is unavailable in this runtime.'));
  }
  const preview = providedPreview || await bindings.CloudBackupPreviewRestore();
  const confirmationToken = String(preview.confirmationToken || '').trim();
  if (!confirmationToken) {
    throw new Error(fallback(t, 'app.cloud_backup.restore.preview_expired', 'The restore preview is no longer valid. Check the remote backup again.'));
  }

  const initialSelection = (preview.categories || []).map((category) => category.id);
  return new Promise<CloudBackupRestoreDialogOutcome>((resolve, reject) => {
    let selection = initialSelection;
    let settled = false;
    let modalRef: ReturnType<typeof Modal.confirm> | null = null;

    const finish = (outcome: CloudBackupRestoreDialogOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    modalRef = Modal.confirm({
      title: fallback(t, 'app.cloud_backup.restore.title', 'Restore cloud backup?'),
      width: 560,
      content: (
        <RestoreSelection
          categories={preview.categories || []}
          initialSelection={initialSelection}
          t={t}
          createdAt={preview.createdAt}
          onChange={(nextSelection) => {
            selection = nextSelection;
            modalRef?.update({ okButtonProps: { danger: true, disabled: selection.length === 0 } });
          }}
        />
      ),
      okText: fallback(t, 'app.cloud_backup.restore.confirm', 'Restore'),
      cancelText: fallback(t, 'common.cancel', 'Cancel'),
      autoFocusButton: 'cancel',
      okButtonProps: { danger: true, disabled: initialSelection.length === 0 },
      onOk: async () => {
        if (selection.length === 0) return false;
        try {
          const result = await bindings.CloudBackupRestore!({ confirmationToken, categories: selection });
          finish({ cancelled: false, result });
          return result;
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          modalRef?.destroy();
          return undefined;
        }
      },
      onCancel: () => finish({ cancelled: true }),
    });
  });
}
