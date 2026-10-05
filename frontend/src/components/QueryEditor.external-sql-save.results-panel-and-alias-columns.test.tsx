import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveNewQueryContext } from '../utils/newQueryContext';
import QueryEditor from './QueryEditor';
import QueryEditorToolbar from './QueryEditorToolbar';
import {
    create,
    storeState,
    backendApp,
    dataGridState,
    autoFetchState,
    monacoEditorMockState,
    editorState,
    textContent,
    findSqlLogTab,
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

  it('shows the query results panel with the shortcut after manually hiding it', async () => {


    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    await act(async () => {
      findButton(renderer, '结果').props.onClick();
    });
    await act(async () => {
      findButton(renderer, '隐藏').props.onClick();
    });
    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');

    const FakeNode = class {};
    const bodyNode = new FakeNode();
    const documentElement = new FakeNode();
    vi.stubGlobal('Node', FakeNode);
    vi.stubGlobal('document', {
      body: bodyNode,
      documentElement,
    });
    editorState.hasTextFocus = false;
    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const toggleEvent = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: true,
      key: 'm',
      target: bodyNode,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(toggleEvent));
    });

    expect(toggleEvent.preventDefault).toHaveBeenCalled();
    expect(findSqlLogTab(renderer)).toHaveLength(1);
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: true,
    });

    renderer.unmount();
  });

  it('opens the embedded sql execution log tab from the shared log event in v2', async () => {

    storeState.sqlLogs = [{
      id: 'log-1',
      timestamp: Date.now(),
      sql: 'select 1',
      status: 'success',
      duration: 12,
    }];

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    expect(findSqlLogTab(renderer)).toHaveLength(0);

    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener());
    });

    expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      resultPanelVisible: true,
    });

    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener());
    });

    expect(findSqlLogTab(renderer)).toHaveLength(0);
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: false,
    });

    renderer.unmount();
  });

  it('keeps the embedded sql execution log tab open for explicit open events in v2', async () => {

    storeState.sqlLogs = [{
      id: 'log-1',
      timestamp: Date.now(),
      sql: 'select 1',
      status: 'success',
      duration: 12,
    }];

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const openEvent = new CustomEvent('gonavi:show-sql-execution-log', { detail: { mode: 'open' } });
    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener(openEvent));
    });
    expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');

    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener(openEvent));
    });
    expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: true,
    });

    renderer.unmount();
  });

  it('shows execution failures inside the embedded sql log tab in v2', async () => {

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'driver exploded',
      data: [],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer.toJSON());
    expect(rendered).toContain('SQL 执行日志');
    expect(rendered).toContain('driver exploded');
    expect(renderer.root.findAll((node) => node.props?.['data-log-panel'] === 'embedded')).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__')).toHaveLength(1);

    renderer.unmount();
  });

  it.each(['sqlite', 'clickhouse', 'mongodb'])(
    'activates the data result tab and requests data preview for %s after the sql log tab was open',
    async (dbType) => {

      storeState.connections[0].config.type = dbType;
      storeState.sqlLogs = [{
        id: 'log-1',
        timestamp: Date.now(),
        sql: 'select old',
        status: 'success',
        duration: 12,
      }];
      backendApp.DBGetColumns.mockResolvedValue({
        success: true,
        data: [{ name: 'id', key: 'PRI' }],
      });
      backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
      if (dbType === 'mongodb') {
        backendApp.DBQueryWithCancel.mockResolvedValue({
          success: true,
          data: [{ id: 1, name: 'alpha' }],
          fields: ['id', 'name'],
        });
      } else {
        backendApp.DBQueryMulti.mockResolvedValue({
          success: true,
          data: [{
            columns: ['id', 'name'],
            rows: [{ id: 1, name: 'alpha' }],
            statementIndex: 1,
          }],
        });
      }

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        }),
        cancelAnimationFrame: vi.fn(),
        innerHeight: 900,
      });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({
          query: 'SELECT * FROM users',
        })} />);
      });

      const openEvent = new CustomEvent('gonavi:show-sql-execution-log', { detail: { mode: 'open' } });
      await act(async () => {
        windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener(openEvent));
      });
      expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');
      dataGridState.latestProps = null;

      await act(async () => {
        await findButton(renderer, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(textContent(renderer.toJSON())).toContain('结果 1');
      expect(dataGridState.latestProps?.columnNames).toEqual(['id', 'name']);
      expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ id: 1, name: 'alpha' });
      expect(dataGridState.latestProps?.initialViewMode).toBe('table');
      expect(dataGridState.latestProps?.initialViewModeScope).toBe('local');
      const firstDataPreviewRequestId = dataGridState.latestProps?.initialViewModeRequestId;
      expect(firstDataPreviewRequestId).toEqual(expect.any(String));

      await act(async () => {
        await findButton(renderer, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dataGridState.latestProps?.initialViewMode).toBe('table');
      expect(dataGridState.latestProps?.initialViewModeScope).toBe('local');
      expect(dataGridState.latestProps?.initialViewModeRequestId).toEqual(expect.any(String));
      expect(dataGridState.latestProps?.initialViewModeRequestId).not.toBe(firstDataPreviewRequestId);

      const secondDataPreviewRequestId = dataGridState.latestProps?.initialViewModeRequestId;
      if (dbType === 'mongodb') {
        backendApp.DBQueryWithCancel.mockResolvedValueOnce({
          success: true,
          data: [],
          fields: [],
        });
      } else {
        backendApp.DBQueryMulti.mockResolvedValueOnce({
          success: true,
          data: [{ columns: [], rows: [], statementIndex: 1 }],
        });
      }

      await act(async () => {
        await findButton(renderer, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dataGridState.latestProps?.columnNames).toEqual([]);
      expect(dataGridState.latestProps?.data).toEqual([]);
      expect(dataGridState.latestProps?.initialViewMode).toBe('table');
      expect(dataGridState.latestProps?.initialViewModeScope).toBe('local');
      expect(dataGridState.latestProps?.initialViewModeRequestId).toEqual(expect.any(String));
      expect(dataGridState.latestProps?.initialViewModeRequestId).not.toBe(secondDataPreviewRequestId);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it('keeps query result panel visibility isolated per tab', async () => {

    storeState.queryOptions.showQueryResultsPanel = false;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ id: 'tab-1', resultPanelVisible: false })} />);
    });
    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ id: 'tab-2', resultPanelVisible: true })} />);
    });

    expect(findSqlLogTab(renderer)).toHaveLength(1);

    renderer.unmount();
  });

  it('registers all SQL completion providers in the disposable singleton state', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    const completionState = (globalThis as any).__gonaviSqlCompletionState;

    expect(editorState.hoverProviderLanguages).toEqual(['sql', 'mysql', 'sql', 'mysql']);
    expect(editorState.hoverProviderRegistrationKinds).toEqual(['ddl', 'ddl', 'metadata', 'metadata']);
    expect(editorState.providerLanguages).toEqual(['sql', 'mysql', 'sql', 'mysql', 'sql', 'mysql']);
    expect(editorState.hoverProviders).toHaveLength(4);
    expect(editorState.providers).toHaveLength(6);
    expect(completionState.disposables).toHaveLength(10);

    await act(async () => {
      renderer.unmount();
    });
  });

  it.each([
    ['mysql', 'mysql'],
    ['mariadb', 'mysql'],
    ['postgres', 'sql'],
  ])('uses the %s connection grammar before formatting SQL', async (dbType, expectedLanguage) => {
    storeState.connections[0].config.type = dbType;
    const initialSql = "update finan_ set openid = 'ol_' where pay_status = '0' limit 50";

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: initialSql })} />);
    });

    expect(monacoEditorMockState.latestProps).toMatchObject({
      defaultValue: initialSql,
      language: expectedLanguage,
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps plain typing out of SQL completion trigger characters', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));

    expect(sqlProvider).toBeTruthy();
    expect(sqlProvider.triggerCharacters).toEqual(['.']);
    expect(sqlProvider.triggerCharacters).not.toContain('s');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('drops cancelled SQL completion requests while the user keeps typing', async () => {
    let renderer!: ReactTestRenderer;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'session_log' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM ss';
    editorState.position = { lineNumber: 1, column: editorState.value.length + 1 };
    editorState.latestOnChange?.(editorState.value);

    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      editorState.position,
      undefined,
      { isCancellationRequested: true },
    );

    expect(result.suggestions).toEqual([]);
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('syncs a cleared database to the active context when the toolbar switches connections', async () => {
    storeState.connections = [
      ...createDefaultConnections(),
      {
        id: 'conn-2',
        name: 'analytics',
        config: {
          type: 'mysql',
          host: '127.0.0.2',
          port: 3306,
          user: 'root',
          password: '',
          database: '',
        },
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ connectionId: 'conn-1', dbName: 'main' })} />);
    });

    const toolbar = renderer.root.findByType(QueryEditorToolbar);
    await act(async () => {
      toolbar.props.onConnectionChange('conn-2');
    });

    expect(storeState.setActiveContext).toHaveBeenLastCalledWith({
      connectionId: 'conn-2',
      dbName: '',
    });
    expect(storeState.activeContext).toEqual({ connectionId: 'conn-2', dbName: '' });
    expect(resolveNewQueryContext({
      sidebarContext: storeState.activeContext,
      activeTab: createTab({ connectionId: 'conn-1', dbName: 'main' }),
      validConnectionIds: new Set(storeState.connections.map((connection) => connection.id)),
    })).toEqual({ connectionId: 'conn-2', dbName: '' });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('loads table completions after selecting a database in a connection-scoped query tab', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'information_schema' }, { Database: 'main' }] });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main'
        ? [{ Tables_in_main: 'organization' }]
        : [{ Tables_in_database_a: 'legacy_table' }],
    }));
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(
        <>
          <QueryEditor tab={createTab({ id: 'old-tab', dbName: 'database_a' })} isActive={false} />
          <QueryEditor tab={createTab({ dbName: '', query: '' })} isActive />
        </>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();

    let immediateCompletion!: Promise<any>;
    await act(async () => {
      const activeToolbar = renderer.root.findAllByType(QueryEditorToolbar).find((toolbar) => toolbar.props.currentDb === '');
      expect(activeToolbar).toBeTruthy();
      activeToolbar!.props.onDatabaseChange('main');

      editorState.value = 'SELECT * FROM org';
      editorState.latestOnChange?.(editorState.value);
      immediateCompletion = sqlProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      await immediateCompletion;
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'main');
    });
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', expect.objectContaining({
      dbName: 'main',
    }));
    expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'main' });

    const result = await immediateCompletion;

    expect(result.suggestions.map((item: any) => item.label)).toContain('organization');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps the database empty after loading options for a connection-scoped query tab', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'information_schema' }, { Database: 'main' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: '', query: '' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', expect.objectContaining({
      dbName: '',
    }));
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('suggests Oracle views after their metadata has loaded', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'APP';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'APP' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (String(sql || '').includes('USER_VIEWS') || String(sql || '').includes('ALL_VIEWS')) {
        return { success: true, data: [{ view_name: 'PERSON_VIEW', schema_name: 'APP' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'APP' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM person';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(result.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'PERSON_VIEW',
        insertText: 'PERSON_VIEW',
        detail: '视图 (APP)',
      }),
    ]));
    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not repeat an Oracle view owner across users and de-duplicates its result columns', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'B';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'B' }, { Database: 'A' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'A'
        ? [
          { tableName: 'V_PERSON', name: 'ID', type: 'NUMBER' },
          { tableName: 'V_PERSON', name: 'NAME', type: 'VARCHAR2' },
          { tableName: 'V_PERSON', name: 'NAME', type: 'VARCHAR2' },
        ]
        : [],
    }));
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/ALL_VIEWS/i.test(sql) && /OWNER = 'A'/i.test(sql)) {
        return { success: true, data: [{ schema_name: 'A', view_name: 'V_PERSON' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM A.V_PERSON v', dbName: 'B' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 48; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM A.V';
    editorState.latestOnChange?.(editorState.value);
    const viewItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(viewItems.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'V_PERSON',
        insertText: 'V_PERSON',
        detail: '视图 (A)',
      }),
    ]));
    expect(viewItems.suggestions.some((item: any) => item.label === 'A.V_PERSON')).toBe(false);

    editorState.value = 'SELECT v. FROM A.V_PERSON v';
    editorState.latestOnChange?.(editorState.value);
    const columnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT v.'.length + 1 },
    );
    expect(columnItems.suggestions.filter((item: any) => item.label === 'ID')).toHaveLength(1);
    expect(columnItems.suggestions.filter((item: any) => item.label === 'NAME')).toHaveLength(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not attribute Oracle USER metadata to a different selected owner', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'B';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'B' }, { Database: 'A' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/USER_VIEWS/i.test(sql)) {
        return { success: true, data: [{ view_name: 'B_ONLY_VIEW' }] };
      }
      if (/ALL_VIEWS/i.test(sql) && /OWNER = 'A'/i.test(sql)) {
        return { success: true, data: [{ schema_name: 'A', view_name: 'A_VIEW' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM A.A_VIEW', dbName: 'B' })} />);
      for (let i = 0; i < 56; i += 1) await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();
    editorState.value = 'SELECT * FROM A.';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(result.suggestions.map((item: any) => item.label)).toContain('A_VIEW');
    expect(result.suggestions.map((item: any) => item.label)).not.toContain('B_ONLY_VIEW');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps same-name Oracle synonyms scoped by owner and resolves qualified columns', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'A';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'A' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetColumns.mockImplementation(async (_config: any, dbName: string, tableName: string) => {
      if (dbName === 'B' && tableName === 'PERSON') {
        return {
          success: true,
          data: [
            { name: 'ID', type: 'NUMBER' },
            { name: 'NAME', type: 'VARCHAR2' },
          ],
        };
      }
      if (dbName === 'IMP_BASICINFO' && tableName === 'PERSON') {
        return {
          success: true,
          data: [
            { name: 'AC01', type: 'VARCHAR2' },
            { name: 'AC02', type: 'VARCHAR2' },
          ],
        };
      }
      return { success: true, data: [] };
    });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/ALL_SYNONYMS/i.test(sql)) {
        return {
          success: true,
          data: [
            { synonym_owner: 'IMP_BASICINFO', synonym_name: 'PERSON', target_schema_name: 'IMP_DATA', target_name: 'PERSON' },
            { synonym_owner: 'IMP_BASICINFO', synonym_name: 'AC02', target_schema_name: 'IMP_DATA', target_name: 'AC02' },
            { synonym_owner: 'PUBLIC', synonym_name: 'PERSON', target_schema_name: 'PUBLIC_DATA', target_name: 'PERSON' },
            { synonym_owner: 'B', synonym_name: 'PERSON', target_schema_name: 'A', target_name: 'PERSON' },
          ],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'A' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 32; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM per';
    editorState.latestOnChange?.(editorState.value);
    const synonymItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(synonymItems.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'PERSON',
        insertText: 'PERSON',
        detail: '同义词 (A.PERSON)',
      }),
    ]));
    expect(synonymItems.suggestions.filter((item: any) => item.label === 'PERSON')).toHaveLength(1);
    expect(synonymItems.suggestions.some((item: any) => item.label === 'AC02')).toBe(false);
    expect(backendApp.DBQuery).toHaveBeenCalledWith(expect.anything(), 'A', expect.stringMatching(/ALL_SYNONYMS/i));

    editorState.value = 'SELECT p. FROM PERSON p';
    editorState.latestOnChange?.(editorState.value);
    const columnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT p.'.length + 1 },
    );
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'B', 'PERSON');
    expect(columnItems.suggestions.map((item: any) => item.label)).toEqual(expect.arrayContaining(['ID', 'NAME']));

    editorState.value = 'SELECT * FROM IMP_BASICINFO.';
    editorState.latestOnChange?.(editorState.value);
    const ownerItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(ownerItems.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'PERSON',
        detail: '同义词 (IMP_DATA.PERSON)',
      }),
      expect.objectContaining({
        label: 'AC02',
        detail: '同义词 (IMP_DATA.AC02)',
      }),
    ]));

    editorState.value = 'SELECT p. FROM IMP_BASICINFO.PERSON p';
    editorState.latestOnChange?.(editorState.value);
    const ownerColumnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT p.'.length + 1 },
    );
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'IMP_BASICINFO', 'PERSON');
    expect(ownerColumnItems.suggestions.map((item: any) => item.label)).toEqual(expect.arrayContaining(['AC01', 'AC02']));

    await act(async () => {
      renderer.unmount();
    });
  });

  it('loads PostgreSQL alias columns from the current database schema instead of a same-name database', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'appdb';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'appdb' }, { Database: 'billing' }],
    });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'billing.orders' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetColumns.mockImplementation(async (_config: any, dbName: string, tableName: string) => {
      if (dbName === 'appdb' && tableName === 'billing.orders') {
        return { success: true, data: [{ name: 'current_schema_id', type: 'bigint' }] };
      }
      if (dbName === 'billing' && tableName === 'orders') {
        return { success: true, data: [{ name: 'wrong_database_id', type: 'bigint' }] };
      }
      return { success: true, data: [] };
    });
    editorState.value = 'SELECT o. FROM billing.orders o';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'appdb' })} />);
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    const completion = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT o.'.length + 1 },
    );

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'appdb', 'billing.orders');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalledWith(expect.anything(), 'billing', 'orders');
    expect(completion.suggestions.map((item: any) => item.label)).toContain('current_schema_id');
    expect(completion.suggestions.map((item: any) => item.label)).not.toContain('wrong_database_id');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('loads SQLite main.table alias columns through the empty connection scope', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }],
    });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetColumns.mockImplementation(async (_config: any, dbName: string, tableName: string) => (
      dbName === '' && tableName === 'main.users'
        ? { success: true, data: [{ name: 'id', type: 'integer' }] }
        : { success: true, data: [] }
    ));
    editorState.value = 'SELECT u. FROM main.users u';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: '' })} />);
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    const completion = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT u.'.length + 1 },
    );

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), '', 'main.users');
    expect(completion.suggestions.map((item: any) => item.label)).toContain('id');
    await act(async () => {
      renderer.unmount();
    });
  });
});
