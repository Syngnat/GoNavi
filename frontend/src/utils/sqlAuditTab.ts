import { t } from '../i18n';
import type { TabData } from '../types';

export const SQL_AUDIT_WORKBENCH_TAB_ID = 'sql-audit-center';
export const SQL_QUERY_HISTORY_WORKBENCH_TAB_ID = 'sql-query-history-center';

type BuildSqlAuditWorkbenchTabInput = {
  connectionId?: string;
  dbName?: string;
  transactionId?: string;
  requestKey?: string;
};

export const buildSqlAuditWorkbenchTab = (
  input: BuildSqlAuditWorkbenchTabInput = {},
): TabData => ({
  id: SQL_AUDIT_WORKBENCH_TAB_ID,
  title: t('sql_audit.workbench.tab_title'),
  type: 'sql-audit',
  connectionId: String(input.connectionId || '').trim(),
  dbName: String(input.dbName || '').trim() || undefined,
  sqlAuditView: 'audit',
  sqlAuditTransactionId: String(input.transactionId || '').trim() || undefined,
  sqlAuditRequestKey: input.requestKey || `sql-audit-${Date.now()}`,
});

type BuildQueryHistoryWorkbenchTabInput = {
  connectionId?: string;
  dbName?: string;
  requestKey?: string;
};

export const buildQueryHistoryWorkbenchTab = (
  input: BuildQueryHistoryWorkbenchTabInput = {},
): TabData => ({
  id: SQL_QUERY_HISTORY_WORKBENCH_TAB_ID,
  title: t('query_history.workbench.tab_title'),
  type: 'sql-audit',
  connectionId: String(input.connectionId || '').trim(),
  dbName: String(input.dbName || '').trim() || undefined,
  sqlAuditView: 'query-history',
  sqlAuditRequestKey: input.requestKey || `query-history-${Date.now()}`,
});

type BuildRestoredQueryTabInput = {
  sourceId?: string;
  connectionId?: string;
  dbName?: string;
  sql: string;
  title: string;
  requestKey?: string;
  preserveUnboundConnection?: boolean;
};

export const buildRestoredQueryTab = (
  input: BuildRestoredQueryTabInput,
): TabData => {
  const sourceId = String(input.sourceId || 'sql').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
  const requestKey = input.requestKey
    || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: `query-history-restore-${sourceId || 'sql'}-${requestKey}`,
    title: String(input.title || '').trim() || t('query_history.restore.tab_title'),
    type: 'query',
    connectionId: String(input.connectionId || '').trim(),
    dbName: String(input.dbName || '').trim() || undefined,
    query: String(input.sql || ''),
    preserveUnboundConnection: input.preserveUnboundConnection === true || undefined,
  };
};

export const shouldKeepRestoredQueryUnbound = (
  tab: Pick<TabData, 'preserveUnboundConnection'>,
  currentConnectionId: string,
): boolean => (
  tab.preserveUnboundConnection === true
  && !String(currentConnectionId || '').trim()
);
