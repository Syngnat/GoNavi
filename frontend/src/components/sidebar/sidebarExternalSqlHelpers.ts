import { t } from '../../i18n';

export type SQLFileExecutionStatus = 'running' | 'done' | 'cancelled' | 'error';

export const normalizeExternalSQLFileName = (rawName: unknown): string => {
  const name = String(rawName || '').trim();
  if (!name) return '';
  return /\.sql$/i.test(name) ? name : `${name}.sql`;
};

export const normalizeExternalSQLDirectoryName = (rawName: unknown): string => {
  return String(rawName || '').trim();
};

export const getExternalSQLParentDirectoryPath = (node: any): string => {
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

export const normalizeSQLFileDialogData = (data: unknown): { content: string; filePath: string; fileName: string; isLargeFile: boolean; fileSizeMB?: string } => {
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

export const resolveSQLFileExecutionStatusLabel = (status: SQLFileExecutionStatus): string => {
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
