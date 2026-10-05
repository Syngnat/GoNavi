import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    notifyStoreSubscribers,
    backendApp,
    autoFetchState,
    editorState,
    findSqlCompletionProvider,
    createSqlCompletionModel,
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

  it('matches table names by prefix, substring, and ordered characters in FROM completion', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'information_schema' }, { Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Tables_in_main: 'users' },
        { Tables_in_main: 'a_cninfo_announcement' },
        { Tables_in_main: 'hrmresource' },
        { Tables_in_main: 'hrm_resource_export_template' },
        { Tables_in_main: 'archive_hrmresource' },
        { Tables_in_main: 'table_new_1' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { tableName: 'hrmresource', name: 'hrmresult', type: 'varchar(32)' },
        { tableName: 'users', name: 'hrmresult_from_users', type: 'varchar(32)' },
        { tableName: 'users', name: 'SHORT_TITLE', type: 'varchar(255)' },
        { tableName: 'users', name: 'emp_code', type: 'varchar(32)' },
      ],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM hrmres';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).toContain('hrmresource');
    // 连续子串和有序字符匹配均保留，且排在精确/前缀命中之后。
    expect(labels).toContain('archive_hrmresource');
    expect(labels.indexOf('archive_hrmresource')).toBeGreaterThan(labels.indexOf('hrmresource'));
    expect(labels).toContain('hrm_resource_export_template');
    expect(labels).not.toContain('hrmresult');

    editorState.value = 'SELECT * FROM users u, hrmres';
    editorState.latestOnChange?.(editorState.value);
    const commaResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const commaLabels = commaResult.suggestions.map((item: any) => item.label);
    expect(commaLabels).toContain('hrmresource');
    expect(commaLabels).toContain('archive_hrmresource');
    expect(commaLabels.indexOf('archive_hrmresource')).toBeGreaterThan(commaLabels.indexOf('hrmresource'));
    expect(commaLabels).not.toContain('hrmresult_from_users');

    // #939：输入表名中段片段（new）也能提示 table_new_1
    editorState.value = 'SELECT * FROM new';
    editorState.latestOnChange?.(editorState.value);
    const substringResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const substringLabels = substringResult.suggestions.map((item: any) => item.label);
    expect(substringLabels).toContain('table_new_1');
    expect(backendApp.DBGetColumns.mock.calls.map((call: any[]) => call[2])).not.toContain('hrmres');

    editorState.value = 'SELECT * FROM A_C';
    editorState.latestOnChange?.(editorState.value);
    const uppercaseTableResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const uppercaseTable = uppercaseTableResult.suggestions.find((item: any) => item.label === 'a_cninfo_announcement');
    expect(uppercaseTable?.insertText).toBe('a_cninfo_announcement AS aca');

    editorState.value = 'SELECT * FROM users WHERE sh';
    editorState.latestOnChange?.(editorState.value);
    const lowercaseColumnResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const lowercaseColumn = lowercaseColumnResult.suggestions.find((item: any) => item.label === 'SHORT_TITLE');
    expect(lowercaseColumn?.insertText).toBe('short_title');

    // #939：字段中段片段提示（输入 code 应提示 emp_code）
    editorState.value = 'SELECT * FROM users WHERE code';
    editorState.latestOnChange?.(editorState.value);
    const columnSubstringResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const columnSubstringLabels = columnSubstringResult.suggestions.map((item: any) => item.label);
    expect(columnSubstringLabels).toContain('emp_code');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('adds deterministic aliases to table source completions and resolves conflicts', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Tables_in_main: 'system_user' },
        { Tables_in_main: 'code_query_record_zykj' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM system_user su JOIN sys';
    editorState.latestOnChange?.(editorState.value);
    const conflictResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(conflictResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su2');

    storeState.connections[0].config.type = 'tidb';
    editorState.value = 'SELECT * FROM sys';
    editorState.latestOnChange?.(editorState.value);
    const tidbResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(tidbResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su');

    editorState.value = '\uFEFF-- legacy completion test\r\nSELECT *\r\nFROM sys';
    editorState.latestOnChange?.(editorState.value);
    const crlfResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 3, column: 9 },
    );
    expect(crlfResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su');
    expect(editorState.value).toBe('\uFEFF-- legacy completion test\r\nSELECT *\r\nFROM sys');

    storeState.connections[0].config.type = 'oracle';
    editorState.value = 'SELECT * FROM sys';
    editorState.latestOnChange?.(editorState.value);
    const oracleResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(oracleResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user su');

    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as Record<string, unknown>).oceanBaseProtocol = 'oracle';
    const oceanBaseOracleResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(oceanBaseOracleResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user su');

    storeState.connections[0].config.type = 'iotdb';
    const unsupportedDialectResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(unsupportedDialectResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user');

    storeState.connections[0].config.type = 'mysql';
    (storeState.connections[0].config as Record<string, unknown>).oceanBaseProtocol = undefined;
    editorState.value = 'SELECT * FROM code';
    editorState.latestOnChange?.(editorState.value);
    const initialsResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(initialsResult.suggestions.find((item: any) => item.label === 'code_query_record_zykj')?.insertText)
      .toBe('code_query_record_zykj AS cqrz');

    editorState.value = 'INSERT INTO system';
    editorState.latestOnChange?.(editorState.value);
    const insertResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(insertResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user');

    for (const sql of [
      'UPDATE system',
      'DELETE FROM system',
      'INSERT INTO system',
      'REPLACE INTO system',
      'MERGE INTO system',
    ]) {
      editorState.value = sql;
      editorState.latestOnChange?.(editorState.value);
      const dmlResult = await sqlProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      expect(dmlResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
        .toBe('system_user');
    }

    editorState.value = 'INSERT INTO audit_log SELECT * FROM system';
    editorState.latestOnChange?.(editorState.value);
    const insertSelectResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(insertSelectResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not add table aliases to table source completions when disabled', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.appearance.autoAddTableAlias = false;
    storeState.appearance.customTableAliasPrefixEnabled = true;
    storeState.appearance.customTableAliasPrefix = 't';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'system_user' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.value = 'SELECT * FROM system';
    editorState.latestOnChange?.(editorState.value);
    const result = await findSqlCompletionProvider().provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(result.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('uses a custom prefix for table source completions without changing dialect alias syntax', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.appearance.customTableAliasPrefixEnabled = true;
    storeState.appearance.customTableAliasPrefix = 't';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'system_user' }, { Tables_in_main: 'service_user' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    editorState.value = 'SELECT * FROM system_user t0 JOIN service';
    editorState.latestOnChange?.(editorState.value);
    const mysqlResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(mysqlResult.suggestions.find((item: any) => item.label === 'service_user')?.insertText)
      .toBe('service_user AS t1');

    storeState.connections[0].config.type = 'oracle';
    editorState.value = 'SELECT * FROM system_user t0 JOIN service';
    editorState.latestOnChange?.(editorState.value);
    const oracleResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(oracleResult.suggestions.find((item: any) => item.label === 'service_user')?.insertText)
      .toBe('service_user t1');

    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as Record<string, unknown>).oceanBaseProtocol = 'oracle';
    const oceanBaseOracleResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(oceanBaseOracleResult.suggestions.find((item: any) => item.label === 'service_user')?.insertText)
      .toBe('service_user t1');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('marks bounded FROM completion as incomplete so Monaco retriggers with the final prefix', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        ...Array.from({ length: 201 }, (_, index) => ({
          Tables_in_main: `hrm_resource_${String(index).padStart(3, '0')}`,
        })),
        { Tables_in_main: 'hrmresource' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM h';
    editorState.latestOnChange?.(editorState.value);
    const initialResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(initialResult.suggestions).toHaveLength(200);
    expect(initialResult.suggestions.map((item: any) => item.label)).not.toContain('hrmresource');
    expect(initialResult.incomplete).toBe(true);

    editorState.value = 'SELECT * FROM hrmres';
    editorState.latestOnChange?.(editorState.value);
    const retriggeredResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
      { triggerKind: 2 },
    );
    expect(retriggeredResult.suggestions).toHaveLength(200);
    expect(retriggeredResult.suggestions.map((item: any) => item.label)).toContain('hrmresource');
    expect(retriggeredResult.incomplete).toBe(true);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('resolves columns from comma-separated Dameng table references and aliases', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'DEV';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'DEV' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Table: 'VULNERABILITY_INFO_T' },
        { Table: 'VULNERABILITY_DETAIL_T' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetColumns.mockImplementation(async (_config: any, _dbName: string, tableName: string) => ({
      success: true,
      data: tableName === 'VULNERABILITY_DETAIL_T'
        ? [
            { name: 'DETAIL_ID', type: 'VARCHAR' },
            { name: 'VULNERABILITY_ID', type: 'VARCHAR' },
          ]
        : [
            { name: 'CODE', type: 'VARCHAR' },
            { name: 'CONTENT', type: 'VARCHAR' },
            { name: 'ID', type: 'VARCHAR' },
          ],
    }));

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'DEV' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();
    const sqlPrefix = 'SELECT * FROM VULNERABILITY_INFO_T a, VULNERABILITY_DETAIL_T b '
      + 'WHERE VULNERABILITY_INFO_T.CODE = ';

    for (const qualifier of ['VULNERABILITY_DETAIL_T', 'b']) {
      editorState.value = `${sqlPrefix}${qualifier}.`;
      editorState.latestOnChange?.(editorState.value);
      const result = await sqlProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const labels = result.suggestions.map((item: any) => item.label);

      expect(result.suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'DETAIL_ID',
          detail: expect.stringContaining('VULNERABILITY_DETAIL_T'),
        }),
      ]));
      expect(labels).toEqual(expect.arrayContaining(['DETAIL_ID', 'VULNERABILITY_ID']));
      expect(labels).not.toEqual(expect.arrayContaining(['CODE', 'CONTENT', 'ID']));
    }
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'DEV', 'VULNERABILITY_DETAIL_T');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalledWith(expect.anything(), 'DEV', 'VULNERABILITY_INFO_T');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps FROM inside an unfinished EXTRACT expression in column completion context', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Table: 'users' },
        { Table: 'archive_created_at' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'created_at', type: 'timestamp' }],
    });

    const sql = 'SELECT EXTRACT(YEAR FROM creat) FROM users';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();
    const cursorPrefix = 'SELECT EXTRACT(YEAR FROM creat';
    const result = await sqlProvider.provideCompletionItems(
      createSqlCompletionModel(sql, 'creat'),
      { lineNumber: 1, column: cursorPrefix.length + 1 },
    );

    expect(result.suggestions.map((item: any) => item.label)).toContain('created_at');
    expect(backendApp.DBGetColumns.mock.calls.map((call: any[]) => call[2])).not.toContain('created_at');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not suggest tables from other databases for unqualified FROM completion', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = 'mkefu_ai_dev';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'mkefu_ai_dev' }, { Database: 'mkefu_dev' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'mkefu_ai_dev') {
        return { success: true, data: [{ Tables_in_mkefu_ai_dev: 'ai_conversation' }] };
      }
      if (dbName === 'mkefu_dev') {
        return { success: true, data: [{ Tables_in_mkefu_dev: 'wechat_visitor_id_bak' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'mkefu_ai_dev' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM wechat';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).not.toContain('wechat_visitor_id_bak');
    expect(labels).not.toContain('mkefu_dev.wechat_visitor_id_bak');
    expect(backendApp.DBGetTables.mock.calls.map((call: any[]) => call[1])).toEqual(
      expect.arrayContaining(['mkefu_ai_dev']),
    );
    expect(backendApp.DBGetTables.mock.calls.map((call: any[]) => call[1])).not.toContain('mkefu_dev');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('lazy loads current database tables for FROM completion when metadata is not preloaded', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = false;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'fs_org_auth_application' }],
    });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/table_comment|information_schema\.tables/i.test(sql)) {
        return { success: true, data: [{ table_name: 'fs_org_auth_application', table_comment: '认证申请表' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'front_end_sys' })} />);
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM fs_org';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const labels = result.suggestions.map((item: any) => item.label);
    const tableSuggestion = result.suggestions.find((item: any) => item.label === 'fs_org_auth_application');

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'front_end_sys');
    expect(labels).toContain('fs_org_auth_application');
    expect(tableSuggestion?.detail).toBe('表 - 认证申请表');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('retries lazy table metadata after a transient failure instead of caching an empty catalog', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = false;
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: false, message: 'temporary metadata failure' })
      .mockResolvedValueOnce({ success: true, data: [{ Table: 'recovered_table' }] });
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'front_end_sys' })} />);
    });
    const sqlProvider = editorState.providers.find((provider) => (
      Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.')
    ));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM recovered_';
    editorState.latestOnChange?.(editorState.value);
    await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not mark the main metadata snapshot complete when a referenced database fails', async () => {
    let referencedDatabaseAttempts = 0;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'other' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => {
      if (dbName === 'main') {
        return { success: true, data: [{ Tables_in_main: 'users' }] };
      }
      referencedDatabaseAttempts += 1;
      return referencedDatabaseAttempts === 1
        ? { success: false, message: 'temporary referenced metadata failure' }
        : { success: true, data: [{ Tables_in_other: 'orders' }] };
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });

    const tab = createTab({
      query: 'SELECT * FROM main.users JOIN other.orders ON main.users.id = other.orders.id',
      dbName: 'main',
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} isActive />);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(referencedDatabaseAttempts).toBe(1);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);

    // Re-running the effect after the transient failure must retry the
    // referenced database instead of being short-circuited by the main DB's
    // still-present table metadata. Replacing the connections array with the
    // same connection objects mirrors an unrelated store update and reruns the
    // metadata effect without changing the requested database set.
    await act(async () => {
      storeState.connections = [...storeState.connections];
      notifyStoreSubscribers();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });

    expect(referencedDatabaseAttempts).toBe(2);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(4);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps hover fallback alive when metadata APIs return malformed responses', async () => {
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce(null);
    backendApp.DBGetAllColumns.mockResolvedValueOnce(null);
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM missing_table', dbName: 'main' })} />);
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });

    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT * FROM missing_table'.length },
    );
    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `missing_table`');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('retries failed object metadata after editing the same reference set', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    let viewAttempts = 0;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/pg_catalog\.pg_views/i.test(sql)) {
        viewAttempts += 1;
        return viewAttempts === 1
          ? { success: false, message: 'temporary view metadata failure' }
          : { success: true, data: [{ view_name: 'recovered_view' }] };
      }
      return { success: true, data: [] };
    });

    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM users', dbName: 'main' })} />);
        for (let i = 0; i < 24; i += 1) await Promise.resolve();
      });
      expect(viewAttempts).toBe(1);

      await act(async () => {
        editorState.value = 'SELECT * FROM users ';
        editorState.latestOnChange?.(editorState.value);
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: ' ' }],
        }));
        vi.advanceTimersByTime(449);
        await Promise.resolve();
      });
      expect(viewAttempts).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
        for (let i = 0; i < 24; i += 1) await Promise.resolve();
      });
      expect(viewAttempts).toBe(2);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('drops stale in-flight lazy table metadata after a schema refresh event', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = false;
    let resolveOldTables!: (value: any) => void;
    const oldTables = new Promise((resolve) => {
      resolveOldTables = resolve;
    });
    backendApp.DBGetTables
      .mockImplementationOnce(() => oldTables)
      .mockResolvedValueOnce({
        success: true,
        data: [{ Table: 'fresh_table' }],
      });
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });

    const baseWindow: any = window;
    const refreshListeners: Array<(event: Event) => void> = [];
    vi.stubGlobal('window', {
      ...baseWindow,
      addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
        if (type === 'gonavi:sidebar-database-refresh') refreshListeners.push(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
        if (type !== 'gonavi:sidebar-database-refresh') return;
        const index = refreshListeners.indexOf(listener);
        if (index >= 0) refreshListeners.splice(index, 1);
      }),
      dispatchEvent: vi.fn(),
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} isActive />);
    });
    const sqlProvider = editorState.providers.find((provider) => (
      Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.')
    ));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM old_';
    editorState.latestOnChange?.(editorState.value);
    const pendingCompletion = sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    await Promise.resolve();
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);

    refreshListeners.forEach((listener) => listener({
      type: 'gonavi:sidebar-database-refresh',
      detail: { connectionId: 'conn-1', dbName: 'main' },
    } as any));
    resolveOldTables({
      success: true,
      data: [{ Table: 'stale_table' }],
    });
    await pendingCompletion;

    editorState.value = 'SELECT * FROM fresh_';
    editorState.latestOnChange?.(editorState.value);
    const refreshedCompletion = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    expect(refreshedCompletion.suggestions.map((item: any) => item.label)).toContain('fresh_table');
    expect(refreshedCompletion.suggestions.map((item: any) => item.label)).not.toContain('stale_table');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('suggests MySQL CALL keyword and stored routine names in SQL completion', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      const text = String(sql || '');
      if (text.includes('information_schema.routines')) {
        return {
          success: true,
          data: [
            { routine_name: 'codex_tmp_proc_link_test', routine_type: 'PROCEDURE', schema_name: 'main' },
            { routine_name: 'codex_tmp_score_user', routine_type: 'FUNCTION', schema_name: 'main' },
          ],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'CA';
    editorState.latestOnChange?.(editorState.value);
    const keywordItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(keywordItems.suggestions.some((item: any) => item.label === 'CALL')).toBe(true);

    editorState.value = 'CALL codex_tmp';
    editorState.latestOnChange?.(editorState.value);
    const routineItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const procedureSuggestion = routineItems.suggestions.find((item: any) => item.label === 'codex_tmp_proc_link_test');
    const functionSuggestion = routineItems.suggestions.find((item: any) => item.label === 'codex_tmp_score_user');

    expect(procedureSuggestion).toMatchObject({
      kind: 2,
      insertText: 'codex_tmp_proc_link_test($0)',
      detail: '存储过程 (main)',
    });
    expect(String(procedureSuggestion?.sortText || '')).toMatch(/^00/);
    expect(functionSuggestion).toBeUndefined();

    editorState.value = 'SELECT codex_tmp';
    editorState.latestOnChange?.(editorState.value);
    const expressionRoutineItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const expressionFunctionSuggestion = expressionRoutineItems.suggestions.find((item: any) => item.label === 'codex_tmp_score_user');
    expect(expressionFunctionSuggestion).toMatchObject({
      kind: 2,
      insertText: 'codex_tmp_score_user($0)',
      detail: '函数 (main)',
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('quotes uppercase postgres table names in FROM completion insert text', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Table: 'public.MyTable' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM My';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const match = result.suggestions.find((item: any) => item.label === 'MyTable');

    expect(match?.insertText).toBe('"MyTable" AS mt');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('quotes uppercase postgres table names after schema qualifiers in completion insert text', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Table: 'public.MyTable' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM public.';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const match = result.suggestions.find((item: any) => item.label === 'MyTable');

    expect(match?.insertText).toBe('"MyTable" AS mt');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('quotes uppercase postgres column names in completion insert text', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Table: 'public.MyTable' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'public.MyTable', name: 'DisplayName', type: 'text' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT Dis FROM public."MyTable"';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: 'SELECT Dis'.length + 1 });
    const match = result.suggestions.find((item: any) => item.label === 'DisplayName');

    expect(match?.insertText).toBe('"DisplayName"');

    await act(async () => {
      renderer.unmount();
    });
  });
});
