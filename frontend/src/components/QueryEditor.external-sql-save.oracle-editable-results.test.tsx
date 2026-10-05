import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import { ORACLE_ROWID_LOCATOR_COLUMN } from '../utils/rowLocator';
import QueryEditor from './QueryEditor';
import { QUERY_EDITOR_SQL_LOG_TAB_KEY } from './QueryEditorResultsPanel';
import {
    create,
    storeState,
    backendApp,
    messageApi,
    dataGridState,
    autoFetchState,
    editorState,
    textContent,
    queryResultMessageText,
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

  it('keeps Oracle FOR UPDATE result columns editable when column metadata is unavailable', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'dev';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['WAFER_ID', 'STATUS'],
        rows: [{ WAFER_ID: 'R015Z10F08', STATUS: 'READY' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'ORCLPDB1',
        query: 'SELECT * FROM table_name FOR UPDATE;',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toBe('SELECT * FROM table_name FOR UPDATE');
    expect(dataGridState.latestProps?.tableName).toBe('DEV.TABLE_NAME');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: [],
      valueColumns: [],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    renderer?.unmount();
  });

  it('does not inject Oracle ROWID when the selected object is a view', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'H2.S_BUSI' }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'COMPID', key: '' }, { name: 'SALENO', key: '' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['COMPID', 'SALENO'], rows: [{ COMPID: 'H2', SALENO: '1001' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'H2',
        query: 'select * from cv_gd_yncrm_salesdtllist for update',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), 'H2');
    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toMatch(/select \* from cv_gd_yncrm_salesdtllist/i);
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: ['COMPID', 'SALENO'],
    });
    renderer?.unmount();
  });

  it('rechecks fresh Oracle table metadata before injecting ROWID after a stale completion cache', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'hydeekf';
    editorState.value = 'select * from cv_gd_yncrm_salesdtllist';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'H2.CV_GD_YNCRM_SALESDTLLIST' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'H2' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    backendApp.DBGetTables.mockClear();
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'COMPID', key: '' }, { name: 'SALENO', key: '' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['COMPID', 'SALENO'], rows: [{ COMPID: 'H2', SALENO: '1001' }] }],
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), 'H2');
    const executedSql = String(backendApp.DBQueryMulti.mock.calls[backendApp.DBQueryMulti.mock.calls.length - 1]?.[2] || '');
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: ['COMPID', 'SALENO'],
    });
    renderer.unmount();
  });

  it('rewrites Oracle SELECT * queries before injecting hidden ROWID locator columns', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'MYCIMLED.EDC_LOG' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['WAFER_ID', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ WAFER_ID: 'R015Z10F08', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'WAFER_ID', key: '' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT * FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('FROM MYCIMLED.EDC_LOG');
    expect(executedSql).toContain('FROM MYCIMLED.EDC_LOG gonavi_query_source');
    expect(executedSql).not.toContain('__gonavi_query_source__');
    expect(executedSql).not.toContain('SELECT *, ROWID AS');
    expect(executedSql).toMatch(/SELECT\s+gonavi_query_source\.\*\s*,\s+gonavi_query_source\.ROWID\s+AS\s+"__gonavi_oracle_rowid__"/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('rewrites OceanBase Oracle SELECT * queries before injecting hidden ROWID locator columns', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'dev';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'DEV.EDC_LOG' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['WAFER_ID', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ WAFER_ID: 'R015Z10F08', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'WAFER_ID', key: '' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'SELECT * FROM EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'DEV', 'EDC_LOG');
    expect(executedSql).toContain('FROM EDC_LOG gonavi_query_source');
    expect(executedSql).toMatch(/SELECT\s+gonavi_query_source\.\*\s*,\s+gonavi_query_source\.ROWID\s+AS\s+"__gonavi_oracle_rowid__"/i);
    expect(dataGridState.latestProps?.tableName).toBe('DEV.EDC_LOG');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    // 行号改由 appearance.showDataTableRowNumber 控制，不再按数据源硬编码写入结果集
    expect(dataGridState.latestProps?.showRowNumberColumn).toBeUndefined();
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: 'SELECT * FROM EDC_LOG',
      status: 'success',
    }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('does not inject ROWID for an OceanBase Oracle synonym that is not a base table', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'B.OTHER_TABLE' }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: '' }, { name: 'NAME', key: '' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['ID', 'NAME'], rows: [{ ID: 7, NAME: 'synonym-row' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'SELECT * FROM person' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toMatch(/FROM\s+person/i);
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: ['ID', 'NAME'],
      readOnly: false,
    });
    renderer?.unmount();
  });

  it('keeps OceanBase Oracle sequence queries out of the ROWNUM auto-limit wrapper', async () => {
    const sql = 'SELECT IMP_BASICINFO.SEQ_HIS_AZA7.nextval FROM dual';
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NEXTVAL'], rows: [{ NEXTVAL: 42 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'IMP_BASICINFO', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('IMP_BASICINFO.SEQ_HIS_AZA7.nextval');
    expect(executedSql).not.toContain('SELECT * FROM (');
    expect(executedSql).not.toMatch(/\bROWNUM\b/i);
    expect(backendApp.DBQueryMultiTransactional).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('quotes exact-case OceanBase Oracle lowercase tables for execution while keeping sql logs unchanged', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'SYS@oracle_tenant#cluster';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'SYS.test' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ NAME: 'demo', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'select * from test' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), 'SYS');
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'SYS', 'test');
    expect(executedSql).toMatch(/from\s+"test"\s+gonavi_query_source/i);
    expect(executedSql).toMatch(/SELECT\s+gonavi_query_source\.\*\s*,\s+gonavi_query_source\.ROWID\s+AS\s+"__gonavi_oracle_rowid__"/i);
    expect(dataGridState.latestProps?.tableName).toBe('SYS.test');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: 'select * from test',
      status: 'success',
    }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('qualifies OceanBase Oracle read-only queries with the selected schema instead of the login user', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'SBDEVREAD';
    storeState.connections[0].config.database = 'ORCLPDB1';
    (storeState.connections[0].config as any).readOnly = true;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [],
    });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'SBDEV.PERSON_INFO' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['ZJJHM'], rows: [{ ZJJHM: '' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'SBDEV', query: "select * from person_info where zjjhm=''" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(1, expect.anything(), 'SBDEVREAD');
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(2, expect.anything(), 'SBDEV');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(executedSql).toMatch(/from\s+"SBDEV"\."PERSON_INFO"\s+where\s+zjjhm=''/i);
    expect(executedSql).not.toContain('SBDEVREAD.PERSON_INFO');
    expect(dataGridState.latestProps?.readOnly).toBe(true);
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "select * from person_info where zjjhm=''",
      status: 'success',
    }));
    renderer?.unmount();
  });

  it('keeps qualifying OceanBase Oracle read-only queries when config.database already equals the selected schema', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'SBDEVREAD';
    storeState.connections[0].config.database = 'SBDEV';
    (storeState.connections[0].config as any).readOnly = true;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [],
    });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'SBDEV.SYSM_USER' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['USER_ID'], rows: [{ USER_ID: '0001477884' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'SBDEV', query: "select * from sysm_user where user_id='0001477884'" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(1, expect.anything(), 'SBDEVREAD');
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(2, expect.anything(), 'SBDEV');
    expect(executedSql).toMatch(/from\s+"SBDEV"\."SYSM_USER"\s+where\s+user_id='0001477884'/i);
    expect(executedSql).not.toContain('SBDEVREAD.SYSM_USER');
    renderer?.unmount();
  });

  it('keeps Oracle anonymous PL/SQL block DML pending for a manual transaction', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-oracle-block',
      transactionPending: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      'BEGIN',
      "    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
      "    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
      "    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
      'END;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(expect.anything(), 'ORCLPDB1', plsql, 'query-1');
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-oracle-block',
      dbType: 'oracle',
      statements: [plsql],
    });
    expect(textContent(renderer!.root)).toContain('提交');
    expect(textContent(renderer!.root)).toContain('回滚');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: plsql,
      status: 'success',
    }));

    await act(async () => {
      await findButton(renderer!, '回滚').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBRollbackTransactionWithTrigger).toHaveBeenCalledWith('tx-oracle-block', 'manual');
    renderer?.unmount();
  });

  it('preserves Oracle SQLPlus slash delimiters for selected object-edit PL/SQL definitions', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const expectedPlsql = [
      '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
      '-- 请确认语法兼容当前数据库后执行',
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1 AS',
      'BEGIN',
      '  NULL;',
      'END cproc_tzhssr_order2sale_A1;',
      '/',
    ].join('\n');
    const legacyEditorPlsql = expectedPlsql.replace(/\n\/$/, '\n/;');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: legacyEditorPlsql, queryMode: 'object-edit' })} />);
    });
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 7,
      endColumn: 3,
      positionLineNumber: 7,
      positionColumn: 3,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'ORCLPDB1', expectedPlsql, 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('/;');
    renderer?.unmount();
  });

  it('renders result grid for sqlserver exec statements that return rows', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['SPID', 'STATUS'], rows: [{ SPID: 52, STATUS: 'RUNNABLE' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_who2' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：');
    expect(dataGridState.latestProps?.columnNames).toEqual(['SPID', 'STATUS']);
    expect(Array.isArray(dataGridState.latestProps?.data)).toBe(true);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ SPID: 52, STATUS: 'RUNNABLE' });
  });

  it('renders standalone message result for sqlserver statistics statements', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: [],
        rows: [],
        messages: ["Table 'users'. Scan count 1, logical reads 3."],
      }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'SET STATISTICS IO ON;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('消息 1');
    expect(queryResultMessageText(renderer!)).toContain("Table 'users'. Scan count 1, logical reads 3.");
    expect(dataGridState.latestProps?.columnNames).not.toEqual([]);
  });

  it('keeps multiple result sets from a single sqlserver statement', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
        { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'sa' }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_helpdb' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(dataGridState.latestProps?.columnNames).toEqual(['name']);
  });

  it('prefers the first displayable sqlserver procedure result when empty result sets are returned', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: [], rows: [] },
        {
          statementIndex: 1,
          columns: ['insert_sql'],
          rows: [
            { insert_sql: "insert into c_user(userid) values('168')" },
            { insert_sql: "insert into c_user(userid) values('169')" },
          ],
        },
        { statementIndex: 1, columns: [], rows: [] },
        { statementIndex: 1, columns: [], rows: [] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select 'c_user','userid = ''168''',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 4');
    expect(dataGridState.latestProps?.columnNames).toEqual(['insert_sql']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({
      insert_sql: "insert into c_user(userid) values('168')",
    });
  });

  it('prefers concrete sqlserver procedure rows over affected-row status results', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 0 }] },
        { statementIndex: 1, columns: [], rows: [] },
        {
          statementIndex: 1,
          columns: ['insert_sql'],
          rows: [
            { insert_sql: "insert into c_user(userid) values('168')" },
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select 'c_user','userid = ''168''',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.columnNames).toEqual(['insert_sql']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({
      insert_sql: "insert into c_user(userid) values('168')",
    });
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
  });

  it('prefers sqlserver print output messages over affected-row status results', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 0 }] },
        {
          statementIndex: 1,
          columns: [],
          rows: [],
          messages: [
            "insert into c_dyscript(projectid,name) values (1,'demo')",
            "insert into c_dyscript(projectid,name) values (2,'next')",
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select c_dyscript,'projectid = 1',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('消息 1');
    expect(queryResultMessageText(renderer!)).toContain("insert into c_dyscript(projectid,name) values (1,'demo')");
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
    expect(dataGridState.latestProps).toBeNull();
  });

  it('renders top-level sqlserver print messages when result sets contain only status rows', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 0 }] },
      ],
      messages: [
        "insert into c_dyscript(projectid,name) values (1,'demo')",
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select c_dyscript,'projectid = 1',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('消息 1');
    expect(queryResultMessageText(renderer!)).toContain("insert into c_dyscript(projectid,name) values (1,'demo')");
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
    expect(dataGridState.latestProps).toBeNull();
  });

  it('keeps both tabs when rerunning the same single sqlserver statement with multiple result sets', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'sa' }] },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'tempdb' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'dbo' }] },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_helpdb' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabLabels = renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab'] === 'true';
    });
    expect(tabLabels).toHaveLength(2);
    expect(dataGridState.latestProps?.columnNames).toEqual(['name']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ name: 'tempdb' });
  });

  it('reloads the active secondary result set for a single sqlserver statement', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'sa' }] },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'dbo' }] },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_helpdb' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const resultTabButtons = renderer!.root.findAll((node) => (
      node.type === 'button'
      && node.props['data-tab-key']
      && node.props['data-tab-key'] !== QUERY_EDITOR_SQL_LOG_TAB_KEY
    ));
    expect(resultTabButtons).toHaveLength(2);

    await act(async () => {
      resultTabButtons[1].props.onClick();
    });

    expect(dataGridState.latestProps?.columnNames).toEqual(['owner']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ owner: 'sa' });

    await act(async () => {
      await dataGridState.latestProps?.onReload?.();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(dataGridState.latestProps?.columnNames).toEqual(['owner']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ owner: 'dbo' });
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'master' })]));
  });

  it('falls back to all-columns editing when no safe locator exists for non-Oracle results', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, 'Run').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.pkColumns).toEqual([]);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      readOnly: false,
      reason: 'No primary key or unique index was detected, so rows will be located by matching all columns. Edit with care.',
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      'Query results remain read-only: main.users No primary key or usable unique index was detected, so changes cannot be committed safely.',
    );
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      '查询结果保持只读：main.users 未检测到主键或可用唯一索引，无法安全提交修改。',
    );
  });

  it('falls back to all-columns editing when unique index metadata is unavailable', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: false,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, 'Run').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      'Query results remain read-only: main.users Unable to load unique index metadata, so changes cannot be committed safely.',
    );
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      '查询结果保持只读：main.users 无法加载唯一索引元数据，无法安全提交修改。',
    );
  });

  it('falls back to all-columns editing when table locator metadata is unavailable', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: false,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, 'Run').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: [],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      'Query results remain read-only: Unable to load primary key/unique index metadata for main.users, so changes cannot be committed safely.',
    );
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      '查询结果保持只读：无法加载 main.users 的主键/唯一索引元数据，无法安全提交修改。',
    );
  });
});
