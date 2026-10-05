import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import QueryEditor, { resolveQueryEditorNavigationDecorations } from './QueryEditor';
import {
    create,
    storeState,
    runtimeApi,
    notifyStoreSubscribers,
    backendApp,
    messageApi,
    autoFetchState,
    monacoEditorMockState,
    editorState,
    findButton,
    findExactButton,
    findEditorAction,
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

  it('shows link-style hover feedback when ctrl/cmd is pressed over a navigable identifier', async () => {
    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [{ tableName: 'events', name: 'id', type: 'bigint', comment: '事件ID' }] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          ctrlKey: true,
          metaKey: false,
        },
      });
    });

    expect(editorState.editor.deltaDecorations).toHaveBeenCalled();
    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
    expect(lastDecorationCall?.[1]?.[0]?.options?.hoverMessage).toBeUndefined();

    const hover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 27 },
    );
    const hoverText = String(hover?.contents?.[0]?.value || '');
    expect(hoverText.match(/\*\*表\*\*/g)).toHaveLength(1);
    expect(hoverText).toContain('**表** `events`');

    await act(async () => {
      editorState.mouseLeaveListeners[0]?.();
    });
    expect(editorState.domNode.style.cursor).toBe('');
    expect(editorState.editor.updateOptions).toHaveBeenLastCalledWith({ mouseStyle: 'text' });
  });

  it('keeps link-style feedback when modifier state is tracked but mousemove omits ctrl/meta flags', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.editor.deltaDecorations.mockClear();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        type: 'keydown',
        ctrlKey: true,
        metaKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          ctrlKey: false,
          metaKey: false,
        },
      });
    });

    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('opens an object tab when modifier state is tracked but mousedown omits ctrl/meta flags', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
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
      windowListeners.keydown?.forEach((listener) => listener({
        type: 'keydown',
        ctrlKey: true,
        metaKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'mkefu_location_dev_local',
      tableName: 'uk_user',
      initialViewMode: 'fields',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('opens an object tab when mousedown stores ctrl/meta flags on the native browser event', async () => {
    editorState.value = 'SELECT * FROM uk_user';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
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
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          leftButton: true,
          ctrlKey: false,
          metaKey: false,
          browserEvent: {
            button: 0,
            buttons: 1,
            ctrlKey: false,
            metaKey: true,
            preventDefault,
            stopPropagation,
          },
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'mkefu_location_dev_local',
      tableName: 'uk_user',
      initialViewMode: 'fields',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('shows link-style feedback from the current cursor when ctrl/cmd is pressed without moving the mouse', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM uk_user'.length + 1 };
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.editor.deltaDecorations.mockClear();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        ctrlKey: true,
        metaKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
    });

    expect(editorState.editor.deltaDecorations).toHaveBeenCalled();
    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('treats modifier keydown itself as pressed when desktop WebView omits ctrl/meta flags', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM uk_user'.length + 1 };
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.editor.deltaDecorations.mockClear();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        type: 'keydown',
        ctrlKey: false,
        metaKey: false,
        key: 'Meta',
        code: 'MetaLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
    });

    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('shows hover shortcut hints in English for every navigable object kind', () => {
    setCurrentLanguage('en-US');

    const tables = [
      { dbName: 'main', tableName: 'users' },
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
      { dbName: 'main', routineName: 'reporting.score_user', routineType: 'FUNCTION', schemaName: 'reporting' },
    ];
    const sequences = [
      { dbName: 'main', sequenceName: 'billing.order_seq', schemaName: 'billing' },
    ];
    const packages = [
      { dbName: 'main', packageName: 'billing.pkg_order', schemaName: 'billing' },
    ];

    const cases = [
      { lineContent: 'use analytics', column: 6, expected: 'Ctrl + click to switch to this database' },
      { lineContent: 'select * from analytics.events', column: 27, expected: 'Ctrl + click to open this table object design' },
      { lineContent: 'select * from reporting.active_users', column: 31, expected: 'Ctrl + click to open this view' },
      { lineContent: 'select * from analytics.mv_daily_stats', column: 37, expected: 'Ctrl + click to open this materialized view' },
      { lineContent: 'call audit.users_bi()', column: 18, expected: 'Ctrl + click to open this trigger' },
      { lineContent: 'call reporting.refresh_stats()', column: 21, expected: 'Ctrl + click to open this stored procedure' },
      { lineContent: 'select reporting.score_user()', column: 21, expected: 'Ctrl + click to open this function' },
      { lineContent: 'select billing.order_seq.nextval from dual', column: 18, expected: 'Ctrl + click to open this sequence' },
      { lineContent: 'begin billing.pkg_order.sync_order(1); end;', column: 16, expected: 'Ctrl + click to open this package' },
    ];

    for (const testCase of cases) {
      const decorations = resolveQueryEditorNavigationDecorations(
        testCase.lineContent,
        testCase.column,
        'main',
        ['main', 'analytics'],
        tables,
        views,
        materializedViews,
        triggers,
        routines,
        sequences,
        packages,
        'Ctrl',
      );

      expect(decorations).toHaveLength(1);
      expect(decorations[0]?.hoverMessage).toBe(testCase.expected);
      expect(decorations[0]?.hoverMessage).not.toMatch(/[点點]击|打开|切换|数据库|表|视图|触发器|存储过程|函数/);
    }
  });

  it('formats SQL through Monaco edits so beautify can be undone', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select * from users where id=1' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(editorState.editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('SELECT'),
        }),
      ]),
    );
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      formatRestoreSnapshot: {
        query: 'select * from users where id=1',
        createdAt: expect.any(Number),
      },
    });
  });

  it('resets stale horizontal scroll after formatting a long single-line SQL statement', async () => {
    let renderer!: ReactTestRenderer;
    const longSql = `select ${Array.from({ length: 80 }, (_, index) => `column_${index + 1}`).join(', ')} from users where id=1`;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: longSql })} />);
    });

    editorState.scrollLeft = 2400;

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalled();
    expect(editorState.editor.setScrollLeft).toHaveBeenCalledWith(0);
    expect(editorState.scrollLeft).toBe(0);
  });

  it('formats only the selected SQL when a non-empty selection exists', async () => {
    let renderer!: ReactTestRenderer;
    const originalSql = 'select 1; select * from users where id=1';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: originalSql })} />);
    });

    editorState.selection = {
      startLineNumber: 1,
      startColumn: 11,
      endLineNumber: 1,
      endColumn: originalSql.length + 1,
    };

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          range: expect.objectContaining({
            startLineNumber: 1,
            startColumn: 11,
            endLineNumber: 1,
            endColumn: originalSql.length + 1,
          }),
          text: expect.stringContaining('SELECT'),
        }),
      ]),
    );
    expect(editorState.value.startsWith('select 1;')).toBe(true);
    expect(editorState.value).toContain('SELECT');
    expect(editorState.value).not.toBe(originalSql);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      formatRestoreSnapshot: {
        query: originalSql,
        createdAt: expect.any(Number),
      },
    });
  });

  it('registers a configurable Monaco shortcut action for SQL formatting', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select * from users where id=1' })} />);
    });

    const formatAction = findEditorAction('gonavi.formatSql');
    expect(formatAction).toMatchObject({
      id: 'gonavi.formatSql',
      label: 'GoNavi: 美化 SQL',
      keybindings: [512 | 1024 | 70],
    });

    formatAction.run();

    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gonavi:format-active-query' }),
    );
  });

  it('restores the last pre-beautify SQL snapshot after reopening a query tab', async () => {
    let renderer!: ReactTestRenderer;
    const originalSql = 'select * from users where id=1';

    await act(async () => {
      renderer = create(
        <QueryEditor
          tab={createTab({
            query: 'SELECT\n  *\nFROM\n  users\nWHERE\n  id = 1',
            formatRestoreSnapshot: {
              query: originalSql,
              createdAt: 123,
            },
          })}
        />,
      );
    });

    const restoreButton = findButton(renderer, '还原上次美化');
    await act(async () => {
      await restoreButton.props.onClick();
    });

    expect(editorState.value).toBe(originalSql);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      query: originalSql,
      formatRestoreSnapshot: undefined,
    });
    expect(messageApi.success).toHaveBeenCalledWith('已还原到美化前 SQL');
  });

  it('formats OceanBase Oracle SQL with parameter placeholders', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    const oracleSql = 'select * from users where id = #{id,jdbcType=NUMBER} and tenant = ${tenant} and status = :status and code = ?';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: oracleSql, dbName: 'main' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringMatching(/#\{id,jdbcType=NUMBER\}[\s\S]*\$\{tenant\}[\s\S]*:status[\s\S]*\?/),
        }),
      ]),
    );
  });

  it('formats Dameng SQL with positional parameter placeholders', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'dameng';
    const damengSql = 'SELECT COUNT(*) AS total FROM VULNERABILITY_RESOURCE_T WHERE (TASK_ID = ?)';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: damengSql, dbName: 'SLGZT' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('TASK_ID = ?'),
        }),
      ]),
    );
    expect(runtimeApi.LogInfo).toHaveBeenCalledWith(expect.stringMatching(
      /^\[SQL美化\] 成功：language=plsql dbType=dameng driver=\(default\) scope=full sqlLength=\d+ positional=true durationMs=\d+(?:\.\d+)? changed=true$/,
    ));
    const successLog = runtimeApi.LogInfo.mock.calls[runtimeApi.LogInfo.mock.calls.length - 1]?.[0];
    expect(successLog).not.toContain('VULNERABILITY_RESOURCE_T');
  });

  it('logs SQL formatter failures without exposing the SQL text', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'oracle';
    const sensitiveSql = "SELECT * FROM CUSTOMER_SECRET WHERE TOKEN = 'do-not-log' AND ID = ?";

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sensitiveSql, dbName: 'APP' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('格式化失败：SQL 语法可能有误。');
    expect(runtimeApi.LogError).toHaveBeenCalledWith(expect.stringMatching(
      /^\[SQL美化\] 失败：language=plsql dbType=oracle driver=\(default\) scope=full sqlLength=\d+ positional=false durationMs=\d+(?:\.\d+)? error=Parse error:/,
    ));
    const failureLog = String(runtimeApi.LogError.mock.calls[runtimeApi.LogError.mock.calls.length - 1]?.[0] || '');
    expect(failureLog).not.toContain('CUSTOMER_SECRET');
    expect(failureLog).not.toContain('do-not-log');
  });

  it('preserves postgres JSONB question-mark operators while formatting', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    const pgSql = "select * from items where data ?| array['a','b'] and data ?& array['c']";

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: pgSql, dbName: 'main' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("data ?| ARRAY['a', 'b']"),
        }),
      ]),
    );
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("data ?& ARRAY['c']"),
        }),
      ]),
    );
  });

  it('formats postgres window-function SQL with cast syntax through Monaco edits', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    const pgSql = [
      'SELECT',
      `FLOOR(DATE_PART('epoch', "CREATE_TIME" - LAG("END_TIME") OVER (ORDER BY "CREATE_TIME" asc, "ID" desc))*1000)::int as time_diff_seconds,`,
      '*',
      `FROM "FAM_RU_BLOCK" WHERE "RU_JOB_ID" = ''`,
    ].join('\n');

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: pgSql, dbName: 'main' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining(')::int AS time_diff_seconds'),
        }),
      ]),
    );
  });

  it('formats postgres cast syntax after switching to another query tab connection', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections = [
      {
        id: 'conn-1',
        name: 'mysql-local',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          password: '',
          database: 'main',
        },
      },
      {
        id: 'conn-2',
        name: 'pg-local',
        config: {
          type: 'postgres',
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          password: '',
          database: 'main',
        },
      },
    ];
    const pgSql = [
      'SELECT',
      '    *,',
      '    is_del = 0',
      'FROM',
      '    wm_stock',
      'WHERE',
      '    1 = 1',
      '    AND is_del = 0',
      "    and create_date > '2025-06-25'::date;",
    ].join('\n');

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ id: 'tab-1', connectionId: 'conn-1', query: 'select 1;' })} />);
    });

    await act(async () => {
      renderer.update(
        <QueryEditor
          tab={createTab({
            id: 'tab-2',
            connectionId: 'conn-2',
            dbName: 'main',
            query: pgSql,
          })}
        />,
      );
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("'2025-06-25'::date;"),
        }),
      ]),
    );
  });

  it('localizes format settings menu labels in English', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select * from users where id=1' })} />);
    });

    expect(findExactButton(renderer, 'Uppercase keywords')).toBeTruthy();
    expect(findExactButton(renderer, 'Lowercase keywords')).toBeTruthy();
    expect(findExactButton(renderer, 'Snippet settings...')).toBeTruthy();
    expect(findExactButton(renderer, 'Shortcut settings...')).toBeTruthy();
    expect(findExactButton(renderer, '关键字大写')).toBeUndefined();
    expect(findExactButton(renderer, '关键字小写')).toBeUndefined();
    expect(findExactButton(renderer, '代码片段管理...')).toBeUndefined();
    expect(findExactButton(renderer, '快捷键管理...')).toBeUndefined();
  });

  it('persists word wrap and applies it to newly opened SQL editors', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select a_very_long_column_name from a_very_long_table_name' })} />);
    });

    expect(monacoEditorMockState.latestProps.options.wordWrap).toBe('off');
    const enableButton = renderer.root.find((node) => (
      node.type === 'button' && node.props?.['aria-label'] === '开启自动换行'
    ));
    expect(enableButton.props['aria-pressed']).toBe(false);

    await act(async () => {
      enableButton.props.onClick();
      notifyStoreSubscribers();
    });

    expect(storeState.setQueryOptions).toHaveBeenCalledWith({ wordWrap: true });
    expect(monacoEditorMockState.latestProps.options.wordWrap).toBe('on');
    const disableButton = renderer.root.find((node) => (
      node.type === 'button' && node.props?.['aria-label'] === '关闭自动换行'
    ));
    expect(disableButton.props['aria-pressed']).toBe(true);

    await act(async () => {
      renderer.unmount();
      renderer = create(<QueryEditor tab={createTab({ id: 'tab-2', query: 'select 2' })} />);
    });

    expect(monacoEditorMockState.latestProps.options.wordWrap).toBe('on');
    const newEditorDisableButton = renderer.root.find((node) => (
      node.type === 'button' && node.props?.['aria-label'] === '关闭自动换行'
    ));
    expect(newEditorDisableButton.props['aria-pressed']).toBe(true);
  });

  it('shows object info via editor ctrl+q action', async () => {
    editorState.value = 'select users.id from users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const showObjectInfoAction = editorState.editor.addAction.mock.calls
      .map((call: any[]) => call[0])
      .find((action: any) => action?.id === 'gonavi.queryEditor.showObjectInfo');
    expect(showObjectInfoAction).toBeTruthy();

    editorState.position = { lineNumber: 1, column: 13 };
    await act(async () => {
      showObjectInfoAction.run();
    });

    expect(editorState.contentHoverCalls).toHaveLength(1);
    expect(editorState.contentHoverCalls[0]).toEqual(expect.objectContaining({
      mode: 1,
      source: 2,
      focus: false,
    }));
  });

  it('renders SQL metadata hover as a fixed overflow widget below first-line tokens', async () => {
    editorState.value = 'select users.id from users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });

    const initialOptions = editorState.editor.updateOptions.mock.calls[0]?.[0];
    expect(initialOptions).toMatchObject({
      fixedOverflowWidgets: true,
      find: {
        addExtraSpaceOnTop: false,
      },
      hover: {
        enabled: true,
        delay: 1000,
        above: false,
      },
    });
  });

  it('prefers the hovered identifier position for ctrl+q object info', async () => {
    editorState.value = 'select * from user_actions';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'user_actions' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const showObjectInfoAction = editorState.editor.addAction.mock.calls
      .map((call: any[]) => call[0])
      .find((action: any) => action?.id === 'gonavi.queryEditor.showObjectInfo');
    expect(showObjectInfoAction).toBeTruthy();

    editorState.position = { lineNumber: 1, column: 2 };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({ ctrlKey: true, metaKey: false, key: 'Control' }));
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 17 } },
        event: {
          ctrlKey: true,
          metaKey: false,
        },
      });
      showObjectInfoAction.run();
    });

    expect(editorState.contentHoverCalls).toHaveLength(1);
    expect(messageApi.info).not.toHaveBeenCalledWith(expect.objectContaining({
      key: 'gonavi-query-editor-object-info-miss',
    }));
  });

  it('registers SQL case conversion context-menu actions and delegates to Monaco', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    const uppercaseAction = findEditorAction('gonavi.queryEditor.transformToUppercase');
    const lowercaseAction = findEditorAction('gonavi.queryEditor.transformToLowercase');

    expect(uppercaseAction).toMatchObject({
      label: '转大写',
      precondition: '!editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1,
    });
    expect(lowercaseAction).toMatchObject({
      label: '转小写',
      precondition: '!editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2,
    });

    await uppercaseAction.run(editorState.editor);
    await lowercaseAction.run(editorState.editor);

    expect(editorState.editor.getAction).toHaveBeenNthCalledWith(1, 'editor.action.transformToUppercase');
    expect(editorState.editor.getAction).toHaveBeenNthCalledWith(2, 'editor.action.transformToLowercase');
    expect(editorState.transformToUppercaseRun).toHaveBeenCalledOnce();
    expect(editorState.transformToLowercaseRun).toHaveBeenCalledOnce();
  });

  it('registers SQL execution context-menu actions with selection and all scopes', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('gonavi.runSelectedSql')).toMatchObject({
      label: '执行当前选中 SQL',
      precondition: 'editorHasSelection',
      contextMenuGroupId: '0_execution',
      contextMenuOrder: 1,
    });
    expect(findEditorAction('gonavi.runAllSql')).toMatchObject({
      label: '执行所有 SQL',
      contextMenuGroupId: '0_execution',
      contextMenuOrder: 2,
    });
  });

  it('executes selected or full editor SQL from the context-menu actions', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const addEventListener = window.addEventListener as any;
    const removeEventListener = window.removeEventListener as any;
    const dispatchEvent = window.dispatchEvent as any;
    addEventListener.mockImplementation((type: string, listener: (event: Event) => void) => {
      const current = listeners.get(type) ?? new Set<(event: Event) => void>();
      current.add(listener);
      listeners.set(type, current);
    });
    removeEventListener.mockImplementation((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    });
    dispatchEvent.mockImplementation((event: Event) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    });
    backendApp.DBQueryMulti.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'select 1;\nselect 2;',
      })} />);
    });

    const selectedAction = findEditorAction('gonavi.runSelectedSql');
    const allAction = findEditorAction('gonavi.runAllSql');
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2;'.length + 1,
    };

    await act(async () => {
      selectedAction.run(editorState.editor);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 2'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');

    backendApp.DBQueryMulti.mockClear();
    editorState.selection = null;
    await act(async () => {
      allAction.run(editorState.editor);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 1'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 2');
  });
});
