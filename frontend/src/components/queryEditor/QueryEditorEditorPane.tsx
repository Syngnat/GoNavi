import { message } from 'antd';
import QueryEditorToolbar from '../QueryEditorToolbar';
import { QueryEditorToolbarFullscreenAction } from './QueryEditorToolbarFullscreenAction';
import { isViewEditSql, resolveViewNameForVerify } from '../../utils/resultDiff/viewDataVerify';
import { t as translate } from '../../i18n';
import Editor from '../MonacoEditor';
import type { QueryEditorCoreStateApi } from './hooks/useQueryEditorCoreState';
import type { QueryEditorShortcutsAndSnippetsApi } from './hooks/useQueryEditorShortcutsAndSnippets';
import type { QueryEditorConnectionContextApi } from './hooks/useQueryEditorConnectionContext';
import type { QueryEditorExecutionStatusApi } from './hooks/useQueryEditorExecutionStatus';
import type { QueryEditorResultTabsApi } from './hooks/useQueryEditorResultTabs';
import type { QueryEditorToolbarMenusApi } from './hooks/useQueryEditorToolbarMenus';
import type { QueryEditorFormattingApi } from './hooks/useQueryEditorFormatting';
import type { QueryEditorQueryContextApi } from './hooks/useQueryEditorQueryContext';
import type { QueryEditorAiContextApi } from './hooks/useQueryEditorAiContext';
import type { QueryEditorResultSetModelApi } from './hooks/useQueryEditorResultSetModel';
import type { QueryEditorRunApi } from './hooks/useQueryEditorRun';
import type { QueryEditorElasticsearchRunApi } from './hooks/useQueryEditorElasticsearchRun';
import type { QueryEditorSaveActionsApi } from './hooks/useQueryEditorSaveActions';
import type { QueryEditorDraftSyncApi } from './hooks/useQueryEditorDraftSync';
import type { QueryEditorMonacoMountApi } from './hooks/useQueryEditorMonacoMount';
import type { QueryEditorEditorSplitApi } from './hooks/useQueryEditorEditorSplit';
import type { QueryEditorProps } from '../QueryEditor';

