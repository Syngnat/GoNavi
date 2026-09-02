import type { TabData } from '../types';
import { t } from '../i18n';

const normalizePathToken = (value: string): string =>
  value.replace(/\\/g, '/').trim();

export const resolveSQLFileExecutionWorkbenchTabId = (
  connectionId: string,
  dbName: string | undefined,
  filePath: string,
): string => {
  const normalizedConnectionId = String(connectionId || '').trim() || 'none';
  const normalizedDbName = String(dbName || '').trim() || 'default';
  const normalizedFilePath = normalizePathToken(String(filePath || '')) || 'file';
  return `sql-file-execution-${normalizedConnectionId}-${normalizedDbName}-${normalizedFilePath}`;
};

type BuildSQLFileExecutionWorkbenchTabInput = {
  connectionId: string;
  dbName?: string;
  filePath: string;
  fileName?: string;
  fileSizeMB?: string;
  requestKey?: string;
  autoStart?: boolean;
};

export const buildSQLFileExecutionWorkbenchTab = (
  input: BuildSQLFileExecutionWorkbenchTabInput,
): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  const filePath = normalizePathToken(String(input.filePath || ''));
  const fileName = String(input.fileName || '').trim();
  const defaultTitle = fileName || t('sidebar.sql_file_exec.title');

  const requestKey = input.autoStart === false
    ? ''
    : String(input.requestKey || `sql-file-execution-${Date.now()}`).trim();

  return {
    id: resolveSQLFileExecutionWorkbenchTabId(connectionId, dbName || undefined, filePath),
    title: defaultTitle,
    type: 'sql-file-execution',
    connectionId,
    ...(dbName ? { dbName } : {}),
    filePath,
    sqlFileExecutionFileName: fileName || undefined,
    sqlFileExecutionFileSizeMB: String(input.fileSizeMB || '').trim() || undefined,
    ...(requestKey ? { sqlFileExecutionRequestKey: requestKey } : {}),
  };
};
