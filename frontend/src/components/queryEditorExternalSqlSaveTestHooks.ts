// 拆分后各场景文件共用的 describe 级 beforeEach / afterEach。
import { act } from 'react-test-renderer';
import { vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import type { SavedQuery } from '../types';
import { setGlobalImeCompositionActive } from '../utils/shortcuts';
import { clearQueryEditorResultSession } from '../utils/queryEditorResultSessionCache';
import { resetQueryEditorTabSplitRatiosForTests } from '../utils/queryEditorSplitLayout';
import { clearQueryTabDraft, clearSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import { clearQueryEditorInlineRuntimeReadinessCache } from './queryEditor/QueryEditorAiAssist';
import { resetDatabaseServerVersionCache } from './queryEditor/queryEditorServerVersion';
import {
    mountedRenderers,
    storeState,
    storeSubscribers,
    runtimeEventListeners,
    runtimeApi,
    backendApp,
    messageApi,
    saveQueryNameInputFocus,
    dataGridState,
    tabsState,
    autoFetchState,
    antdSelectState,
    monacoEditorMockState,
    defaultEditorContributionResolver,
    editorState,
    createDefaultConnections,
} from './queryEditorExternalSqlSaveTestSupport';

export const setUpQueryEditorExternalSqlSaveTest = () => {
    resetQueryEditorTabSplitRatiosForTests();
    resetDatabaseServerVersionCache();
    clearQueryEditorInlineRuntimeReadinessCache();
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
      body: { nodeName: 'BODY', appendChild: vi.fn() },
      documentElement: { nodeName: 'HTML' },
      execCommand: vi.fn(() => true),
      createElement: vi.fn((tagName: string) => ({
        tagName: String(tagName || '').toUpperCase(),
        className: '',
        style: {},
        setAttribute: vi.fn(),
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn(),
      })),
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      platform: 'MacIntel',
      userAgent: 'Vitest',
    });
    setCurrentLanguage('zh-CN');
    storeState.languagePreference = 'zh-CN';
    storeState.shortcutOptions.runQuery.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.runQuery.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.saveQuery.mac = { enabled: true, combo: 'Meta+S' };
    storeState.shortcutOptions.saveQuery.windows = { enabled: true, combo: 'Ctrl+S' };
    storeState.shortcutOptions.saveQueryAs.mac = { enabled: true, combo: 'Meta+Shift+S' };
    storeState.shortcutOptions.saveQueryAs.windows = { enabled: true, combo: 'Ctrl+Shift+S' };
    runtimeApi.EventsOn.mockClear();
    runtimeApi.LogError.mockReset();
    runtimeApi.LogInfo.mockReset();
    runtimeEventListeners.clear();
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.activeContext = null;
    storeState.setActiveContext.mockImplementation((context: { connectionId: string; dbName: string } | null) => {
      storeState.activeContext = context;
    });
    storeState.saveQuery.mockReset();
    storeState.saveQuery.mockImplementation(async (query: SavedQuery) => query);
    storeState.savedQueries = [];
    storeState.activeTabId = 'tab-1';
    storeState.tabs = [];
    storeState.aiPanelVisible = false;
    storeState.setAIPanelVisible.mockReset();

    storeState.appearance.newQuerySqlTemplate = null;
    storeState.appearance.autoAddTableAlias = true;
    storeState.appearance.customTableAliasPrefixEnabled = false;
    storeState.appearance.customTableAliasPrefix = '';
    storeState.appearance.queryTableCtrlClickAction = 'open-design';
    storeState.queryOptions = {
      maxRows: 5000,
      wordWrap: false,
      showColumnComment: true,
      showColumnType: true,
      showQueryResultsPanel: false,
      queryEditorEditorHeightRatio: 0.5,
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
      duplicateCurrentLine: {
        mac: { enabled: false, combo: '' },
        windows: { enabled: false, combo: '' },
      },
      saveQuery: {
        mac: { enabled: true, combo: 'Meta+S' },
        windows: { enabled: true, combo: 'Ctrl+S' },
      },
      saveQueryAs: {
        mac: { enabled: true, combo: 'Meta+Shift+S' },
        windows: { enabled: true, combo: 'Ctrl+Shift+S' },
      },
      toggleQueryResultsPanel: {
        mac: { enabled: true, combo: 'Meta+Shift+M' },
        windows: { enabled: true, combo: 'Ctrl+Shift+M' },
      },
      acceptSqlAiCompletion: {
        mac: { enabled: true, combo: 'Tab' },
        windows: { enabled: true, combo: 'Tab' },
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
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    messageApi.info.mockReset();
    messageApi.warning.mockReset();
    saveQueryNameInputFocus.mockReset();
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });
    backendApp.WriteSQLFile.mockResolvedValue({ success: true });
    backendApp.ExportSQLFile.mockResolvedValue({ success: true });
    backendApp.DBQueryWithCancel.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMultiInTransaction.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMultiTransactional.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryAudited.mockResolvedValue({ success: true, data: [] });
    backendApp.DBCommitTransaction.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBRollbackTransaction.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBRollbackTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTriggers.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBTableExists.mockResolvedValue({ success: true, data: { exists: true } });
    backendApp.DBShowCreateTable.mockResolvedValue({ success: false, data: '' });
    backendApp.DBGetServerVersion.mockResolvedValue({ success: false });
    backendApp.GenerateQueryID.mockResolvedValue('query-1');
    backendApp.InspectElasticsearchConsole.mockResolvedValue({
      success: true,
      requests: [],
      containsWrite: false,
      requiresConfirmation: false,
      fingerprint: 'inspection-default',
    });
    backendApp.ExecuteElasticsearchConsole.mockResolvedValue({ success: true, results: [] });
    storeState.connections = createDefaultConnections();
    storeState.sqlLogs = [];
    storeState.addSqlLog.mockReset();
    storeState.sqlSnippets = [];
    storeState.clearSqlLogs.mockReset();
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';

    autoFetchState.visible = false;
    antdSelectState.props = [];
    dataGridState.latestProps = null;
    tabsState.activeKey = undefined;
    editorState.value = '';
    delete (editorState.editor.getModel() as any).uri;
    editorState.position = { lineNumber: 1, column: 1 };
    editorState.selection = null;
    editorState.scrollLeft = 0;
    monacoEditorMockState.latestProps = null;
    editorState.domNode.style.cursor = '';
    editorState.providers = [];
    editorState.providerLanguages = [];
    editorState.hoverProviders = [];
    editorState.hoverProviderLanguages = [];
    editorState.hoverProviderRegistrationKinds = [];
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
    editorState.editor.getValue.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();
    editorState.editor.setValue.mockClear();
    editorState.editor.executeEdits.mockClear();
    editorState.editor.getAction.mockClear();
    editorState.transformToUppercaseRun.mockReset();
    editorState.transformToLowercaseRun.mockReset();
    editorState.editor.getScrollLeft.mockClear();
    editorState.editor.setScrollLeft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.updateOptions.mockClear();
    editorState.editor.pushUndoStop.mockClear();
    editorState.editor.addAction.mockClear();
    editorState.editor.onKeyDown.mockClear();
    editorState.editor.getContribution.mockReset();
    editorState.editor.getContribution.mockImplementation(defaultEditorContributionResolver(editorState));
    storeState.updateQueryTabDraft.mockReset();
    storeSubscribers.clear();
    editorState.editor.layout.mockClear();
    editorState.editor.trigger.mockClear();
    clearQueryTabDraft('tab-1');
    clearQueryTabDraft('tab-2');
    clearSQLFileTabDraft('tab-1');
    clearSQLFileTabDraft('tab-2');
    setGlobalImeCompositionActive(false);
    monacoEditorMockState.deferOnMount = false;
  };

export const tearDownQueryEditorExternalSqlSaveTest = () => {
    act(() => {
      [...mountedRenderers].forEach((renderer) => renderer.unmount());
    });
    clearQueryEditorResultSession('tab-1');
    clearQueryEditorResultSession('tab-2');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  };
