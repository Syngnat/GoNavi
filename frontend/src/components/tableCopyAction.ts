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

type ConfirmCopyTablesOptions = {
  config: unknown;
  dbName: string;
  sourceSchemaName?: string;
  sourceTableNames: string[];
  onSuccess?: (targetTableNames: string[]) => void | Promise<void>;
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

const previewCopyTableNames = (tables: string[]): string => {
  const preview = tables.slice(0, 8).join(', ');
  return tables.length > 8 ? `${preview}, …` : preview;
};

const formatCopyTableFailures = (
  failures: Array<{ source: string; error: string }>,
): string => {
  const details = failures
    .slice(0, 5)
    .map((failure) => `${failure.source}: ${failure.error}`)
    .join('; ');
  return failures.length > 5 ? `${details}; …` : details;
};

export const confirmCopyTables = ({
  config,
  dbName,
  sourceSchemaName = '',
  sourceTableNames,
  onSuccess,
}: ConfirmCopyTablesOptions): void => {
  const tables = Array.from(new Set(
    (Array.isArray(sourceTableNames) ? sourceTableNames : [])
      .map((table) => String(table || '').trim())
      .filter(Boolean),
  ));
  if (tables.length === 0) return;
  if (tables.length === 1) {
    confirmCopyTable({
      config,
      dbName,
      sourceSchemaName,
      sourceTableName: tables[0],
      onSuccess: onSuccess
        ? async (target) => onSuccess([target])
        : undefined,
    });
    return;
  }

  Modal.confirm({
    title: t('table_copy.modal.multiple_title'),
    content: t('table_copy.modal.multiple_content', {
      count: tables.length,
      tables: previewCopyTableNames(tables),
    }),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      const copyTable = resolveCopyTableBackend();
      if (!copyTable) {
        const error = t('table_copy.message.backend_unavailable');
        message.error(error);
        return Promise.reject(new Error(error));
      }

      const hide = message.loading(
        t('table_copy.message.loading_multiple', { count: tables.length }),
        0,
      );
      const targets: string[] = [];
      const failures: Array<{ source: string; error: string }> = [];
      try {
        for (const source of tables) {
          try {
            const result = await copyTable(config, dbName, sourceSchemaName, source);
            if (!result?.success) {
              throw new Error(result?.message || t('common.unknown'));
            }
            const target = String(result.data || '').trim();
            if (!target) {
              throw new Error(t('table_copy.message.target_missing'));
            }
            targets.push(target);
          } catch (error: any) {
            failures.push({
              source,
              error: error?.message || String(error),
            });
          }
        }

        if (onSuccess && targets.length > 0) {
          try {
            await onSuccess(targets);
          } catch (error: any) {
            message.warning(t('table_copy.message.refresh_failed_multiple', {
              count: targets.length,
              error: error?.message || String(error),
            }));
          }
        }

        if (failures.length === 0) {
          message.success(t('table_copy.message.success_multiple', {
            count: targets.length,
          }));
          return;
        }

        const details = formatCopyTableFailures(failures);
        if (targets.length === 0) {
          message.error(t('table_copy.message.failed_multiple', {
            count: tables.length,
            details,
          }));
          return Promise.reject(new Error(details));
        }
        message.warning(t('table_copy.message.partial', {
          success: targets.length,
          failed: failures.length,
          details,
        }));
      } finally {
        hide();
      }
    },
  });
};
