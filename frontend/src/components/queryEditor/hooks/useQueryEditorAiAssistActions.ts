import { useCallback } from 'react';
import { message } from 'antd';
import { t as translate } from '../../../i18n';
import { QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER } from '../queryEditorRunHelpers';
import { publishQueryEditorSelection } from '../queryEditorAiSelection';
import { useStore } from '../../../store';
import { bindAIEditorSelectionContext } from '../../ai/bindAIEditorSelectionContext';
import { injectQueryEditorAiPromptWithContext } from '../queryEditorAiPromptInject';
import {
    type QueryEditorAiApplyMode,
    requestQueryEditorTextToElasticsearch,
    getQueryEditorAiService,
    requestQueryEditorTextToSql,
} from '../QueryEditorAiAssist';
import { normalizeEditorPosition } from '../QueryEditorHelpers';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorObjectDecorationsApi } from './useQueryEditorObjectDecorations';
import type { QueryEditorAiContextApi } from './useQueryEditorAiContext';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorAiAssistActionsInput {
    aiContextMenuActionDisposablesRef: QueryEditorCoreStateApi['aiContextMenuActionDisposablesRef'];
    tab: QueryEditorProps['tab'];
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    queryEditorMonacoLanguage: QueryEditorConnectionContextApi['queryEditorMonacoLanguage'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    applyQueryState: QueryEditorDraftSyncApi['applyQueryState'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    setTextToSqlApplyMode: QueryEditorCoreStateApi['setTextToSqlApplyMode'];
    setIsTextToSqlModalOpen: QueryEditorCoreStateApi['setIsTextToSqlModalOpen'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    refreshObjectDecorations: QueryEditorObjectDecorationsApi['refreshObjectDecorations'];
    lastEditorCursorPositionRef: QueryEditorCoreStateApi['lastEditorCursorPositionRef'];
    textToSqlInstruction: QueryEditorCoreStateApi['textToSqlInstruction'];
    setTextToSqlInstruction: QueryEditorCoreStateApi['setTextToSqlInstruction'];
    setTextToSqlGenerating: QueryEditorCoreStateApi['setTextToSqlGenerating'];
    buildQueryEditorAiContext: QueryEditorAiContextApi['buildQueryEditorAiContext'];
    buildQueryEditorAiEditorSnapshot: QueryEditorAiContextApi['buildQueryEditorAiEditorSnapshot'];
    elasticsearchServerMajor: QueryEditorConnectionContextApi['elasticsearchServerMajor'];
    textToSqlApplyMode: QueryEditorCoreStateApi['textToSqlApplyMode'];
}

export const useQueryEditorAiAssistActions = ({
    aiContextMenuActionDisposablesRef, tab, isElasticsearchMode, currentConnectionIdRef,
    currentDbRef, queryEditorMonacoLanguage, connectionsRef, applyQueryState, editorRef,
    setTextToSqlApplyMode, setIsTextToSqlModalOpen, monacoRef, refreshObjectDecorations,
    lastEditorCursorPositionRef, textToSqlInstruction, setTextToSqlInstruction,
    setTextToSqlGenerating, buildQueryEditorAiContext, buildQueryEditorAiEditorSnapshot,
    elasticsearchServerMajor, textToSqlApplyMode,
}: UseQueryEditorAiAssistActionsInput) => {
    const buildQueryEditorAiContextMenuActions = useCallback(() => ([
        {
            id: 'ai.generateSQL',
            label: `AI ${translate('query_editor.action.ai_generate_sql_menu')}`,
            prompt: translate('query_editor.ai_prompt.generate'),
            bindSelection: false,
        },
        {
            id: 'ai.explainSQL',
            label: `AI ${translate('query_editor.action.ai_explain_sql_menu')}`,
            useSelection: true,
            prompt: translate('query_editor.ai_prompt.explain', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
            bindSelection: false,
        },
        {
            id: 'ai.optimizeSQL',
            label: `AI ${translate('query_editor.action.ai_optimize_sql_menu')}`,
            useSelection: true,
            prompt: translate('query_editor.ai_prompt.optimize', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
            bindSelection: false,
        },
        {
            id: 'ai.bindSelectionContext',
            label: `AI ${translate('ai_chat.input.context.bind_selection')}`,
            prompt: '',
            bindSelection: true,
        },
    ]), [translate]);

    const disposeQueryEditorAiContextMenuActions = useCallback(() => {
        aiContextMenuActionDisposablesRef.current.forEach((disposable) => disposable?.dispose?.());
        aiContextMenuActionDisposablesRef.current = [];
    }, []);

    const registerQueryEditorAiContextMenuActions = useCallback((editor: any) => {
        disposeQueryEditorAiContextMenuActions();
        if (isElasticsearchMode) {
            return;
        }
        aiContextMenuActionDisposablesRef.current = buildQueryEditorAiContextMenuActions().map((action) => (
            editor.addAction({
                id: action.id,
                label: action.label,
                contextMenuGroupId: '9_ai',
                contextMenuOrder: 1,
                ...(action.bindSelection ? { precondition: 'editorHasSelection' } : {}),
                run: async (ed: any) => {
                    if (action.bindSelection) {
                        const selection = publishQueryEditorSelection({
                            editor: ed,
                            tabId: tab.id,
                            tabTitle: tab.title,
                            connectionId: currentConnectionIdRef.current || tab.connectionId,
                            dbName: currentDbRef.current || tab.dbName,
                            language: queryEditorMonacoLanguage,
                        });
                        const connectionId = String(currentConnectionIdRef.current || tab.connectionId || '').trim();
                        if (!selection) {
                            message.warning(translate('ai_chat.input.message.select_editor_text_first'));
                            return;
                        }
                        if (!connectionId) {
                            message.warning(translate('ai_chat.input.message.select_database_context_first'));
                            return;
                        }
                        const dbName = String(currentDbRef.current || tab.dbName || '').trim();
                        const connectionKey = `${connectionId}:${dbName}`;
                        const state = useStore.getState();
                        const result = bindAIEditorSelectionContext({
                            selection,
                            connectionKey,
                            contextItems: state.aiContexts[connectionKey] || [],
                            addAIContext: state.addAIContext,
                            removeAIContext: state.removeAIContext,
                        });
                        if (state.activeContext?.connectionId !== connectionId
                            || state.activeContext?.dbName !== dbName) {
                            state.setActiveContext({ connectionId, dbName });
                        }
                        state.setAIPanelVisible(true);
                        if (result === 'added') {
                            message.success(translate('ai_chat.input.message.context_selection_added'));
                        } else if (result === 'unchanged') {
                            message.info(translate('ai_chat.input.message.context_selection_unchanged'));
                        }
                        return;
                    }
                    const selection = ed.getModel()?.getValueInRange(ed.getSelection());
                    let prompt = action.prompt;
                    if (action.useSelection && selection) {
                        prompt = prompt.replace(QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER, selection);
                    }
                    await injectQueryEditorAiPromptWithContext({
                        connection: connectionsRef.current.find((c) => c.id === currentConnectionIdRef.current),
                        database: currentDbRef.current,
                        prompt,
                    });
                },
            })
        ));
    }, [buildQueryEditorAiContextMenuActions, disposeQueryEditorAiContextMenuActions, isElasticsearchMode, queryEditorMonacoLanguage, tab.connectionId, tab.dbName, tab.id, tab.title]);

    const buildQueryEditorSlashCommandDefs = useCallback(() => ([
        {
            cmd: '/query',
            label: `🔍 ${translate('query_editor.slash_command.query.label')}`,
            desc: translate('query_editor.slash_command.query.description'),
            prompt: translate('query_editor.slash_command.query.prompt'),
        },
        {
            cmd: '/sql',
            label: `📝 ${translate('query_editor.slash_command.sql.label')}`,
            desc: translate('query_editor.slash_command.sql.description'),
            prompt: translate('query_editor.slash_command.sql.prompt'),
        },
        {
            cmd: '/explain',
            label: `💡 ${translate('query_editor.slash_command.explain.label')}`,
            desc: translate('query_editor.slash_command.explain.description'),
            prompt: translate('query_editor.slash_command.explain.prompt', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
            useSelection: true,
        },
        {
            cmd: '/optimize',
            label: `⚡ ${translate('query_editor.slash_command.optimize.label')}`,
            desc: translate('query_editor.slash_command.optimize.description'),
            prompt: translate('query_editor.slash_command.optimize.prompt', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
            useSelection: true,
        },
        {
            cmd: '/schema',
            label: `🏗️ ${translate('query_editor.slash_command.schema.label')}`,
            desc: translate('query_editor.slash_command.schema.description'),
            prompt: translate('query_editor.slash_command.schema.prompt'),
        },
        {
            cmd: '/index',
            label: `📊 ${translate('query_editor.slash_command.index.label')}`,
            desc: translate('query_editor.slash_command.index.description'),
            prompt: translate('query_editor.slash_command.index.prompt'),
        },
        {
            cmd: '/diff',
            label: `🔄 ${translate('query_editor.slash_command.diff.label')}`,
            desc: translate('query_editor.slash_command.diff.description'),
            prompt: translate('query_editor.slash_command.diff.prompt'),
        },
        {
            cmd: '/mock',
            label: `🎲 ${translate('query_editor.slash_command.mock.label')}`,
            desc: translate('query_editor.slash_command.mock.description'),
            prompt: translate('query_editor.slash_command.mock.prompt'),
        },
    ]), []);

    const refreshQueryEditorSlashCommandDefs = useCallback(() => {
        (window as any).__gonaviSlashCmdDefs = buildQueryEditorSlashCommandDefs();
    }, [buildQueryEditorSlashCommandDefs]);

    const syncQueryToEditor = (sql: string) => {
        const next = sql || '';
        applyQueryState(next);
        const editor = editorRef.current;
        if (editor && editor.getValue?.() !== next) {
            editor.setValue(next);
        }
    };

    const openTextToSqlModal = useCallback(() => {
        const editor = editorRef.current;
        const selection = editor?.getSelection?.();
        const selectedText = selection ? String(editor?.getModel?.()?.getValueInRange?.(selection) || '') : '';
        setTextToSqlApplyMode(selectedText.trim() ? 'replaceSelection' : 'insert');
        setIsTextToSqlModalOpen(true);
    }, []);

    const applyTextToSqlResult = useCallback((sql: string, applyMode: QueryEditorAiApplyMode) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        const nextSql = String(sql || '').trim();
        if (!nextSql) {
            return false;
        }
        if (!editor || !monaco?.Range || !model) {
            syncQueryToEditor(nextSql);
            refreshObjectDecorations();
            return true;
        }

        const selection = editor.getSelection?.();
        const hasSelection = !!selection && !(typeof selection.isEmpty === 'function'
            ? selection.isEmpty()
            : selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
        const lineCount = Number(model.getLineCount?.() || 1);
        const range = applyMode === 'replaceAll'
            ? (
                model.getFullModelRange?.()
                || new monaco.Range(1, 1, lineCount, Number(model.getLineMaxColumn?.(lineCount) || 1))
            )
            : applyMode === 'replaceSelection' && hasSelection
                ? selection
                : (() => {
                    const position = normalizeEditorPosition(editor.getPosition?.())
                        || normalizeEditorPosition(lastEditorCursorPositionRef.current)
                        || { lineNumber: lineCount, column: Number(model.getLineMaxColumn?.(lineCount) || 1) };
                    return new monaco.Range(
                        position.lineNumber,
                        position.column,
                        position.lineNumber,
                        position.column,
                    );
                })();

        editor.focus?.();
        editor.pushUndoStop?.();
        editor.executeEdits?.('gonavi-text-to-sql', [{
            range,
            text: nextSql,
            forceMoveMarkers: true,
        }]);
        editor.pushUndoStop?.();
        const nextValue = String(editor.getValue?.() || nextSql);
        applyQueryState(nextValue);
        refreshObjectDecorations();
        return true;
    }, [applyQueryState, refreshObjectDecorations]);

    const showTextToSqlReadinessWarning = useCallback((reason?: string) => {
        const key = reason === 'service_unavailable'
            ? 'query_editor.message.ai_service_unavailable'
            : reason === 'model_missing'
                ? 'query_editor.message.ai_model_missing'
                : 'query_editor.message.ai_provider_missing';
        void message.warning(translate(key));
    }, []);

    const handleGenerateTextToSql = useCallback(async () => {
        const instruction = textToSqlInstruction.trim();
        if (!instruction) {
            void message.warning(translate('query_editor.message.text_to_sql_empty_instruction'));
            return;
        }

        setTextToSqlGenerating(true);
        try {
            const aiContext = buildQueryEditorAiContext();
            const editorSnapshot = buildQueryEditorAiEditorSnapshot();
            const response = isElasticsearchMode
                ? await requestQueryEditorTextToElasticsearch({
                    service: getQueryEditorAiService(),
                    aiContext: {
                        ...aiContext,
                        elasticsearchVersion: elasticsearchServerMajor > 0
                            ? String(elasticsearchServerMajor)
                            : '',
                        elasticsearchMapping: JSON.stringify({
                            fields: (aiContext.columns || []).map((column) => ({
                                index: column.dbName,
                                field: column.name,
                                type: column.type,
                            })),
                        }, null, 2),
                    },
                    editorSnapshot,
                    instruction,
                })
                : await requestQueryEditorTextToSql({
                    service: getQueryEditorAiService(),
                    aiContext,
                    editorSnapshot,
                    instruction,
                });
            const generatedSource = 'source' in response ? response.source : response.sql;
            const { readiness } = response;
            if (!readiness.ready) {
                showTextToSqlReadinessWarning(readiness.reason);
                return;
            }
            if (!generatedSource.trim()) {
                void message.warning(translate('query_editor.message.text_to_sql_empty_result'));
                return;
            }
            if (applyTextToSqlResult(generatedSource, textToSqlApplyMode)) {
                setIsTextToSqlModalOpen(false);
                setTextToSqlInstruction('');
                void message.success(translate('query_editor.message.text_to_sql_success'));
            }
        } catch (error: any) {
            void message.error(translate(isElasticsearchMode
                ? 'query_editor.elasticsearch.ai_failed'
                : 'query_editor.message.text_to_sql_failed', {
                error: error?.message || String(error || ''),
            }));
        } finally {
            setTextToSqlGenerating(false);
        }
    }, [
        applyTextToSqlResult,
        buildQueryEditorAiContext,
        buildQueryEditorAiEditorSnapshot,
        elasticsearchServerMajor,
        isElasticsearchMode,
        showTextToSqlReadinessWarning,
        textToSqlApplyMode,
        textToSqlInstruction,
    ]);
    return {
        disposeQueryEditorAiContextMenuActions, registerQueryEditorAiContextMenuActions,
        refreshQueryEditorSlashCommandDefs, syncQueryToEditor, openTextToSqlModal,
        handleGenerateTextToSql,
    };
};

export type QueryEditorAiAssistActionsApi = ReturnType<typeof useQueryEditorAiAssistActions>;
