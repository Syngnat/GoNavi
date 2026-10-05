import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import { formatSqlExecutionError } from '../utils/sqlErrorSemantics';
import QueryEditor from './QueryEditor';
import { QUERY_EDITOR_SQL_LOG_TAB_KEY } from './QueryEditorResultsPanel';
import { storeState, backendApp, messageApi, dataGridState, editorState } from './queryEditorResultsAndDropTestState';
import {
    create,
    textContent,
    findButtons,
    findButton,
    findEditorAction,
    createRunShortcutEvent,
    createTab,
} from './queryEditorResultsAndDropTestHelpers';
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

  it('runs the SQL statement at the cursor instead of the whole editor when nothing is selected', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 2, column: 8 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.();
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as two'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('select 2 as two'),
    }));
  });

  it('executes only the statement body when the cursor is on a semicolon after leading comments', async () => {
    const sql = [
      '-- 1856887305879470081',
      '-- 3257969823961465780',
      '-- 3257963896428446491',
      "SELECT * FROM contract WHERE contract_code = 'YEC202608039';",
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'contract_code'],
        rows: [{ id: 1, contract_code: 'YEC202608039' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'contract_code', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: sql })} />);
    });
    editorState.position = { lineNumber: 4, column: sql.split('\n')[3].length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.();
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti.mock.calls[0]?.[2]).toBe(
      "SELECT * FROM contract WHERE contract_code = 'YEC202608039' LIMIT 5000",
    );
    renderer!.unmount();
  });

  it('keeps cursor statement execution available in v2 UI', async () => {

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 2, column: 8 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.();
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as two'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('registers Windows Ctrl+R with Monaco CtrlCmd and runs the selected SQL', async () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Vitest',
    });
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+R' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn((event: Event) => {
        windowListeners[event.type]?.forEach((listener) => listener(event));
        return true;
      }),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['total'], rows: [{ total: 1 }] }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect count(*) as total from messages;\nselect 3;',
      })} />);
    });

    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select count(*) as total from messages'.length + 1,
    };
    const runAction = findEditorAction('gonavi.runQuery');

    await act(async () => {
      await runAction.run();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select count(*) as total from messages'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('runs the cursor SQL from the run shortcut when nothing is selected', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
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

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: editorState.position });
    });
    backendApp.DBQueryMulti.mockClear();

    const event = createRunShortcutEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 2 as two'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('runs selected SQL from the run shortcut', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
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
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });
    editorState.position = { lineNumber: 1, column: 4 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as two'.length + 1,
    };

    const event = createRunShortcutEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as two'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('renders the zero-count V2 SQL log tab for the active non-Chinese language', async () => {

    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ resultPanelVisible: true })} />);
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('Logs0');
    expect(renderer!.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(1);
    expect(renderer!.root.findAll((node) =>
      node.props?.['data-tab-key'] === QUERY_EDITOR_SQL_LOG_TAB_KEY,
    )).toHaveLength(1);
    expect(rendered).not.toContain('日志0');
    await act(async () => {
      renderer!.unmount();
    });
  });

  it('uses the last editor cursor position when the run button takes focus', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 2, column: 'select 2 as b;'.length + 1 } });
    });
    editorState.hasTextFocus = false;
    editorState.position = { lineNumber: 3, column: 'select 3 as c;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
  });

  it('prefers the last editor cursor event even if Monaco still reports text focus', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 2, column: 'select 2 as b;'.length + 1 } });
    });
    editorState.hasTextFocus = true;
    editorState.position = { lineNumber: 3, column: 'select 3 as c;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
  });

  it('uses Monaco active selection position when run button focus drifts onto a blank line', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['b'], rows: [{ b: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\n\nselect 3 as c;',
      })} />);
    });

    editorState.selection = {
      startLineNumber: 2,
      startColumn: 'select 2 as b;'.length + 1,
      endLineNumber: 2,
      endColumn: 'select 2 as b;'.length + 1,
      positionLineNumber: 2,
      positionColumn: 'select 2 as b;'.length + 1,
    };
    editorState.position = { lineNumber: 3, column: 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可执行的 SQL。');
  });

  it('keeps cursor statement execution when CRLF line endings put the cursor after a semicolon', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['b'], rows: [{ b: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\r\nselect 2 as b;\r\n\r\nselect 3 as c;',
      })} />);
    });

    editorState.position = { lineNumber: 2, column: 'select 2 as b;'.length + 1 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 'select 2 as b;'.length + 1,
      endLineNumber: 2,
      endColumn: 'select 2 as b;'.length + 1,
      positionLineNumber: 2,
      positionColumn: 'select 2 as b;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可执行的 SQL。');
  });

  it('executes all SQL when the cursor is on a blank line', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['a'], rows: [{ a: 1 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\n\nselect 3 as c;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select 1 as a;'.length + 1 };
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 'select 1 as a;'.length + 1,
      endLineNumber: 1,
      endColumn: 'select 1 as a;'.length + 1,
      positionLineNumber: 1,
      positionColumn: 'select 1 as a;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, 'Run');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('Result 1');
    backendApp.DBQueryMulti.mockClear();
    messageApi.info.mockClear();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['a'], rows: [{ a: 1 }] }],
    });

    editorState.position = { lineNumber: 3, column: 1 };
    editorState.selection = {
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
      positionLineNumber: 3,
      positionColumn: 1,
    };
    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 3, column: 1 } });
    });

    await act(async () => {
      const runButton = findButton(renderer!, 'Run');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('select 1 as a');
    expect(executedSql).toContain('select 2 as b');
    expect(executedSql).toContain('select 3 as c');
    expect(messageApi.info).not.toHaveBeenCalledWith('No executable SQL.');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可执行的 SQL。');
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
  });

  it('shows "Select a database first." in English before running database-dependent SQL without a database', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: '', query: 'select * from orders;' })} />);
    });

    await act(async () => {
      await findButton(renderer, 'Run').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Select a database first.');
    expect(messageApi.error).not.toHaveBeenCalledWith('请先选择数据库');
  });

  it('shows "Connection not found." in English before running without a matching connection', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    storeState.connections = [];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ connectionId: 'missing', dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, 'Run').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Connection not found.');
    expect(messageApi.error).not.toHaveBeenCalledWith('Connection not found');
  });

  it('shows the unsupported source guard in English before running', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    storeState.connections[0].config.type = 'redis';

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, 'Run').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith(
      'This data source does not support the SQL query editor. Use its dedicated page instead.',
    );
    expect(messageApi.error).not.toHaveBeenCalledWith('当前数据源不支持 SQL 查询编辑器，请使用对应专用页面。');
  });

  describe('execution toast localization', () => {
    it('shows the Mongo multi-statement success toast in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'mongodb';
      const query = 'db.users.find({});\ndb.logs.find({});';
      backendApp.DBQueryWithCancel
        .mockResolvedValueOnce({ success: true, data: [{ _id: 1 }], fields: ['_id'] })
        .mockResolvedValueOnce({ success: true, data: [{ _id: 2 }], fields: ['_id'] });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 'db.logs.find({});'.length + 1,
        positionLineNumber: 2,
        positionColumn: 'db.logs.find({});'.length + 1,
      };

      await act(async () => {
        await findButton(renderer, 'Run').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.success).toHaveBeenCalledWith('Executed 2 statements and produced 2 result sets.');
      expect(messageApi.success).not.toHaveBeenCalledWith('已执行 2 条语句，生成 2 个结果集。');
    });

    it('shows the Mongo multi-statement failure prefix localization in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'mongodb';
      const query = 'db.users.find({});\ndb.logs.find({});';
      backendApp.DBQueryWithCancel
        .mockResolvedValueOnce({ success: true, data: [{ _id: 1 }], fields: ['_id'] })
        .mockResolvedValueOnce({ success: false, message: 'driver exploded' });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 'db.logs.find({});'.length + 1,
        positionLineNumber: 2,
        positionColumn: 'db.logs.find({});'.length + 1,
      };

      await act(async () => {
        await findButton(renderer, 'Run').props.onClick();
      });
      await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer.toJSON());
    expect(rendered).toContain(formatSqlExecutionError('driver exploded', {
      prefix: 'Statement 2 failed:',
    }));
    expect(rendered).not.toContain('第 2 条语句执行失败：driver exploded');
    });

    it('shows the Mongo zero-result success toast in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'mongodb';
      const query = '{"ping":1}';
      backendApp.DBQueryWithCancel.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.position = { lineNumber: 1, column: query.length + 1 };

      await act(async () => {
        await findButton(renderer, 'Run').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.success).toHaveBeenCalledWith('Execution succeeded.');
      expect(messageApi.success).not.toHaveBeenCalledWith('执行成功。');
    });

    it('shows the non-Mongo multi-result success toast in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1 as a; select 2 as b;';
      backendApp.DBQueryMulti.mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['a'], rows: [{ a: 1 }] },
          { columns: ['b'], rows: [{ b: 2 }] },
        ],
      });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
      expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 1 as a');
      expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 2 as b');
      expect(messageApi.success).toHaveBeenCalledWith('Execution finished and produced 2 result sets.');
      expect(messageApi.success).not.toHaveBeenCalledWith('已执行完成，生成 2 个结果集。');
    });

  it('shows the non-Mongo zero-result success toast in English', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    const query = 'update users set active = 1 where 1 = 0;';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({ success: true, data: [] });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

    expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
    expect(String(backendApp.DBQueryMultiTransactional.mock.calls[0][2])).toContain('update users set active = 1 where 1 = 0');
    expect(messageApi.success).toHaveBeenCalledWith('Execution succeeded.');
    expect(messageApi.success).not.toHaveBeenCalledWith('执行成功。');
  });

    it('shows the wrapped execution failure toast in English while preserving raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1;';
      backendApp.DBQueryMulti.mockRejectedValueOnce(new Error('driver exploded'));

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
      expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 1');
      expect(messageApi.error).toHaveBeenCalledWith(`Query execution failed: ${formatSqlExecutionError('driver exploded')}`);
      expect(messageApi.error).not.toHaveBeenCalledWith('Error executing query: driver exploded');
    });
  });

  describe('result refresh toast localization', () => {
    const renderAndRunQuery = async (query: string) => {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dataGridState.latestProps?.onReload).toEqual(expect.any(Function));
    };

    it('shows the response refresh failure toast in English while preserving raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1 as a;';
      backendApp.DBQueryMulti
        .mockResolvedValueOnce({
          success: true,
          data: [{ columns: ['a'], rows: [{ a: 1 }] }],
        })
        .mockResolvedValueOnce({ success: false, message: 'network down' });

      await renderAndRunQuery(query);
      messageApi.error.mockClear();

      await act(async () => {
        await dataGridState.latestProps.onReload();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.error).toHaveBeenCalledWith(`Refresh failed: ${formatSqlExecutionError('network down')}`);
      expect(messageApi.error).not.toHaveBeenCalledWith('刷新失败: network down');
    });

    it('shows the rejected refresh failure toast in English while preserving raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1 as a;';
      backendApp.DBQueryMulti
        .mockResolvedValueOnce({
          success: true,
          data: [{ columns: ['a'], rows: [{ a: 1 }] }],
        })
        .mockRejectedValueOnce(new Error('socket closed'));

      await renderAndRunQuery(query);
      messageApi.error.mockClear();

      await act(async () => {
        await dataGridState.latestProps.onReload();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.error).toHaveBeenCalledWith(`Refresh failed: ${formatSqlExecutionError('socket closed')}`);
      expect(messageApi.error).not.toHaveBeenCalledWith('刷新失败: socket closed');
    });
  });

  it('cancels the pending run before a query id exists', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let resolveQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID.mockReturnValueOnce(new Promise((resolve) => {
      resolveQueryId = resolve;
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      findButton(renderer, 'Run').props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, 'Stop').props.onClick();
    });

    expect(messageApi.success).toHaveBeenCalledWith('Query canceled.');
    expect(messageApi.warning).not.toHaveBeenCalledWith('No running query to cancel.');
    expect(findButtons(renderer, 'Stop')).toHaveLength(0);

    await act(async () => {
      resolveQueryId('query-too-late');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
  });

  it('shows "Query canceled." in English when stop cancels a running query', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    backendApp.GenerateQueryID.mockResolvedValueOnce('query-1');
    backendApp.DBQueryMulti.mockReturnValueOnce(new Promise(() => {}));
    backendApp.CancelQuery.mockResolvedValueOnce({ success: true });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      findButton(renderer, 'Run').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, 'Stop').props.onClick();
    });

    expect(messageApi.success).toHaveBeenCalledWith('Query canceled.');
    expect(messageApi.success).not.toHaveBeenCalledWith('查询已取消');
    expect(findButtons(renderer, 'Stop')).toHaveLength(0);
  });
});
