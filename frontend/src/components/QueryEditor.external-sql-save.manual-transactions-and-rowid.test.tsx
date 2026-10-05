import React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORACLE_ROWID_LOCATOR_COLUMN } from '../utils/rowLocator';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    backendApp,
    messageApi,
    dataGridState,
    editorState,
    textContent,
    findButtons,
    findButton,
    createTab,
} from './queryEditorExternalSqlSaveTestSupport';
import { setUpQueryEditorExternalSqlSaveTest, tearDownQueryEditorExternalSqlSaveTest } from './queryEditorExternalSqlSaveTestHooks';

vi.mock('../store', async (importOriginal) => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule1(importOriginal));

vi.mock('../../wailsjs/runtime', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule2());

vi.mock('../../wailsjs/go/app/App', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule3());

vi.mock('../utils/autoFetchVisibility', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule4());

vi.mock('@monaco-editor/react', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule5());

vi.mock('./DataGrid', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule6());

vi.mock('./resultDiff/ResultDiffWizard', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule7());

vi.mock('./resultDiff/ViewDataVerifyWizard', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule8());

vi.mock('./LogPanel', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule9());

vi.mock('@ant-design/icons', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule10());

vi.mock('antd', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule11());

describe('QueryEditor external SQL save', () => {
  beforeEach(setUpQueryEditorExternalSqlSaveTest);

  afterEach(tearDownQueryEditorExternalSqlSaveTest);

  it('shows the pending statement count for multi-SQL manual transactions', async () => {
    const sql = "UPDATE users SET active = 0 WHERE id = 1; DELETE FROM users WHERE id = 2;";
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-multi-dml',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 2 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: sql.length + 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('DELETE FROM users'),
      'query-1',
    );
    expect(textContent(renderer!.root)).not.toContain('未提交');
    expect(textContent(renderer!.root)).toContain('提交2');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-multi-dml',
      statementCount: 2,
    });
  });

  it('keeps SQL editor WITH SELECT on the regular query path', async () => {
    const sql = 'WITH target AS (SELECT id FROM users WHERE active = 1) SELECT * FROM target';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['id'], rows: [{ id: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('WITH target AS'),
      'query-1',
    );
    expect(backendApp.DBQueryMultiTransactional).not.toHaveBeenCalled();
  });

  it('keeps manual SQL transaction actions inline in the top toolbar without duplicating them in result tabs', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-toolbar-inline',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET active = 0 WHERE id = 1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pageText = textContent(renderer!.root);
    expect(pageText).not.toContain('未提交');
    expect(findButtons(renderer!, '提交')).toHaveLength(1);
    expect(findButtons(renderer!, '回滚')).toHaveLength(1);
  });

  it('adds pagination to limited query results and reloads the selected page only', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    const secondPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 501 }));
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: firstPageRows, statementIndex: 1 },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: secondPageRows, statementIndex: 1 },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.pagination).toMatchObject({
      current: 1,
      pageSize: 500,
      total: 1000,
      totalKnown: false,
    });
    expect(dataGridState.latestProps?.resultExportAllSql).toBe('SELECT id FROM users');

    await act(async () => {
      await dataGridState.latestProps?.onPageChange?.(2, 500);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    const pageSql = String(backendApp.DBQueryMulti.mock.calls[1][2]);
    expect(pageSql).toContain('SELECT * FROM (SELECT id FROM users) AS __gonavi_query_page__');
    expect(pageSql).toContain('LIMIT 501 OFFSET 500');
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      current: 2,
      pageSize: 500,
      total: 1000,
      totalKnown: true,
    });
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ id: 501 });
  });

  it('counts the exact total for a limited query result and updates pagination', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-page-initial')
      .mockResolvedValueOnce('query-total-count');
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: firstPageRows, statementIndex: 1 },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 1234 }], statementIndex: 1 },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
    });
    expect(dataGridState.latestProps?.onRequestTotalCount).toEqual(expect.any(Function));

    await act(async () => {
      await dataGridState.latestProps.onRequestTotalCount();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(backendApp.DBQueryMulti).toHaveBeenLastCalledWith(
      expect.anything(),
      'main',
      'SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT id FROM users) __gonavi_query_count__',
      'query-total-count',
    );
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1234,
      totalKnown: true,
      totalCountLoading: false,
    });
  });

  it('cancels a query-result total count without applying its late response', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    let resolveCount!: (value: any) => void;
    const pendingCount = new Promise((resolve) => {
      resolveCount = resolve;
    });
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-page-initial')
      .mockResolvedValueOnce('query-total-count');
    backendApp.CancelQuery.mockResolvedValueOnce({ success: true });
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: firstPageRows, statementIndex: 1 },
        ],
      })
      .mockImplementationOnce(() => pendingCount);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      void dataGridState.latestProps.onRequestTotalCount();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination?.totalCountLoading).toBe(true);
    expect(dataGridState.latestProps?.onCancelTotalCount).toEqual(expect.any(Function));

    await act(async () => {
      await dataGridState.latestProps.onCancelTotalCount();
    });
    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-total-count');
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
      totalCountLoading: false,
    });

    await act(async () => {
      resolveCount({
        success: true,
        data: [
          { columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 9999 }] },
        ],
      });
      await pendingCount;
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
      totalCountLoading: false,
    });
  });

  it('does not apply an old total-count response to a newly executed result with the same key', async () => {
    const firstQueryRows = Array.from({ length: 500 }, (_item, index) => ({ old_id: index + 1 }));
    const secondQueryRows = Array.from({ length: 500 }, (_item, index) => ({ new_id: index + 1 }));
    let resolveOldCount!: (value: any) => void;
    const oldCount = new Promise((resolve) => {
      resolveOldCount = resolve;
    });
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-first')
      .mockResolvedValueOnce('query-old-total')
      .mockResolvedValueOnce('query-second');
    backendApp.CancelQuery.mockResolvedValue({ success: true });
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['old_id'], rows: firstQueryRows, statementIndex: 1 }],
      })
      .mockImplementationOnce(() => oldCount)
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['new_id'], rows: secondQueryRows, statementIndex: 1 }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT old_id FROM old_users LIMIT 0,500' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      void dataGridState.latestProps.onRequestTotalCount();
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.value = 'SELECT new_id FROM new_users LIMIT 0,500';
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ new_id: 1 });

    await act(async () => {
      resolveOldCount({
        success: true,
        data: [{ columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 9999 }] }],
      });
      await oldCount;
      await Promise.resolve();
    });

    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-old-total');
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
    });
  });

  it('keeps an exact counted total while navigating through non-final pages', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    const secondPageWithLookahead = Array.from({ length: 501 }, (_item, index) => ({ id: index + 501 }));
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-initial')
      .mockResolvedValueOnce('query-total')
      .mockResolvedValueOnce('query-page-2');
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['id'], rows: firstPageRows, statementIndex: 1 }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 1234 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['id'], rows: secondPageWithLookahead, statementIndex: 1 }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await dataGridState.latestProps.onRequestTotalCount();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({ total: 1234, totalKnown: true });

    await act(async () => {
      await dataGridState.latestProps.onPageChange(2, 500);
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      current: 2,
      total: 1234,
      totalKnown: true,
    });
  });

  it('runs SQL editor data-changing CTEs through a pending managed transaction', async () => {
    const sql = 'WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-write-cte',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 3 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('DELETE FROM audit_logs'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(textContent(renderer!.root)).not.toContain('未提交');
  });

  it('cancels and rolls back a managed transaction that returns after the SQL tab closes', async () => {
    let resolveTransaction!: (result: any) => void;
    backendApp.DBQueryMultiTransactional.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTransaction = resolve;
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <React.StrictMode>
          <QueryEditor tab={createTab({ query: 'UPDATE users SET active = 0 WHERE id = 1' })} />
        </React.StrictMode>,
      );
    });
    let runPromise!: Promise<void>;
    act(() => {
      runPromise = Promise.resolve(findButton(renderer!, '运行').props.onClick());
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      'UPDATE users SET active = 0 WHERE id = 1',
      'query-1',
    );

    await act(async () => {
      renderer.unmount();
    });
    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-1');

    await act(async () => {
      resolveTransaction({
        success: true,
        transactionId: 'tx-tab-close',
        transactionPending: true,
        data: [],
      });
      await runPromise;
    });

    expect(backendApp.DBRollbackTransactionWithTrigger).toHaveBeenCalledWith('tx-tab-close', 'tab_close');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toBeUndefined();
  });

  it('auto commits SQL editor DML transactions after the configured delay', async () => {
    vi.useFakeTimers();
    storeState.sqlEditorTransactionOptions = {
      commitMode: 'auto',
      autoCommitDelayMs: 3000,
    };
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-auto',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: "DELETE FROM users WHERE id = 1" })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(textContent(renderer!.root)).toContain('3s 后自动提交');
      expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-auto', 'auto');
      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports DBeaver-style immediate auto-commit for SQL editor DML transactions', async () => {
    vi.useFakeTimers();
    storeState.sqlEditorTransactionOptions = {
      commitMode: 'auto',
      autoCommitDelayMs: 0,
    };
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-auto-now',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET active = 0 WHERE id = 1" })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
      expect(textContent(renderer!.root)).toContain('自动提交中');
    expect(textContent(renderer!.root)).toContain('提交1');
      expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();

      await act(async () => {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-auto-now', 'auto');
      expect(textContent(renderer!.root)).not.toContain('自动提交中');
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically appends hidden primary key locator columns for editable query results', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_ID'], rows: [{ NAME: 'old-name', __gonavi_locator_1_ID: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT NAME FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('MYCIMLED.EDC_LOG');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['ID']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(dataGridState.latestProps?.resultSql).toBe('SELECT NAME FROM MYCIMLED.EDC_LOG');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"ID" AS "__gonavi_locator_1_ID"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('normalizes unquoted lowercase Oracle identifiers before committing query result edits', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_ID'], rows: [{ NAME: 'old-name', __gonavi_locator_1_ID: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'anonymous', query: 'select name from mycimled.edc_log' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'MYCIMLED', 'EDC_LOG');
    expect(dataGridState.latestProps?.tableName).toBe('MYCIMLED.EDC_LOG');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      writableColumns: {
        name: 'NAME',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps dotted Dameng owner and table boundaries in editable query results', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'PEM2.4_V1_1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['ID', 'NAME'], rows: [{ ID: 7, NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'PEM2.4_V1_1',
        query: 'SELECT * FROM "PEM2.4_V1_1"."COM_APPROVE_INFO"',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(
      expect.anything(),
      'PEM2.4_V1_1',
      'COM_APPROVE_INFO',
    );
    expect(dataGridState.latestProps?.dbName).toBe('PEM2.4_V1_1');
    expect(dataGridState.latestProps?.tableName).toBe('PEM2.4_V1_1.COM_APPROVE_INFO');
    expect(dataGridState.latestProps?.readOnly).toBe(false);
  });

  it('keeps Dameng USER_COL_COMMENTS queries read-only without injecting ROWID', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'APP';
    const sql = `SELECT T.TABLE_NAME, T.COLUMN_NAME, T.COMMENTS
FROM USER_COL_COMMENTS T
WHERE T.TABLE_NAME = 'MEITUAN_COMMENT_INFO';`;
    backendApp.DBGetColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['TABLE_NAME', 'COLUMN_NAME', 'COMMENTS'],
        rows: [{
          TABLE_NAME: 'MEITUAN_COMMENT_INFO',
          COLUMN_NAME: 'CONTENT',
          COMMENTS: '评论内容',
        }],
      }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'APP', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('FROM USER_COL_COMMENTS T');
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({ readOnly: true });
    expect(dataGridState.latestProps?.readOnly).toBe(true);
  });

  it('keeps Dameng DBA_TAB_PRIVS queries read-only without injecting ROWID', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'APP';
    const sql = `SELECT *
FROM DBA_TAB_PRIVS
WHERE GRANTEE = 'APPUSER';`;
    backendApp.DBGetColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['GRANTEE', 'OWNER', 'TABLE_NAME', 'PRIVILEGE'],
        rows: [{
          GRANTEE: 'APPUSER',
          OWNER: 'APPUSER',
          TABLE_NAME: 'MEITUAN_COMMENT_INFO',
          PRIVILEGE: 'SELECT',
        }],
      }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'APP', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('FROM DBA_TAB_PRIVS');
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({ readOnly: true });
    expect(dataGridState.latestProps?.readOnly).toBe(true);
  });

  it('uses Oracle login user as default schema for unqualified query result metadata', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'dev';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'DEV.PER_CERT_INFO' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['PID', 'BUSILOG_ID', 'ZJLX_ID', ORACLE_ROWID_LOCATOR_COLUMN],
        rows: [{
          PID: '200005000000010',
          BUSILOG_ID: '00000000000000000000',
          ZJLX_ID: '01',
          [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAATestAABAAABrXAAA',
        }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'PID', type: 'CHAR(15)', comment: '个人标识', key: '' },
        { name: 'BUSILOG_ID', type: 'VARCHAR2(20)', comment: '业务日志编号', key: '' },
        { name: 'ZJLX_ID', type: 'CHAR(2)', comment: '证件类型', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'select * from per_cert_info' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'DEV', 'PER_CERT_INFO');
    expect(dataGridState.latestProps?.tableName).toBe('DEV.PER_CERT_INFO');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('gonavi_query_source.ROWID');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses a unique index locator for query results without primary keys', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_EMAIL'], rows: [{ NAME: 'old-name', __gonavi_locator_1_EMAIL: 'a@example.com' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'EMAIL', key: '' }, { name: 'NAME', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'UK_EMAIL', columnName: 'EMAIL', nonUnique: 0, seqInIndex: 1, indexType: 'BTREE' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT NAME FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'unique-key',
      columns: ['EMAIL'],
      valueColumns: ['__gonavi_locator_1_EMAIL'],
      hiddenColumns: ['__gonavi_locator_1_EMAIL'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"EMAIL" AS "__gonavi_locator_1_EMAIL"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses snake_case unique index metadata for query result row locators', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'KINGBASE';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_EMAIL'], rows: [{ NAME: 'old-name', __gonavi_locator_1_EMAIL: 'a@example.com' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ column_name: 'EMAIL' }, { column_name: 'NAME' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [{ index_name: 'users_email_key', column_name: 'EMAIL', is_unique: 't', seq_in_index: '1', index_type: 'btree' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'KINGBASE', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'unique-key',
      columns: ['EMAIL'],
      valueColumns: ['__gonavi_locator_1_EMAIL'],
      hiddenColumns: ['__gonavi_locator_1_EMAIL'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps Kingbase schema-qualified query results writable without treating the schema as the database', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'ldf_server_dbs_dev';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'work_order_no'],
        rows: [{ id: 1001, work_order_no: 'MO-1001' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'work_order_no', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'mes_work_order_pkey', columnName: 'id', nonUnique: 0, seqInIndex: 1 }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'ldf_server_dbs_dev',
        query: 'SELECT * FROM ldf_server.mes_work_order',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'ldf_server_dbs_dev', 'ldf_server.mes_work_order');
    expect(backendApp.DBGetIndexes).toHaveBeenCalledWith(expect.anything(), 'ldf_server_dbs_dev', 'ldf_server.mes_work_order');
    expect(dataGridState.latestProps?.tableName).toBe('ldf_server.mes_work_order');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      valueColumns: ['id'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses hidden Oracle ROWID for query results without primary or unique keys', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'MYCIMLED.EDC_LOG' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ NAME: 'old-name', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT NAME FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain(`ROWID AS "${ORACLE_ROWID_LOCATOR_COLUMN}"`);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });
});
