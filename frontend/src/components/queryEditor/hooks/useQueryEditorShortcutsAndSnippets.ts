import { useMemo, useCallback, useEffect } from 'react';
import { message } from 'antd';
import { useStore } from '../../../store';
import {
    getShortcutPlatform,
    resolveShortcutBinding,
    isShortcutMatch,
    getShortcutPrimaryModifierDisplayLabel,
} from '../../../utils/shortcuts';
import { isMacLikePlatform } from '../../../utils/appearance';
import { t as translate } from '../../../i18n';
import { buildSqlAnalysisWorkbenchTab } from '../../../utils/sqlAnalysisTab';
import { buildQueryHistoryWorkbenchTab } from '../../../utils/sqlAuditTab';
import type { QueryEditorRunScope } from '../queryEditorRunHelpers';
import { useQueryEditorErrorDiagnose } from '../useQueryEditorErrorDiagnose';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import { useQueryEditorFullscreen } from '../useQueryEditorFullscreen';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorShortcutsAndSnippetsInput {
    sqlSnippets: QueryEditorConnectionContextApi['sqlSnippets'];
    sqlSnippetPickerKeyword: QueryEditorCoreStateApi['sqlSnippetPickerKeyword'];
    tab: QueryEditorProps['tab'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentConnectionCapabilities: QueryEditorConnectionContextApi['currentConnectionCapabilities'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    addTab: QueryEditorConnectionContextApi['addTab'];
    setIsSqlSnippetPickerOpen: QueryEditorCoreStateApi['setIsSqlSnippetPickerOpen'];
    setSqlSnippetPickerKeyword: QueryEditorCoreStateApi['setSqlSnippetPickerKeyword'];
    insertSqlSnippetActionRef: QueryEditorCoreStateApi['insertSqlSnippetActionRef'];
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    sqlExecutionContextMenuActionDisposablesRef: QueryEditorCoreStateApi['sqlExecutionContextMenuActionDisposablesRef'];
    languagePreference: QueryEditorConnectionContextApi['languagePreference'];
    transformCaseActionDisposablesRef: QueryEditorCoreStateApi['transformCaseActionDisposablesRef'];
    getCurrentQuery: () => string;
    resolveExecutionErrorStatement: QueryEditorCoreStateApi['resolveExecutionErrorStatement'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    currentConnectionConfig: QueryEditorConnectionContextApi['currentConnectionConfig'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    executionErrorRef: QueryEditorCoreStateApi['executionErrorRef'];
    acceptSqlAiCompletionBindingRef: QueryEditorCoreStateApi['acceptSqlAiCompletionBindingRef'];
    queryEditorActiveRef: QueryEditorCoreStateApi['queryEditorActiveRef'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    queryEditorRootRef: QueryEditorCoreStateApi['queryEditorRootRef'];
    editorHeight: QueryEditorCoreStateApi['editorHeight'];
    isResultPanelVisible: QueryEditorConnectionContextApi['isResultPanelVisible'];
}

export const useQueryEditorShortcutsAndSnippets = ({
    sqlSnippets, sqlSnippetPickerKeyword, tab, currentConnectionId, currentConnectionCapabilities,
    currentDb, addTab, setIsSqlSnippetPickerOpen, setSqlSnippetPickerKeyword,
    insertSqlSnippetActionRef, isElasticsearchMode, sqlExecutionContextMenuActionDisposablesRef,
    languagePreference, transformCaseActionDisposablesRef, getCurrentQuery,
    resolveExecutionErrorStatement, currentConnectionIdRef, currentDbRef, currentConnectionConfig,
    isActive, executionErrorRef, acceptSqlAiCompletionBindingRef, queryEditorActiveRef, editorRef,
    queryEditorRootRef, editorHeight, isResultPanelVisible,
}: UseQueryEditorShortcutsAndSnippetsInput) => {
    const shortcutOptions = useStore(state => state.shortcutOptions);
    const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());
    const runQueryShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'runQuery', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    // SQL 诊断 / 慢 SQL 历史的快捷键绑定（从 store 读取，用户可在快捷键管理面板自定义）
    const diagnoseQueryShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'diagnoseQuery', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const showSlowQueriesShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'showSlowQueries', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const diagnoseExecutionErrorShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'diagnoseExecutionError', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const sortedSqlSnippets = useMemo(
        () => [...sqlSnippets].sort((left, right) => (
            left.prefix.localeCompare(right.prefix) || left.name.localeCompare(right.name)
        )),
        [sqlSnippets],
    );
    const filteredSqlSnippets = useMemo(() => {
        const keyword = String(sqlSnippetPickerKeyword || '').trim().toLowerCase();
        if (!keyword) {
            return sortedSqlSnippets;
        }
        return sortedSqlSnippets.filter((snippet) => (
            [
                snippet.prefix,
                snippet.name,
                snippet.description,
                snippet.syntaxHelp,
                snippet.body,
            ].some((field) => String(field || '').toLowerCase().includes(keyword))
        ));
    }, [sortedSqlSnippets, sqlSnippetPickerKeyword]);
    const sqlSnippetPickerEmptyLabel = useMemo(
        () => (
            String(sqlSnippetPickerKeyword || '').trim()
                ? translate('query_editor.snippet_picker.empty_filtered')
                : translate('query_editor.snippet_picker.empty')
        ),
        [sqlSnippetPickerKeyword],
    );

    const openSqlAnalysisWorkbench = useCallback(
        (view: 'diagnose' | 'slow-query', nextSql?: string) => {
            const connectionId = String(currentConnectionId || '').trim();
            if (!connectionId) {
                message.warning(translate('query_editor.message.connection_not_found'));
                return;
            }
            if (view === 'diagnose' && !currentConnectionCapabilities.supportsExplainDiagnosis) {
                message.warning(translate('sql_analysis.slow_query.unsupported_diagnosis' as any));
                return;
            }
            // `''` is a valid context for connection-scoped sources such as
            // SQLite. Do not fall back to the tab snapshot after the user has
            // deliberately cleared the database selector.
            const dbName = String(currentDb ?? tab.dbName ?? '').trim();
            addTab(buildSqlAnalysisWorkbenchTab({
                connectionId,
                dbName: dbName || undefined,
                query: typeof nextSql === 'string' && nextSql.trim() ? nextSql : undefined,
                view,
            }));
        },
        [addTab, currentConnectionCapabilities.supportsExplainDiagnosis, currentConnectionId, currentDb, tab.dbName],
    );

    const openQueryHistoryWorkbench = useCallback(() => {
        addTab(buildQueryHistoryWorkbenchTab({
            connectionId: String(currentConnectionId || '').trim(),
            dbName: String(currentDb ?? tab.dbName ?? '').trim(),
        }));
    }, [addTab, currentConnectionId, currentDb, tab.dbName]);

    const handleCloseSqlSnippetPicker = useCallback(() => {
        setIsSqlSnippetPickerOpen(false);
        setSqlSnippetPickerKeyword('');
    }, []);

    const handleOpenSqlSnippetPicker = useCallback(() => {
        setSqlSnippetPickerKeyword('');
        setIsSqlSnippetPickerOpen(true);
    }, []);

    const handleOpenSnippetSettingsFromPicker = useCallback(() => {
        handleCloseSqlSnippetPicker();
        window.dispatchEvent(new CustomEvent('gonavi:open-snippet-settings'));
    }, [handleCloseSqlSnippetPicker]);

    const registerInsertSqlSnippetContextMenuAction = useCallback((editor: any) => {
        if (insertSqlSnippetActionRef.current) {
            insertSqlSnippetActionRef.current.dispose();
            insertSqlSnippetActionRef.current = null;
        }
        if (!editor || isElasticsearchMode) {
            return;
        }

        insertSqlSnippetActionRef.current = editor.addAction({
            id: 'gonavi.insertSqlSnippet',
            label: translate('query_editor.action.insert_sql_snippet'),
            contextMenuGroupId: '8_snippet',
            contextMenuOrder: 1,
            run: handleOpenSqlSnippetPicker,
        });
    }, [handleOpenSqlSnippetPicker, isElasticsearchMode]);

    const disposeSqlExecutionContextMenuActions = useCallback(() => {
        sqlExecutionContextMenuActionDisposablesRef.current.forEach((disposable) => disposable?.dispose?.());
        sqlExecutionContextMenuActionDisposablesRef.current = [];
    }, []);

    const registerSqlExecutionContextMenuActions = useCallback((editor: any) => {
        disposeSqlExecutionContextMenuActions();
        if (!editor || isElasticsearchMode) {
            return;
        }

        const actions: Array<{
            id: string;
            label: string;
            scope: Exclude<QueryEditorRunScope, 'default'>;
            contextMenuOrder: number;
            precondition?: string;
        }> = [
            {
                id: 'gonavi.runSelectedSql',
                label: translate('query_editor.action.run_selected_sql'),
                scope: 'selection',
                contextMenuOrder: 1,
                precondition: 'editorHasSelection',
            },
            {
                id: 'gonavi.runAllSql',
                label: translate('query_editor.action.run_all_sql'),
                scope: 'all',
                contextMenuOrder: 2,
            },
        ];

        sqlExecutionContextMenuActionDisposablesRef.current = actions.map((action) => editor.addAction({
            id: action.id,
            label: action.label,
            precondition: action.precondition,
            contextMenuGroupId: '0_execution',
            contextMenuOrder: action.contextMenuOrder,
            run: () => {
                window.dispatchEvent(new CustomEvent('gonavi:run-active-query', {
                    detail: { scope: action.scope },
                }));
            },
        }));
    }, [disposeSqlExecutionContextMenuActions, isElasticsearchMode, languagePreference]);

    const disposeTransformCaseContextMenuActions = useCallback(() => {
        transformCaseActionDisposablesRef.current.forEach((disposable) => disposable?.dispose?.());
        transformCaseActionDisposablesRef.current = [];
    }, []);

    const registerTransformCaseContextMenuActions = useCallback((editor: any) => {
        disposeTransformCaseContextMenuActions();
        transformCaseActionDisposablesRef.current = [
            {
                id: 'gonavi.queryEditor.transformToUppercase',
                label: translate('query_editor.completion.action.uppercase'),
                actionId: 'editor.action.transformToUppercase',
                contextMenuOrder: 1,
            },
            {
                id: 'gonavi.queryEditor.transformToLowercase',
                label: translate('query_editor.completion.action.lowercase'),
                actionId: 'editor.action.transformToLowercase',
                contextMenuOrder: 2,
            },
        ].map((action) => editor.addAction({
            id: action.id,
            label: action.label,
            precondition: '!editorReadonly',
            contextMenuGroupId: '1_modification',
            contextMenuOrder: action.contextMenuOrder,
            run: (ed: any) => ed.getAction?.(action.actionId)?.run?.(),
        }));
    }, [disposeTransformCaseContextMenuActions]);

    // SQL 诊断 / 慢 SQL 历史的快捷键监听（必须在 binding 声明之后）
    const handleDiagnoseExecutionErrorWithAI = useQueryEditorErrorDiagnose({
        getEditorSql: () => getCurrentQuery(),
        resolveExecutionErrorStatement,
        getConnectionId: () => currentConnectionIdRef.current,
        getDatabase: () => currentDbRef.current,
        getDialect: () => String(resolveSqlDialect(
            String(currentConnectionConfig?.type || ''),
            String(currentConnectionConfig?.driver || ''),
            { oceanBaseProtocol: currentConnectionConfig?.oceanBaseProtocol },
        ) || ''),
    });

    useEffect(() => {
      if (!isActive) return;
      const handler = (e: KeyboardEvent) => {
        if (diagnoseQueryShortcutBinding?.enabled && isShortcutMatch(e, diagnoseQueryShortcutBinding.combo)) {
          e.preventDefault();
          openSqlAnalysisWorkbench('diagnose', getCurrentQuery());
          return;
        }
        if (diagnoseExecutionErrorShortcutBinding?.enabled && isShortcutMatch(e, diagnoseExecutionErrorShortcutBinding.combo)) {
          e.preventDefault();
          // 仅在最近一次执行失败时触发，与结果区「一键 AI 诊断」按钮的可见条件一致。
          if (executionErrorRef.current) {
            handleDiagnoseExecutionErrorWithAI(executionErrorRef.current);
          }
          return;
        }
        if (showSlowQueriesShortcutBinding?.enabled && isShortcutMatch(e, showSlowQueriesShortcutBinding.combo)) {
          e.preventDefault();
          openSqlAnalysisWorkbench('slow-query');
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
      // handleDiagnoseExecutionErrorWithAI 有意不进 deps：getter 惰性求值使其陈旧闭包安全，
      // 与原实现对 getCurrentQuery 的处理一致
    }, [diagnoseExecutionErrorShortcutBinding, diagnoseQueryShortcutBinding, isActive, openSqlAnalysisWorkbench, showSlowQueriesShortcutBinding]);
    const selectCurrentStatementShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'selectCurrentStatement', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const duplicateCurrentLineShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'duplicateCurrentLine', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const toggleLineCommentShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'toggleLineComment', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const saveQueryShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'saveQuery', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const saveQueryAsShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'saveQueryAs', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const formatSqlShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'formatSql', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const triggerSqlAiCompletionShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'triggerSqlAiCompletion', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const acceptSqlAiCompletionShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'acceptSqlAiCompletion', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    // 渲染期同步最新绑定/激活态,keydown 监听从 ref 读取,editor 重建或改绑均无需重注册。
    acceptSqlAiCompletionBindingRef.current = acceptSqlAiCompletionShortcutBinding;
    queryEditorActiveRef.current = isActive;
    const toggleQueryResultsPanelShortcutBinding = useMemo(
        () => resolveShortcutBinding(shortcutOptions, 'toggleQueryResultsPanel', activeShortcutPlatform),
        [activeShortcutPlatform, shortcutOptions],
    );
    const editorFullscreen = useQueryEditorFullscreen({ isActive, shortcutOptions, activeShortcutPlatform, editorRef, rootRef: queryEditorRootRef, editorHeight, resultsPanelVisible: isResultPanelVisible });
    const findInEditorShortcutCombo = useMemo<'Meta+F' | 'Ctrl+F'>(
        () => activeShortcutPlatform === 'mac' ? 'Meta+F' : 'Ctrl+F',
        [activeShortcutPlatform],
    );
    const primaryShortcutModifierLabel = useMemo(
        () => getShortcutPrimaryModifierDisplayLabel(activeShortcutPlatform),
        [activeShortcutPlatform],
    );
    return {
        shortcutOptions, activeShortcutPlatform, runQueryShortcutBinding,
        diagnoseQueryShortcutBinding, showSlowQueriesShortcutBinding,
        diagnoseExecutionErrorShortcutBinding, filteredSqlSnippets, sqlSnippetPickerEmptyLabel,
        openSqlAnalysisWorkbench, openQueryHistoryWorkbench, handleCloseSqlSnippetPicker,
        handleOpenSnippetSettingsFromPicker, registerInsertSqlSnippetContextMenuAction,
        disposeSqlExecutionContextMenuActions, registerSqlExecutionContextMenuActions,
        disposeTransformCaseContextMenuActions, registerTransformCaseContextMenuActions,
        handleDiagnoseExecutionErrorWithAI, selectCurrentStatementShortcutBinding,
        duplicateCurrentLineShortcutBinding, toggleLineCommentShortcutBinding,
        saveQueryShortcutBinding, saveQueryAsShortcutBinding, formatSqlShortcutBinding,
        triggerSqlAiCompletionShortcutBinding, toggleQueryResultsPanelShortcutBinding,
        editorFullscreen, findInEditorShortcutCombo, primaryShortcutModifierLabel,
    };
};

export type QueryEditorShortcutsAndSnippetsApi = ReturnType<typeof useQueryEditorShortcutsAndSnippets>;
