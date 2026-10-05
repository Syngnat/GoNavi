import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogs } from '../i18n/catalog';
import QueryEditor from './QueryEditor';
import QueryEditorToolbar from './QueryEditorToolbar';
import {
    create,
    storeState,
    backendApp,
    messageApi,
    autoFetchState,
    antdSelectState,
    editorState,
    textContent,
    findButton,
    findSqlCompletionProvider,
    createTab,
    createDefaultConnections,
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

  it('renders fallback table metadata for a cross-line source missing from the current database', async () => {
    editorState.value = 'SELECT *\nFROM\n  test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'other_table' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(3);
    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 3, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
    expect(metadataHover?.contents?.[0]?.value).toContain('库：`main`');
  });

  it('renders fallback table metadata while current-database metadata is still loading', async () => {
    editorState.value = 'SELECT *\nFROM\n  test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    let resolveTables!: (value: any) => void;
    backendApp.DBGetTables.mockImplementation(() => new Promise((resolve) => {
      resolveTables = resolve;
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(3);
    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 3, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
    expect(metadataHover?.contents?.[0]?.value).toContain('库：`main`');

    resolveTables({ success: true, data: [] });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    renderer.unmount();
  });

  it('loads DDL from an inferred table source while table metadata is unavailable', async () => {
    editorState.value = 'SELECT *\nFROM test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE test_users (id BIGINT PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 15 },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'test_users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE test_users');
  });

  it('preserves a quoted dot inside an inferred table name for DDL lookup', async () => {
    editorState.value = 'SELECT * FROM `Sales.Data`';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE `Sales.Data` (id BIGINT PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      '`Sales.Data`',
    );
  });

  it('keeps PostgreSQL quoted table names case-sensitive in the DDL hover cache', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'SELECT * FROM "Users"';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockImplementation(async (_config: unknown, _dbName: string, tableName: string) => ({
      success: true,
      data: tableName === '"Users"'
        ? 'CREATE TABLE "Users" (upper_id BIGINT PRIMARY KEY)'
        : 'CREATE TABLE "users" (lower_id BIGINT PRIMARY KEY)',
    }));

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    const upperCaseHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(upperCaseHover?.contents?.[0]?.value).toContain('upper_id');

    editorState.value = 'SELECT * FROM "users"';
    const lowerCaseHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(lowerCaseHover?.contents?.[0]?.value).toContain('lower_id');
    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'postgres' }),
      'main',
      '"Users"',
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'postgres' }),
      'main',
      '"users"',
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
  });

  it('loads hover metadata for a connection-scoped SQLite tab with no database name', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Table: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: '' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), '');
    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(expect.anything(), '', 'users');
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
  });

  it('keeps SQLite main.table hover metadata in the empty database context', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    editorState.value = 'SELECT * FROM main.users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Table: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: '' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), '');
    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(expect.anything(), '', 'main.users');
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
  });

  it('keeps an explicitly cleared SQLite context when the tab snapshot still has an old database', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Table: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'stale-db' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const toolbar = renderer.root.findByType(QueryEditorToolbar);
    await act(async () => {
      toolbar.props.onDatabaseChange('');
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenLastCalledWith(expect.anything(), '', 'users');
    renderer.unmount();
  });

  it('lazy-loads SQLite table completion when the connection has no database name', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    editorState.value = 'SELECT * FROM us';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [{ Table: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: '' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();
    const completion = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), '');
    expect(completion.suggestions.map((item: any) => item.label)).toContain('users');
    renderer.unmount();
  });

  it('preserves the selected PostgreSQL schema when inferred DDL loads without table metadata', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'SELECT *\nFROM users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE sales.users (id BIGINT PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: editorState.value,
        dbName: 'main',
        schemaName: 'sales',
      })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 10 },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'sales.users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE sales.users');
  });

  it('drops a delayed inferred DDL hover when the selected PostgreSQL schema changes', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation((_config: unknown, _dbName: string, sql: string) => {
      const normalizedSql = String(sql || '').toLowerCase();
      if (normalizedSql.includes('current_schema()')) {
        return Promise.resolve({ success: true, data: [{ schema_name: 'public' }] });
      }
      if (normalizedSql.includes('pg_namespace')) {
        return Promise.resolve({
          success: true,
          data: [{ schema_name: 'public' }, { schema_name: 'sales' }],
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    let resolveOldDdl!: (result: { success: boolean; data: string }) => void;
    backendApp.DBShowCreateTable
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldDdl = resolve;
      }))
      .mockResolvedValueOnce({
        success: true,
        data: 'CREATE TABLE sales.users (id BIGINT PRIMARY KEY, email TEXT)',
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        dbName: 'main',
      })} />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    const schemaSelect = () => [...antdSelectState.props].reverse().find((props) => (
      String(props.className || '').includes('gn-v2-query-toolbar-schema-select')
      || props['aria-label'] === catalogs['zh-CN']['query_editor.object_info.label.schema']
    ));
    const pendingDdlHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'public.users',
    );

    await act(async () => {
      schemaSelect()?.onChange('sales');
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(schemaSelect()?.value).toBe('sales');
    resolveOldDdl({ success: true, data: 'CREATE TABLE public.users (id BIGINT PRIMARY KEY)' });
    await expect(pendingDdlHover).resolves.toBeNull();

    const refreshedDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'sales.users',
    );
    expect(refreshedDdlHover?.contents?.[0]?.value).toContain('CREATE TABLE sales.users');
    renderer.unmount();
  });

  it('does not render a delayed DDL hover after a successful table alteration', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    // ALTER 成功后触发元数据重载，库/表元数据需持续返回
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let resolveDdl!: (result: { success: boolean; data: string }) => void;
    backendApp.DBShowCreateTable.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDdl = resolve;
    }));
    backendApp.DBQueryMulti.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pendingDdlHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN email VARCHAR(128)';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    let staleDdlHover: any;
    await act(async () => {
      resolveDdl({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY)' });
      staleDdlHover = await pendingDdlHover;
    });

    expect(staleDdlHover).toBeNull();
  });

  it('does not accept an old DDL hover after the database context makes a round trip', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'other' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'users' }] : [],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let resolveOldDdl!: (result: { success: boolean; data: string }) => void;
    backendApp.DBShowCreateTable
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldDdl = resolve;
      }))
      .mockResolvedValue({
        success: true,
        data: 'CREATE TABLE users (id BIGINT PRIMARY KEY, fresh_flag BOOLEAN)',
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const pendingDdlHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'other' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    resolveOldDdl({ success: true, data: 'CREATE TABLE users (id BIGINT PRIMARY KEY, stale_flag BOOLEAN)' });
    await expect(pendingDdlHover).resolves.toBeNull();

    const freshDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
    expect(freshDdlHover?.contents?.[0]?.value).toContain('fresh_flag');
    expect(freshDdlHover?.contents?.[0]?.value).not.toContain('stale_flag');
    renderer.unmount();
  });

  it('refreshes the DDL hover after an unconfirmed failed schema statement', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    // ALTER 失败但结果不确定时仍会触发元数据重载，库/表元数据需持续返回
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY)' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, email VARCHAR(128))' });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      partial: true,
      executedCount: 0,
      message: 'connection closed after execution',
      data: [],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN email VARCHAR(128)';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    editorState.value = 'SELECT * FROM users';
    const refreshedDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
    expect(refreshedDdlHover?.contents?.[0]?.value).toContain('email VARCHAR(128)');
  });

  it('treats a rejected schema execution transport as unknown and refreshes metadata', async () => {
    editorState.value = 'ALTER TABLE users ADD COLUMN transport_flag TINYINT';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMulti.mockRejectedValueOnce(new Error('connection closed after execution'));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: editorState.value.length + 1,
      positionLineNumber: 1,
      positionColumn: editorState.value.length + 1,
    };

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:sidebar-database-refresh',
    }));
    expect(textContent(renderer.toJSON())).toContain('connection closed after execution');
    renderer.unmount();
  });

  it('reloads query editor metadata after a schema refresh event', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    let resolveRefreshedTables!: (value: any) => void;
    const refreshedTables = new Promise((resolve) => {
      resolveRefreshedTables = resolve;
    });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockImplementationOnce(() => refreshedTables);
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    // beforeEach 的 window 桩不会真正传播事件；本测试需要 sidebar 刷新事件触达编辑器监听器
    const baseWindow: any = window;
    const refreshEventListeners: Array<(event: Event) => void> = [];
    vi.stubGlobal('window', {
      ...baseWindow,
      addEventListener: (type: string, handler: (event: Event) => void) => {
        if (type === 'gonavi:sidebar-database-refresh') refreshEventListeners.push(handler);
        baseWindow.addEventListener?.(type, handler);
      },
      removeEventListener: (type: string, handler: (event: Event) => void) => {
        const index = refreshEventListeners.indexOf(handler);
        if (index >= 0) refreshEventListeners.splice(index, 1);
        baseWindow.removeEventListener?.(type, handler);
      },
      dispatchEvent: (event: Event) => {
        if (event?.type === 'gonavi:sidebar-database-refresh') {
          refreshEventListeners.slice().forEach((handler) => handler(event));
        }
        return true;
      },
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const initialMetadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(initialMetadataHover?.contents?.[0]?.value).toContain('**表** `users`');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-database-refresh', {
        detail: { connectionId: 'conn-1', dbName: 'main' },
      }));
    });

    // 结构变更一旦被确认，旧 metadata 不能继续被 hover 使用；新请求尚在飞行中时只允许基础兜底信息。
    const pendingMetadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(pendingMetadataHover?.contents?.[0]?.value).toContain('**表** `users`');
    expect(pendingMetadataHover?.contents?.[0]?.value).toContain('库：`main`');

    await act(async () => {
      resolveRefreshedTables({ success: true, data: [] });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    });

    const refreshedMetadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(refreshedMetadataHover?.contents?.[0]?.value).toContain('**表** `users`');
    expect(refreshedMetadataHover?.contents?.[0]?.value).toContain('库：`main`');
  });

  it('reloads an inactive query editor when its connection schema changes', async () => {
    autoFetchState.visible = true;
    storeState.connections = [
      ...createDefaultConnections(),
      {
        id: 'conn-2',
        name: 'secondary',
        config: {
          type: 'mysql',
          host: '127.0.0.2',
          port: 3306,
          user: 'root',
          password: '',
          database: 'main',
        },
      },
    ];
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    const baseWindow: any = window;
    const refreshEventListeners: Array<(event: Event) => void> = [];
    vi.stubGlobal('window', {
      ...baseWindow,
      addEventListener: (type: string, handler: (event: Event) => void) => {
        if (type === 'gonavi:sidebar-database-refresh') refreshEventListeners.push(handler);
        baseWindow.addEventListener?.(type, handler);
      },
      removeEventListener: (type: string, handler: (event: Event) => void) => {
        const index = refreshEventListeners.indexOf(handler);
        if (index >= 0) refreshEventListeners.splice(index, 1);
        baseWindow.removeEventListener?.(type, handler);
      },
      dispatchEvent: (event: Event) => {
        if (event?.type === 'gonavi:sidebar-database-refresh') {
          refreshEventListeners.slice().forEach((handler) => handler(event));
        }
        return true;
      },
    });

    const renderEditors = (firstActive: boolean) => (
      <>
        <QueryEditor tab={createTab({ id: 'tab-1', connectionId: 'conn-1', query: 'SELECT * FROM users' })} isActive={firstActive} />
        <QueryEditor tab={createTab({ id: 'tab-2', connectionId: 'conn-2', query: 'SELECT * FROM users' })} isActive={!firstActive} />
      </>
    );
    const countConnectionCalls = (host: string) => backendApp.DBGetTables.mock.calls.filter(
      ([config]: any[]) => config?.host === host,
    ).length;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderEditors(true));
    });
    await vi.waitFor(() => {
      expect(countConnectionCalls('127.0.0.1')).toBeGreaterThan(0);
    });

    await act(async () => {
      renderer.update(renderEditors(false));
    });
    await vi.waitFor(() => {
      expect(countConnectionCalls('127.0.0.2')).toBeGreaterThan(0);
    });
    const initialFirstConnectionCalls = countConnectionCalls('127.0.0.1');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-database-refresh', {
        detail: { connectionId: 'conn-1', dbName: 'main' },
      }));
    });
    const activeConnectionHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(activeConnectionHover?.contents?.[0]?.value).toContain('**表** `users`');

    await act(async () => {
      renderer.update(renderEditors(true));
    });
    await vi.waitFor(() => {
      expect(countConnectionCalls('127.0.0.1')).toBeGreaterThan(initialFirstConnectionCalls);
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('restores an edited trigger when the replacement fails after DROP', async () => {
    const triggerRollbackSql = 'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.updated_at = NOW();';
    editorState.value = [
      '-- trigger replacement',
      'DROP TRIGGER IF EXISTS `users_bi`;',
      'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW BEGIN',
      '  SET NEW.updated_at = CURRENT_TIMESTAMP;',
      'END;',
    ].join('\n');
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: editorState.value.split('\n')[editorState.value.split('\n').length - 1]!.length + 1,
    };
    autoFetchState.visible = true;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'replacement failed',
      executedCount: 1,
      failedIndex: 2,
      data: [],
    });
    backendApp.DBQueryAudited.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        queryMode: 'object-edit',
        triggerRollbackSql,
      })} isActive />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryAudited).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'main',
      triggerRollbackSql,
      'table_designer',
    );
    const refreshEvents = (window.dispatchEvent as any).mock.calls.filter(
      ([event]: any[]) => event?.type === 'gonavi:sidebar-database-refresh',
    );
    expect(refreshEvents).toHaveLength(2);
  });

  it('blocks a trigger object edit that drops the original without a replacement CREATE', async () => {
    editorState.value = [
      '-- trigger replacement',
      'DROP TRIGGER IF EXISTS `users_bi`;',
      'SELECT 1;',
    ].join('\n');
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: editorState.value.split('\n')[2]!.length + 1,
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        queryMode: 'object-edit',
        triggerName: 'users_bi',
        triggerRollbackSql: 'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.id = 1;',
      })} isActive />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(messageApi.error).toHaveBeenCalledWith(expect.stringContaining('CREATE TRIGGER'));
    renderer.unmount();
  });

  it('restores an edited trigger when a setup statement fails before the replacement CREATE', async () => {
    storeState.connections[0].config.type = 'postgres';
    const triggerRollbackSql = 'CREATE TRIGGER users_bi BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_bi_fn();';
    editorState.value = [
      '-- trigger replacement',
      'DROP TRIGGER IF EXISTS users_bi ON users;',
      'CREATE FUNCTION users_bi_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
      'CREATE TRIGGER users_bi BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_bi_fn();',
    ].join('\n');
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: editorState.value.split('\n')[3]!.length + 1,
    };
    autoFetchState.visible = true;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'function replacement failed',
      executedCount: 1,
      failedIndex: 3,
      data: [],
    });
    backendApp.DBQueryAudited.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        queryMode: 'object-edit',
        triggerRollbackSql,
      })} isActive />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryAudited).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      triggerRollbackSql,
      'table_designer',
    );
    renderer.unmount();
  });

  it('does not restore an edited trigger when the replacement outcome is unknown', async () => {
    const triggerRollbackSql = 'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.updated_at = NOW();';
    editorState.value = [
      '-- trigger replacement',
      'DROP TRIGGER IF EXISTS `users_bi`;',
      'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.updated_at = CURRENT_TIMESTAMP;',
    ].join('\n');
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: editorState.value.split('\n')[2]!.length + 1,
    };
    autoFetchState.visible = true;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'connection lost after dispatch',
      executedCount: 1,
      failedIndex: 2,
      outcomeUnknown: true,
      data: [],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        queryMode: 'object-edit',
        triggerRollbackSql,
      })} isActive />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryAudited).not.toHaveBeenCalledWith(
      expect.anything(),
      'main',
      triggerRollbackSql,
      'table_designer',
    );
  });

  it('does not restore a trigger when a later statement fails after replacement', async () => {
    const triggerRollbackSql = 'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.updated_at = NOW();';
    editorState.value = [
      '-- trigger replacement',
      'DROP TRIGGER IF EXISTS `users_bi`;',
      'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.updated_at = CURRENT_TIMESTAMP;',
      'SELECT * FROM missing_table;',
    ].join('\n');
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: editorState.value.split('\n')[3]!.length + 1,
    };
    autoFetchState.visible = true;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'table does not exist',
      executedCount: 2,
      failedIndex: 3,
      data: [],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        queryMode: 'object-edit',
        triggerRollbackSql,
      })} isActive />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryAudited).not.toHaveBeenCalledWith(
      expect.anything(),
      'main',
      triggerRollbackSql,
      'table_designer',
    );
  });

  it('keeps multiline table-source resolution after the hover document limit', async () => {
    const padding = '-- padding for a large SQL document\n'.repeat(6_000);
    editorState.value = `${padding}SELECT *\nFROM\n  test`;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'test' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'test' }] : [],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'main');
    });

    const hover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 6_003, column: 7 },
    );
    expect(hover?.contents?.[0]?.value).toContain('**表** `test`');
    expect(hover?.contents?.[0]?.value).not.toContain('**数据库** `test`');
  });
});
