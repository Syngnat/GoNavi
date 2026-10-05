import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveQueryEditorTabSplitRatio, setQueryEditorTabSplitRatio } from '../utils/queryEditorSplitLayout';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    backendApp,
    messageApi,
    dataGridState,
    autoFetchState,
    editorState,
    textContent,
    findButton,
    findEditorAction,
    createTab,
    createQueryEditorSplitNodeMock,
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
    await act(async () => {
      frameCallbacks.splice(0).forEach((callback) => callback(0));
    });
    vi.mocked(window.requestAnimationFrame).mockClear();
    editorState.editor.layout.mockClear();

    const resizer = renderer.root.find((node) => node.props?.title === '拖动调整高度');
    await act(async () => {
      resizer.props.onMouseDown({ clientY: 300, preventDefault: vi.fn() });
      moveListeners.forEach((listener) => listener({ clientY: 340 } as MouseEvent));
      moveListeners.forEach((listener) => listener({ clientY: 380 } as MouseEvent));
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(editorState.editor.layout).not.toHaveBeenCalled();

    await act(async () => {
      frameCallbacks.splice(0).forEach((callback) => callback(16));
    });
    expect(editorState.editor.layout).toHaveBeenCalledTimes(1);

    await act(async () => {
      upListeners.forEach((listener) => listener());
    });
    expect(editorState.editor.layout).toHaveBeenCalledTimes(2);
    expect(document.removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(document.removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function));
  });

  it('keeps the editor and result split ratio on the dragged query tab', async () => {

    const moveListeners: Array<(event: MouseEvent) => void> = [];
    const upListeners: Array<() => void> = [];
    vi.mocked(document.addEventListener).mockImplementation((type: string, listener: any) => {
      if (type === 'mousemove') moveListeners.push(listener);
      if (type === 'mouseup') upListeners.push(listener);
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryEditor tab={createTab({ resultPanelVisible: true })} />,
        { createNodeMock: createQueryEditorSplitNodeMock },
      );
    });

    const resizer = renderer.root.find((node) => node.props?.title === '拖动调整高度');
    await act(async () => {
      resizer.props.onMouseDown({ clientY: 300, preventDefault: vi.fn() });
      moveListeners.forEach((listener) => listener({ clientY: 420 } as MouseEvent));
    });
    await act(async () => {
      upListeners.forEach((listener) => listener());
    });

    expect(storeState.setQueryOptions).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryEditorEditorHeightRatio: expect.any(Number) }),
    );
    expect(resolveQueryEditorTabSplitRatio('tab-1', 0.5)).toBe(0.6);
    expect(resolveQueryEditorTabSplitRatio('tab-2', 0.5)).toBe(0.5);
  });

  it('keeps another query tab on its own split ratio', async () => {

    setQueryEditorTabSplitRatio('tab-1', 0.75);
    storeState.activeTabId = 'tab-2';
    storeState.queryOptions = {
      ...storeState.queryOptions,
      queryEditorEditorHeightRatio: 0.5,
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryEditor tab={createTab({ id: 'tab-2', resultPanelVisible: true })} />,
        { createNodeMock: createQueryEditorSplitNodeMock },
      );
    });

    const editorStage = renderer.root.find((node) => {
      const className = String(node.props?.className || '');
      return className.includes('gn-v2-query-monaco-stage');
    });
    expect(editorStage.props.style.height).toBe(350);
  });

  it('inserts sidebar object text when dropped into the SQL editor', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
    } as any;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select * from ' })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select * from '.length + 1 };

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
              return JSON.stringify({ text: 'reporting.active_users' });
            }
            if (type === 'text/plain') {
              return 'reporting.active_users';
            }
            return '';
          },
        },
      }));
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-sidebar-drop',
      [expect.objectContaining({ text: 'reporting.active_users' })],
    );
    expect(editorState.value).toContain('reporting.active_users');
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
    expect(editorState.value).toContain('fs_mkefu_regist_record');
    expect(hover?.contents?.[0]?.value).toContain('**表** `fs_mkefu_regist_record`');

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
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
      tableName: 'fs_mkefu_regist_record',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
    }));
  });

  it('keeps sidebar object navigation tied to the dragged database after drop', async () => {
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
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'front_end_sys' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_front_end_sys: 'fs_mkefu_regist_record' }] });
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
              return JSON.stringify({
                text: 'fs_mkefu_regist_record',
                nodeType: 'table',
                connectionId: 'conn-1',
                dbName: 'front_end_sys',
              });
            }
            if (type === 'text/plain') {
              return 'fs_mkefu_regist_record';
            }
            return '';
          },
        },
      }));
    });

    expect(editorState.value).toContain('front_end_sys.fs_mkefu_regist_record');

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'SELECT * FROM front_end_sys.fs_mkefu_regist_record'.length } },
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
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
    }));
  });

  it('runs selected SQL before cursor SQL', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['selected'], rows: [{ selected: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as selected;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 4 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as selected'.length + 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as selected'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('keeps a reverse Shift+Home selection and caret when the Monaco run action executes it', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
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
      data: [{ columns: ['selected'], rows: [{ selected: 2 }] }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as selected;\nselect 3;',
      })} />);
    });

    const reverseSelection = {
      selectionStartLineNumber: 2,
      selectionStartColumn: 'select 2 as selected'.length + 1,
      positionLineNumber: 2,
      positionColumn: 1,
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as selected'.length + 1,
    };
    editorState.position = { lineNumber: 2, column: 1 };
    editorState.selection = reverseSelection;
    editorState.editor.setPosition.mockClear();
    editorState.editor.setSelection.mockClear();

    const runAction = findEditorAction('gonavi.runQuery');
    expect(runAction).toBeTruthy();
    await act(async () => {
      runAction.run();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 2 as selected'),
      'query-1',
    );
    expect(editorState.position).toEqual({ lineNumber: 2, column: 1 });
    expect(editorState.selection).toEqual(reverseSelection);
    expect(editorState.editor.setPosition).not.toHaveBeenCalled();
    expect(editorState.editor.setSelection).not.toHaveBeenCalled();
  });

  it('allows editable table columns while leaving expression columns out of commits', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['DISPLAY_NAME', 'NAME_UPPER', '__gonavi_locator_1_ID'],
        rows: [{ DISPLAY_NAME: 'old-name', NAME_UPPER: 'OLD-NAME', __gonavi_locator_1_ID: 7 }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'SELECT NAME AS DISPLAY_NAME, UPPER(NAME) AS NAME_UPPER FROM users',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      writableColumns: {
        DISPLAY_NAME: 'NAME',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('`ID` AS `__gonavi_locator_1_ID`');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps DuckDB qualified table query results writable when primary key metadata arrives', async () => {
    storeState.connections[0].config.type = 'duckdb';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_id'], rows: [{ NAME: 'launch', __gonavi_locator_1_id: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'name', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM main.events' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'main', 'main.events');
    expect(dataGridState.latestProps?.tableName).toBe('main.events');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      valueColumns: ['__gonavi_locator_1_id'],
      hiddenColumns: ['__gonavi_locator_1_id'],
      writableColumns: {
        NAME: 'name',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"id" AS "__gonavi_locator_1_id"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses hidden DuckDB rowid when query results have no primary or unique key', async () => {
    storeState.connections[0].config.type = 'duckdb';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_duckdb_rowid__'], rows: [{ NAME: 'launch', __gonavi_duckdb_rowid__: 17 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'name', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM main.events' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('main.events');
    expect(dataGridState.latestProps?.pkColumns).toEqual([]);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'duckdb-rowid',
      columns: ['rowid'],
      valueColumns: ['__gonavi_duckdb_rowid__'],
      hiddenColumns: ['__gonavi_duckdb_rowid__'],
      writableColumns: {
        NAME: 'name',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('rowid AS "__gonavi_duckdb_rowid__"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it.each([
    'mysql',
    'mariadb',
    'oceanbase',
    'diros',
    'sphinx',
    'postgres',
    'kingbase',
    'highgo',
    'vastbase',
    'opengauss',
    'gaussdb',
    'sqlserver',
    'sqlite',
    'duckdb',
    'oracle',
    'dameng',
    'tdengine',
    'clickhouse',
  ])(
    'keeps aggregate query results silently read-only for %s',
    async (dbType) => {
      storeState.connections[0].config.type = dbType;
      storeState.connections[0].config.database = dbType === 'oracle' || dbType === 'dameng' ? 'APP' : 'main';
      backendApp.DBQueryMulti.mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['COUNT'], rows: [{ COUNT: 1 }] }],
      });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({
          dbName: storeState.connections[0].config.database,
          query: 'SELECT count(1) FROM users',
        })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const expectedTableName = dbType === 'oracle' || dbType === 'dameng' ? 'USERS' : 'users';
      expect(dataGridState.latestProps?.tableName).toBe(expectedTableName);
      expect(dataGridState.latestProps?.editLocator).toBeUndefined();
      expect(dataGridState.latestProps?.readOnly).toBe(true);
      expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
      expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
      expect(messageApi.warning).not.toHaveBeenCalled();
    },
  );
});
