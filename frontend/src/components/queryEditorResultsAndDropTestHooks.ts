// 拆分后各场景文件共用的 describe 级 beforeEach / afterEach。
import { act } from 'react-test-renderer';
import { vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import type { SavedQuery } from '../types';
import { clearQueryEditorResultSession } from '../utils/queryEditorResultSessionCache';
import { clearQueryTabDraft, clearSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import {
  storeState,
  storeSubscribers,
  backendApp,
  nativeDetachedWindowState,
  messageApi,
  dataGridState,
  tabsState,
  autoFetchState,
  editorState,
} from './queryEditorResultsAndDropTestState';
import { mountedRenderers, createDefaultConnections } from './queryEditorResultsAndDropTestHelpers';

export const setUpQueryEditorResultsAndDropTest = () => {
    const completionState = (globalThis as any).__gonaviSqlCompletionState;
    if (completionState) {
      completionState.registered = false;
      completionState.disposables = [];
    }
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
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
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Vitest',
    });
    setCurrentLanguage('zh-CN');
    storeState.languagePreference = 'zh-CN';
    storeState.shortcutOptions.runQuery.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.runQuery.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.saveQuery.mac = { enabled: true, combo: 'Meta+S' };
    storeState.shortcutOptions.saveQuery.windows = { enabled: true, combo: 'Ctrl+S' };
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.saveQuery.mockReset();
    storeState.saveQuery.mockImplementation(async (query: SavedQuery) => query);
    storeState.savedQueries = [];
    storeState.sqlFormatOptions = { keywordCase: 'upper' };
    storeState.activeTabId = 'tab-1';
    storeState.aiPanelVisible = false;
    storeState.setAIPanelVisible.mockReset();
    storeState.queryOptions = {
      maxRows: 5000,
      showColumnComment: true,
      showColumnType: true,
      showQueryResultsPanel: false,
    };
    storeState.sqlEditorTransactionOptions = {
      commitMode: 'manual',
      autoCommitDelayMs: 0,
    };
    storeState.shortcutOptions = {
      runQuery: {
        mac: { enabled: false, combo: '' },
        windows: { enabled: false, combo: '' },
      },
      selectCurrentStatement: {
        mac: { enabled: false, combo: '' },
        windows: { enabled: false, combo: '' },
      },
      saveQuery: {
        mac: { enabled: true, combo: 'Meta+S' },
        windows: { enabled: true, combo: 'Ctrl+S' },
      },
      toggleQueryResultsPanel: {
        mac: { enabled: true, combo: 'Meta+Shift+M' },
        windows: { enabled: true, combo: 'Ctrl+Shift+M' },
      },
    };
    storeState.setQueryOptions.mockReset();
    storeState.setQueryOptions.mockImplementation((options: Record<string, unknown>) => {
      storeState.queryOptions = { ...storeState.queryOptions, ...options };
    });
    storeState.setSqlEditorTransactionOptions.mockReset();
    storeState.setSqlEditorTransactionOptions.mockImplementation((options: Record<string, unknown>) => {
      storeState.sqlEditorTransactionOptions = { ...storeState.sqlEditorTransactionOptions, ...options };
    });
    storeState.sqlEditorPendingTransactions = {};
    storeState.setSqlEditorPendingTransaction.mockReset();
    storeState.setSqlEditorPendingTransaction.mockImplementation((tabId: string, transaction: unknown) => {
      if (!transaction) {
        delete storeState.sqlEditorPendingTransactions[tabId];
        return;
      }
      storeState.sqlEditorPendingTransactions[tabId] = transaction;
    });
    Object.values(backendApp).forEach((fn) => fn.mockReset());
    nativeDetachedWindowState.openNativeQueryResultWindow.mockReset();
    nativeDetachedWindowState.openNativeQueryResultWindow.mockResolvedValue(false);
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    messageApi.info.mockReset();
    messageApi.warning.mockReset();
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });
    backendApp.WriteSQLFile.mockResolvedValue({ success: true });
    backendApp.ExportSQLFile.mockResolvedValue({ success: true });
    backendApp.DBQueryWithCancel.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMultiTransactional.mockResolvedValue({ success: true, data: [] });
    backendApp.DBCommitTransaction.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBRollbackTransaction.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBRollbackTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBTableExists.mockResolvedValue({ success: true, data: { exists: true } });
    backendApp.GenerateQueryID.mockResolvedValue('query-1');
    storeState.connections = createDefaultConnections();
    storeState.sqlLogs = [];
    storeState.clearSqlLogs.mockReset();
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    storeState.fontSize = 14;

    storeState.appearance.customMonoFontFamily = null;
    storeState.appearance.dataTableFontSize = null;
    storeState.appearance.dataTableFontSizeFollowGlobal = true;
    storeState.appearance.sqlEditorFontSize = null;
    storeState.appearance.sqlEditorFontSizeFollowGlobal = true;
    autoFetchState.visible = false;
    dataGridState.latestProps = null;
    tabsState.activeKey = undefined;
    editorState.value = '';
    editorState.position = { lineNumber: 1, column: 1 };
    editorState.selection = null;
    editorState.domNode.style.cursor = '';
    editorState.providers = [];
    editorState.hoverProviders = [];
    editorState.contentChangeListeners = [];
    editorState.cursorPositionListeners = [];
    editorState.modelContentListeners = [];
    editorState.keyDownListeners = [];
    editorState.mouseMoveListeners = [];
    editorState.mouseDownListeners = [];
    editorState.mouseLeaveListeners = [];
    editorState.hasTextFocus = true;
    editorState.decorationIds = [];
    editorState.contentHoverCalls = [];
    editorState.latestOnChange = null;
    editorState.latestOptions = null;
    editorState.editor.getValue.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();
    editorState.editor.setValue.mockClear();
    editorState.editor.executeEdits.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.updateOptions.mockClear();
    editorState.editor.pushUndoStop.mockClear();
    editorState.editor.addAction.mockClear();
    storeState.updateQueryTabDraft.mockReset();
    storeSubscribers.clear();
    editorState.editor.layout.mockClear();
    clearQueryTabDraft('tab-1');
    clearQueryTabDraft('tab-2');
    clearSQLFileTabDraft('tab-1');
    clearSQLFileTabDraft('tab-2');
  };

export const tearDownQueryEditorResultsAndDropTest = () => {
    act(() => {
      [...mountedRenderers].forEach((renderer) => renderer.unmount());
    });
    clearQueryEditorResultSession('tab-1');
    clearQueryEditorResultSession('tab-2');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  };