export interface QueryEditorEditorPaneProps {
  editorPaneRef: QueryEditorCoreStateApi['editorPaneRef'];
  editorFullscreen: QueryEditorShortcutsAndSnippetsApi['editorFullscreen'];
  isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
  activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
  currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
  currentDb: QueryEditorCoreStateApi['currentDb'];
  queryCapableConnections: QueryEditorConnectionContextApi['queryCapableConnections'];
  connectionTags: QueryEditorConnectionContextApi['connectionTags'];
  sidebarRootOrder: QueryEditorConnectionContextApi['sidebarRootOrder'];
  rootSortMode: QueryEditorConnectionContextApi['rootSortMode'];
  rootConnectionSortMode: QueryEditorConnectionContextApi['rootConnectionSortMode'];
  dbList: QueryEditorCoreStateApi['dbList'];
  queryContextLockRunSeq: QueryEditorCoreStateApi['queryContextLockRunSeq'];
  pendingSqlTransaction: QueryEditorExecutionStatusApi['pendingSqlTransaction'];
  canSelectQuerySchema: QueryEditorConnectionContextApi['canSelectQuerySchema'];
  currentSchema: QueryEditorCoreStateApi['currentSchema'];
  schemaList: QueryEditorCoreStateApi['schemaList'];
  schemaLoading: QueryEditorCoreStateApi['schemaLoading'];
  loading: QueryEditorCoreStateApi['loading'];
  queryContextLockRunSeqRef: QueryEditorCoreStateApi['queryContextLockRunSeqRef'];
  pendingSqlTransactionRef: QueryEditorExecutionStatusApi['pendingSqlTransactionRef'];
  currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
  latestSelectedSchemaRef: QueryEditorConnectionContextApi['latestSelectedSchemaRef'];
  setCurrentSchema: QueryEditorCoreStateApi['setCurrentSchema'];
  setSchemaList: QueryEditorCoreStateApi['setSchemaList'];
  updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
  tab: QueryEditorProps['tab'];
  queryOptions: QueryEditorCoreStateApi['queryOptions'];
  sqlEditorCommitMode: QueryEditorExecutionStatusApi['sqlEditorCommitMode'];
  sqlEditorAutoCommitDelayMs: QueryEditorExecutionStatusApi['sqlEditorAutoCommitDelayMs'];
  sqlEditorTransactionToolbar: QueryEditorResultTabsApi['sqlEditorTransactionToolbar'];
  runQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['runQueryShortcutBinding'];
  saveQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['saveQueryShortcutBinding'];
  formatSqlShortcutBinding: QueryEditorShortcutsAndSnippetsApi['formatSqlShortcutBinding'];
  triggerSqlAiCompletionShortcutBinding: QueryEditorShortcutsAndSnippetsApi['triggerSqlAiCompletionShortcutBinding'];
  toggleQueryResultsPanelShortcutBinding: QueryEditorShortcutsAndSnippetsApi['toggleQueryResultsPanelShortcutBinding'];
  isResultPanelVisible: QueryEditorConnectionContextApi['isResultPanelVisible'];
  wordWrapEnabled: QueryEditorCoreStateApi['wordWrapEnabled'];
  saveMoreMenuItems: QueryEditorToolbarMenusApi['saveMoreMenuItems'];
  analysisMenuItems: QueryEditorToolbarMenusApi['analysisMenuItems'];
  formatSettingsMenu: QueryEditorFormattingApi['formatSettingsMenu'];
  sqlFormatOptions: QueryEditorConnectionContextApi['sqlFormatOptions'];
  elasticsearchTemplateMenuItems: QueryEditorToolbarMenusApi['elasticsearchTemplateMenuItems'];
  switchQueryContext: QueryEditorQueryContextApi['switchQueryContext'];
  handleDatabaseChange: QueryEditorAiContextApi['handleDatabaseChange'];
  setQueryOptions: QueryEditorCoreStateApi['setQueryOptions'];
  setSqlEditorTransactionOptions: QueryEditorConnectionContextApi['setSqlEditorTransactionOptions'];
  captureEditorCursorPosition: QueryEditorResultSetModelApi['captureEditorCursorPosition'];
  handleRun: QueryEditorRunApi['handleRun'];
  handleElasticsearchRun: QueryEditorElasticsearchRunApi['handleElasticsearchRun'];
  handleCancel: QueryEditorRunApi['handleCancel'];
  handleQuickSave: QueryEditorSaveActionsApi['handleQuickSave'];
  handleOpenEditorFind: QueryEditorExecutionStatusApi['handleOpenEditorFind'];
  handleFormat: QueryEditorFormattingApi['handleFormat'];
  triggerAiInlineCompletionRef: QueryEditorCoreStateApi['triggerAiInlineCompletionRef'];
  toggleResultPanelVisibility: QueryEditorExecutionStatusApi['toggleResultPanelVisibility'];
  handleAIAction: QueryEditorFormattingApi['handleAIAction'];
  isObjectEditQueryTab: QueryEditorCoreStateApi['isObjectEditQueryTab'];
  query: QueryEditorCoreStateApi['query'];
  setViewDataVerifyOpen: QueryEditorCoreStateApi['setViewDataVerifyOpen'];
  editorStageRef: QueryEditorCoreStateApi['editorStageRef'];
  editorShellRef: QueryEditorCoreStateApi['editorShellRef'];
  queryEditorMonacoLanguage: QueryEditorConnectionContextApi['queryEditorMonacoLanguage'];
  darkMode: QueryEditorConnectionContextApi['darkMode'];
  syncQueryDraft: QueryEditorDraftSyncApi['syncQueryDraft'];
  paramsState: QueryEditorQueryContextApi['paramsState'];
  handleEditorBeforeMount: QueryEditorMonacoMountApi['handleEditorBeforeMount'];
  handleEditorDidMount: QueryEditorMonacoMountApi['handleEditorDidMount'];
  queryEditorMonacoOptions: QueryEditorCoreStateApi['queryEditorMonacoOptions'];
  executionElapsedLabel: QueryEditorCoreStateApi['executionElapsedLabel'];
  executionSpeedIcon: QueryEditorCoreStateApi['executionSpeedIcon'];
  executionElapsedText: QueryEditorCoreStateApi['executionElapsedText'];
  executionStatusText: QueryEditorExecutionStatusApi['executionStatusText'];
  handleMouseDown: QueryEditorEditorSplitApi['handleMouseDown'];
}

