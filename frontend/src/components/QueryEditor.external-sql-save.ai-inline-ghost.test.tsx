import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import {
    create,
    createInlineAiHarnessService,
    storeState,
    backendApp,
    editorState,
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

  it('uses grounded AI inline ghost when manual completion is triggered in table-name context and inline AI is available', async () => {
    const inlineAiService = createInlineAiHarnessService();
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
      go: {
        aiservice: {
          Service: inlineAiService,
        },
      },
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM ';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };
    editorState.editor.trigger.mockClear();
    editorState.domNode.appendChild.mockClear();

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

    expect(inlineAiService.AISubmitAgentInput).toHaveBeenCalledTimes(1);
    expect(editorState.domNode.appendChild).toHaveBeenCalled();
    const ghostOverlay = editorState.domNode.appendChild.mock.calls[
      editorState.domNode.appendChild.mock.calls.length - 1
    ]?.[0];
    expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
    expect(ghostOverlay?.textContent).toBe('videos');
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('uses local SQL memory for manual inline completion in an empty editor', async () => {
    storeState.sqlLogs = [{
      id: 'sql-log-1',
      timestamp: Date.now(),
      sql: 'SELECT * FROM videos WHERE code = ?;',
      status: 'success',
      duration: 12,
      dbName: 'main',
    } as any];

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
      create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });

    editorState.value = '';
    editorState.position = { lineNumber: 1, column: 1 };
    editorState.editor.trigger.mockClear();
    editorState.domNode.appendChild.mockClear();

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
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.value).toBe('');
    expect(editorState.domNode.appendChild).toHaveBeenCalled();
    const ghostOverlay = editorState.domNode.appendChild.mock.calls[
      editorState.domNode.appendChild.mock.calls.length - 1
    ]?.[0];
    expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
    expect(ghostOverlay?.textContent).toBe('SELECT * FROM videos WHERE code = ?;');
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('uses local SQL memory for automatic inline completion in update table context', async () => {
    vi.useFakeTimers();
    try {
      storeState.sqlLogs = [{
        id: 'sql-log-2',
        timestamp: Date.now(),
        sql: 'UPDATE videos SET status = 1 WHERE id = ?;',
        status: 'success',
        duration: 9,
        dbName: 'main',
      } as any];

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
        create(<QueryEditor tab={createTab({ query: 'UPDAT', dbName: 'main' })} />);
      });

      editorState.value = 'UPDATE';
      editorState.position = { lineNumber: 1, column: 'UPDATE'.length + 1 };
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('UPDATE');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'E' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.domNode.appendChild).toHaveBeenCalled();
      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
      expect(ghostOverlay?.textContent).toBe(' videos SET status = 1 WHERE id = ?;');
      expect(editorState.editor.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore a table alias from SQL memory when automatic table aliases are disabled', async () => {
    vi.useFakeTimers();
    try {
      storeState.appearance.autoAddTableAlias = false;
      storeState.sqlLogs = [{
        id: 'sql-log-table-alias-memory',
        timestamp: Date.now(),
        sql: 'SELECT * FROM system_user AS su WHERE su.id = ?;',
        status: 'success',
        duration: 9,
        dbName: 'main',
      } as any];

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT * FROM system_user ';
      editorState.position = { lineNumber: 1, column: editorState.value.length + 1 };
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.(editorState.value);
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: ' ' }],
        }));
        vi.advanceTimersByTime(120);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.domNode.appendChild).not.toHaveBeenCalled();
      expect(editorState.editor.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a metadata-normalized inline ghost with the default Tab shortcut and preserves trailing SQL', async () => {
    vi.useFakeTimers();
    try {
      storeState.sqlLogs = [{
        id: 'sql-log-inline-case',
        timestamp: Date.now(),
        sql: 'SELECT * FROM a_cninfo_announcement WHERE id = 1;',
        status: 'success',
        duration: 12,
        dbName: 'main',
      } as any];

      const inlineAiService = createInlineAiHarnessService();
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [
          { TABLE_NAME: 'a_cninfo_announcement' },
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT * FROM A_C', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT * FROM A_C';
      editorState.position = { lineNumber: 1, column: 'SELECT * FROM A_C'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT * FROM A_C');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'C' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.textContent).toBe('ninfo_announcement WHERE id = 1;');

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
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

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({
          text: 'a_cninfo_announcement WHERE id = 1;',
          range: expect.objectContaining({
            startColumn: 15,
            endColumn: 18,
          }),
        })],
      );
      expect(editorState.value).toBe('SELECT * FROM a_cninfo_announcement WHERE id = 1;');
      expect(inlineAiService.AISubmitAgentInput).not.toHaveBeenCalled();
      expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume Tab when no AI inline ghost is visible', async () => {
    vi.useFakeTimers();
    try {
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
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.editor.executeEdits.mockClear();

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
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

      expect(monacoShortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(editorState.editor.executeEdits).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume Tab when the AI inline ghost is stale (cursor moved)', async () => {
    vi.useFakeTimers();
    try {
      const inlineAiService = createInlineAiHarnessService();
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      // 光标已移走,幽灵与当前位置不匹配
      editorState.position = { lineNumber: 1, column: 1 };

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
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

      expect(monacoShortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(editorState.editor.executeEdits).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the AI inline ghost with a rebound Right shortcut', async () => {
    vi.useFakeTimers();
    try {
      storeState.shortcutOptions.acceptSqlAiCompletion = {
        mac: { enabled: true, combo: 'Right' },
        windows: { enabled: true, combo: 'Right' },
      };

      const inlineAiService = createInlineAiHarnessService();
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const shortcutEvent = {
        type: 'keydown',
        key: 'ArrowRight',
        code: 'ArrowRight',
        keyCode: 39,
        which: 39,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
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

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({ text: expect.any(String) })],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the AI inline ghost with a rebound Shift+Tab shortcut', async () => {
    vi.useFakeTimers();
    try {
      storeState.shortcutOptions.acceptSqlAiCompletion = {
        mac: { enabled: true, combo: 'Shift+Tab' },
        windows: { enabled: true, combo: 'Shift+Tab' },
      };

      const inlineAiService = createInlineAiHarnessService();
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        isComposing: false,
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

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({ text: expect.any(String) })],
      );
      expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues accepted inline SQL ghost with grounded table AI completion', async () => {
    vi.useFakeTimers();
    try {
      const inlineAiService = createInlineAiHarnessService();
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const dispatchAcceptTab = () => {
        const shortcutEvent = {
          type: 'keydown',
          key: 'Tab',
          code: 'Tab',
          keyCode: 9,
          which: 9,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          isComposing: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        };
        const monacoShortcutEvent = {
          browserEvent: shortcutEvent,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        };
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
        return { monacoShortcutEvent, shortcutEvent };
      };

      await act(async () => {
        const { monacoShortcutEvent } = dispatchAcceptTab();
        expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
        expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({
          text: ' * FROM ',
        })],
      );
      expect(editorState.value).toBe('SELECT * FROM ');
      expect(inlineAiService.AISubmitAgentInput).toHaveBeenCalledTimes(1);
      expect(editorState.domNode.appendChild).toHaveBeenCalled();
      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
      expect(ghostOverlay?.textContent).toBe('videos');
      expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
        'gonavi-ai-inline-auto',
        'editor.action.triggerSuggest',
        undefined,
      );

      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();

      await act(async () => {
        dispatchAcceptTab();
        vi.advanceTimersByTime(1);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({
          text: 'videos',
        })],
      );
      expect(editorState.value).toBe('SELECT * FROM videos');
      expect(inlineAiService.AISubmitAgentInput).toHaveBeenCalledTimes(1);
      expect(editorState.editor.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips a stray backslash before keeping manual toolbar AI completion on the AI path', async () => {
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

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM \\', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM \\'.length + 1 };
    editorState.editor.executeEdits.mockClear();
    editorState.editor.trigger.mockClear();

    await act(async () => {
      findButton(renderer!, 'AI').props.onClick();
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-manual-sql-ai-strip-marker',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('keeps the AI dropdown completion action on the AI path instead of opening plain suggestions', async () => {
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { TABLE_NAME: 'videos' },
        { TABLE_NAME: 'visits' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM ';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };
    editorState.editor.trigger.mockClear();

    await act(async () => {
      findButton(renderer!, '触发 SQL AI 自动补全').props.onClick();
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
