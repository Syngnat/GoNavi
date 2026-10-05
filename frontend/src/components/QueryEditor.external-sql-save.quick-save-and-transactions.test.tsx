import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import { catalogs } from '../i18n/catalog';
import type { SavedQuery, TabData } from '../types';
import { QUERY_TAB_RENAME_REQUEST_EVENT } from '../utils/queryTabTitle';
import { getQueryTabDraft, getSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import QueryEditor from './QueryEditor';
import QueryEditorToolbar from './QueryEditorToolbar';
import {
    create,
    storeState,
    storeSubscribers,
    notifyStoreSubscribers,
    backendApp,
    messageApi,
    dataGridState,
    antdSelectState,
    editorState,
    textContent,
    findButton,
    findExactButton,
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

  it('keeps saved query quick-save behavior for non-file tabs', async () => {
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
    storeState.saveQuery.mockImplementationOnce(async (savedQuery: SavedQuery) => {
      storeState.savedQueries = storeState.savedQueries.map((item) => (
        item.id === savedQuery.id ? savedQuery : item
      ));
      storeSubscribers.forEach((subscriber) => subscriber());
      return savedQuery;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
    });
    expect(getQueryTabDraft('tab-1')).toBe('select 3;');

    await act(async () => {
      await findButton(renderer!, '保存').props.onClick();
    });

    expect(backendApp.WriteSQLFile).not.toHaveBeenCalled();
    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 3;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }));
    expect(getQueryTabDraft('tab-1')).toBe('');
  });

  it('saves a copy of an existing query without overwriting the original', async () => {
    const originalQuery: SavedQuery = {
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 1;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    };
    storeState.savedQueries = [originalQuery];
    const sourceTab = createTab({
      id: originalQuery.id,
      title: originalQuery.name,
      query: originalQuery.sql,
      savedQueryId: originalQuery.id,
    });
    storeState.tabs = [sourceTab];
    storeState.addTab.mockImplementation((nextTab: TabData) => {
      const existingIndex = storeState.tabs.findIndex((item) => item.id === nextTab.id);
      storeState.tabs = existingIndex >= 0
        ? storeState.tabs.map((item, index) => index === existingIndex ? { ...item, ...nextTab } : item)
        : [...storeState.tabs, nextTab];
      storeState.activeTabId = nextTab.id;
      notifyStoreSubscribers();
    });
    storeState.saveQuery.mockImplementation(async (savedQuery: SavedQuery) => {
      const existing = storeState.savedQueries.some((item) => item.id === savedQuery.id);
      storeState.savedQueries = existing
        ? storeState.savedQueries.map((item) => item.id === savedQuery.id ? savedQuery : item)
        : [...storeState.savedQueries, savedQuery];
      notifyStoreSubscribers();
      return savedQuery;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={sourceTab} />);
    });

    await act(async () => {
      editorState.value = 'select 9;';
      editorState.latestOnChange?.(editorState.value);
      findButton(renderer!, '另存为').props.onClick();
    });
    await act(async () => {
      const saveAsButtons = renderer!.root.findAll(
        (node) => node.type === 'button' && textContent(node) === '另存为',
      );
      await saveAsButtons[saveAsButtons.length - 1]?.props.onClick();
    });

    const copiedQuery = storeState.saveQuery.mock.calls[0]?.[0] as SavedQuery;
    expect(copiedQuery).toEqual(expect.objectContaining({
      name: '查询',
      sql: 'select 9;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
    expect(copiedQuery.id).not.toBe(originalQuery.id);
    expect(copiedQuery.createdAt).not.toBe(originalQuery.createdAt);
    expect(storeState.savedQueries).toEqual(expect.arrayContaining([originalQuery, copiedQuery]));
    expect(storeState.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: copiedQuery.id,
      title: '查询',
      savedQueryId: copiedQuery.id,
      query: 'select 9;',
    }));
    expect(storeState.tabs).toEqual(expect.arrayContaining([
      sourceTab,
      expect.objectContaining({
        id: copiedQuery.id,
        savedQueryId: copiedQuery.id,
        query: 'select 9;',
      }),
    ]));
    expect(storeState.activeTabId).toBe(copiedQuery.id);
    expect(getQueryTabDraft(sourceTab.id)).toBe('select 9;');
    expect(getQueryTabDraft(copiedQuery.id)).toBe('');
  });

  it('keeps edits made while a saved-query write is pending', async () => {
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
    let finishSave!: () => void;
    storeState.saveQuery.mockImplementationOnce((savedQuery: SavedQuery) => new Promise((resolve) => {
      finishSave = () => {
        storeState.savedQueries = storeState.savedQueries.map((item) => (
          item.id === savedQuery.id ? savedQuery : item
        ));
        notifyStoreSubscribers();
        resolve(savedQuery);
      };
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      savePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select 2;' }));

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
      finishSave();
      await savePromise;
    });

    expect(storeState.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      savedQueryId: 'saved-1',
      query: 'select 3;',
    }));
    expect(getQueryTabDraft('tab-1')).toBe('select 3;');
  });

  it('keeps edits made while an external SQL file write is pending', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    let finishWrite!: () => void;
    backendApp.WriteSQLFile.mockImplementationOnce(() => new Promise((resolve) => {
      finishWrite = () => resolve({ success: true });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      savePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 2;');

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
      finishWrite();
      await savePromise;
    });

    expect(storeState.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      filePath,
      query: 'select 3;',
    }));
    expect(getSQLFileTabDraft('tab-1')).toBe('select 3;');
  });

  it('does not reopen an external SQL file tab after a pending write outlives the editor', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    let finishWrite!: () => void;
    backendApp.WriteSQLFile.mockImplementationOnce(() => new Promise((resolve) => {
      finishWrite = () => resolve({ success: true });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      savePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      finishWrite();
      await savePromise;
    });

    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.success).not.toHaveBeenCalled();
  });

  it('serializes repeated saved-query writes so the newest content is persisted last', async () => {
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
    const finishWrites: Array<() => void> = [];
    storeState.saveQuery.mockImplementation((savedQuery: SavedQuery) => new Promise((resolve) => {
      finishWrites.push(() => {
        storeState.savedQueries = storeState.savedQueries.map((item) => (
          item.id === savedQuery.id ? savedQuery : item
        ));
        notifyStoreSubscribers();
        resolve(savedQuery);
      });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    let firstSavePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      firstSavePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });

    let secondSavePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
      secondSavePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    expect(storeState.saveQuery).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishWrites[0]();
      await firstSavePromise;
      await Promise.resolve();
    });
    expect(storeState.saveQuery).toHaveBeenCalledTimes(2);
    expect(storeState.saveQuery).toHaveBeenLastCalledWith(expect.objectContaining({ sql: 'select 3;' }));

    await act(async () => {
      finishWrites[1]();
      await secondSavePromise;
    });
    expect(storeState.savedQueries[0].sql).toBe('select 3;');
    expect(getQueryTabDraft('tab-1')).toBe('');
  });

  it('keeps the latest editor draft when saved-query metadata rerenders', async () => {
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

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
    });
    expect(getQueryTabDraft('tab-1')).toBe('select 3;');

    await act(async () => {
      renderer.update(
        <QueryEditor tab={createTab({ title: '已重命名查询', savedQueryId: 'saved-1' })} />,
      );
    });

    expect(getQueryTabDraft('tab-1')).toBe('select 3;');
  });

  it('keeps untitled fallback when the new query tab title is localized', async () => {
    setCurrentLanguage('en-US');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: 'New Query', savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 8;';

    await act(async () => {
      findButton(renderer!, 'Save').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: 'Untitled query',
      sql: 'select 8;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
  });

  it('keeps untitled fallback after a language switch when the tab title came from another locale', async () => {
    setCurrentLanguage('ja-JP');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: 'New Query', savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 10;';

    await act(async () => {
      findButton(renderer!, '保存').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '無題のクエリ',
      sql: 'select 10;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
  });

  it('keeps untitled fallback for database-scoped new query titles after a language switch', async () => {
    setCurrentLanguage('ja-JP');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: 'New query (main)', savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 11;';

    await act(async () => {
      findButton(renderer!, '保存').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '無題のクエリ',
      sql: 'select 11;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
  });

  it('renames saved queries without creating a new saved query id', async () => {
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

    editorState.value = 'select 9;';
    await act(async () => {
      findButton(renderer!, '重命名查询').props.onClick();
    });
    await act(async () => {
      await findExactButton(renderer!, '重命名').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '查询',
      sql: 'select 9;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }));
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: '查询',
      savedQueryId: 'saved-1',
    }));
    expect(messageApi.success).toHaveBeenCalledWith('查询已重命名。');
  });

  it('opens the existing rename flow for the query tab context-menu request', async () => {
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

    const renameRequestListenerCalls = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === QUERY_TAB_RENAME_REQUEST_EVENT);
    const renameRequestListener = renameRequestListenerCalls[renameRequestListenerCalls.length - 1]?.[1];
    expect(renameRequestListener).toBeTypeOf('function');

    await act(async () => {
      renameRequestListener(new CustomEvent(QUERY_TAB_RENAME_REQUEST_EVENT, {
        detail: { tabId: 'another-tab' },
      }));
    });
    expect(findExactButton(renderer!, '重命名')).toBeUndefined();

    await act(async () => {
      renameRequestListener(new CustomEvent(QUERY_TAB_RENAME_REQUEST_EVENT, {
        detail: { tabId: 'tab-1' },
      }));
    });
    expect(findExactButton(renderer!, '重命名')).toBeTruthy();
  });

  it('exports the current editor SQL without changing saved query state', async () => {
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

    editorState.value = 'select 10;';
    await act(async () => {
      await findButton(renderer!, '导出 SQL 文件').props.onClick();
    });

    expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
    expect(storeState.saveQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalledWith(expect.objectContaining({
      query: 'select 10;',
    }));
    expect(messageApi.success).toHaveBeenCalledWith('SQL 文件已导出。');
  });

  it('downloads SQL directly in the web runtime without invoking the desktop export dialog', async () => {
    storeState.savedQueries = [{
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 1;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    (window as any).__GONAVI_WEB_RUNTIME__ = { buildType: 'web' };
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
    };
    (document.createElement as any).mockReturnValueOnce(anchor);
    (document.body as any).removeChild = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:web-sql');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    editorState.value = 'select 10;';

    await act(async () => {
      await findButton(renderer, '导出 SQL 文件').props.onClick();
    });

    expect(backendApp.ExportSQLFile).not.toHaveBeenCalled();
    expect(anchor).toMatchObject({ href: 'blob:web-sql', download: '常用查询.sql' });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:web-sql');
    expect(messageApi.success).toHaveBeenCalledWith('SQL 文件已导出。');
  });

  describe('export sql file toast localization', () => {
    const prepareSavedQueryExport = async () => {
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

      editorState.value = 'select 10;';
      return renderer;
    };

    it('shows the English success toast after exporting a SQL file', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.success).toHaveBeenCalledWith('SQL file exported.');
      expect(messageApi.success).not.toHaveBeenCalledWith('SQL 文件已导出！');
    });

    it('shows the English response failure toast while preserving the raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      backendApp.ExportSQLFile.mockResolvedValueOnce({ success: false, message: 'disk full' });
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.error).toHaveBeenCalledWith('Export SQL file failed: disk full');
      expect(messageApi.error).not.toHaveBeenCalledWith('导出 SQL 文件失败: disk full');
    });

    it('shows the English rejected failure toast while preserving the raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      backendApp.ExportSQLFile.mockRejectedValueOnce(new Error('permission denied'));
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.error).toHaveBeenCalledWith('Export SQL file failed: permission denied');
      expect(messageApi.error).not.toHaveBeenCalledWith('导出 SQL 文件失败: permission denied');
    });

    it('falls back to the English unknown detail when export SQL file rejection has no usable detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      backendApp.ExportSQLFile.mockRejectedValueOnce({});
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.error).toHaveBeenCalledWith('Export SQL file failed: Unknown');
      expect(messageApi.error).not.toHaveBeenCalledWith('Export SQL file failed: [object Object]');
      expect(messageApi.error).not.toHaveBeenCalledWith('导出 SQL 文件失败：未知');
    });
  });

  it('shows Chinese semantic meaning for SQL execution errors', async () => {

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'pq: syntax error at or near "from"',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * from' })} />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pageText = textContent(renderer!.root);
    expect(pageText).toContain('SQL 执行日志');
    expect(pageText).toContain('执行失败');
    expect(pageText).toContain('中文语义：SQL 语法错误');
    expect(pageText).toContain('处理建议：');
    expect(pageText).toContain('原始错误：pq: syntax error at or near "from"');
  });

  it('runs SQL editor DML through a pending managed transaction and commits manually', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-1',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 2 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET name = 'new' WHERE id = 1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('UPDATE users SET name'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(textContent(renderer!.root)).not.toContain('未提交');
    expect(textContent(renderer!.root)).toContain('提交');
    expect(textContent(renderer!.root)).toContain('影响行数：2');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-1',
      dbType: 'mysql',
      dbName: 'main',
      statements: ["UPDATE users SET name = 'new' WHERE id = 1"],
      executionDurationMs: expect.any(Number),
    });

    const latestConnectionSelect = [...antdSelectState.props].reverse().find((props) => (
      props.placeholder === catalogs['zh-CN']['query_editor.placeholder.connection']
    ));
    const latestDatabaseSelect = [...antdSelectState.props].reverse().find((props) => (
      props.placeholder === catalogs['zh-CN']['query_editor.placeholder.database']
    ));
    expect(latestConnectionSelect?.disabled).toBe(true);
    expect(latestDatabaseSelect?.disabled).toBe(true);

    await act(async () => {
      latestDatabaseSelect?.onChange('analytics');
    });
    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ dbName: 'analytics' }),
    );

    await act(async () => {
      await findButton(renderer!, '提交').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-1', 'manual');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "START TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nCOMMIT;",
      status: 'success',
      dbName: 'main',
    }));
    expect(textContent(renderer!.root)).not.toContain('未提交');
  });

  it('locks the query context while a managed transaction request is in flight', async () => {
    let resolveTransaction!: (value: any) => void;
    backendApp.DBQueryMultiTransactional.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTransaction = resolve;
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET name = 'new' WHERE id = 1" })} />);
    });

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = Promise.resolve(findButton(renderer!, '运行').props.onClick());
      await vi.waitFor(() => {
        expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
      });
    });

    const inFlightToolbar = renderer.root.findByType(QueryEditorToolbar);
    expect(inFlightToolbar.props.contextSelectionDisabled).toBe(true);

    await act(async () => {
      inFlightToolbar.props.onDatabaseChange('analytics');
    });
    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ dbName: 'analytics' }),
    );
    expect(renderer.root.findByType(QueryEditorToolbar).props.currentDb).toBe('main');

    await act(async () => {
      resolveTransaction({
        success: true,
        transactionId: 'tx-in-flight',
        transactionPending: true,
        data: [],
      });
      await runPromise;
    });

    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-in-flight',
      dbName: 'main',
    });
    expect(renderer.root.findByType(QueryEditorToolbar).props.contextSelectionDisabled).toBe(true);
  });

  it('keeps DML with a trailing line comment in a pending managed transaction', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-comment',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'DELETE FROM users WHERE id = 1; -- keep this operation pending',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      'DELETE FROM users WHERE id = 1',
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-comment',
      dbType: 'mysql',
      statements: ['DELETE FROM users WHERE id = 1'],
    });
  });

  it('keeps TDengine insert on the regular query path because it has no managed transaction support', async () => {
    storeState.connections[0].config.type = 'tdengine';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'INSERT INTO meters(ts, current) VALUES (NOW, 10.2)',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('INSERT INTO meters'),
      'query-1',
    );
    expect(backendApp.DBQueryMultiTransactional).not.toHaveBeenCalled();
    expect(messageApi.error).not.toHaveBeenCalledWith(expect.stringContaining('SQL 编辑器托管事务'));
    expect(textContent(renderer!.root)).toContain('影响行数：1');
  });

  it('reuses the pending managed transaction for follow-up read-only SQL in the same tab', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-1',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });
    backendApp.DBQueryMultiInTransaction.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-1',
      transactionPending: true,
      data: [
        { columns: ['name'], rows: [{ name: 'new' }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET name = 'new' WHERE id = 1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: 'SELECT name FROM users WHERE id = 1' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
    expect(backendApp.DBQueryMultiInTransaction).toHaveBeenCalledWith(
      'tx-1',
      expect.stringContaining('SELECT name FROM users'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(dataGridState.latestProps?.columnNames).toEqual(['name']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ name: 'new' });
    expect(textContent(renderer!.root)).toContain('提交');
    expect(textContent(renderer!.root)).toContain('回滚');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      statements: [
        "UPDATE users SET name = 'new' WHERE id = 1",
        'SELECT name FROM users WHERE id = 1',
      ],
      statementCount: 2,
    });

    await act(async () => {
      await findButton(renderer!, '提交').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "START TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nSELECT name FROM users WHERE id = 1;\nCOMMIT;",
      status: 'success',
    }));
  });

  it('runs SQL editor WITH DML through a pending managed transaction', async () => {
    const sql = 'WITH target AS (SELECT id FROM users WHERE active = 1) UPDATE users SET synced = 1 WHERE id IN (SELECT id FROM target)';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-with-dml',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 2 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('WITH target AS'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(textContent(renderer!.root)).not.toContain('未提交');
    expect(textContent(renderer!.root)).toContain('提交');

    await act(async () => {
      await findButton(renderer!, '提交').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-with-dml', 'manual');
  });
});