export const QueryEditorEditorPane = ({
  editorPaneRef, editorFullscreen, isElasticsearchMode, activeShortcutPlatform, currentConnectionId,
  currentDb, queryCapableConnections, connectionTags, sidebarRootOrder, rootSortMode,
  rootConnectionSortMode, dbList, queryContextLockRunSeq, pendingSqlTransaction,
  canSelectQuerySchema, currentSchema, schemaList, schemaLoading, loading,
  queryContextLockRunSeqRef, pendingSqlTransactionRef, currentSchemaRef, latestSelectedSchemaRef,
  setCurrentSchema, setSchemaList, updateQueryTabDraft, tab, queryOptions, sqlEditorCommitMode,
  sqlEditorAutoCommitDelayMs, sqlEditorTransactionToolbar, runQueryShortcutBinding,
  saveQueryShortcutBinding, formatSqlShortcutBinding, triggerSqlAiCompletionShortcutBinding,
  toggleQueryResultsPanelShortcutBinding, isResultPanelVisible, wordWrapEnabled, saveMoreMenuItems,
  analysisMenuItems, formatSettingsMenu, sqlFormatOptions, elasticsearchTemplateMenuItems,
  switchQueryContext, handleDatabaseChange, setQueryOptions, setSqlEditorTransactionOptions,
  captureEditorCursorPosition, handleRun, handleElasticsearchRun, handleCancel, handleQuickSave,
  handleOpenEditorFind, handleFormat, triggerAiInlineCompletionRef, toggleResultPanelVisibility,
  handleAIAction, isObjectEditQueryTab, query, setViewDataVerifyOpen, editorStageRef,
  editorShellRef, queryEditorMonacoLanguage, darkMode, syncQueryDraft, paramsState,
  handleEditorBeforeMount, handleEditorDidMount, queryEditorMonacoOptions, executionElapsedLabel,
  executionSpeedIcon, executionElapsedText, executionStatusText, handleMouseDown,
}: QueryEditorEditorPaneProps) => (
  <div
    ref={editorPaneRef}
    className="gn-v2-query-editor-pane"
    style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: editorFullscreen.resultsAreaMounted ? '0 0 auto' : '1 1 auto' }}
  >
  <QueryEditorToolbar
    editorMode={isElasticsearchMode ? 'elasticsearch' : 'sql'}
    editorFullscreenAction={<QueryEditorToolbarFullscreenAction active={editorFullscreen.active} shortcutBinding={editorFullscreen.shortcutBinding} activeShortcutPlatform={activeShortcutPlatform} onToggle={editorFullscreen.toggle} />}
    currentConnectionId={currentConnectionId}
    currentDb={currentDb}
    queryCapableConnections={queryCapableConnections}
    connectionTags={connectionTags}
    sidebarRootOrder={sidebarRootOrder}
    rootSortMode={rootSortMode}
    rootConnectionSortMode={rootConnectionSortMode}
    dbList={dbList}
    contextSelectionDisabled={queryContextLockRunSeq !== 0 || Boolean(pendingSqlTransaction)}
    schemaSelect={canSelectQuerySchema ? {
        value: currentSchema,
        options: schemaList,
        loading: schemaLoading,
        disabled: schemaLoading || loading || queryContextLockRunSeq !== 0 || Boolean(pendingSqlTransaction),
        onChange: (schemaName) => {
            const nextSchema = String(schemaName || '').trim();
            if (
                !nextSchema
                || queryContextLockRunSeqRef.current !== 0
                || pendingSqlTransactionRef.current
            ) return;
            currentSchemaRef.current = nextSchema;
            latestSelectedSchemaRef.current = nextSchema;
            setCurrentSchema(nextSchema);
            setSchemaList((current) => current.includes(nextSchema)
                ? current
                : [nextSchema, ...current]);
            updateQueryTabDraft(tab.id, { schemaName: nextSchema });
        },
    } : undefined}
    maxRows={queryOptions?.maxRows ?? 5000}
    sqlEditorCommitMode={sqlEditorCommitMode}
    sqlEditorAutoCommitDelayMs={sqlEditorAutoCommitDelayMs}
    pendingTransactionToolbar={pendingSqlTransaction ? sqlEditorTransactionToolbar : null}
    runQueryShortcutBinding={runQueryShortcutBinding}
    saveQueryShortcutBinding={saveQueryShortcutBinding}
    formatSqlShortcutBinding={formatSqlShortcutBinding}
    triggerSqlAiCompletionShortcutBinding={triggerSqlAiCompletionShortcutBinding}
    toggleQueryResultsPanelShortcutBinding={toggleQueryResultsPanelShortcutBinding}
    activeShortcutPlatform={activeShortcutPlatform}
    isResultPanelVisible={isResultPanelVisible}
    wordWrapEnabled={wordWrapEnabled}
    loading={loading}
    runDisabled={canSelectQuerySchema && schemaLoading}
    saveMoreMenuItems={saveMoreMenuItems}
    analysisMenuItems={analysisMenuItems}
    formatSettingsMenu={formatSettingsMenu}
    formatSettingsSelectedKeys={[sqlFormatOptions.keywordCase]}
    templateMenuItems={elasticsearchTemplateMenuItems}
    onConnectionChange={(val) => {
        void switchQueryContext(val, '');
    }}
    onDatabaseChange={handleDatabaseChange}
    onMaxRowsChange={(maxRows) => setQueryOptions({ maxRows })}
    onCommitModeChange={(mode) => setSqlEditorTransactionOptions(
        mode === 'auto'
            ? { commitMode: mode, autoCommitDelayMs: 0 }
            : { commitMode: mode },
    )}
    onAutoCommitDelayMsChange={(delayMs) => setSqlEditorTransactionOptions({ autoCommitDelayMs: delayMs })}
    onCaptureEditorCursorPosition={captureEditorCursorPosition}
    onRun={handleRun}
    onRunAll={() => void handleElasticsearchRun(true)}
    onCancel={handleCancel}
    onQuickSave={handleQuickSave}
    onFindInEditor={handleOpenEditorFind}
    onToggleWordWrap={() => setQueryOptions({ wordWrap: !wordWrapEnabled })}
    onFormat={handleFormat}
    onTriggerSqlAiCompletion={() => triggerAiInlineCompletionRef.current?.()}
    onToggleResultPanelVisibility={toggleResultPanelVisibility}
    onAIAction={handleAIAction}
    showViewDataVerify={
      isObjectEditQueryTab
      && (
        Boolean(String(tab.viewName || '').trim())
        || tab.objectType === 'view'
        || tab.objectType === 'materialized-view'
        || isViewEditSql(query)
      )
    }
    onViewDataVerify={() => {
      const viewName = resolveViewNameForVerify({
        sql: query,
        tabViewName: tab.viewName,
        tabTitle: tab.title,
      });
      if (!viewName) {
        message.warning(translate('result_diff.view_verify.error.no_view_name'));
        return;
      }
      setViewDataVerifyOpen(true);
    }}
  />

  <div
    ref={editorStageRef}
    className="gn-v2-query-monaco-stage gn-query-monaco-stage"
    style={editorFullscreen.stageStyle}
  >
    <div
      ref={editorShellRef}
      className="gn-v2-query-monaco-shell gn-query-monaco-shell"
      style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0 }}
    >
      <Editor
        height="100%"
        gonaviTypography="sql"
        language={queryEditorMonacoLanguage}
        theme={darkMode ? "transparent-dark" : "transparent-light"}
        defaultValue={query}
        onChange={(val) => {
            const nextValue = val || '';
            syncQueryDraft(nextValue);
            paramsState.requestAnalysis();
        }}
        beforeMount={handleEditorBeforeMount}
        onMount={handleEditorDidMount}
        options={isElasticsearchMode ? {
            ...queryEditorMonacoOptions,
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            inlineSuggest: { enabled: false },
        } : queryEditorMonacoOptions}
      />
    </div>
    <div className="gn-query-execution-statusbar">
      <span
        aria-label={executionElapsedLabel}
        className="gn-query-execution-timer"
        role="timer"
        title={executionElapsedLabel}
      >
        <span aria-hidden="true" className="gn-query-execution-speed-icon">
          {executionSpeedIcon}
        </span>
        <span className="gn-query-execution-elapsed">
          {executionElapsedText}
        </span>
      </span>
      {executionStatusText ? (
        <span className="gn-query-execution-status-label" title={executionStatusText}>
          {executionStatusText}
        </span>
      ) : null}
    </div>
  </div>

  {editorFullscreen.resultsAreaMounted && (
    <div
      className="gn-v2-query-resizer"
      onMouseDown={handleMouseDown}
      style={{
          height: '5px',
          cursor: 'row-resize',
          background: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
          flexShrink: 0,
          zIndex: 10
      }}
      title={translate('query_editor.action.resize_editor')}
    />
  )}
  </div>
);
