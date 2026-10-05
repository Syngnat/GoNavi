import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueryTabDraft } from '../utils/sqlFileTabDrafts';
import QueryEditor, { collectQueryEditorObjectDecorationCandidates } from './QueryEditor';
import {
    create,
    storeState,
    backendApp,
    messageApi,
    saveQueryNameInputFocus,
    autoFetchState,
    editorState,
    textContent,
    findButton,
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

  it('does not build the full inline AI snapshot synchronously during typing', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
      });

      const model = editorState.editor.getModel();
      const getValueInRangeSpy = vi.spyOn(model, 'getValueInRange');
      editorState.value = `SELECT * FROM users ${'x'.repeat(60_000)}`;
      editorState.position = { lineNumber: 1, column: editorState.value.length + 1 };

      await act(async () => {
        editorState.latestOnChange?.(editorState.value);
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: ' ' }],
        }));
      });

      try {
        expect(getValueInRangeSpy).not.toHaveBeenCalled();
      } finally {
        getValueInRangeSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('debounces object decoration rescans and colors newly typed tables in the same database context', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    try {
      editorState.value = 'select * from users;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'users' }, { Tables_in_main: 'orders' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const readObjectTokenTexts = () => editorState.editor.deltaDecorations.mock.calls
        .flatMap((call: any[]) => call[1] || [])
        .filter((item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token')
        .map((item: any) => editorState.editor.getModel().getValueInRange(item.range));

      expect(readObjectTokenTexts()).toContain('users');

      editorState.editor.deltaDecorations.mockClear();
      const emitChange = (value: string, insertedText: string) => {
        editorState.value = value;
        editorState.latestOnChange?.(value);
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: insertedText }],
        }));
      };

      await act(async () => {
        emitChange('select * from users;\nselect * from orde', '\nselect * from orde');
        vi.advanceTimersByTime(225);
        await Promise.resolve();
      });
      await act(async () => {
        emitChange('select * from users;\nselect * from orders;', 'rs;');
      });

      await act(async () => {
        vi.advanceTimersByTime(449);
        await Promise.resolve();
      });
      expect(readObjectTokenTexts()).not.toContain('orders');

      await act(async () => {
        vi.advanceTimersByTime(1);
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      });

      expect(readObjectTokenTexts()).toContain('orders');
      expect(editorState.editor.deltaDecorations.mock.calls.filter(
        (call: any[]) => (call[1] || []).some(
          (item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token',
        ),
      )).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('cancels a pending idle object decoration refresh when the editor becomes inactive', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    let objectDecorationIdleCallback: IdleRequestCallback | undefined;
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn((
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => {
      if (options?.timeout === 1_200) {
        objectDecorationIdleCallback = callback;
        return 41;
      }
      return 42;
    });
    Object.assign(window, { requestIdleCallback, cancelIdleCallback });

    try {
      editorState.value = 'select * from users;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'users' }, { Tables_in_main: 'orders' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      const tab = createTab({ query: editorState.value, dbName: 'main' });
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={tab} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const initialObjectTokenTexts = editorState.editor.deltaDecorations.mock.calls
        .flatMap((call: any[]) => call[1] || [])
        .filter((item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token')
        .map((item: any) => editorState.editor.getModel().getValueInRange(item.range));
      expect(initialObjectTokenTexts).toContain('users');
      requestIdleCallback.mockClear();
      cancelIdleCallback.mockClear();
      objectDecorationIdleCallback = undefined;

      await act(async () => {
        editorState.value = 'select * from users;\nselect * from orders;';
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: '\nselect * from orders;' }],
        }));
        vi.advanceTimersByTime(450);
        await Promise.resolve();
      });

      expect(requestIdleCallback.mock.calls.filter(([, options]) => options?.timeout === 1_200)).toHaveLength(1);
      expect(objectDecorationIdleCallback).toBeTypeOf('function');

      await act(async () => {
        renderer.update(<QueryEditor tab={tab} isActive={false} />);
      });
      expect(cancelIdleCallback).toHaveBeenCalledWith(41);

      const model = editorState.editor.getModel();
      model.getValue.mockClear();
      model.getValueLength.mockClear();
      editorState.editor.getModel.mockClear();
      editorState.editor.deltaDecorations.mockClear();

      await act(async () => {
        objectDecorationIdleCallback?.({ didTimeout: false, timeRemaining: () => 50 });
      });

      expect(editorState.editor.getModel).not.toHaveBeenCalled();
      expect(model.getValue).not.toHaveBeenCalled();
      expect(model.getValueLength).not.toHaveBeenCalled();
      expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('cancels the debounced object decoration refresh when the editor unmounts', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
      });
      vi.clearAllTimers();

      await act(async () => {
        editorState.value = 'select * from orders;';
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'select * from orders;' }],
        }));
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await act(async () => {
        renderer.unmount();
      });

      const model = editorState.editor.getModel();
      model.getValue.mockClear();
      model.getValueLength.mockClear();
      editorState.editor.getModel.mockClear();
      editorState.editor.deltaDecorations.mockClear();

      await act(async () => {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      });

      expect(editorState.editor.getModel).not.toHaveBeenCalled();
      expect(model.getValue).not.toHaveBeenCalled();
      expect(model.getValueLength).not.toHaveBeenCalled();
      expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('ignores focused local tab query echoes so IME candidate commits are not overwritten', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    editorState.value = '';
    editorState.hasTextFocus = true;
    editorState.editor.setValue.mockClear();

    await act(async () => {
      editorState.latestOnChange?.('我');
    });

    editorState.editor.getValue.mockImplementationOnce(() => '');
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: '我' })} />);
    });

    expect(getQueryTabDraft('tab-1')).toBe('我');
    expect(editorState.editor.setValue).not.toHaveBeenCalled();
  });

  it('still applies true external tab query changes while the editor is focused', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    editorState.value = '';
    editorState.hasTextFocus = true;
    editorState.editor.setValue.mockClear();

    await act(async () => {
      editorState.latestOnChange?.('我');
    });

    editorState.editor.getValue.mockImplementationOnce(() => '');
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: 'SELECT 2;' })} />);
    });

    expect(editorState.editor.setValue).toHaveBeenCalledWith('SELECT 2;');
  });

  it('waits for the native IME commit before applying the composition fallback', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const editorInput = {
      className: 'inputarea',
      closest: vi.fn((selector: string) => (
        selector === '.monaco-editor' ? editorState.domNode : null
      )),
    };
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ target: editorInput, data: '' }));
        domListeners.compositionend?.forEach((listener) => listener({ target: editorInput, data: '我' }));
      });
      await act(async () => {
        vi.advanceTimersByTime(79);
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply the SQL IME fallback to a composition committed in the find replace input', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const findReplaceInput = {
      className: 'input',
      closest: vi.fn((selector: string) => (
        selector.includes('.find-widget') || selector.includes('.monaco-inputbox')
          ? { className: 'monaco-inputbox' }
          : null
      )),
    };
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select abc from table1;' })} />);
      });

      editorState.position = { lineNumber: 1, column: 11 };
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 8,
        endLineNumber: 1,
        endColumn: 11,
      };
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({
          target: findReplaceInput,
          data: '',
        }));
        domListeners.compositionend?.forEach((listener) => listener({
          target: findReplaceInput,
          data: 'replacement',
        }));
      });
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
      expect(editorState.value).toBe('select abc from table1;');
      expect(editorState.selection).toEqual({
        startLineNumber: 1,
        startColumn: 8,
        endLineNumber: 1,
        endColumn: 11,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply the SQL IME fallback when the find widget owns the active element', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const findReplaceInput = {
      className: 'input',
      tagName: 'INPUT',
      closest: vi.fn((selector: string) => (
        selector.includes('.find-widget') || selector.includes('.monaco-inputbox')
          ? { className: 'monaco-inputbox' }
          : null
      )),
    };
    const editorInput = {
      className: 'inputarea',
      closest: vi.fn((selector: string) => (
        selector === '.monaco-editor' ? editorState.domNode : null
      )),
    };
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select abc from table1;' })} />);
      });

      editorState.hasTextFocus = true;
      (document as any).activeElement = findReplaceInput;
      editorState.position = { lineNumber: 1, column: 11 };
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 8,
        endLineNumber: 1,
        endColumn: 11,
      };
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({
          target: editorInput,
          data: '',
        }));
        domListeners.compositionend?.forEach((listener) => listener({
          target: editorInput,
          data: 'test',
        }));
      });
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
      expect(editorState.value).toBe('select abc from table1;');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips inline AI metadata warmup when no inline model is configured', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select * from users' })} />);
      });

      backendApp.DBGetTables.mockClear();
      editorState.position = { lineNumber: 1, column: 'select * from users'.length + 1 };
      await act(async () => {
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 's' }],
        }));
        vi.advanceTimersByTime(220);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps deterministic inline SQL ghosts available before AI readiness succeeds', async () => {
    vi.useFakeTimers();
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

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELEC', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.domNode.appendChild.mockClear();
      backendApp.DBGetTables.mockClear();
      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        await Promise.resolve();
      });

      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.textContent).toBe(' * FROM');
      expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers committed IME text when Monaco composition end leaves the model unchanged', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ data: '' }));
        domListeners.compositionend?.forEach((listener) => listener({ data: '我' }));
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        [{
          range: expect.objectContaining({
            startLineNumber: 1,
            startColumn: 9,
            endLineNumber: 1,
            endColumn: 9,
          }),
          text: '我',
          forceMoveMarkers: true,
        }],
      );
      expect(editorState.value).toBe("select '我';");
      expect(getQueryTabDraft('tab-1')).toBe("select '我';");
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate IME text when Monaco already applied the composition commit', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ data: '' }));
        editorState.value = "select '我';";
        domListeners.compositionend?.forEach((listener) => listener({ data: '我' }));
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
      expect(editorState.value).toBe("select '我';");
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses beforeinput data as the IME fallback text when composition end data is empty', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ data: '' }));
        domListeners.beforeinput?.forEach((listener) => listener({
          data: '我',
          inputType: 'insertCompositionText',
          isComposing: true,
        }));
        domListeners.compositionend?.forEach((listener) => listener({ data: '' }));
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        [expect.objectContaining({ text: '我' })],
      );
      expect(editorState.value).toBe("select '我';");
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps short regular query typing on the Monaco fast path without rerender side effects', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
    });

    storeState.updateQueryTabDraft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      editorState.value = 'SELECT * FROM fs_org_auth_application;\n\nSELECT * FROM fs_bcp_auth_info; ';
      editorState.latestOnChange?.(editorState.value);
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{ text: ' ' }],
      }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getQueryTabDraft('tab-1')).toBe('SELECT * FROM fs_org_auth_application;\n\nSELECT * FROM fs_bcp_auth_info; ');
    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith('tab-1', expect.objectContaining({
      query: expect.any(String),
    }));
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
  });

  it('skips SQL literals when collecting object decoration candidates for insert scripts', () => {
    const insertValues = Array.from({ length: 120 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, '0');
      return `('legacy-seed-L${suffix}', '旧版企业-L${suffix}', '深圳市南山区 ${suffix} 号', 'legacy${suffix}@demo.test')`;
    }).join(',\n');
    const sql = [
      '-- 字符串里的 fs_org_auth_file 不应参与对象装饰扫描',
      'INSERT INTO mkefu_location_dev_local.uk_corp (id, corp_name, address, email) VALUES',
      `${insertValues};`,
      'SELECT uk_corp.id FROM uk_corp;',
    ].join('\n');

    const candidates = collectQueryEditorObjectDecorationCandidates(sql, 1000);
    const candidateTexts = candidates.map((candidate) => candidate.lineContent.slice(candidate.positionColumn - 1, candidate.positionColumn + 30));

    expect(candidateTexts.some((text) => text.includes('legacy-seed'))).toBe(false);
    expect(candidateTexts.some((text) => text.includes('旧版企业'))).toBe(false);
    expect(candidateTexts.some((text) => text.includes('demo.test'))).toBe(false);
    expect(candidateTexts.some((text) => text.includes('mkefu_location_dev_local'))).toBe(true);
    expect(candidateTexts.some((text) => text.includes('uk_corp'))).toBe(true);
  });

  it('does not provide metadata hover inside SQL string literals', async () => {
    editorState.value = "insert into users(name) values ('users.id should stay plain');";
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

    const hoverProvider = editorState.hoverProviders[0];
    expect(hoverProvider).toBeTruthy();
    const literalColumn = editorState.value.indexOf('users.id should') + 3;
    const hover = hoverProvider.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: literalColumn },
    );

    expect(hover).toBeNull();
  });

  it('registers Ctrl/Cmd+S to quick-save the active query', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    await act(async () => {
      create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    const saveAction = findEditorAction('gonavi.saveQuery');
    expect(saveAction).toMatchObject({
      label: 'GoNavi: 保存查询',
    });
    expect(saveAction?.keybindings?.[0]).toBeGreaterThan(0);

    editorState.value = 'select 5;';
    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 5;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }));
    expect(messageApi.success).toHaveBeenCalledWith('查询已保存。');
  });

  it('registers Cmd/Ctrl+Shift+S to open save as for a saved query', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    const saveAsAction = findEditorAction('gonavi.saveQueryAs');
    expect(saveAsAction).toMatchObject({
      label: 'GoNavi: 查询另存为',
      keybindings: [2048 | 1024 | 83],
    });
    expect(textContent(findButton(renderer, '另存为'))).toContain('⌘⇧S');

    const event = {
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(saveQueryNameInputFocus).toHaveBeenCalledWith({ cursor: 'all' });
    expect(storeState.saveQuery).not.toHaveBeenCalled();
  });

  it('does not consume Cmd/Ctrl+Shift+S for new or external SQL query tabs', async () => {
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
      create(<QueryEditor tab={createTab({ title: '新建查询' })} />);
    });

    const newQueryEvent = {
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(newQueryEvent));
    });
    expect(newQueryEvent.preventDefault).not.toHaveBeenCalled();
    expect(newQueryEvent.stopPropagation).not.toHaveBeenCalled();
    expect(saveQueryNameInputFocus).not.toHaveBeenCalled();

    let externalRenderer!: ReactTestRenderer;
    await act(async () => {
      externalRenderer = create(<QueryEditor tab={createTab({ filePath: '/tmp/report.sql' })} />);
    });

    const externalQueryEvent = {
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(externalQueryEvent));
    });
    expect(externalQueryEvent.preventDefault).not.toHaveBeenCalled();
    expect(externalQueryEvent.stopPropagation).not.toHaveBeenCalled();
    expect(saveQueryNameInputFocus).not.toHaveBeenCalled();
    externalRenderer.unmount();
  });

  it('allows Ctrl/Cmd+S to save external SQL files from document-level targets', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    editorState.hasTextFocus = false;

    await act(async () => {
      create(<QueryEditor tab={createTab({ filePath })} />);
    });

    editorState.value = 'select 6;';
    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 's',
      target: document.body,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 6;');
    expect(messageApi.success).toHaveBeenCalledWith(expect.stringContaining('SQL 文件已保存'));
  });

  it('does not create saved queries when external SQL file writes fail', async () => {
    let renderer!: ReactTestRenderer;
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    backendApp.WriteSQLFile.mockResolvedValueOnce({ success: false, message: '磁盘只读' });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    editorState.value = 'select 4;';

    await act(async () => {
      await findButton(renderer!, '保存').props.onClick();
    });

    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 4;');
    expect(storeState.saveQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.error).toHaveBeenCalledWith('保存 SQL 文件失败：磁盘只读');
  });

  it('focuses the query name input when first saving a new query', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: '新建查询' })} />);
    });

    await act(async () => {
      findButton(renderer!, '保存').props.onClick();
      await Promise.resolve();
    });

    expect(saveQueryNameInputFocus).toHaveBeenCalledWith({ cursor: 'all' });
  });
});
