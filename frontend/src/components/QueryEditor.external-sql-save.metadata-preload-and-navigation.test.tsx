import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor, { resolveQueryEditorNavigationTarget } from './QueryEditor';
import {
    create,
    storeState,
    notifyStoreSubscribers,
    backendApp,
    messageApi,
    autoFetchState,
    editorState,
    findButton,
    findSqlCompletionProvider,
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

  it('preloads metadata only for the current database when many databases are visible', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = '';
    const databaseRows = [
      { Database: 'main' },
      ...Array.from({ length: 40 }, (_, index) => ({ Database: `tenant_${String(index + 1).padStart(3, '0')}` })),
    ];
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: databaseRows });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'users' }] : [{ [`Tables_in_${dbName}`]: 'unexpected_table' }],
    }));
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ tableName: 'users', name: 'id', type: 'bigint' }] : [],
    }));
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM users', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetTables.mock.calls.map((call: any[]) => call[1])).toEqual(['main']);
    expect(backendApp.DBGetAllColumns.mock.calls.map((call: any[]) => call[1])).toEqual(['main']);
    const metadataQueryDbs = new Set(backendApp.DBQuery.mock.calls.map((call: any[]) => call[1]));
    expect([...metadataQueryDbs]).toEqual(['main']);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps an existing query tab on its database when a new pattern hides it from the picker', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'hidden' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select 1;', dbName: 'hidden' })} />);
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      (storeState.connections[0] as any).excludeDatabasePatterns = ['hidden'];
      storeState.connections = [...storeState.connections];
      notifyStoreSubscribers();
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'hidden',
      expect.stringContaining('select 1'),
      'query-1',
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it('suggests columns in WHERE for cross-database MySQL tables with quoted hyphenated database names', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'sanpin' }, { Database: 'ccbim-document-07' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'sanpin') {
        return { success: true, data: [{ Table: 'orders' }] };
      }
      if (dbName === 'ccbim-document-07') {
        return { success: true, data: [{ Table: 'doc' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'sanpin') {
        return {
          success: true,
          data: [{ tableName: 'orders', name: 'id', type: 'bigint' }],
        };
      }
      if (dbName === 'ccbim-document-07') {
        return {
          success: true,
          data: [
            { tableName: 'doc', name: 'node_id', type: 'varchar(64)' },
            { tableName: 'doc', name: 'node_name', type: 'varchar(255)' },
          ],
        };
      }
      return { success: true, data: [] };
    });

    editorState.value = 'SELECT *\nFROM `ccbim-document-07`.doc\nWHERE no';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'sanpin' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 3, column: 'WHERE no'.length + 1 },
    );
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).toContain('node_id');
    expect(labels).toContain('node_name');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('prioritizes SQL keywords for a new statement instead of leaking previous statement columns', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'analytics' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return { success: true, data: [{ Tables_in_main: 'users' }] };
      }
      if (dbName === 'analytics') {
        return { success: true, data: [{ Tables_in_analytics: 'events' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return {
          success: true,
          data: [{ tableName: 'users', name: 'updated_by', type: 'varchar(32)' }],
        };
      }
      if (dbName === 'analytics') {
        return {
          success: true,
          data: [{ tableName: 'events', name: 'update_time', type: 'timestamp' }],
        };
      }
      return { success: true, data: [] };
    });

    editorState.value = 'SELECT *\nFROM analytics.events;\nupdate';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 3, column: 'update'.length + 1 },
    );
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels[0]).toBe('UPDATE');
    expect(labels).not.toContain('update_time');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('limits column completion to tables referenced before the cursor in the current statement', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'analytics' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return { success: true, data: [{ Tables_in_main: 'users' }] };
      }
      if (dbName === 'analytics') {
        return { success: true, data: [{ Tables_in_analytics: 'events' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return {
          success: true,
          data: [{ tableName: 'users', name: 'updated_by', type: 'varchar(32)' }],
        };
      }
      if (dbName === 'analytics') {
        return {
          success: true,
          data: [{ tableName: 'events', name: 'update_time', type: 'timestamp' }],
        };
      }
      return { success: true, data: [] };
    });

    editorState.value = 'SELECT * FROM analytics.events;\nSELECT * FROM main.users WHERE upd';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 'SELECT * FROM main.users WHERE upd'.length + 1 },
    );
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).toContain('updated_by');
    expect(labels).not.toContain('update_time');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps large table and referenced-column completion within a bounded candidate budget', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    const noisyTableRows = Array.from({ length: 2_000 }, (_, index) => ({
      Tables_in_main: `entity_z_archive_${String(index).padStart(4, '0')}`,
    }));
    const noisyColumnRows = Array.from({ length: 2_000 }, (_, index) => ({
      tableName: 'users',
      name: `column_${String(index).padStart(4, '0')}`,
      type: 'varchar(64)',
    }));
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Tables_in_main: 'users' },
        ...noisyTableRows,
        { Tables_in_main: 'entity_primary' },
        { Tables_in_main: 'entity' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [
        ...noisyColumnRows,
        { tableName: 'users', name: 'column_primary', type: 'varchar(64)' },
        { tableName: 'users', name: 'column', type: 'varchar(64)' },
      ],
    });

    editorState.value = 'SELECT * FROM entity';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const tableItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const tableLabels = tableItems.suggestions.map((item: any) => item.label);
    expect(tableLabels).toHaveLength(200);
    expect(tableLabels.slice(0, 2)).toEqual(['entity', 'entity_primary']);

    editorState.value = 'SELECT * FROM users WHERE column';
    const columnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const columnLabels = columnItems.suggestions.map((item: any) => item.label);
    expect(columnLabels).toHaveLength(200);
    expect(columnLabels).toContain('COLUMN');
    expect(columnLabels).toContain('column');
    expect(columnLabels.indexOf('column')).toBeLessThan(columnLabels.indexOf('column_0000'));

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps a late current-database column when other-database candidates fill the budget first', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'otherdb' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main'
        ? [{ Tables_in_main: 'local_table' }]
        : [{ Tables_in_otherdb: 'remote_table' }],
    }));
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'otherdb'
        ? Array.from({ length: 200 }, (_, index) => ({
            tableName: 'remote_table',
            name: `col_other_${String(index).padStart(3, '0')}`,
            type: 'varchar(64)',
          }))
        : [],
    }));
    backendApp.DBGetColumns.mockImplementation(async (_config: any, dbName: string, tableName: string) => ({
      success: true,
      data: dbName === 'main' && tableName === 'local_table'
        ? [{ name: 'col_current_late', type: 'varchar(64)' }]
        : [],
    }));

    editorState.value = [
      'SELECT r.col_other_000',
      'FROM otherdb.remote_table r',
      'JOIN main.local_table l ON r.id = l.id',
      'WHERE col',
    ].join('\n');
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const completionItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 4, column: 'WHERE col'.length + 1 },
    );
    const labels = completionItems.suggestions.map((item: any) => item.label);

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'main', 'local_table');
    expect(labels).toHaveLength(200);
    expect(labels).toContain('col_current_late');
    expect(labels.indexOf('col_current_late')).toBeLessThan(labels.indexOf('col_other_000'));

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps final sortText ordering when an other-database exact match follows 200 current-database prefixes', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'otherdb' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main'
        ? Array.from({ length: 200 }, (_, index) => ({
            Tables_in_main: `tar_current_${String(index).padStart(3, '0')}`,
          }))
        : [{ Tables_in_otherdb: 'seed' }, { Tables_in_otherdb: 'tar' }],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    editorState.value = 'SELECT * FROM otherdb.seed;\nSELECT tar';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const completionItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 'SELECT tar'.length + 1 },
    );
    const labels = completionItems.suggestions.map((item: any) => item.label);

    expect(labels).toHaveLength(200);
    expect(labels).not.toContain('otherdb.tar');
    expect(labels[0]).toBe('tar_current_000');
    expect(labels[199]).toBe('tar_current_199');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('returns no completion for an unmatched known schema qualifier instead of leaking global objects', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Table: 'dbo.users' },
        { Table: 'sales.zzz_candidate' },
        { Table: 'zzz_global' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    editorState.value = 'SELECT * FROM dbo.zzz';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const completionItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(completionItems.suggestions).toEqual([]);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('resolves database and table targets for ctrl/cmd navigation', () => {
    const tables = [
      { dbName: 'main', tableName: 'users' },
      { dbName: 'main', tableName: 'dbo.orders' },
      { dbName: 'analytics', tableName: 'events' },
    ];
    const views = [
      { dbName: 'main', viewName: 'reporting.active_users', schemaName: 'reporting' },
    ];
    const materializedViews = [
      { dbName: 'analytics', viewName: 'mv_daily_stats', schemaName: undefined },
    ];
    const triggers = [
      { dbName: 'main', triggerName: 'audit.users_bi', tableName: 'audit.users', schemaName: 'audit' },
    ];
    const routines = [
      { dbName: 'main', routineName: 'reporting.refresh_stats', routineType: 'PROCEDURE', schemaName: 'reporting' },
    ];
    const sequences = [
      { dbName: 'main', sequenceName: 'billing.order_seq', schemaName: 'billing' },
    ];
    const packages = [
      { dbName: 'main', packageName: 'billing.pkg_order', schemaName: 'billing' },
    ];

    expect(resolveQueryEditorNavigationTarget('select * from analytics.events', 31, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'table',
      dbName: 'analytics',
      tableName: 'events',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('select * from dbo.orders', 21, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'table',
      dbName: 'main',
      tableName: 'dbo.orders',
      schemaName: 'dbo',
    });
    // MySQL 跨库手写 db.table：库不在可见列表时，只要元数据已加载也应可跳转
    expect(resolveQueryEditorNavigationTarget(
      'select * from front_end_sys_new.fs_mkefu_regist_record',
      'select * from front_end_sys_new.fs_mkefu_regist_record'.length,
      'mkefu_test_new',
      ['mkefu_test_new'],
      [
        { dbName: 'mkefu_test_new', tableName: 'uk_back_corp' },
        { dbName: 'front_end_sys_new', tableName: 'fs_mkefu_regist_record' },
      ],
      [],
      [],
      [],
      [],
      [],
      [],
    )).toEqual({
      type: 'table',
      dbName: 'front_end_sys_new',
      tableName: 'fs_mkefu_regist_record',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('use analytics', 6, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'database',
      dbName: 'analytics',
    });
    expect(resolveQueryEditorNavigationTarget('select * from users', 18, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'table',
      dbName: 'main',
      tableName: 'users',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('select * from reporting.active_users', 31, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'view',
      dbName: 'main',
      viewName: 'reporting.active_users',
      schemaName: 'reporting',
    });
    expect(resolveQueryEditorNavigationTarget('select * from analytics.mv_daily_stats', 37, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'materialized-view',
      dbName: 'analytics',
      viewName: 'mv_daily_stats',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('call audit.users_bi()', 18, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'trigger',
      dbName: 'main',
      triggerName: 'audit.users_bi',
      tableName: 'audit.users',
      schemaName: 'audit',
    });
    expect(resolveQueryEditorNavigationTarget('call reporting.refresh_stats()', 21, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'routine',
      dbName: 'main',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
      schemaName: 'reporting',
    });
    expect(resolveQueryEditorNavigationTarget('select billing.order_seq.nextval from dual', 18, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'sequence',
      dbName: 'main',
      sequenceName: 'billing.order_seq',
      schemaName: 'billing',
    });
    expect(resolveQueryEditorNavigationTarget('begin billing.pkg_order.sync_order(1); end;', 16, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'package',
      dbName: 'main',
      packageName: 'billing.pkg_order',
      schemaName: 'billing',
    });
  });

  it('prefers the unique schema-qualified view target when metadata also contains a bare view name', () => {
    const views = [
      { dbName: 'SYSDBA', viewName: 'V_ACCOUNT', schemaName: undefined },
      { dbName: 'SYSDBA', viewName: 'SYSDBA.V_ACCOUNT', schemaName: 'SYSDBA' },
    ];

    expect(resolveQueryEditorNavigationTarget(
      'select * from V_ACCOUNT',
      'select * from V_ACCOUNT'.length + 1,
      'SYSDBA',
      ['SYSDBA'],
      [],
      views,
      [],
      [],
      [],
    )).toEqual({
      type: 'view',
      dbName: 'SYSDBA',
      viewName: 'SYSDBA.V_ACCOUNT',
      schemaName: 'SYSDBA',
    });
  });

  it('opens a table data tab with the embedded object designer on ctrl left click inside the editor', async () => {
    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'analytics', 'events');
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    expect(storeState.addTab).toHaveBeenCalledWith({
      id: 'conn-1-analytics-table-events',
      title: 'events',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'analytics',
      tableName: 'events',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
      returnToTabId: 'tab-1',
    });
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('keeps a MySQL quoted dotted table literal intact during ctrl-click validation', async () => {
    editorState.value = 'select * from `order.items`';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'order.items' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.length } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      '`order.items`',
    );
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      dbName: 'main',
      tableName: 'order.items',
    }));
  });

  it('opens a table data tab with the embedded object designer on macOS cmd click when Monaco omits leftButton', async () => {
    editorState.value = 'select * from fs_mkefu_regist_record;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'fs_mkefu_regist_record' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from fs_mkefu_regist_record'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(
      expect.anything(),
      'mkefu_location_dev_local',
      'fs_mkefu_regist_record',
    );
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'mkefu_location_dev_local',
      tableName: 'fs_mkefu_regist_record',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
      returnToTabId: 'tab-1',
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('locates a table in the sidebar on ctrl/cmd click when configured', async () => {
    storeState.appearance.queryTableCtrlClickAction = 'locate';
    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      await Promise.resolve();
    });

    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
      detail: expect.objectContaining({
        connectionId: 'conn-1',
        dbName: 'analytics',
        tableName: 'events',
        objectGroup: 'tables',
      }),
    }));
    const locateEvent = (window.dispatchEvent as any).mock.calls
      .map(([event]: [CustomEvent]) => event)
      .find((event: CustomEvent) => event?.type === 'gonavi:locate-sidebar-object');
    expect(locateEvent?.detail).not.toHaveProperty('tabId');
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('revalidates fresh table metadata and ignores a stale cmd-click table link', async () => {
    editorState.value = 'select * from customr;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_ai_dev' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_mkefu_ai_dev: 'customr' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_ai_dev' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    backendApp.DBTableExists.mockResolvedValueOnce({ success: true, data: { exists: false } });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    await act(async () => {
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
        event: { ctrlKey: false, metaKey: true },
      });
    });
    expect(editorState.domNode.style.cursor).toBe('pointer');

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'mkefu_ai_dev', 'customr');
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith('表 customr 已不存在，已刷新 SQL 编辑器元数据。');
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(editorState.domNode.style.cursor).toBe('');
    expect(editorState.editor.updateOptions).toHaveBeenLastCalledWith({ mouseStyle: 'text' });

    backendApp.DBGetColumns.mockClear();
    backendApp.DBGetTables.mockClear();
    backendApp.DBTableExists.mockClear();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
  });

  it('does not treat a same-name table in another schema as the deleted navigation target', async () => {
    editorState.value = 'select * from dbo.users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'dbo.users' }, { Table: 'audit.users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBTableExists.mockResolvedValueOnce({ success: true, data: { exists: false } });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from dbo.users'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'dbo.users');
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith('表 dbo.users 已不存在，已刷新 SQL 编辑器元数据。');

    backendApp.DBTableExists.mockClear();
    storeState.addTab.mockClear();
    editorState.value = 'select * from audit.users;';
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from audit.users'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'audit.users');
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      dbName: 'main',
      tableName: 'audit.users',
    }));
  });
});
