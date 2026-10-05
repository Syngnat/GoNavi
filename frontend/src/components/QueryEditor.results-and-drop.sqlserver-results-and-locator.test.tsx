import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import { normalizeQueryResultMessages } from './queryEditor/QueryEditorHelpers';
import QueryEditor from './QueryEditor';
import { QUERY_EDITOR_SQL_LOG_TAB_KEY } from './QueryEditorResultsPanel';
import { storeState, backendApp, messageApi, dataGridState, editorState } from './queryEditorResultsAndDropTestState';
import { create, textContent, findButton, findResultMessageTextarea, findByClassName, createTab } from './queryEditorResultsAndDropTestHelpers';
import { setUpQueryEditorResultsAndDropTest, tearDownQueryEditorResultsAndDropTest } from './queryEditorResultsAndDropTestHooks';

vi.mock('../store', async (importOriginal) => (await import('./queryEditorResultsAndDropTestState')).mockModule1(importOriginal));

vi.mock('../../wailsjs/go/app/App', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule2());

vi.mock('../utils/nativeDetachedWindowHost', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule3());

vi.mock('../utils/autoFetchVisibility', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule4());

vi.mock('@monaco-editor/react', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule5());

vi.mock('./DataGrid', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule6());

vi.mock('./resultDiff/ResultDiffWizard', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule7());

vi.mock('./resultDiff/ViewDataVerifyWizard', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule8());

vi.mock('./LogPanel', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule9());

vi.mock('./DetachDragPreview', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule10());

vi.mock('@ant-design/icons', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule11());

vi.mock('antd', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule12());

