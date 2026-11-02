import { message } from 'antd';

import { t } from '../i18n';
import Modal from './common/ResizableDraggableModal';

type CopyDatabaseResult = {
  success?: boolean;
  data?: unknown;
  message?: string;
};

type CopyDatabaseBackend = (
  config: unknown,
  dbName: string,
) => Promise<CopyDatabaseResult>;

type ConfirmCopyDatabaseOptions = {
  config: unknown;
  dbName: string;
  /** 复制成功后刷新该库所在连接的树，让新库立刻出现。 */
  onSuccess?: (targetDatabase: string) => void | Promise<void>;
};

const resolveCopyDatabaseBackend = (): CopyDatabaseBackend | null => {
  const runtime = globalThis as typeof globalThis & {
    go?: { app?: { App?: { CopyDatabase?: CopyDatabaseBackend } } };
  };
  return typeof runtime.go?.app?.App?.CopyDatabase === 'function'
    ? runtime.go.app.App.CopyDatabase
    : null;
};

/**
 * 整库复制的确认与执行。
 *
 * 与 confirmCopyTable 同一套交互：先确认（复制整库是重操作），执行时显示
 * loading，成功后刷新树并提示新库名；失败按后端返回的文案提示。
 */
export const confirmCopyDatabase = ({
  config,
  dbName,
  onSuccess,
}: ConfirmCopyDatabaseOptions): void => {
  const source = String(dbName || '').trim();
  if (!source) return;

  Modal.confirm({
    title: t('database_copy.modal.title'),
    content: t('database_copy.modal.content', { source, target: `${source}_copy1` }),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      const copyDatabase = resolveCopyDatabaseBackend();
      if (!copyDatabase) {
        const error = t('database_copy.message.backend_unavailable');
        message.error(error);
        return Promise.reject(new Error(error));
      }

      const hide = message.loading(t('database_copy.message.loading', { source }), 0);
      try {
        const result = await copyDatabase(config, source);
        if (!result?.success) {
          throw new Error(result?.message || t('common.unknown'));
        }

        const target = String(result.data || '').trim();
        if (!target) {
          throw new Error(t('database_copy.message.target_missing'));
        }

        if (onSuccess) {
          try {
            await onSuccess(target);
          } catch (error: any) {
            message.warning(t('database_copy.message.refresh_failed', {
              target,
              error: error?.message || String(error),
            }));
          }
        }
        message.success(t('database_copy.message.success', { target }));
      } catch (error: any) {
        message.error(t('database_copy.message.failed', {
          error: error?.message || String(error),
        }));
        return Promise.reject(error);
      } finally {
        hide();
      }
    },
  });
};
