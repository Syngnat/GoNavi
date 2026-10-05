import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogs } from '../i18n/catalog';
import { I18nProvider } from '../i18n/provider';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    backendApp,
    dataGridState,
    autoFetchState,
    antdSelectState,
    editorState,
    textContent,
    findSqlLogTab,
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

  it('shows the default SQL template for a fresh blank query tab', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('uses the customized new query template for a fresh blank query tab', async () => {
    storeState.appearance.newQuerySqlTemplate = 'SELECT id,\n       name\nFROM users;';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('SELECT id,\n       name\nFROM users;');
  });

  it('allows a blank new query template when the default content is cleared', async () => {
    storeState.appearance.newQuerySqlTemplate = '';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('');
  });

  it('keeps the query results panel hidden by default on first entry', async () => {


    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <I18nProvider preference="zh-CN" onPreferenceChange={() => undefined}>
          <QueryEditor tab={createTab()} />
        </I18nProvider>,
      );
    });

    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');
  });

  it('renders the v2 SQL toolbar actions as icon-only buttons', async () => {


    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const exactLabels = [
      '运行',
      '保存',
      'AI · 更多',
      '更多',
      '搜索',
      '开启自动换行',
      '美化 SQL',
      '美化 SQL · 设置',
    ];
    const iconOnlyButtons = exactLabels.map((label) => renderer.root.find(
      (node) => node.type === 'button' && node.props?.['aria-label'] === label,
    ));
    iconOnlyButtons.push(renderer.root.find(
      (node) => node.type === 'button'
        && String(node.props?.['aria-label'] || '').startsWith('触发 SQL AI 自动补全'),
    ));

    for (const button of iconOnlyButtons) {
      expect(textContent(button)).toBe('');
      expect(button.props.className).toContain('gn-v2-query-toolbar-icon-action');
    }

    await act(async () => {
      renderer.unmount();
    });
  });

  it('refreshes Elasticsearch index choices and the sidebar after a successful index write', async () => {
    storeState.connections[0].config.type = 'elasticsearch';
    storeState.connections[0].config.port = 9200;
    backendApp.InspectElasticsearchConsole.mockImplementation(
      (_config: unknown, _defaultIndex: string, source: string) => Promise.resolve(
        source === 'GET /'
          ? {
              success: true,
              requests: [{ method: 'GET', path: '/', route: '/', risk: 'read' }],
              containsWrite: false,
              requiresConfirmation: false,
              fingerprint: 'inspect-root',
              serverMajor: 8,
            }
          : {
              success: true,
              requests: [{ method: 'PUT', path: '/events-2026', route: '/{target}', target: 'events-2026', risk: 'dangerous' }],
              containsWrite: true,
              requiresConfirmation: false,
              fingerprint: 'create-events-2026',
              serverMajor: 8,
            },
      ),
    );
    backendApp.ExecuteElasticsearchConsole.mockResolvedValue({
      success: true,
      results: [{
        index: 0,
        method: 'PUT',
        path: '/events-2026',
        requestLabel: 'PUT /events-2026',
        httpStatus: 200,
        rawResponse: '{"acknowledged":true}',
        outcome: 'success',
        readOnly: false,
      }],
    });
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'events-2026' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: '',
        query: 'PUT /events-2026\n{}',
      })} />);
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, '运行当前请求').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(antdSelectState.props.some((props) => (
      Array.isArray(props.options)
      && props.options.some((option: any) => option?.value === 'events-2026')
    ))).toBe(true);
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:sidebar-database-list-refresh',
      detail: expect.objectContaining({
        connectionId: 'conn-1',
        reason: 'elasticsearch-write',
      }),
    }));
  });

  it('loads PostgreSQL schemas and executes SQL with the selected search_path', async () => {
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.port = 5432;
    (storeState.connections[0].config as any).connectionParams = 'application_name=gonavi';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }],
    });
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
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [{ name: 'sales_id', key: 'PRI' }, { name: 'name', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'public.users' }, { Table: 'sales.users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE sales.users(id bigint primary key)',
    });
    backendApp.DBQueryMulti.mockResolvedValue({
      success: true,
      data: [{ columns: ['sales_id', 'name'], rows: [{ sales_id: 1, name: 'Alice' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'SELECT * FROM users',
        schemaName: 'removed_schema',
      })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const latestSchemaSelect = () => [...antdSelectState.props].reverse().find((props) => (
      String(props.className || '').includes('gn-v2-query-toolbar-schema-select')
      || props['aria-label'] === catalogs['zh-CN']['query_editor.object_info.label.schema']
    ));
    expect(latestSchemaSelect()).toMatchObject({
      value: 'removed_schema',
      options: [
        { label: 'removed_schema', value: 'removed_schema', title: '', fullName: 'removed_schema' },
        { label: 'public', value: 'public', title: '', fullName: 'public' },
        { label: 'sales', value: 'sales', title: '', fullName: 'sales' },
      ],
    });

    await act(async () => {
      latestSchemaSelect()?.onChange('sales');
      await Promise.resolve();
      await Promise.resolve();
    });
    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT * FROM users'.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'sales.users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE sales.users');

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    const executionConfig = backendApp.DBQueryMulti.mock.calls[0]?.[0];
    const connectionParams = new URLSearchParams(String(executionConfig?.connectionParams || ''));
    expect(connectionParams.get('application_name')).toBe('gonavi');
    expect(connectionParams.get('search_path')).toBe('"sales","public"');
    const locatorColumnsCall = backendApp.DBGetColumns.mock.calls.find((call) => call[2] === 'users');
    const locatorIndexesCall = backendApp.DBGetIndexes.mock.calls.find((call) => call[2] === 'users');
    expect(new URLSearchParams(String(locatorColumnsCall?.[0]?.connectionParams || '')).get('search_path'))
      .toBe('"sales","public"');
    expect(new URLSearchParams(String(locatorIndexesCall?.[0]?.connectionParams || '')).get('search_path'))
      .toBe('"sales","public"');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['sales_id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['sales_id'],
    });
    const resultConnectionParams = new URLSearchParams(String(
      dataGridState.latestProps?.connectionParamsOverride || '',
    ));
    expect(resultConnectionParams.get('application_name')).toBe('gonavi');
    expect(resultConnectionParams.get('search_path')).toBe('"sales","public"');
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      schemaName: 'sales',
    });

    await act(async () => {
      latestSchemaSelect()?.onChange('public');
    });
    backendApp.DBQueryMulti.mockClear();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['sales_id', 'name'], rows: [{ sales_id: 2, name: 'Bob' }] }],
    });
    await act(async () => {
      await dataGridState.latestProps?.onReload?.();
    });
    const reloadConfig = backendApp.DBQueryMulti.mock.calls[0]?.[0];
    expect(new URLSearchParams(String(reloadConfig?.connectionParams || '')).get('search_path'))
      .toBe('"sales","public"');
  });

  it('does not reload an old database result through the current managed transaction', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 1 }] }],
    });
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-archive',
      transactionPending: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT id FROM users' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    const oldResultProps = dataGridState.latestProps;
    expect(oldResultProps?.onReload).toEqual(expect.any(Function));

    const databaseSelect = [...antdSelectState.props].reverse().find((props) => (
      props.placeholder === catalogs['zh-CN']['query_editor.placeholder.database']
    ));
    await act(async () => {
      databaseSelect?.onChange('archive');
      await Promise.resolve();
    });

    editorState.value = "UPDATE users SET name = 'archived' WHERE id = 1";
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-archive',
      dbName: 'archive',
    });

    backendApp.DBQueryMulti.mockClear();
    backendApp.DBQueryMultiInTransaction.mockClear();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 2 }] }],
    });
    await act(async () => {
      await oldResultProps.onReload();
    });

    expect(backendApp.DBQueryMultiInTransaction).not.toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('SELECT id FROM users'),
      expect.any(String),
    );
  });

  it('shows the empty query results panel after toggling the results button', async () => {


    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <I18nProvider preference="zh-CN" onPreferenceChange={() => undefined}>
          <QueryEditor tab={createTab()} />
        </I18nProvider>,
      );
    });

    await act(async () => {
      findButton(renderer, '结果').props.onClick();
    });

    expect(findSqlLogTab(renderer)).toHaveLength(1);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      resultPanelVisible: true,
    });
  });

  it('hides the expanded empty query results panel from the inline hide action', async () => {


    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    await act(async () => {
      findButton(renderer, '结果').props.onClick();
    });
    expect(findSqlLogTab(renderer)).toHaveLength(1);

    await act(async () => {
      findButton(renderer, '隐藏').props.onClick();
    });

    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: false,
    });
  });

  it('auto expands the query results panel after a successful execution returns rows', async () => {

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['value'], rows: [{ value: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT 1 AS value' })} />);
    });

    expect(textContent(renderer.toJSON())).not.toContain('结果 1');

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer.toJSON())).toContain('结果 1');
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      resultPanelVisible: true,
    });
  });

  it('keeps the inline hide action available after query results render rows', async () => {

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['value'], rows: [{ value: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT 1 AS value' })} />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer.toJSON())).toContain('结果 1');

    const hideButton = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === '隐藏结果区',
    );
    expect(textContent(hideButton)).toBe('');
    expect(hideButton.props.className).toContain('gn-v2-data-grid-toolbar-action');

    await act(async () => {
      hideButton.props.onClick();
    });

    expect(textContent(renderer.toJSON())).not.toContain('结果 1');
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: false,
    });
  });

  it('toggles the query results panel with Ctrl/Cmd+Shift+M', async () => {


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

    const toggleAction = editorState.editor.addAction.mock.calls
      .map((call: any[]) => call[0])
      .find((action: any) => action?.id === 'gonavi.toggleQueryResultsPanel');
    expect(toggleAction).toMatchObject({
      label: 'GoNavi: 切换结果区',
    });
    expect(toggleAction?.keybindings?.[0]).toBeGreaterThan(0);

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const createToggleEvent = () => ({
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: true,
      key: 'm',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    const firstEvent = createToggleEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(firstEvent));
    });

    expect(firstEvent.preventDefault).toHaveBeenCalled();
    expect(firstEvent.stopPropagation).toHaveBeenCalled();
    expect(findSqlLogTab(renderer)).toHaveLength(1);

    const secondEvent = createToggleEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(secondEvent));
    });

    expect(secondEvent.preventDefault).toHaveBeenCalled();
    expect(secondEvent.stopPropagation).toHaveBeenCalled();
    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');
  });

  it('captures the manual SQL AI completion shortcut before Monaco inserts a backslash', async () => {
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.focus.mockClear();
    const shortcutEvent = {
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const monacoShortcutEvent = {
      browserEvent: shortcutEvent,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
    });

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(shortcutEvent));
    });

    expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
    expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
    expect(shortcutEvent.preventDefault).toHaveBeenCalled();
    expect(shortcutEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.editor.focus).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('treats a sticky Alt modifier plus Backslash as the manual SQL AI completion shortcut', async () => {
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    const altDownEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Alt',
      code: 'AltLeft',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const backslashEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: '\\',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(altDownEvent));
      windowListeners.keydown?.forEach((listener) => listener(backslashEvent));
    });

    expect(backslashEvent.preventDefault).toHaveBeenCalled();
    expect(backslashEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('treats a sticky Alt modifier plus IntlBackslash layout event as the manual SQL AI completion shortcut', async () => {
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    const altDownEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Alt',
      code: 'AltLeft',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const backslashEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: 'Process',
      code: 'IntlBackslash',
      keyCode: 226,
      which: 226,
      nativeEvent: {
        code: 'IntlBackslash',
        keyCode: 226,
        which: 226,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(altDownEvent));
      windowListeners.keydown?.forEach((listener) => listener(backslashEvent));
    });

    expect(backslashEvent.preventDefault).toHaveBeenCalled();
    expect(backslashEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('recovers a missed manual SQL AI completion keystroke by removing the inserted backslash', async () => {
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.focus.mockClear();
    editorState.editor.executeEdits.mockClear();

    const altDownEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Alt',
      code: 'AltLeft',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const unmatchedMonacoShortcutEvent = {
      browserEvent: {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: 'Process',
        code: '',
        keyCode: 0,
        which: 0,
        isComposing: false,
        nativeEvent: {
          code: '',
          keyCode: 0,
          which: 0,
          isComposing: false,
        },
        target: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(altDownEvent));
      editorState.keyDownListeners.forEach((listener) => listener(unmatchedMonacoShortcutEvent));
    });

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM \\'.length + 1 };

    await act(async () => {
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{
          text: '\\',
        }],
      }));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-trigger-sql-ai-completion-fallback',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
    expect(editorState.editor.focus).toHaveBeenCalled();
  });

  it('recovers a stray backslash in table completion context even when the desktop keydown is not observable', async () => {
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.executeEdits.mockClear();
    editorState.editor.focus.mockClear();

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM \\'.length + 1 };

    await act(async () => {
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{
          text: '\\',
          rangeOffset: 'SELECT * FROM '.length,
          rangeLength: 0,
        }],
      }));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-trigger-sql-ai-completion-fallback',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
    expect(editorState.editor.focus).toHaveBeenCalled();
  });

  it('recovers a stray backslash from content-change range data even when the cursor is still stale', async () => {
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.executeEdits.mockClear();
    editorState.editor.focus.mockClear();

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };

    await act(async () => {
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{
          text: '\\',
          range: {
            startLineNumber: 1,
            startColumn: 'SELECT * FROM '.length + 1,
            endLineNumber: 1,
            endColumn: 'SELECT * FROM '.length + 1,
          },
        }],
      }));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-trigger-sql-ai-completion-fallback',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('does not fall back to structured SQL suggestions when manual AI completion is triggered in table-name context', async () => {
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { TABLE_NAME: 'videos' },
        { TABLE_NAME: 'visits' },
      ],
    });

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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM ';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };
    editorState.editor.trigger.mockClear();

    const shortcutEvent = {
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const monacoShortcutEvent = {
      browserEvent: shortcutEvent,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });
});
