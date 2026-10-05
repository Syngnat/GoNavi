import React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import QueryEditorResultsPanel, { QUERY_EDITOR_SQL_LOG_TAB_KEY, resolveEffectiveActiveResultKey } from './QueryEditorResultsPanel';
import { storeState, backendApp, dataGridState, autoFetchState, editorState } from './queryEditorResultsAndDropTestState';
import { create, notifyStoreSubscribers, textContent, findButton, createTab } from './queryEditorResultsAndDropTestHelpers';
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

  it('appends a result when running a different cursor SQL after an existing result', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['b'], rows: [{ b: 2 }] }],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
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
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
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

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).toContain('select 2 as b');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 3 as c');
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ b: 2 })]));
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
  });

  it('renders compact result tab labels with row counts outside the title text', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['a'], rows: [{ a: 1 }, { a: 2 }] },
        { columns: ['b'], rows: [{ b: 3 }] },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;',
      })} />);
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
    const counts = renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab-count'] === 'true';
    });
    const titles = renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab-title'] === 'true';
    });

    expect(tabLabels).toHaveLength(2);
    expect(titles.map((node) => textContent(node))).toEqual(['结果 1', '结果 2']);
    expect(counts.map((node) => textContent(node))).toEqual(['2', '1']);
    expect(textContent(renderer!.toJSON())).not.toContain('结果 1 (2)');
  });

  it('connects each query result sort state and callback to DataGrid', async () => {
    const onResultSort = vi.fn();
    const sortInfo = [{ columnKey: 'name', order: 'ascend', enabled: true }];
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select id, name from users',
            rows: [{ id: 1, name: 'Ada' }],
            columns: ['id', 'name'],
            pkColumns: [],
            readOnly: true,
            sortInfo,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}

          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={onResultSort}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    expect(dataGridState.latestProps?.sortInfoExternal).toEqual(sortInfo);
    expect(dataGridState.latestProps?.onSort).toEqual(expect.any(Function));

    const serialized = JSON.stringify([{ columnKey: 'id', order: 'descend', enabled: true }]);
    dataGridState.latestProps.onSort(serialized, '');
    expect(onResultSort).toHaveBeenCalledWith('result-1', serialized, '');
    renderer.unmount();
  });

  it('passes max rows only to paginated SQL result grids', async () => {
    const pagedResultSets = [{
        key: 'paged-result',
        sql: 'select id from users',
        rows: [{ id: 1 }],
        columns: ['id'],
        pkColumns: [],
        readOnly: true,
        page: { baseSql: 'select id from users', current: 1, pageSize: 100, total: 1, totalKnown: true },
      }];
    const localResultSets = [{
        key: 'local-result',
        sql: 'select 1 as value',
        rows: [{ value: 1 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      }];
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={pagedResultSets}
          activeResultKey="paged-result"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}

          currentDb="main"
          currentConnectionId="conn-1"
          maxRows={750}
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    expect(dataGridState.latestProps?.queryMaxRows).toBe(750);

    await act(async () => {
      renderer.update(
        <QueryEditorResultsPanel
          resultSets={localResultSets}
          activeResultKey="local-result"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}

          currentDb="main"
          currentConnectionId="conn-1"
          maxRows={750}
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    expect(dataGridState.latestProps?.queryMaxRows).toBeUndefined();
    renderer.unmount();
  });

  it('sorts complete query results locally and restores execution order when cleared', async () => {
    const query = "select 3 as id, 'Zulu' as name union all select 1, 'Alpha' union all select 2, 'Alpha';";
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'name'],
        rows: [
          { id: 3, name: 'Zulu' },
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Alpha' },
        ],
      }],
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Zulu', 'Alpha', 'Alpha']);
    expect(dataGridState.latestProps?.sortInfoExternal).toEqual([]);

    await act(async () => {
      await dataGridState.latestProps.onSort(JSON.stringify([
        { columnKey: 'name', order: 'ascend', enabled: true },
        { columnKey: 'id', order: 'descend', enabled: true },
      ]), '');
    });

    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Alpha', 'Alpha', 'Zulu']);
    expect(dataGridState.latestProps?.data.map((row: any) => row.__gonavi_row_key__)).toEqual([2, 1, 0]);
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);

    await act(async () => {
      await dataGridState.latestProps.onSort('[]', '');
    });

    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Zulu', 'Alpha', 'Alpha']);
    expect(dataGridState.latestProps?.data.map((row: any) => row.__gonavi_row_key__)).toEqual([0, 1, 2]);
    expect(dataGridState.latestProps?.sortInfoExternal).toEqual([]);
    renderer.unmount();
  });

  it('requeries the first page with outer ordering when a pageable result is sorted', async () => {
    storeState.queryOptions.maxRows = 2;
    const query = 'select id, name from (select id, name from users) q;';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id', 'name'],
          rows: [{ id: 2, name: 'Beta' }, { id: 1, name: 'Alpha' }],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id', 'name'],
          rows: [{ id: 4, name: 'Delta' }, { id: 3, name: 'Charlie' }],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id', 'name'],
          rows: [
            { id: 1, name: 'Alpha' },
            { id: 2, name: 'Beta' },
            { id: 3, name: 'Charlie' },
          ],
        }],
      });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 1, pageSize: 2 });

    await act(async () => {
      await dataGridState.latestProps.onPageChange(2, 2);
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 2, pageSize: 2 });

    await act(async () => {
      await dataGridState.latestProps.onSort(JSON.stringify([
        { columnKey: 'name', order: 'ascend', enabled: true },
      ]), '');
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(3);
    const sortedPageSql = String(backendApp.DBQueryMulti.mock.calls[2][2]);
    expect(sortedPageSql).toContain('AS __gonavi_query_page__ ORDER BY `name` ASC LIMIT 3 OFFSET 0');
    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 1, pageSize: 2 });
    expect(dataGridState.latestProps?.sortInfoExternal).toEqual([
      { columnKey: 'name', order: 'ascend', enabled: true },
    ]);
    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Alpha', 'Beta']);
    renderer.unmount();
  });

  it('loads all SQL result rows without a page LIMIT when the page size is unlimited', async () => {
    storeState.queryOptions.maxRows = 2;
    const query = 'select id from users;';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id'],
          rows: [{ id: 1 }, { id: 2 }],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id'],
          rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        }],
      });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await dataGridState.latestProps.onPageChange(2, 0);
    });

    const unlimitedPageSql = String(backendApp.DBQueryMulti.mock.calls[1][2]);
    expect(unlimitedPageSql).not.toContain('LIMIT');
    expect(unlimitedPageSql).not.toContain('OFFSET');
    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 1, pageSize: 0, total: 3, totalKnown: true });
    expect(dataGridState.latestProps?.data.map((row: any) => row.id)).toEqual([1, 2, 3]);
    renderer.unmount();
  });

  it('renders the embedded SQL execution log tab', () => {
    const renderResultsPanel = (sqlLogCount = 1) => create(
      <QueryEditorResultsPanel
        resultSets={[]}
        activeResultKey=""
        isActive
        loading={false}
        executionError=""
        sqlLogCount={sqlLogCount}
        darkMode={false}

        currentDb="main"
        currentConnectionId="conn-1"
        toggleShortcutLabel=""
        onActiveResultKeyChange={vi.fn()}
        onHide={vi.fn()}
        onCloseResult={vi.fn()}
        onCloseOtherResultTabs={vi.fn()}
        onCloseResultTabsToLeft={vi.fn()}
        onCloseResultTabsToRight={vi.fn()}
        onCloseAllResultTabs={vi.fn()}
        onResultPinnedChange={vi.fn()}
        onReloadResult={vi.fn()}
        onResultPageChange={vi.fn()}
        onResultSort={vi.fn()}
        onDiagnoseExecutionError={vi.fn()}
      />,
    );

    const renderer = renderResultsPanel();
    expect(renderer.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__')).toHaveLength(1);
    const tabActions = renderer.root.findByProps({ className: 'query-result-panel-tab-actions' });
    const actionButtons = tabActions.findAll((node) => node.type === 'button');
    const resultPanelStyles = renderer.root.findAll((node) => node.type === 'style')
      .map((node) => textContent(node))
      .join('\n');
    expect(actionButtons.map((node) => node.props.className)).toEqual([
      'query-result-panel-clear query-result-panel-tab-action',
      'query-result-panel-hide query-result-panel-tab-action',
    ]);
    expect(resultPanelStyles).toContain(
      '.query-result-panel-tab-actions { display: inline-flex; flex-direction: row;',
    );
    expect(resultPanelStyles).toContain(
      '.query-result-tabs .ant-tabs-extra-content .query-result-panel-tab-action { width: 28px; min-width: 28px; height: 28px !important; min-height: 28px !important; padding: 0 !important;',
    );
    act(() => {
      actionButtons[0].props.onClick();
    });
    expect(storeState.clearSqlLogs).toHaveBeenCalledTimes(1);
    renderer.unmount();

    const emptyRenderer = renderResultsPanel(0);
    expect(emptyRenderer.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(1);
    expect(emptyRenderer.root.findAll((node) => node.props?.['data-tab-key'] === QUERY_EDITOR_SQL_LOG_TAB_KEY)).toHaveLength(1);
    expect(emptyRenderer.root.findAll((node) =>
      node.props?.['data-gonavi-close-shortcut-scope'] === 'result',
    )).toHaveLength(1);
    emptyRenderer.unmount();
  });

  it('uses the shared effective result key for stale-key rendering fallbacks', () => {
    const resultSets = [{
      key: 'result-1',
      sql: 'select 1 as value',
      rows: [{ value: 1 }],
      columns: ['value'],
      pkColumns: [],
      readOnly: true,
    }];
    expect(resolveEffectiveActiveResultKey(resultSets, 'stale-result', true)).toBe('result-1');
    expect(resolveEffectiveActiveResultKey([], 'stale-result', true)).toBe(QUERY_EDITOR_SQL_LOG_TAB_KEY);
    expect(resolveEffectiveActiveResultKey([], 'stale-result', false)).toBe('');

    const renderer = create(
      <QueryEditorResultsPanel
        resultSets={resultSets}
        activeResultKey="stale-result"
        isActive
        loading={false}
        executionError=""
        sqlLogCount={0}
        darkMode={false}

        currentDb="main"
        currentConnectionId="conn-1"
        toggleShortcutLabel=""
        onActiveResultKeyChange={vi.fn()}
        onHide={vi.fn()}
        onCloseResult={vi.fn()}
        onCloseOtherResultTabs={vi.fn()}
        onCloseResultTabsToLeft={vi.fn()}
        onCloseResultTabsToRight={vi.fn()}
        onCloseAllResultTabs={vi.fn()}
        onResultPinnedChange={vi.fn()}
        onReloadResult={vi.fn()}
        onResultPageChange={vi.fn()}
        onResultSort={vi.fn()}
        onDiagnoseExecutionError={vi.fn()}
      />,
    );
    expect(dataGridState.latestProps?.data).toEqual([{ value: 1 }]);
    renderer.unmount();
  });

  it('coalesces editor result splitter dragging through requestAnimationFrame', async () => {
    const moveListeners: Array<(event: MouseEvent) => void> = [];
    const upListeners: Array<() => void> = [];
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.mocked(document.addEventListener).mockImplementation((type: string, listener: any) => {
      if (type === 'mousemove') moveListeners.push(listener);
      if (type === 'mouseup') upListeners.push(listener);
    });
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ resultPanelVisible: true })} />);
    });
    vi.mocked(window.requestAnimationFrame).mockClear();
    frameCallbacks.length = 0;

    const resizer = renderer.root.find((node) => node.props?.title === '拖动调整高度');
    await act(async () => {
      resizer.props.onMouseDown({ clientY: 300, preventDefault: vi.fn() });
      moveListeners.forEach((listener) => listener({ clientY: 340 } as MouseEvent));
      moveListeners.forEach((listener) => listener({ clientY: 380 } as MouseEvent));
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    await act(async () => {
      frameCallbacks.splice(0).forEach((callback) => callback(16));
    });

    await act(async () => {
      upListeners.forEach((listener) => listener());
    });
    expect(document.removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(document.removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function));
  });

  it('prevents Monaco native drag marker and keeps metadata hover after sidebar object drops', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
    } as any;
    editorState.editor.getTargetAtClientPoint = vi.fn(() => ({
      position: { lineNumber: 1, column: 'SELECT * FROM '.length + 1 },
    }));
    editorState.value = 'SELECT * FROM ';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'front_end_sys' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_front_end_sys: 'fs_mkefu_regist_record' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'front_end_sys' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const dragOverEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        types: ['application/x-gonavi-sql-object', 'text/plain'],
        dropEffect: 'none',
        getData: vi.fn(() => ''),
      },
    };
    await act(async () => {
      domListeners.dragover?.forEach((listener) => listener(dragOverEvent));
    });

    expect(dragOverEvent.preventDefault).toHaveBeenCalled();
    expect(dragOverEvent.stopPropagation).toHaveBeenCalled();
    expect(dragOverEvent.dataTransfer.dropEffect).toBe('copy');
    expect(dragOverEvent.dataTransfer.getData).not.toHaveBeenCalled();

    await act(async () => {
      domListeners.drop?.forEach((listener) => listener({
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['application/x-gonavi-sql-object', 'text/plain'],
          getData: (type: string) => {
            if (type === 'application/x-gonavi-sql-object') {
              return JSON.stringify({ text: 'fs_mkefu_regist_record' });
            }
            if (type === 'text/plain') {
              return 'fs_mkefu_regist_record';
            }
            return '';
          },
        },
      }));
    });

    const hover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT * FROM fs_mkefu_regist_record'.length },
    );

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'SELECT * FROM fs_mkefu_regist_record'.length } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
      tableName: 'fs_mkefu_regist_record',
      objectType: 'table',
    }));
  });

  it('projects field drops from editor whitespace by x coordinate and previews the same anchor', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const sql = 'SELECT org_id, title FROM a_cninfo_announcement\n\n';
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      contains: vi.fn(() => false),
      getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 300 })),
    } as any;
    editorState.editor.getTargetAtClientPoint = vi.fn(() => ({
      type: 7,
      position: { lineNumber: 3, column: 1 },
    }));
    editorState.editor.getVisibleRanges = vi.fn(() => [{ startLineNumber: 1, endLineNumber: 3 }]);
    editorState.editor.getScrolledVisiblePosition = vi.fn(({ lineNumber, column }: any) => ({
      left: (column - 1) * 10,
      top: (lineNumber - 1) * 20,
      height: 20,
    }));
    editorState.editor.render = vi.fn();
    editorState.value = sql;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    const titleOffset = sql.indexOf('title');
    const createDataTransfer = () => ({
      types: [
        'application/x-gonavi-sql-object',
        'application/x-gonavi-sql-field',
        'text/plain',
      ],
      dropEffect: 'none',
      getData: (type: string) => {
        if (type === 'application/x-gonavi-sql-object') {
          return JSON.stringify({ text: 'announcement_id', nodeType: 'column' });
        }
        return 'announcement_id';
      },
    });
    const dragCoordinates = {
      clientX: (titleOffset + 2) * 10,
      clientY: 100,
    };

    await act(async () => {
      domListeners.dragover?.forEach((listener) => listener({
        ...dragCoordinates,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: createDataTransfer(),
      }));
    });

    const previewDecoration = editorState.editor.deltaDecorations.mock.calls
      .flatMap((call: any[]) => call[1] || [])
      .find((decoration: any) => decoration?.options?.inlineClassName === 'gonavi-query-editor-field-drop-anchor');
    expect(previewDecoration?.range).toMatchObject({
      startLineNumber: 1,
      startColumn: titleOffset + 1,
      endLineNumber: 1,
      endColumn: titleOffset + 'title'.length + 1,
    });

    await act(async () => {
      domListeners.drop?.forEach((listener) => listener({
        ...dragCoordinates,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: createDataTransfer(),
      }));
    });

    expect(editorState.value).toBe(
      'SELECT org_id, title, announcement_id FROM a_cninfo_announcement\n\n',
    );
  });

  it('fetches database and completion metadata only for the active query tab', async () => {
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }],
    });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Tables_in_main: 'users' }],
    });

    const firstTab = createTab({ id: 'tab-1', query: 'SELECT * FROM users' });
    const secondTab = createTab({ id: 'tab-2', query: 'SELECT * FROM orders' });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <>
          <QueryEditor key={firstTab.id} tab={firstTab} isActive />
          <QueryEditor key={secondTab.id} tab={secondTab} isActive={false} />
        </>,
      );
    });

    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
      expect(backendApp.DBGetAllColumns).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      renderer.update(
        <>
          <QueryEditor key={firstTab.id} tab={firstTab} isActive={false} />
          <QueryEditor key={secondTab.id} tab={secondTab} isActive />
        </>,
      );
    });

    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(2);
      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
      expect(backendApp.DBGetAllColumns).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not rerender inactive query editors when SQL logs change', async () => {
    const renderCounts = { active: 0, inactive: 0 };
    const firstTab = createTab({ id: 'tab-1', query: 'SELECT * FROM users' });
    const secondTab = createTab({ id: 'tab-2', query: 'SELECT * FROM orders' });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <>
          <React.Profiler id="active" onRender={() => { renderCounts.active += 1; }}>
            <QueryEditor key={firstTab.id} tab={firstTab} isActive />
          </React.Profiler>
          <React.Profiler id="inactive" onRender={() => { renderCounts.inactive += 1; }}>
            <QueryEditor key={secondTab.id} tab={secondTab} isActive={false} />
          </React.Profiler>
        </>,
      );
    });

    const baseline = { ...renderCounts };
    await act(async () => {
      storeState.sqlLogs = [{
        id: 'log-1',
        timestamp: Date.now(),
        sql: 'SELECT 1',
        status: 'success',
        duration: 1,
      }];
      notifyStoreSubscribers();
    });

    expect(renderCounts.active).toBeGreaterThan(baseline.active);
    expect(renderCounts.inactive).toBe(baseline.inactive);

    await act(async () => {
      renderer.update(
        <>
          <React.Profiler id="active" onRender={() => { renderCounts.active += 1; }}>
            <QueryEditor key={firstTab.id} tab={firstTab} isActive={false} />
          </React.Profiler>
          <React.Profiler id="inactive" onRender={() => { renderCounts.inactive += 1; }}>
            <QueryEditor key={secondTab.id} tab={secondTab} isActive />
          </React.Profiler>
        </>,
      );
    });

    const switchedBaseline = { ...renderCounts };
    await act(async () => {
      storeState.sqlLogs = [{
        id: 'log-2',
        timestamp: Date.now() + 1,
        sql: 'SELECT 2',
        status: 'success',
        duration: 1,
      }, ...storeState.sqlLogs];
      notifyStoreSubscribers();
    });

    expect(renderCounts.active).toBe(switchedBaseline.active);
    expect(renderCounts.inactive).toBeGreaterThan(switchedBaseline.inactive);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not rerender background Kingbase query editors when the active tab changes', async () => {
    const renderCounts = { first: 0, second: 0 };
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'appdb';
    const longQuery = Array.from({ length: 120 }, (_, index) => (
      `SELECT * FROM public.order_${index + 1};`
    )).join('\n');
    const firstTab = createTab({ id: 'tab-1', dbName: 'appdb', query: longQuery });
    const secondTab = createTab({ id: 'tab-2', dbName: 'appdb', query: longQuery });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <>
          <React.Profiler id="first-kingbase-query" onRender={() => { renderCounts.first += 1; }}>
            <QueryEditor key={firstTab.id} tab={firstTab} isActive />
          </React.Profiler>
          <React.Profiler id="second-kingbase-query" onRender={() => { renderCounts.second += 1; }}>
            <QueryEditor key={secondTab.id} tab={secondTab} isActive={false} />
          </React.Profiler>
        </>,
      );
    });

    const baseline = { ...renderCounts };
    await act(async () => {
      storeState.activeTabId = 'tab-2';
      notifyStoreSubscribers();
    });

    expect(renderCounts).toEqual(baseline);
    renderer.unmount();
  });

  it('does not rescan unchanged Kingbase SQL when a cached query tab is reactivated', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'appdb';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'appdb' }],
    });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'public.users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    const tab = createTab({
      id: 'tab-1',
      dbName: 'appdb',
      query: Array.from({ length: 120 }, () => 'SELECT * FROM public.users;').join('\n'),
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={tab} isActive />);
    });
    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
      }
    });
    expect(backendApp.DBGetTables).toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).toHaveBeenCalled();

    await act(async () => {
      renderer.update(<QueryEditor tab={tab} isActive={false} />);
    });
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      renderer.update(<QueryEditor tab={tab} isActive />);
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
