import { message } from 'antd';

import { t } from '../i18n';
import Modal from './common/ResizableDraggableModal';

type CopyTableResult = {
  success?: boolean;
  data?: unknown;
  message?: string;
};

type CopyTableBackend = (
  config: unknown,
  dbName: string,
  sourceSchemaName: string,
  sourceTableName: string,
) => Promise<CopyTableResult>;

type ConfirmCopyTableOptions = {
  config: unknown;
  dbName: string;
  sourceSchemaName?: string;
  sourceTableName: string;
  onSuccess?: (targetTableName: string) => void | Promise<void>;
};

const resolveCopyTableBackend = (): CopyTableBackend | null => {
  const runtime = globalThis as typeof globalThis & {
    go?: { app?: { App?: { CopyTable?: CopyTableBackend } } };
  };
  return typeof runtime.go?.app?.App?.CopyTable === 'function'
    ? runtime.go.app.App.CopyTable
    : null;
};

export const confirmCopyTable = ({
  config,
  dbName,
  sourceSchemaName = '',
  sourceTableName,
  onSuccess,
}: ConfirmCopyTableOptions): void => {
  const source = String(sourceTableName || '').trim();
  if (!source) return;

  Modal.confirm({
    title: t('table_copy.modal.title'),
    content: t('table_copy.modal.content', { source, target: `${source}_copy1` }),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      const copyTable = resolveCopyTableBackend();
      if (!copyTable) {
        const error = t('table_copy.message.backend_unavailable');
        message.error(error);
        return Promise.reject(new Error(error));
      }

      const hide = message.loading(t('table_copy.message.loading', { source }), 0);
      try {
        const result = await copyTable(config, dbName, sourceSchemaName, source);
        if (!result?.success) {
          throw new Error(result?.message || t('common.unknown'));
        }

        const target = String(result.data || '').trim();
        if (!target) {
          throw new Error(t('table_copy.message.target_missing'));
        }

        if (onSuccess) {
          try {
            await onSuccess(target);
          } catch (error: any) {
            message.warning(t('table_copy.message.refresh_failed', {
              target,
              error: error?.message || String(error),
            }));
          }
        }
        message.success(t('table_copy.message.success', { target }));
      } catch (error: any) {
        message.error(t('table_copy.message.failed', {
          error: error?.message || String(error),
        }));
        return Promise.reject(error);
      } finally {
        hide();
      }
    },
  });
};
