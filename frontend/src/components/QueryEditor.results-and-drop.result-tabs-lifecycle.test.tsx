import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import {
  CLOSE_ACTIVE_RESULT_TAB_EVENT,
  type CloseActiveResultShortcutRequest,
} from '../utils/closeTabShortcut';
import QueryEditor, { filterQueryEditorResultSetsForBulkClose } from './QueryEditor';
import QueryEditorToolbar from './QueryEditorToolbar';
import {
    storeState,
    backendApp,
    nativeDetachedWindowState,
    messageApi,
    dataGridState,
    editorState,
} from './queryEditorResultsAndDropTestState';
import { create, textContent, findButtons, findButton, createTab } from './queryEditorResultsAndDropTestHelpers';
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

  it('keeps the newer query cancellable when the previous run finishes late', async () => {
    let resolvePreviousQuery!: (value: unknown) => void;
    const previousQuery = new Promise((resolve) => {
      resolvePreviousQuery = resolve;
    });
    const currentQuery = new Promise(() => {});

    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-previous')
      .mockResolvedValueOnce('query-current');
    backendApp.DBQueryMulti
      .mockReturnValueOnce(previousQuery)
      .mockReturnValueOnce(currentQuery);
    backendApp.CancelQuery.mockResolvedValue({ success: true });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);

    await act(async () => {
      void renderer.root.findByType(QueryEditorToolbar).props.onRun();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-previous');

    await act(async () => {
      resolvePreviousQuery({ success: false, message: 'context canceled' });
      await Promise.resolve();
      await Promise.resolve();
    });

    backendApp.CancelQuery.mockClear();
    messageApi.warning.mockClear();
    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });

    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-current');
    expect(messageApi.warning).not.toHaveBeenCalledWith('没有正在运行的查询可取消。');
  });

  it('does not start a replacement run after stop cancels it while the previous query cancellation is pending', async () => {
    let resolveReplacementCancel!: (value: { success: boolean }) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-previous')
      .mockResolvedValueOnce('query-replacement');
    backendApp.DBQueryMulti
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ success: true, data: [] });
    backendApp.CancelQuery
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveReplacementCancel = resolve;
      }))
      .mockResolvedValueOnce({ success: true });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);

    await act(async () => {
      void renderer.root.findByType(QueryEditorToolbar).props.onRun();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.CancelQuery).toHaveBeenCalledTimes(1);

    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });
    expect(findButtons(renderer, '停止')).toHaveLength(0);

    await act(async () => {
      resolveReplacementCancel({ success: true });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.GenerateQueryID).toHaveBeenCalledTimes(1);
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending result refresh before its query id exists', async () => {
    let resolveRefreshQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-initial')
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRefreshQueryId = resolve;
      }));
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 2 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1 as value;' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.onReload).toEqual(expect.any(Function));

    await act(async () => {
      void dataGridState.latestProps.onReload();
      await Promise.resolve();
    });
    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });

    await act(async () => {
      resolveRefreshQueryId('query-refresh-too-late');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.success).toHaveBeenCalledWith('查询已中止。');
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending page query before its query id exists', async () => {
    storeState.queryOptions.maxRows = 2;
    let resolvePageQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-initial')
      .mockReturnValueOnce(new Promise((resolve) => {
        resolvePageQueryId = resolve;
      }));
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 1 }, { value: 2 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 3 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select value from items;' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.onPageChange).toEqual(expect.any(Function));

    await act(async () => {
      void dataGridState.latestProps.onPageChange(2, 2);
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.loading).toBe(true);
    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });
    expect(dataGridState.latestProps?.loading).toBe(false);

    await act(async () => {
      resolvePageQueryId('query-page-too-late');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.success).toHaveBeenCalledWith('查询已中止。');
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
  });

  it('cancels a Mongo multi-statement run between statement query ids', async () => {
    storeState.connections[0].config.type = 'mongodb';
    const query = 'db.users.find({});\ndb.logs.find({});';
    let resolveSecondQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-mongo-first')
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSecondQueryId = resolve;
      }));
    backendApp.DBQueryWithCancel
      .mockResolvedValueOnce({ success: true, data: [{ _id: 1 }], fields: ['_id'] })
      .mockResolvedValueOnce({ success: true, data: [{ _id: 2 }], fields: ['_id'] });
    backendApp.CancelQuery.mockResolvedValue({ success: false, message: 'query already completed' });

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
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.GenerateQueryID).toHaveBeenCalledTimes(2);
    expect(backendApp.DBQueryWithCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });
    await act(async () => {
      resolveSecondQueryId('query-mongo-too-late');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.success).toHaveBeenCalledWith('查询已中止。');
    expect(backendApp.CancelQuery).not.toHaveBeenCalled();
    expect(backendApp.DBQueryWithCancel).toHaveBeenCalledTimes(1);
  });

  it('shows "Failed to cancel query" in English while preserving the raw error detail', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    backendApp.GenerateQueryID.mockResolvedValueOnce('query-1');
    backendApp.DBQueryMulti.mockReturnValueOnce(new Promise(() => {}));
    backendApp.CancelQuery.mockRejectedValueOnce(new Error('network down'));

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

    expect(messageApi.error).toHaveBeenCalledWith('Failed to cancel query: network down');
    expect(messageApi.error).not.toHaveBeenCalledWith('取消查询失败: network down');
  });

  it('runs only appended SQL and keeps existing results after a full editor execution', async () => {
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
        query: 'select 1 as a;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select 1 as a;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.value = 'select 1 as a;\nselect 2 as b;';
    editorState.position = { lineNumber: 2, column: 'select 2 as b;'.length + 1 };

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
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).toContain('select 2 as b');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 1 as a');
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-count') && textContent(node) === '1';
    })).toHaveLength(2);
  });

  it('replaces existing result tabs when rerunning the same formatted SQL', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
          { columns: ['id'], rows: Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })) },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: [{ id: 11 }, { id: 12 }, { id: 13 }] },
          { columns: ['id'], rows: Array.from({ length: 10 }, (_, index) => ({ id: index + 11 })) },
        ],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'SELECT * FROM fs_org_auth_application;\nSELECT * FROM fs_bcp_auth_info;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'SELECT * FROM fs_org_auth_application;'.length + 1 };
    editorState.selection = null;

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');

    editorState.value = [
      'SELECT',
      '    *',
      'FROM',
      '    fs_org_auth_application;',
      '',
      'SELECT',
      '    *',
      'FROM',
      '    fs_bcp_auth_info;',
    ].join('\n');
    editorState.position = { lineNumber: 4, column: '    fs_org_auth_application;'.length + 1 };
    editorState.selection = null;

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
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(textContent(renderer!.toJSON())).not.toContain('结果 3');
    expect(textContent(renderer!.toJSON())).not.toContain('结果 4');
    expect(renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab'] === 'true';
    })).toHaveLength(2);
  });

  it('keeps pinned result tabs across bulk close modes', () => {
    const resultSets = [
      { key: 'result-1', pinned: true },
      { key: 'result-2' },
      { key: 'result-3', pinned: true },
      { key: 'result-4' },
    ] as any[];

    expect(filterQueryEditorResultSetsForBulkClose(resultSets, 'result-2', 'other').map((result) => result.key))
      .toEqual(['result-1', 'result-2', 'result-3']);
    expect(filterQueryEditorResultSetsForBulkClose(resultSets, 'result-2', 'left').map((result) => result.key))
      .toEqual(['result-1', 'result-2', 'result-3', 'result-4']);
    expect(filterQueryEditorResultSetsForBulkClose(resultSets, 'result-2', 'right').map((result) => result.key))
      .toEqual(['result-1', 'result-2', 'result-3']);
    expect(filterQueryEditorResultSetsForBulkClose(resultSets, '', 'all').map((result) => result.key))
      .toEqual(['result-1', 'result-3']);
  });

  it('pins a result from the context menu and keeps its snapshot when rerunning the same SQL', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({ success: true, data: [{ columns: ['value'], rows: [{ value: 'first' }] }] })
      .mockResolvedValueOnce({ success: true, data: [{ columns: ['value'], rows: [{ value: 'second' }] }] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1 as value;' })} />);
      await Promise.resolve();
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const pinButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '固定结果',
    )[0];
    expect(pinButton).toBeTruthy();
    await act(async () => {
      pinButton.props.onClick();
    });
    expect(renderer.root.findAll((node) =>
      String(node.props?.className || '').includes('query-result-tab-pin'),
    )).toHaveLength(1);

    const openInWindowButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '在独立窗口打开',
    )[0];
    await act(async () => {
      await openInWindowButton.props.onClick();
      await Promise.resolve();
    });
    expect(nativeDetachedWindowState.openNativeQueryResultWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ pinned: true }),
      }),
    );

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const resultTabs = renderer.root.findAll((node) =>
      node.type === 'button' && String(node.props?.['data-tab-key'] || '').startsWith('result-'),
    );
    expect(resultTabs).toHaveLength(2);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ value: 'second' }),
    ]);
    const unpinButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '取消固定结果',
    )[0];
    expect(unpinButton).toBeTruthy();
  });

  it('provides context menu actions for query result tabs', async () => {
    backendApp.DBQueryMulti.mockResolvedValue({
      success: true,
      data: [
        { columns: ['a'], rows: [{ a: 1 }] },
        { columns: ['b'], rows: [{ b: 2 }] },
        { columns: ['c'], rows: [{ c: 3 }] },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab'] === 'true';
    })).toHaveLength(3);

    await act(async () => {
      renderer!.root.findAll((node) => node.type === 'button' && textContent(node) === '关闭右侧')[1].props.onClick();
    });
    expect(renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab'] === 'true';
    })).toHaveLength(2);
    expect(textContent(renderer!.toJSON())).not.toContain('结果 3');

    await act(async () => {
      renderer!.root.findAll((node) => node.type === 'button' && textContent(node) === '关闭左侧')[1].props.onClick();
    });
    expect(renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab'] === 'true';
    })).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ b: 2 })]));
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ c: 3 })]));

    await act(async () => {
      renderer!.root.findAll((node) => node.type === 'button' && textContent(node) === '关闭所有')[0].props.onClick();
    });
    expect(renderer!.root.findAll((node) => {
      return node.props?.['data-query-result-tab'] === 'true';
    })).toHaveLength(0);
  });

  it('closes the active result tab directly without switching to the log tab', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['a'], rows: [{ a: 1 }] },
        { columns: ['b'], rows: [{ b: 2 }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;',
      })} />);
    });

    await act(async () => {
      const runButton = findButton(renderer, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const resultTabs = renderer.root.findAll((node) =>
      node.type === 'button' && String(node.props?.['data-tab-key'] || '').startsWith('result-'),
    );
    expect(resultTabs).toHaveLength(2);

    await act(async () => {
      resultTabs[1].props.onClick();
    });
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ b: 2 })]));

    const closeButtons = renderer.root.findAll((node) =>
      String(node.props?.className || '').split(/\s+/).includes('query-result-tab-close'),
    );
    await act(async () => {
      closeButtons[1].props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });

    expect(renderer.root.findAll((node) => node.props?.['data-query-result-tab'] === 'true')).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
  });

  it('preserves a restored result execution snapshot when reopening it in a native window', async () => {
    const executionConnectionParams = 'application_name=gonavi&options=-c%20search_path%3D%22sales%22%2C%22public%22';
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ connectionId: 'conn-current', dbName: 'current_db' })} />);
    });

    const restoreRegistration = (window.addEventListener as any).mock.calls
      .find(([eventName]: [string]) => eventName === 'gonavi:restore-query-result');
    expect(restoreRegistration).toBeTruthy();

    await act(async () => {
      restoreRegistration[1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-snapshot',
            sql: 'select * from orders',
            columns: ['id'],
            rows: [{ id: 1 }],
            tableName: 'orders',
            pkColumns: ['id'],
            readOnly: false,
            executionConnectionId: 'conn-snapshot',
            executionDbName: 'snapshot_db',
            executionConnectionParams,
          },
        },
      }));
    });

    expect(dataGridState.latestProps).toMatchObject({
      connectionId: 'conn-snapshot',
      dbName: 'snapshot_db',
      connectionParamsOverride: executionConnectionParams,
    });

    const openInWindowButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '在独立窗口打开',
    )[0];
    await act(async () => {
      openInWindowButton.props.onClick();
      await Promise.resolve();
    });

    expect(nativeDetachedWindowState.openNativeQueryResultWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-snapshot',
        dbName: 'snapshot_db',
        result: expect.objectContaining({
          executionConnectionId: 'conn-snapshot',
          executionDbName: 'snapshot_db',
          executionConnectionParams,
        }),
      }),
    );
  });

  it('removes only the inline result inserted by a rolled-back native attach', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const restoreRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === 'gonavi:restore-query-result');
    const redetachRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === 'gonavi:redetach-query-result');
    expect(restoreRegistrations).toHaveLength(1);
    expect(redetachRegistrations).toHaveLength(1);

    await act(async () => {
      restoreRegistrations[0][1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-restored',
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-restored',
            sql: 'select 1 as a',
            columns: ['a'],
            rows: [{ a: 1 }],
            pkColumns: [],
            readOnly: true,
          },
        },
      }));
      redetachRegistrations[0][1](new CustomEvent('gonavi:redetach-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-restored',
          sourceQueryTabId: 'tab-1',
          resultKey: 'result-restored',
        },
      }));
    });

    expect(renderer.root.findAll((node) => node.props?.['data-query-result-tab'] === 'true')).toHaveLength(0);

    await act(async () => {
      restoreRegistrations[0][1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-existing',
            sql: 'select existing',
            columns: ['value'],
            rows: [{ value: 'existing' }],
            pkColumns: [],
            readOnly: true,
            pinned: true,
          },
        },
      }));
      restoreRegistrations[0][1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-existing',
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-existing',
            sql: 'select detached',
            columns: ['value'],
            rows: [{ value: 'detached' }],
            pkColumns: [],
            readOnly: true,
          },
        },
      }));
      redetachRegistrations[0][1](new CustomEvent('gonavi:redetach-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-existing',
          sourceQueryTabId: 'tab-1',
          resultKey: 'result-existing',
        },
      }));
    });

    expect(renderer.root.findAll((node) =>
      String(node.props?.className || '').includes('query-result-tab-pin'),
    )).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ value: 'existing' }),
    ]);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('closes the final result and synchronously hides the log tab on the next command', async () => {

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['a'], rows: [{ a: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1 as a;' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const closeRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT);
    expect(closeRegistrations).toHaveLength(1);
    const closeListener = closeRegistrations[0][1] as EventListener;
    (window.dispatchEvent as any).mockImplementation((event: Event) => {
      closeListener(event);
      return true;
    });

    let firstOutcome!: CloseActiveResultShortcutRequest;
    let secondOutcome!: CloseActiveResultShortcutRequest;
    act(() => {
      const firstRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-1', handled: false, outcome: 'ignored' };
      window.dispatchEvent(new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: firstRequest }));
      firstOutcome = { ...firstRequest };

      const secondRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-1', handled: false, outcome: 'ignored' };
      window.dispatchEvent(new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: secondRequest }));
      secondOutcome = { ...secondRequest };
    });

    expect(firstOutcome).toEqual({ targetTabId: 'tab-1', handled: true, outcome: 'closed' });
    expect(secondOutcome).toEqual({ targetTabId: 'tab-1', handled: true, outcome: 'hidden' });
    expect(renderer.root.findAll((node) =>
      node.props?.['data-gonavi-close-shortcut-scope'] === 'result',
    )).toHaveLength(0);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('ignores result close commands for hidden, invalid, or inactive result targets', async () => {

    let hiddenRenderer!: ReactTestRenderer;
    await act(async () => {
      hiddenRenderer = create(<QueryEditor tab={createTab()} />);
    });

    const closeRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT);
    expect(closeRegistrations).toHaveLength(1);
    const hiddenRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-1', handled: false, outcome: 'ignored' };
    closeRegistrations[0][1](new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: hiddenRequest }));
    expect(hiddenRequest).toEqual({ targetTabId: 'tab-1', handled: true, outcome: 'ignored' });
    const detachedRequest: CloseActiveResultShortcutRequest = { targetTabId: 'detached-tab', handled: false, outcome: 'ignored' };
    closeRegistrations[0][1](new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: detachedRequest }));
    expect(detachedRequest).toEqual({ targetTabId: 'detached-tab', handled: false, outcome: 'ignored' });
    await act(async () => {
      hiddenRenderer.unmount();
    });

    vi.mocked(window.addEventListener).mockClear();

    let invalidRenderer!: ReactTestRenderer;
    await act(async () => {
      invalidRenderer = create(<QueryEditor tab={createTab({ id: 'tab-invalid', resultPanelVisible: true })} />);
    });
    const invalidRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT);
    expect(invalidRegistrations).toHaveLength(1);
    const invalidRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-invalid', handled: false, outcome: 'ignored' };
    invalidRegistrations[0][1](new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: invalidRequest }));
    expect(invalidRequest).toEqual({ targetTabId: 'tab-invalid', handled: true, outcome: 'hidden' });
    await act(async () => {
      invalidRenderer.unmount();
    });

    vi.mocked(window.addEventListener).mockClear();
    let inactiveRenderer!: ReactTestRenderer;
    await act(async () => {
      inactiveRenderer = create(<QueryEditor tab={createTab({ id: 'tab-2' })} isActive={false} />);
    });
    expect((window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT)).toHaveLength(0);
    await act(async () => {
      inactiveRenderer.unmount();
    });
  });

  it('replaces the current result when rerunning the same cursor SQL', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 10 }] }],
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

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabLabels = renderer!.root.findAll((node) => textContent(node).includes('结果 '));
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).not.toContain('结果 2');
    expect(tabLabels.length).toBeGreaterThan(0);
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ a: 10 })]));
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 2 as b');
  });
});