describe('QueryEditor external SQL save', () => {
  beforeEach(setUpQueryEditorResultsAndDropTest);

  afterEach(tearDownQueryEditorResultsAndDropTest);

  it('runs the preceding Oracle procedure when the cursor is on the SQLPlus slash delimiter', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_sourceid IN VARCHAR2,',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      'BEGIN',
      "  p_msg_out := '';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      '    p_msg_out := SQLERRM;',
      'END cproc_tzhssr_order2sale_A1;',
      '/;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql, queryMode: 'object-edit' })} />);
    });

    const slashLine = plsql.split('\n').findIndex((line) => line.startsWith('/')) + 1;
    editorState.position = { lineNumber: slashLine, column: 1 };
    editorState.selection = {
      startLineNumber: slashLine,
      startColumn: 1,
      endLineNumber: slashLine,
      endColumn: 1,
      positionLineNumber: slashLine,
      positionColumn: 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1');
    expect(executedSql).toContain('p_msg_out OUT NVARCHAR2');
    expect(executedSql).toContain('END cproc_tzhssr_order2sale_A1;');
    expect(executedSql).not.toContain('/;');
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

  it('renders SQLite select results even when the result panel starts hidden', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id', 'name'], rows: [{ id: 1, name: 'SQLite row' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: "SELECT 1 AS id, 'SQLite row' AS name" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(dataGridState.latestProps?.columnNames).toEqual(['id', 'name']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ id: 1, name: 'SQLite row' });
    renderer.unmount();
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
    expect(findResultMessageTextarea(renderer!).props.value).toBe("Table 'users'. Scan count 1, logical reads 3.");
    expect(renderer!.root.findAll((node) => node.props?.['data-grid'] === 'true')).toHaveLength(0);
  });

  it('preserves sqlserver message indentation and blank lines after stripping mssql prefixes', () => {
    expect(normalizeQueryResultMessages([
      "mssql:     select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
      "mssql:         'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
      '',
      "        where funcno = @funcno and tabname = '$vendorclass'",
    ])).toEqual([
      "    select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
      "        'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
      '',
      "        where funcno = @funcno and tabname = '$vendorclass'",
    ]);
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

  it('hides redundant sqlserver affected-row status result after a query result', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        {
          columns: ['dddwno', 'dddwlist'],
          rows: [{ dddwno: '001', dddwlist: 'demo' }],
        },
        { columns: ['affectedRows'], rows: [{ affectedRows: 846 }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: 'select * from c_dddw' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('结果 1');
    expect(rendered).not.toContain('结果 2');
    expect(rendered).not.toContain('影响行数：846');
    expect(dataGridState.latestProps?.columnNames).toEqual(['dddwno', 'dddwlist']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ dddwno: '001', dddwlist: 'demo' });
    expect(messageApi.success).toHaveBeenCalledWith('已执行完成，生成 1 个结果集。');
  });

  it('hides ignorable SQL Server session notices after a single SELECT', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'NSGJ_Golf75';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        {
          columns: ['ID', 'OrderDate', 'Amount', 'rn'],
          rows: [{ ID: 101, OrderDate: '2026-01-01', Amount: 500, rn: '1' }],
        },
        {
          columns: [],
          rows: [],
          messages: [
            "mssql: Changed database context to 'NSGJ_Golf75'.",
            '(1 row(s) affected)',
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'NSGJ_Golf75',
        query: 'WITH OracleData_CTE AS (SELECT 1 AS ID) SELECT * FROM OracleData_CTE',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('结果 1');
    expect(rendered).not.toContain('消息 2');
    expect(messageApi.success).toHaveBeenCalledWith('已执行完成，生成 1 个结果集。');
    expect(dataGridState.latestProps?.columnNames).toEqual(['ID', 'OrderDate', 'Amount', 'rn']);
  });

  it('keeps SQL Server PRINT output after a query result without counting it as a second result set', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['id'], rows: [{ id: 1 }] },
        {
          columns: [],
          rows: [],
          messages: ["insert into c_user(userid) values('168')"],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: 'SELECT 1 AS id' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('结果 1');
    expect(rendered).toContain('消息 2');
    expect(messageApi.success).toHaveBeenCalledWith('已执行完成，生成 1 个结果集。');
    expect(messageApi.success).not.toHaveBeenCalledWith('已执行完成，生成 2 个结果集。');
  });

  it('hides redundant sqlserver affected-row status results for every statement in a batch', async () => {

    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['value'], rows: [{ value: 1 }] },
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 1 }] },
        { statementIndex: 2, columns: ['value'], rows: [{ value: 2 }] },
        { statementIndex: 2, columns: ['affectedRows'], rows: [{ affectedRows: 1 }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'SELECT 1;\nSELECT 2;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('结果 1');
    expect(rendered).toContain('结果 2');
    expect(rendered).not.toContain('结果 3');
    expect(rendered).not.toContain('结果 4');
    expect(rendered).not.toContain('影响行数：1');
    expect(messageApi.success).toHaveBeenCalledWith('已执行完成，生成 2 个结果集。');

    const resultTabButtons = renderer!.root.findAll((node) =>
      node.type === 'button' && String(node.props['data-tab-key'] || '').startsWith('result-'));
    expect(resultTabButtons).toHaveLength(2);

    await act(async () => {
      resultTabButtons[1].props.onClick();
    });

    expect(dataGridState.latestProps?.columnNames).toEqual(['value']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ value: 2 });
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

  it('shows the data result tab in V2 when the SQL log tab is already visible', async () => {

    storeState.sqlLogs = [{
      id: 'log-existing',
      timestamp: Date.now(),
      sql: 'SELECT * FROM ldf_server.mes_work_order',
      status: 'success',
      duration: 120,
    }];
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'ldf_server_dbs_dev';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        statementIndex: 1,
        columns: ['work_order'],
        rows: [{ work_order: 'MO-20260629' }],
      }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'ldf_server_dbs_dev',
        query: 'SELECT * FROM ldf_server.mes_work_order;',
        resultPanelVisible: true,
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('日志');
    expect(rendered).toContain('结果 1');
    expect(dataGridState.latestProps?.columnNames).toEqual(['work_order']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ work_order: 'MO-20260629' });
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
    expect(findResultMessageTextarea(renderer!).props.value).toBe([
      "insert into c_dyscript(projectid,name) values (1,'demo')",
      "insert into c_dyscript(projectid,name) values (2,'next')",
    ].join('\n'));
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
    expect(dataGridState.latestProps).toBeNull();
  });

  it('preserves sqlserver message indentation in the rendered result message textarea', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        {
          statementIndex: 1,
          columns: [],
          rows: [],
          messages: [
            "mssql:     select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
            "mssql:         'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
            '',
            "        where funcno = @funcno and tabname = '$vendorclass'",
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "sp_sql p_get_query" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    const messageTextarea = findResultMessageTextarea(renderer!);
    const messageBlock = findByClassName(renderer!, 'query-result-message-block');
    const messageScrollBody = findByClassName(renderer!, 'query-result-message-scroll-body');
    expect(rendered).toContain('消息 1');
    expect(messageTextarea.props.value).toBe([
      "    select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
      "        'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
      '',
      "        where funcno = @funcno and tabname = '$vendorclass'",
    ].join('\n'));
    expect(messageTextarea.props.wrap).toBe('off');
    expect(messageTextarea.props.style).toMatchObject({
      display: 'block',
      whiteSpace: 'pre',
      overflow: 'auto',
      width: '100%',
      minWidth: 0,
      padding: '10px 12px',
    });
    expect(messageTextarea.props.style.padding).not.toBe(0);
    expect(messageTextarea.props.style.minWidth).not.toBe('max-content');
    expect(messageBlock.props.style).toMatchObject({
      alignItems: 'stretch',
      width: '100%',
    });
    expect(messageScrollBody.props.style).toMatchObject({
      display: 'flex',
      alignItems: 'stretch',
      width: '100%',
      overflow: 'hidden',
      minWidth: 0,
      borderRadius: 6,
    });
    expect(messageScrollBody.props.style.border).toContain('1px solid');
    expect(messageScrollBody.props.style.background).toBeTruthy();
    expect(messageTextarea.props.value).not.toContain('mssql:');
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
    expect(findResultMessageTextarea(renderer!).props.value).toBe("insert into c_dyscript(projectid,name) values (1,'demo')");
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

  it('localizes the non-Oracle all-columns locator warning in English while preserving the raw table name', async () => {
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

  it('uses all-columns editing when non-Oracle unique-index metadata is unavailable', async () => {
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

  it('uses all-columns editing when non-Oracle table locator metadata is unavailable', async () => {
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

  it('falls back to all-columns editing when query locator metadata stalls', async () => {
    vi.useFakeTimers();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'alpha' }] }],
    });
    backendApp.DBGetColumns.mockReturnValueOnce(new Promise(() => {}));
    backendApp.DBGetIndexes.mockReturnValueOnce(new Promise(() => {}));

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
      });

      await act(async () => {
        findButton(renderer!, '运行').props.onClick();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
        expect.anything(),
        'main',
        'SELECT NAME FROM users LIMIT 5000',
        'query-1',
      );
      expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ NAME: 'alpha' });
      expect(dataGridState.latestProps?.tableName).toBe('users');
      expect(dataGridState.latestProps?.editLocator).toMatchObject({
        strategy: 'all-columns',
        readOnly: false,
      });
      expect(dataGridState.latestProps?.readOnly).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps MySQL information_schema routine results read-only without a locator warning', async () => {
    const sql = [
      'SELECT ROUTINE_SCHEMA, ROUTINE_NAME, DEFINER, SECURITY_TYPE',
      'FROM information_schema.ROUTINES',
      "WHERE ROUTINE_SCHEMA = 'mkefu_location_dev_local'",
      "  AND ROUTINE_NAME = 'init_orgi'",
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['ROUTINE_SCHEMA', 'ROUTINE_NAME', 'DEFINER', 'SECURITY_TYPE'],
        rows: [{
          ROUTINE_SCHEMA: 'mkefu_location_dev_local',
          ROUTINE_NAME: 'init_orgi',
          DEFINER: 'root@%',
          SECURITY_TYPE: 'DEFINER',
        }],
      }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'mkefu_location_dev_local', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('ROUTINES');
    expect(dataGridState.latestProps?.readOnly).toBe(true);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });
});
