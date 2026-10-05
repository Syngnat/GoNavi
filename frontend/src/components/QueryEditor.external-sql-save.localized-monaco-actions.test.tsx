import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    runtimeEventListeners,
    notifyStoreSubscribers,
    messageApi,
    monacoEditorMockState,
    defaultEditorContributionResolver,
    editorState,
    findEditorAction,
    findEditorActionLabels,
    getLastInjectedPrompt,
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

  it('localizes Monaco action labels for the active language', async () => {
    setCurrentLanguage('en-US');
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('gonavi.queryEditor.showObjectInfo')).toMatchObject({
      label: 'GoNavi: Show Object Info',
    });
    expect(findEditorAction('gonavi.runQuery')).toMatchObject({
      label: 'GoNavi: Run SQL',
    });
    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: 'Insert SQL Snippet',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToUppercase')).toMatchObject({
      label: 'convert to uppercase',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToLowercase')).toMatchObject({
      label: 'convert to lowercase',
    });
    expect(findEditorAction('gonavi.selectCurrentStatement')).toMatchObject({
      label: 'GoNavi: Select Current Line and Copy',
    });
    expect(findEditorAction('gonavi.duplicateCurrentLine')).toMatchObject({
      label: 'GoNavi: Duplicate Current Line Below',
    });
    expect(findEditorAction('gonavi.saveQuery')).toMatchObject({
      label: 'GoNavi: Save Query',
    });
  });

  it('refreshes Monaco action labels when languagePreference changes after mount', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('gonavi.queryEditor.showObjectInfo')).toMatchObject({
      label: 'GoNavi: 查看对象信息',
    });
    expect(findEditorAction('gonavi.runQuery')).toMatchObject({
      label: 'GoNavi: 执行 SQL',
    });
    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: '插入 SQL 片段',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToUppercase')).toMatchObject({
      label: '转大写',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToLowercase')).toMatchObject({
      label: '转小写',
    });
    expect(findEditorAction('gonavi.selectCurrentStatement')).toMatchObject({
      label: 'GoNavi: 选择当前行并复制',
    });
    expect(findEditorAction('gonavi.duplicateCurrentLine')).toMatchObject({
      label: 'GoNavi: 复制当前行到下一行',
    });
    expect(findEditorAction('gonavi.saveQuery')).toMatchObject({
      label: 'GoNavi: 保存查询',
    });

    await act(async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      notifyStoreSubscribers();
    });

    expect(findEditorActionLabels('gonavi.queryEditor.showObjectInfo')).toContain('GoNavi: Show Object Info');
    expect(findEditorActionLabels('gonavi.runQuery')).toContain('GoNavi: Run SQL');
    expect(findEditorActionLabels('gonavi.insertSqlSnippet')).toContain('Insert SQL Snippet');
    expect(findEditorActionLabels('gonavi.queryEditor.transformToUppercase')).toContain('convert to uppercase');
    expect(findEditorActionLabels('gonavi.queryEditor.transformToLowercase')).toContain('convert to lowercase');
    expect(findEditorActionLabels('gonavi.selectCurrentStatement')).toContain('GoNavi: Select Current Line and Copy');
    expect(findEditorActionLabels('gonavi.duplicateCurrentLine')).toContain('GoNavi: Duplicate Current Line Below');
    expect(findEditorActionLabels('gonavi.saveQuery')).toContain('GoNavi: Save Query');
    expect(findEditorAction('gonavi.queryEditor.showObjectInfo')).toMatchObject({
      label: 'GoNavi: Show Object Info',
    });
    expect(findEditorAction('gonavi.runQuery')).toMatchObject({
      label: 'GoNavi: Run SQL',
    });
    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: 'Insert SQL Snippet',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToUppercase')).toMatchObject({
      label: 'convert to uppercase',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToLowercase')).toMatchObject({
      label: 'convert to lowercase',
    });
    expect(findEditorAction('gonavi.selectCurrentStatement')).toMatchObject({
      label: 'GoNavi: Select Current Line and Copy',
    });
    expect(findEditorAction('gonavi.duplicateCurrentLine')).toMatchObject({
      label: 'GoNavi: Duplicate Current Line Below',
    });
    expect(findEditorAction('gonavi.saveQuery')).toMatchObject({
      label: 'GoNavi: Save Query',
    });
  });

  it('registers the SQL snippet context-menu action even when Monaco onMount is deferred', async () => {
    monacoEditorMockState.deferOnMount = true;

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: '插入 SQL 片段',
    });
  });

  it('refreshes AI context-menu labels when languagePreference changes after mount', async () => {
    storeState.aiPanelVisible = true;

    await act(async () => {
      create(<QueryEditor tab={createTab({ dbName: 'analytics' })} />);
    });

    expect(findEditorAction('ai.generateSQL')).toMatchObject({
      label: 'AI 生成 SQL',
    });
    expect(findEditorAction('ai.explainSQL')).toMatchObject({
      label: 'AI 解释 SQL',
    });
    expect(findEditorAction('ai.optimizeSQL')).toMatchObject({
      label: 'AI 优化 SQL',
    });

    await act(async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      notifyStoreSubscribers();
    });

    expect(findEditorActionLabels('ai.generateSQL')).toContain('AI Generate SQL');
    expect(findEditorActionLabels('ai.explainSQL')).toContain('AI Explain SQL');
    expect(findEditorActionLabels('ai.optimizeSQL')).toContain('AI Optimize SQL');
    expect(findEditorAction('ai.generateSQL')).toMatchObject({
      label: 'AI Generate SQL',
    });
    expect(findEditorAction('ai.explainSQL')).toMatchObject({
      label: 'AI Explain SQL',
    });
    expect(findEditorAction('ai.optimizeSQL')).toMatchObject({
      label: 'AI Optimize SQL',
    });

    await act(async () => {
      await findEditorAction('ai.generateSQL').run({
        getModel: () => ({ getValueInRange: () => '' }),
        getSelection: () => null,
      });
    });

    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "analytics", database version unknown.\nGenerate a query based on the current database schema.',
    );
  });

  it('refreshes slash command labels descriptions and prompt seeds when languagePreference changes after mount', async () => {
    vi.useFakeTimers();
    try {
      storeState.aiPanelVisible = true;

      await act(async () => {
        create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
      });

      const slashProvider = editorState.providers.find((provider: any) =>
        Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('/'),
      );
      expect(slashProvider).toBeTruthy();

      await act(async () => {
        storeState.languagePreference = 'en-US';
        setCurrentLanguage('en-US');
        notifyStoreSubscribers();
      });

      const completionItems = await slashProvider.provideCompletionItems(
        {
          getLineContent: () => '/',
        },
        { lineNumber: 1, column: 2 },
      );

      expect(completionItems.suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: '/query  🔍 Natural language query',
            detail: 'Describe what you want to query',
          }),
          expect.objectContaining({
            label: '/schema  🏗️ Table design review',
            detail: 'Review table structure design quality',
          }),
        ]),
      );

      const slashCmdDefs = (window as any).__gonaviSlashCmdDefs;
      expect(slashCmdDefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cmd: '/sql',
            label: '📝 Generate SQL',
            desc: 'Describe the requirement and generate a statement',
            prompt: 'Generate SQL for this requirement:',
          }),
          expect.objectContaining({
            cmd: '/explain',
            label: '💡 Explain SQL',
            desc: 'Explain the selected SQL logic',
            prompt: 'Explain the execution logic of this SQL statement:\n```sql\n{SQL}\n```',
          }),
        ]),
      );

      editorState.value = '__AI_SQL__\nselect 1;';
      await act(async () => {
        editorState.contentChangeListeners.forEach((listener) => (listener as any)({
          changes: [{ text: '__AI_SQL__' }],
        }));
        await Promise.resolve();
        vi.runAllTimers();
      });

      expect(getLastInjectedPrompt()).toBe(
        'Context: mysql "local", selected database "main", database version unknown.\nGenerate SQL for this requirement:',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "No copyable content on the current line." in English when selecting an empty current line', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    messageApi.info.mockReset();

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '', readOnly: true })} />);
    });

    const selectCurrentStatementAction = findEditorAction('gonavi.selectCurrentStatement');
    expect(selectCurrentStatementAction).toBeTruthy();

    await act(async () => {
      await selectCurrentStatementAction.run();
    });

    expect(messageApi.info).toHaveBeenCalledWith('No copyable content on the current line.');
    expect(messageApi.info).not.toHaveBeenCalledWith('当前行没有可复制内容。');
  });

  it('selects and copies only the current line when the editor content uses CRLF line endings', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    const sql = [
      'SELECT * FROM first_table;',
      '',
      'SELECT * FROM second_table;',
      '',
      'SELECT a.id, a.name FROM third_table a ORDER BY a.id;',
    ].join('\r\n');
    editorState.position = { lineNumber: 5, column: 18 };
    editorState.selection = null;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: sql, readOnly: true })} />);
    });

    const selectCurrentStatementAction = findEditorAction('gonavi.selectCurrentStatement');
    expect(selectCurrentStatementAction).toBeTruthy();

    await act(async () => {
      await selectCurrentStatementAction.run();
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(editorState.selection).toMatchObject({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 'SELECT a.id, a.name FROM third_table a ORDER BY a.id;'.length + 1,
    });
  });

  it('falls back to the browser clipboard when the Monaco copy command is unavailable', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    (document.execCommand as any).mockReturnValueOnce(false);

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;

    const selectCurrentStatementAction = findEditorAction('gonavi.selectCurrentStatement');
    expect(selectCurrentStatementAction).toBeTruthy();

    await act(async () => {
      await selectCurrentStatementAction.run();
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('SELECT 2 AS two;');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'SELECT 2 AS two;'.length + 1,
    });
  });

  it('duplicates the current line below and keeps the caret column', async () => {
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };
    editorState.position = { lineNumber: 2, column: 6 };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nFROM dual',
        readOnly: true,
      })} />);
    });

    const duplicateCurrentLineAction = findEditorAction('gonavi.duplicateCurrentLine');
    expect(duplicateCurrentLineAction).toBeTruthy();

    await act(async () => {
      duplicateCurrentLineAction.run();
    });

    expect(editorState.value).toBe('SELECT 1;\nFROM dual\nFROM dual');
    expect(editorState.position).toEqual({ lineNumber: 3, column: 6 });
    expect(editorState.selection).toMatchObject({
      startLineNumber: 3,
      startColumn: 6,
      endLineNumber: 3,
      endColumn: 6,
    });
    expect(editorState.editor.pushUndoStop).toHaveBeenCalled();
  });

  it('intercepts Ctrl/Cmd+E at window level and copies the current line instead of leaking to host search', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+E' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+E' };
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
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    (window.dispatchEvent as any).mockClear();
    (navigator.clipboard.writeText as any).mockClear();

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 'e',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(editorState.editor.setSelections).not.toHaveBeenCalled();
    expect(editorState.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'SELECT 2 AS two;'.length + 1,
    });
    expect(
      (window.dispatchEvent as any).mock.calls.map((call: any[]) => call[0]?.type),
    ).not.toContain('gonavi:find-active-query');
  });

  it('keeps SQL editor search on Cmd+F only and suppresses Monaco Cmd+E find-with-selection', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: false, combo: '' };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    (window.dispatchEvent as any).mockClear();
    (document.execCommand as any).mockClear();

    expect(findEditorAction('gonavi.findInEditor')).toMatchObject({
      keybindings: [2048 | 70],
    });

    const suppressMacFindAction = findEditorAction('gonavi.suppressMacFindWithSelection');
    expect(suppressMacFindAction).toMatchObject({
      keybindings: [2048 | 69],
    });

    await act(async () => {
      suppressMacFindAction.run();
      await Promise.resolve();
    });

    expect(
      (window.dispatchEvent as any).mock.calls.map((call: any[]) => call[0]?.type),
    ).not.toContain('gonavi:find-active-query');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('leaves Ctrl/Cmd+A inside Monaco find inputs while retaining the editor fallback', async () => {
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
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM users' })} />);
    });

    const OriginalHTMLElement = globalThis.HTMLElement;
    class EditableInputTarget {
      tagName = 'INPUT';
      isContentEditable = false;
      closest = vi.fn(() => null);
    }
    vi.stubGlobal('HTMLElement', EditableInputTarget as any);

    editorState.editor.trigger.mockClear();
    editorState.editor.focus.mockClear();
    const findInputEvent = {
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: 'a',
      target: new EditableInputTarget(),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(findInputEvent));
    });

    expect(findInputEvent.preventDefault).not.toHaveBeenCalled();
    expect(findInputEvent.stopPropagation).not.toHaveBeenCalled();
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith('keyboard', 'editor.action.selectAll', null);
    expect(editorState.editor.focus).not.toHaveBeenCalled();

    const documentLevelEvent = {
      ...findInputEvent,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(documentLevelEvent));
    });

    expect(documentLevelEvent.preventDefault).toHaveBeenCalled();
    expect(documentLevelEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.editor.trigger).toHaveBeenCalledWith('keyboard', 'editor.action.selectAll', null);
    vi.stubGlobal('HTMLElement', OriginalHTMLElement);
  });

  it('intercepts Ctrl/Cmd+D at window level and duplicates the current line below', async () => {
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] = (windowListeners[type] || []).filter((item) => item !== listener);
      }),
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
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    (window.dispatchEvent as any).mockClear();

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 'd',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT 1;\nSELECT 2 AS two;\nSELECT 2 AS two;\nSELECT 3;');
    expect(editorState.position).toEqual({ lineNumber: 3, column: 8 });
    expect(
      (window.dispatchEvent as any).mock.calls.map((call: any[]) => call[0]?.type),
    ).not.toContain('gonavi:find-active-query');
  });

  it('responds to the macOS native Cmd+E fallback event and copies the current line', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+E' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+E' };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    (document.execCommand as any).mockClear();

    const nativeListeners = runtimeEventListeners.get('gonavi:native-select-current-line');
    expect(nativeListeners?.size ?? 0).toBeGreaterThan(0);

    await act(async () => {
      nativeListeners?.forEach((listener) => listener());
      await Promise.resolve();
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(editorState.editor.setSelections).not.toHaveBeenCalled();
    expect(editorState.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'SELECT 2 AS two;'.length + 1,
    });
  });

  it('uses the last tracked cursor position for the macOS native Cmd+E fallback when the live cursor is unavailable', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+E' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+E' };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });

    await act(async () => {
      editorState.cursorPositionListeners.forEach((listener) => listener({
        position: { lineNumber: 2, column: 8 },
      }));
    });
    editorState.position = null as any;
    editorState.selection = null;
    (document.execCommand as any).mockClear();

    const nativeListeners = runtimeEventListeners.get('gonavi:native-select-current-line');
    expect(nativeListeners?.size ?? 0).toBeGreaterThan(0);

    await act(async () => {
      nativeListeners?.forEach((listener) => listener());
      await Promise.resolve();
    });

    expect(editorState.editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 8 });
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
  });

  it('shows the object info miss toast in English when the cursor is not on a recognized table or column', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    messageApi.info.mockReset();

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select 1;', dbName: 'main' })} />);
    });

    const showObjectInfoAction = findEditorAction('gonavi.queryEditor.showObjectInfo');
    expect(showObjectInfoAction).toBeTruthy();

    editorState.position = { lineNumber: 1, column: 2 };
    await act(async () => {
      await showObjectInfoAction.run();
    });

    expect(messageApi.info).toHaveBeenCalledWith(expect.objectContaining({
      key: 'gonavi-query-editor-object-info-miss',
      content: 'The cursor is not on a recognized table or column.',
    }));
    expect(messageApi.info).not.toHaveBeenCalledWith(expect.objectContaining({
      content: '当前光标未定位到可识别的表或字段。',
    }));
  });

  it('localizes AI context menu labels in English', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('ai.generateSQL')).toMatchObject({
      label: 'AI Generate SQL',
    });
    expect(findEditorAction('ai.explainSQL')).toMatchObject({
      label: 'AI Explain SQL',
    });
    expect(findEditorAction('ai.optimizeSQL')).toMatchObject({
      label: 'AI Optimize SQL',
    });

    expect(findEditorActionLabels('ai.generateSQL')).not.toContain('🤖 AI 生成 SQL');
    expect(findEditorActionLabels('ai.explainSQL')).not.toContain('🤖 AI 解释 SQL');
    expect(findEditorActionLabels('ai.optimizeSQL')).not.toContain('🤖 AI 优化 SQL');
  });

  it('opens the SQL snippet picker from the context menu action and inserts the selected snippet', async () => {
    storeState.appearance.newQuerySqlTemplate = '';
    storeState.sqlSnippets = [
      {
        id: 'snippet-select-user',
        prefix: 'selu',
        name: 'Select User',
        description: 'Select rows from the user table',
        body: 'SELECT ${1:id} FROM ${2:user_table}$0;',
        isBuiltin: false,
        createdAt: 1,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    await act(async () => {
      await findEditorAction('gonavi.insertSqlSnippet').run();
    });

    expect(renderer.root.findByProps({ 'data-query-editor-snippet-picker': 'true' })).toBeTruthy();

    await act(async () => {
      renderer.root.findByProps({
        'data-query-editor-snippet-item': 'snippet-select-user',
      }).props.onClick();
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-insert-sql-snippet',
      [expect.objectContaining({
        text: 'SELECT id FROM user_table;',
      })],
    );
    expect(editorState.value).toBe('SELECT id FROM user_table;');
    expect(renderer.root.findAllByProps({ 'data-query-editor-snippet-picker': 'true' })).toHaveLength(0);
  });

  it('prefers Monaco snippet controller insertion when the controller is available', async () => {
    storeState.appearance.newQuerySqlTemplate = '';
    storeState.sqlSnippets = [
      {
        id: 'snippet-alter-table',
        prefix: 'alt',
        name: 'ALTER TABLE',
        description: 'ALTER TABLE add column template',
        body: 'ALTER TABLE ${1:table_name}\\nADD COLUMN ${2:column_name} VARCHAR(255);$0',
        isBuiltin: true,
        createdAt: 1,
      },
    ];

    const snippetController = {
      insert: vi.fn((body: string) => {
        expect(body).toBe('ALTER TABLE ${1:table_name}\\nADD COLUMN ${2:column_name} VARCHAR(255);$0');
        editorState.value = 'ALTER TABLE demo_table\nADD COLUMN user_name VARCHAR(255);';
      }),
    };
    editorState.editor.getContribution.mockImplementation((id: string) => {
      if (id === 'snippetController2') {
        return snippetController;
      }
      return defaultEditorContributionResolver(editorState)(id);
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    await act(async () => {
      await findEditorAction('gonavi.insertSqlSnippet').run();
    });

    await act(async () => {
      renderer.root.findByProps({
        'data-query-editor-snippet-item': 'snippet-alter-table',
      }).props.onClick();
    });

    expect(snippetController.insert).toHaveBeenCalledTimes(1);
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi.insertSqlSnippet',
      'editor.action.insertSnippet',
      expect.anything(),
    );
    expect(editorState.editor.executeEdits).not.toHaveBeenCalled();
    expect(editorState.value).toBe('ALTER TABLE demo_table\nADD COLUMN user_name VARCHAR(255);');
    expect(renderer.root.findAllByProps({ 'data-query-editor-snippet-picker': 'true' })).toHaveLength(0);
  });

  it('builds localized AI context prefix for QueryEditor prompt injection', async () => {
    storeState.languagePreference = 'en-US';
    storeState.aiPanelVisible = true;
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab({ dbName: 'analytics' })} />);
    });

    const generateAction = findEditorAction('ai.generateSQL');

    await act(async () => {
      await generateAction.run({
        getModel: () => ({ getValueInRange: () => '' }),
        getSelection: () => null,
      });
    });

    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "analytics", database version unknown.\nGenerate a query based on the current database schema.',
    );
    expect(getLastInjectedPrompt()).not.toContain('上下文环境：');
    expect(getLastInjectedPrompt()).toContain('"local"');
    expect(getLastInjectedPrompt()).toContain('"analytics"');
  });

  it('injects localized context-menu AI prompts for generate explain and optimize actions', async () => {
    storeState.languagePreference = 'en-US';
    storeState.aiPanelVisible = true;
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab({ dbName: 'main' })} />);
    });

    const selection = 'select * from users';
    const actionEditor = {
      getModel: () => ({ getValueInRange: () => selection }),
      getSelection: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: selection.length + 1,
      }),
    };

    await act(async () => {
      await findEditorAction('ai.generateSQL').run(actionEditor);
    });
    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "main", database version unknown.\nGenerate a query based on the current database schema.',
    );

    await act(async () => {
      await findEditorAction('ai.explainSQL').run(actionEditor);
    });
    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "main", database version unknown.\nExplain the execution logic of this SQL statement:\n```sql\nselect * from users\n```',
    );
    expect(getLastInjectedPrompt()).not.toContain('请解释以下 SQL');

    await act(async () => {
      await findEditorAction('ai.optimizeSQL').run(actionEditor);
    });
    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "main", database version unknown.\nAnalyze this SQL statement for performance issues and suggest optimizations:\n```sql\nselect * from users\n```',
    );
    expect(getLastInjectedPrompt()).not.toContain('请分析以下 SQL');
  });

  it('renders localized slash command completion labels descriptions and prompt seeds', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    const slashProvider = editorState.providers.find((provider: any) =>
      Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('/'),
    );
    expect(slashProvider).toBeTruthy();

    const completionItems = await slashProvider.provideCompletionItems(
      {
        getLineContent: () => '/',
      },
      { lineNumber: 1, column: 2 },
    );

    expect(completionItems.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '/query  🔍 Natural language query',
          detail: 'Describe what you want to query',
        }),
        expect.objectContaining({
          label: '/schema  🏗️ Table design review',
          detail: 'Review table structure design quality',
        }),
      ]),
    );

    const slashCmdDefs = (window as any).__gonaviSlashCmdDefs;
    expect(slashCmdDefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cmd: '/sql',
          label: '📝 Generate SQL',
          desc: 'Describe the requirement and generate a statement',
          prompt: 'Generate SQL for this requirement:',
        }),
        expect.objectContaining({
          cmd: '/explain',
          label: '💡 Explain SQL',
          desc: 'Explain the selected SQL logic',
          prompt: 'Explain the execution logic of this SQL statement:\n```sql\n{SQL}\n```',
        }),
      ]),
    );
    expect(JSON.stringify(slashCmdDefs)).not.toContain('自然语言查询');
    expect(JSON.stringify(slashCmdDefs)).not.toContain('请根据以下需求生成 SQL：');
  });

  it('replaces slash markers and injects the localized prompt', async () => {
    vi.useFakeTimers();
    try {
      storeState.languagePreference = 'en-US';
      storeState.aiPanelVisible = true;
      setCurrentLanguage('en-US');

      await act(async () => {
        create(<QueryEditor tab={createTab({ dbName: 'analytics', query: 'select 1;' })} />);
      });
      editorState.value = '__AI_SQL__\nselect 1;';

      await act(async () => {
        editorState.contentChangeListeners.forEach((listener) => (listener as any)({
          changes: [{ text: '__AI_SQL__' }],
        }));
        await Promise.resolve();
        vi.runAllTimers();
      });

      expect(editorState.value).toBe('select 1;');
      expect(getLastInjectedPrompt()).toBe(
        'Context: mysql "local", selected database "analytics", database version unknown.\nGenerate SQL for this requirement:',
      );
      expect(getLastInjectedPrompt()).not.toContain('请根据以下需求生成 SQL：');
    } finally {
      vi.useRealTimers();
    }
  });
});
