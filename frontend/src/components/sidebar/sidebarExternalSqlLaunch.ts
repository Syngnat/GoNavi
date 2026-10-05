import type { BuildDataImportWorkbenchTabInput } from '../../utils/dataImportTab';

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
