import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLanguage, t } from '../i18n';
import {
  buildQueryHistoryWorkbenchTab,
  buildRestoredQueryTab,
  buildSqlAuditWorkbenchTab,
  shouldKeepRestoredQueryUnbound,
  SQL_AUDIT_WORKBENCH_TAB_ID,
  SQL_QUERY_HISTORY_WORKBENCH_TAB_ID,
} from './sqlAuditTab';

describe('sqlAuditTab', () => {
  afterEach(() => setCurrentLanguage('zh-CN'));

  it('uses one stable global workbench tab for every entry point', () => {
    const first = buildSqlAuditWorkbenchTab();
    const scoped = buildSqlAuditWorkbenchTab({ connectionId: 'conn-1', transactionId: 'tx-1' });

    expect(first.id).toBe(SQL_AUDIT_WORKBENCH_TAB_ID);
    expect(scoped.id).toBe(SQL_AUDIT_WORKBENCH_TAB_ID);
    expect(scoped).toMatchObject({
      type: 'sql-audit',
      connectionId: 'conn-1',
      sqlAuditTransactionId: 'tx-1',
    });
  });

  it('localizes the workbench tab title', () => {
    setCurrentLanguage('en-US');
    expect(buildSqlAuditWorkbenchTab().title).toBe(t('sql_audit.workbench.tab_title'));
    expect(buildQueryHistoryWorkbenchTab().title).toBe(t('query_history.workbench.tab_title'));
  });

  it('opens execution history in a distinct tab scoped to the editor context', () => {
    const tab = buildQueryHistoryWorkbenchTab({
      connectionId: ' conn-1 ',
      dbName: ' analytics ',
      requestKey: 'history-request',
    });

    expect(tab).toMatchObject({
      id: SQL_QUERY_HISTORY_WORKBENCH_TAB_ID,
      type: 'sql-audit',
      connectionId: 'conn-1',
      dbName: 'analytics',
      sqlAuditView: 'query-history',
      sqlAuditRequestKey: 'history-request',
    });
  });

  it('builds an editable query tab with the recoverable connection context', () => {
    expect(buildRestoredQueryTab({
      sourceId: 'event/42',
      connectionId: 'conn-1',
      dbName: 'analytics',
      sql: 'SELECT ?',
      title: 'Recovered SQL',
      requestKey: 'restore-request',
    })).toMatchObject({
      id: 'query-history-restore-event-42-restore-request',
      title: 'Recovered SQL',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'analytics',
      query: 'SELECT ?',
    });
  });

  it('keeps a recovered query unbound when its original connection is gone', () => {
    const tab = buildRestoredQueryTab({
      sourceId: 'event-43',
      connectionId: '',
      dbName: 'archived_db',
      sql: 'SELECT ? FROM archived_table',
      title: 'Recovered SQL',
      requestKey: 'missing-connection',
      preserveUnboundConnection: true,
    });

    expect(tab).toMatchObject({
      connectionId: '',
      dbName: 'archived_db',
      query: 'SELECT ? FROM archived_table',
      preserveUnboundConnection: true,
    });
    expect(shouldKeepRestoredQueryUnbound(tab, '')).toBe(true);
    expect(shouldKeepRestoredQueryUnbound(tab, 'new-connection')).toBe(false);
  });
});
