import { useEffect } from 'react';
import { message } from 'antd';
import { registerQueryEditorShortcutAction } from '../queryEditorShortcutRegistration';
import {
    buildQueryEditorMonacoActionLabel,
    type QueryEditorRunScope,
    QUERY_EDITOR_NATIVE_SELECT_CURRENT_LINE_EVENT,
} from '../queryEditorRunHelpers';
import {
    comboToMonacoKeyBinding,
    isShortcutMatch,
    normalizeShortcutCombo,
} from '../../../utils/shortcuts';
import {
    normalizeEditorPosition,
    resolveQueryEditorNavigationTarget,
    dispatchQueryEditorSidebarLocate,
    resolveEventTargetNode,
    isDocumentLevelShortcutTarget,
} from '../QueryEditorHelpers';
import {
    dispatchSavedQueryLocateFallback,
    resolveQueryEditorLineTableLocate,
} from '../queryEditorLineTableLocate';
import { t as translate } from '../../../i18n';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import { EventsOn } from '../../../../wailsjs/runtime';
import { useAiSqlInsertToTabListener } from '../queryEditorAiSqlInsert';
import type { QueryEditorDropAndLineEditsApi } from './useQueryEditorDropAndLineEdits';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorAiAssistActionsApi } from './useQueryEditorAiAssistActions';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorRunApi } from './useQueryEditorRun';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorActiveTabShortcutsInput {
    registerToggleLineCommentAction: QueryEditorDropAndLineEditsApi['registerToggleLineCommentAction'];
    disposeToggleLineCommentAction: QueryEditorDropAndLineEditsApi['disposeToggleLineCommentAction'];
    saveQueryActionRef: QueryEditorCoreStateApi['saveQueryActionRef'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    saveQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['saveQueryShortcutBinding'];
    languagePreference: QueryEditorConnectionContextApi['languagePreference'];
    tab: QueryEditorProps['tab'];
    saveQueryAsActionRef: QueryEditorCoreStateApi['saveQueryAsActionRef'];
    currentSavedQuery: QueryEditorQueryContextApi['currentSavedQuery'];
    saveQueryAsShortcutBinding: QueryEditorShortcutsAndSnippetsApi['saveQueryAsShortcutBinding'];
    findInEditorActionRef: QueryEditorCoreStateApi['findInEditorActionRef'];
    findInEditorShortcutCombo: QueryEditorShortcutsAndSnippetsApi['findInEditorShortcutCombo'];
    formatSqlActionRef: QueryEditorCoreStateApi['formatSqlActionRef'];
    formatSqlShortcutBinding: QueryEditorShortcutsAndSnippetsApi['formatSqlShortcutBinding'];
    registerQueryEditorAiContextMenuActions: QueryEditorAiAssistActionsApi['registerQueryEditorAiContextMenuActions'];
    disposeQueryEditorAiContextMenuActions: QueryEditorAiAssistActionsApi['disposeQueryEditorAiContextMenuActions'];
    refreshQueryEditorSlashCommandDefs: QueryEditorAiAssistActionsApi['refreshQueryEditorSlashCommandDefs'];
    toggleQueryResultsPanelActionRef: QueryEditorCoreStateApi['toggleQueryResultsPanelActionRef'];
    toggleQueryResultsPanelShortcutBinding: QueryEditorShortcutsAndSnippetsApi['toggleQueryResultsPanelShortcutBinding'];
    toggleResultPanelVisibility: QueryEditorExecutionStatusApi['toggleResultPanelVisibility'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    lastEditorCursorPositionRef: QueryEditorCoreStateApi['lastEditorCursorPositionRef'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    currentConnectionConfig: QueryEditorConnectionContextApi['currentConnectionConfig'];
    queryTableLocateCycleRef: QueryEditorCoreStateApi['queryTableLocateCycleRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    viewsRef: QueryEditorCoreStateApi['viewsRef'];
    materializedViewsRef: QueryEditorCoreStateApi['materializedViewsRef'];
    triggersRef: QueryEditorCoreStateApi['triggersRef'];
    routinesRef: QueryEditorCoreStateApi['routinesRef'];
    sequencesRef: QueryEditorCoreStateApi['sequencesRef'];
    packagesRef: QueryEditorCoreStateApi['packagesRef'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    handleRun: QueryEditorRunApi['handleRun'];
    handleRunSelectedShortcut: QueryEditorRunApi['handleRunSelectedShortcut'];
    handleOpenEditorFind: QueryEditorExecutionStatusApi['handleOpenEditorFind'];
    selectCurrentStatementShortcutBinding: QueryEditorShortcutsAndSnippetsApi['selectCurrentStatementShortcutBinding'];
    queryEditorRootRef: QueryEditorCoreStateApi['queryEditorRootRef'];
    handleSelectCurrentStatement: QueryEditorDropAndLineEditsApi['handleSelectCurrentStatement'];
    duplicateCurrentLineShortcutBinding: QueryEditorShortcutsAndSnippetsApi['duplicateCurrentLineShortcutBinding'];
    handleDuplicateCurrentLine: QueryEditorDropAndLineEditsApi['handleDuplicateCurrentLine'];
    switchQueryContext: QueryEditorQueryContextApi['switchQueryContext'];
    applyQueryState: QueryEditorDraftSyncApi['applyQueryState'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    runAfterQueryContextReady: QueryEditorRunApi['runAfterQueryContextReady'];
}

export const useQueryEditorActiveTabShortcuts = ({
    registerToggleLineCommentAction, disposeToggleLineCommentAction, saveQueryActionRef, editorRef,
    monacoRef, activeShortcutPlatform, saveQueryShortcutBinding, languagePreference, tab,
    saveQueryAsActionRef, currentSavedQuery, saveQueryAsShortcutBinding, findInEditorActionRef,
    findInEditorShortcutCombo, formatSqlActionRef, formatSqlShortcutBinding,
    registerQueryEditorAiContextMenuActions, disposeQueryEditorAiContextMenuActions,
    refreshQueryEditorSlashCommandDefs, toggleQueryResultsPanelActionRef,
    toggleQueryResultsPanelShortcutBinding, toggleResultPanelVisibility, isActive,
    lastEditorCursorPositionRef, currentConnectionIdRef, currentDbRef, currentConnectionConfig,
    queryTableLocateCycleRef, visibleDbsRef, tablesRef, viewsRef, materializedViewsRef, triggersRef,
    routinesRef, sequencesRef, packagesRef, currentSchemaRef, handleRun, handleRunSelectedShortcut,
    handleOpenEditorFind, selectCurrentStatementShortcutBinding, queryEditorRootRef,
    handleSelectCurrentStatement, duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine,
    switchQueryContext, applyQueryState, getCurrentQuery, runAfterQueryContextReady,
}: UseQueryEditorActiveTabShortcutsInput) => {
    // 「取消/添加注释」右键菜单 + 可配置快捷键：委托 Monaco 内置
    // editor.action.commentLine（当前行/选区生效、一步撤销），语言或改键变化时重注册。
    // 平台默认 Ctrl（Cmd）+/ 恒被吞键命令占用：enabled 时菜单键位委托切换
    // 注释、disabled 时默认键完全静默，保证「禁用/改绑」对内置键位生效。
    useEffect(() => {
        registerToggleLineCommentAction();
        return () => disposeToggleLineCommentAction();
    }, [disposeToggleLineCommentAction, registerToggleLineCommentAction]);

    useEffect(() => {
        if (saveQueryActionRef.current) {
            saveQueryActionRef.current.dispose();
            saveQueryActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        saveQueryActionRef.current = registerQueryEditorShortcutAction({
            editor,
            monaco,
            platform: activeShortcutPlatform,
            id: 'gonavi.saveQuery',
            label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.saveQuery.label'),
            combo: saveQueryShortcutBinding?.combo,
            enabled: saveQueryShortcutBinding?.enabled,
            run: () => {
                window.dispatchEvent(new CustomEvent('gonavi:save-active-query'));
            },
        });

        return () => {
            if (saveQueryActionRef.current) {
                saveQueryActionRef.current.dispose();
                saveQueryActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, languagePreference, saveQueryShortcutBinding]);

    useEffect(() => {
        if (saveQueryAsActionRef.current) {
            saveQueryAsActionRef.current.dispose();
            saveQueryAsActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco || !currentSavedQuery || tab.filePath) return;

        saveQueryAsActionRef.current = registerQueryEditorShortcutAction({
            editor,
            monaco,
            platform: activeShortcutPlatform,
            id: 'gonavi.saveQueryAs',
            label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.saveQueryAs.label'),
            combo: saveQueryAsShortcutBinding?.combo,
            enabled: saveQueryAsShortcutBinding?.enabled,
            run: () => {
                window.dispatchEvent(new CustomEvent('gonavi:save-active-query-as'));
            },
        });

        return () => {
            if (saveQueryAsActionRef.current) {
                saveQueryAsActionRef.current.dispose();
                saveQueryAsActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, currentSavedQuery, languagePreference, saveQueryAsShortcutBinding, tab.filePath]);

    useEffect(() => {
        if (findInEditorActionRef.current) {
            findInEditorActionRef.current.dispose();
            findInEditorActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const keyBinding = comboToMonacoKeyBinding(
            findInEditorShortcutCombo,
            monaco.KeyMod,
            monaco.KeyCode,
            activeShortcutPlatform,
        );
        if (keyBinding) {
            findInEditorActionRef.current = editor.addAction({
                id: 'gonavi.findInEditor',
                label: buildQueryEditorMonacoActionLabel('query_editor.action.find_in_editor'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                run: () => {
                    window.dispatchEvent(new CustomEvent('gonavi:find-active-query'));
                },
            });
        }

        return () => {
            if (findInEditorActionRef.current) {
                findInEditorActionRef.current.dispose();
                findInEditorActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, findInEditorShortcutCombo, languagePreference]);

    useEffect(() => {
        if (formatSqlActionRef.current) {
            formatSqlActionRef.current.dispose();
            formatSqlActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const binding = formatSqlShortcutBinding;
        if (!binding?.enabled || !binding.combo) return;

        const keyBinding = comboToMonacoKeyBinding(
            binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
        );
        if (keyBinding) {
            formatSqlActionRef.current = editor.addAction({
                id: 'gonavi.formatSql',
                label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.formatSql.label'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                run: () => {
                    window.dispatchEvent(new CustomEvent('gonavi:format-active-query'));
                },
            });
        }

        return () => {
            if (formatSqlActionRef.current) {
                formatSqlActionRef.current.dispose();
                formatSqlActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, languagePreference, formatSqlShortcutBinding]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        registerQueryEditorAiContextMenuActions(editor);

        return () => {
            disposeQueryEditorAiContextMenuActions();
        };
    }, [languagePreference, disposeQueryEditorAiContextMenuActions, registerQueryEditorAiContextMenuActions]);

    useEffect(() => {
        refreshQueryEditorSlashCommandDefs();
    }, [languagePreference, refreshQueryEditorSlashCommandDefs]);

    useEffect(() => {
        if (toggleQueryResultsPanelActionRef.current) {
            toggleQueryResultsPanelActionRef.current.dispose();
            toggleQueryResultsPanelActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const binding = toggleQueryResultsPanelShortcutBinding;
        if (!binding?.enabled || !binding.combo) return;

        const keyBinding = comboToMonacoKeyBinding(
            binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
        );
        if (keyBinding) {
            toggleQueryResultsPanelActionRef.current = editor.addAction({
                id: 'gonavi.toggleQueryResultsPanel',
                label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.toggleQueryResultsPanel.label'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                run: toggleResultPanelVisibility,
            });
        }

        return () => {
            if (toggleQueryResultsPanelActionRef.current) {
                toggleQueryResultsPanelActionRef.current.dispose();
                toggleQueryResultsPanelActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, languagePreference, toggleQueryResultsPanelShortcutBinding, toggleResultPanelVisibility]);

    useEffect(() => {
        const handleLocateActiveQueryTable = (event: Event) => {
            if (!isActive) return;
            const fallbackRequest = (event as CustomEvent<Record<string, unknown> | undefined>).detail;
            const editor = editorRef.current;
            const model = editor?.getModel?.();
            const position = normalizeEditorPosition(editor?.getPosition?.() || lastEditorCursorPositionRef.current);
            const connectionId = String(currentConnectionIdRef.current || '').trim();
            const dbName = String(currentDbRef.current || '').trim();
            if (!model || !position || !connectionId || !dbName) {
                if (dispatchSavedQueryLocateFallback(fallbackRequest)) return;
                void message.warning(translate('query_editor.message.locate_table_unavailable'));
                return;
            }
            const lineContent = String(model.getLineContent?.(position.lineNumber) || '');
            const dialect = resolveSqlDialect(
                String(currentConnectionConfig?.type || ''),
                String(currentConnectionConfig?.driver || ''),
                { oceanBaseProtocol: currentConnectionConfig?.oceanBaseProtocol },
            );
            const located = resolveQueryEditorLineTableLocate({
                lineContent, lineNumber: position.lineNumber, dialect, previous: queryTableLocateCycleRef.current,
                resolveTarget: (reference) => resolveQueryEditorNavigationTarget(
                    `FROM ${reference.tableIdent}`,
                    6,
                    dbName,
                    visibleDbsRef.current,
                    tablesRef.current,
                    viewsRef.current,
                    materializedViewsRef.current,
                    triggersRef.current,
                    routinesRef.current,
                    sequencesRef.current,
                    packagesRef.current,
                    true,
                    undefined,
                    currentSchemaRef.current,
                    dialect,
                ),
            });
            if (!located) {
                if (dispatchSavedQueryLocateFallback(fallbackRequest)) return;
                void message.warning(translate('query_editor.message.locate_table_unavailable'));
                return;
            }
            const { target } = located;
            queryTableLocateCycleRef.current = located.cycle;
            dispatchQueryEditorSidebarLocate({
                connectionId,
                dbName: target.dbName,
                tableName: target.tableName,
                schemaName: target.schemaName,
                objectGroup: 'tables',
            });
        };
        window.addEventListener('gonavi:locate-active-query-table', handleLocateActiveQueryTable);
        return () => window.removeEventListener('gonavi:locate-active-query-table', handleLocateActiveQueryTable);
    }, [currentConnectionConfig, isActive]);
    useEffect(() => {
        const handleRunActiveQuery = (event: Event) => {
            if (!isActive) {
                return;
            }
            const detail = (event as CustomEvent<{
                requireSelection?: boolean;
                scope?: QueryEditorRunScope;
            }>).detail;
            if (detail?.scope === 'selection' || detail?.scope === 'all') {
                void handleRun(detail.scope);
                return;
            }
            if (detail?.requireSelection) {
                void handleRunSelectedShortcut();
                return;
            }
            void handleRun();
        };

        window.addEventListener('gonavi:run-active-query', handleRunActiveQuery as EventListener);
        return () => {
            window.removeEventListener('gonavi:run-active-query', handleRunActiveQuery as EventListener);
        };
    }, [isActive, handleRun, handleRunSelectedShortcut]);

    useEffect(() => {
        const handleFindActiveQuery = () => {
            if (!isActive) {
                return;
            }
            handleOpenEditorFind();
        };

        window.addEventListener('gonavi:find-active-query', handleFindActiveQuery as EventListener);
        return () => {
            window.removeEventListener('gonavi:find-active-query', handleFindActiveQuery as EventListener);
        };
    }, [handleOpenEditorFind, isActive]);

    useEffect(() => {
        const binding = selectCurrentStatementShortcutBinding;
        if (!binding?.enabled || !binding.combo) {
            return;
        }

        const handleSelectCurrentStatementShortcut = (event: KeyboardEvent) => {
            if (!isActive) {
                return;
            }
            if (!isShortcutMatch(event, binding.combo)) {
                return;
            }

            const editor = editorRef.current;
            const targetNode = resolveEventTargetNode(event.target);
            const editorHasFocus = !!editor?.hasTextFocus?.();
            const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
            if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            void handleSelectCurrentStatement();
        };

        window.addEventListener('keydown', handleSelectCurrentStatementShortcut, true);
        return () => {
            window.removeEventListener('keydown', handleSelectCurrentStatementShortcut, true);
        };
    }, [handleSelectCurrentStatement, isActive, selectCurrentStatementShortcutBinding]);

    useEffect(() => {
        const binding = selectCurrentStatementShortcutBinding;
        if (
            activeShortcutPlatform !== 'mac'
            || !binding?.enabled
            || normalizeShortcutCombo(binding.combo) !== 'Meta+E'
        ) {
            return;
        }

        try {
            return EventsOn(QUERY_EDITOR_NATIVE_SELECT_CURRENT_LINE_EVENT, () => {
                if (!isActive) {
                    return;
                }
                void handleSelectCurrentStatement();
            });
        } catch {
            return;
        }
    }, [activeShortcutPlatform, handleSelectCurrentStatement, isActive, selectCurrentStatementShortcutBinding]);

    useEffect(() => {
        const binding = duplicateCurrentLineShortcutBinding;
        if (!binding?.enabled || !binding.combo) {
            return;
        }

        const handleDuplicateCurrentLineShortcut = (event: KeyboardEvent) => {
            if (!isActive) {
                return;
            }
            if (!isShortcutMatch(event, binding.combo)) {
                return;
            }

            const editor = editorRef.current;
            const targetNode = resolveEventTargetNode(event.target);
            const editorHasFocus = !!editor?.hasTextFocus?.();
            const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
            if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            handleDuplicateCurrentLine();
        };

        window.addEventListener('keydown', handleDuplicateCurrentLineShortcut, true);
        return () => {
            window.removeEventListener('keydown', handleDuplicateCurrentLineShortcut, true);
        };
    }, [duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, isActive]);

    // 监听由 TabManager 分发的专用注入事件（含 AI“替换原 SQL”，见 queryEditorAiSqlInsert.ts）
    useAiSqlInsertToTabListener({
        tabId: tab.id,
        editorRef,
        monacoRef,
        currentConnectionIdRef,
        currentDbRef,
        switchQueryContext,
        applyQueryState,
        getCurrentQuery,
        runAfterQueryContextReady,
    });
};

export type QueryEditorActiveTabShortcutsApi = ReturnType<typeof useQueryEditorActiveTabShortcuts>;
