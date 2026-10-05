import { message, MenuProps } from 'antd';
import { format } from 'sql-formatter';
import { useRef, useEffect } from 'react';
import { UndoOutlined, CodeOutlined, KeyOutlined } from '@ant-design/icons';
import { formatElasticsearchConsoleSource } from '../../../utils/elasticsearchConsole';
import { t as translate } from '../../../i18n';
import {
    queryEditorFormatNow,
    writeQueryEditorFormatLog,
    formatQueryEditorFormatDuration,
    normalizeQueryEditorFormatLogField,
    supportsPositionalSqlFormatParams,
    QUERY_EDITOR_FORMAT_PARAM_TYPES,
    formatQueryEditorFormatError,
    QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER,
} from '../queryEditorRunHelpers';
import { resolveQueryEditorFormatterLanguage } from '../QueryEditorHelpers';
import { useQueryEditorAIAction } from '../useQueryEditorAIAction';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorAiAssistActionsApi } from './useQueryEditorAiAssistActions';
import type { QueryEditorObjectDecorationsApi } from './useQueryEditorObjectDecorations';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorFormattingInput {
    tab: QueryEditorProps['tab'];
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
    applyQueryState: QueryEditorDraftSyncApi['applyQueryState'];
    syncQueryToEditor: QueryEditorAiAssistActionsApi['syncQueryToEditor'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    sqlFormatOptions: QueryEditorConnectionContextApi['sqlFormatOptions'];
    refreshObjectDecorations: QueryEditorObjectDecorationsApi['refreshObjectDecorations'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    shortcutOptions: QueryEditorShortcutsAndSnippetsApi['shortcutOptions'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    openTextToSqlModal: QueryEditorAiAssistActionsApi['openTextToSqlModal'];
    setSqlFormatOptions: QueryEditorConnectionContextApi['setSqlFormatOptions'];
}

export const useQueryEditorFormatting = ({
    tab, isElasticsearchMode, editorRef, monacoRef, getCurrentQuery, updateQueryTabDraft,
    applyQueryState, syncQueryToEditor, currentConnectionIdRef, connectionsRef, sqlFormatOptions,
    refreshObjectDecorations, isActive, shortcutOptions, activeShortcutPlatform, connections,
    currentConnectionId, currentDb, openTextToSqlModal, setSqlFormatOptions,
}: UseQueryEditorFormattingInput) => {
    const handleFormat = () => {
        if (isElasticsearchMode) {
            const editor = editorRef.current;
            const monaco = monacoRef.current;
            const model = editor?.getModel?.();
            const selection = editor?.getSelection?.();
            const selectedRaw = model && selection
                ? String(model.getValueInRange?.(selection) || '')
                : '';
            const formatSelection = !!selection && !!selectedRaw.trim();
            const fullSource = getCurrentQuery();
            const source = formatSelection ? selectedRaw : fullSource;
            const formatted = formatElasticsearchConsoleSource(source);
            if (!formatted.ok) {
                void message.error(translate('query_editor.message.format_failed'));
                return;
            }
            if (source === formatted.text) {
                return;
            }
            updateQueryTabDraft(tab.id, {
                formatRestoreSnapshot: {
                    query: fullSource,
                    createdAt: Date.now(),
                },
            });
            if (editor && monaco && model) {
                const editRange = formatSelection
                    ? selection
                    : (model.getFullModelRange?.()
                        || new monaco.Range(1, 1, model.getLineCount?.() || 1, model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1));
                editor.pushUndoStop?.();
                editor.executeEdits?.('gonavi-format-elasticsearch-console', [{
                    range: editRange,
                    text: formatted.text,
                    forceMoveMarkers: true,
                }]);
                editor.pushUndoStop?.();
                applyQueryState(String(editor.getValue?.() || formatted.text));
                editor.setScrollLeft?.(0);
                return;
            }
            if (!formatSelection) {
                syncQueryToEditor(formatted.text);
            }
            return;
        }
        const startedAt = queryEditorFormatNow();
        let formatterLanguageLog = 'unknown';
        let dbType = '(unknown)';
        let driver = '(default)';
        let formatScope = 'full';
        let sqlLength = 0;
        let positionalParams = false;
        const logSuccess = (changed: boolean) => {
            writeQueryEditorFormatLog(
                'info',
                `[SQL美化] 成功：language=${formatterLanguageLog} dbType=${dbType} driver=${driver} scope=${formatScope} sqlLength=${sqlLength} positional=${positionalParams} durationMs=${formatQueryEditorFormatDuration(startedAt)} changed=${changed}`,
            );
        };
        try {
            const activeConnectionId = String(currentConnectionIdRef.current || '').trim();
            const tabConnectionId = String(tab.connectionId || '').trim();
            const conn = connectionsRef.current.find(c => c.id === activeConnectionId)
                || (tabConnectionId && tabConnectionId !== activeConnectionId
                    ? connectionsRef.current.find(c => c.id === tabConnectionId)
                    : undefined);
            const formatterLanguage = resolveQueryEditorFormatterLanguage(conn);
            formatterLanguageLog = formatterLanguage;
            dbType = normalizeQueryEditorFormatLogField(conn?.config?.type, '(unknown)');
            driver = normalizeQueryEditorFormatLogField(conn?.config?.driver, '(default)');
            const editor = editorRef.current;
            const monaco = monacoRef.current;
            const model = editor?.getModel?.();
            const selection = editor?.getSelection?.();
            const selectedRaw = model && selection
                ? String(model.getValueInRange?.(selection) || '')
                : '';
            const formatSelection = !!selection && !!selectedRaw.trim();
            formatScope = formatSelection ? 'selection' : 'full';
            const fullQuery = getCurrentQuery();
            const sourceSql = formatSelection ? selectedRaw : fullQuery;
            sqlLength = sourceSql.length;
            positionalParams = supportsPositionalSqlFormatParams(conn?.config);
            const formatted = format(sourceSql, {
                language: formatterLanguage,
                keywordCase: sqlFormatOptions.keywordCase,
                paramTypes: {
                    ...QUERY_EDITOR_FORMAT_PARAM_TYPES,
                    ...(positionalParams ? { positional: true } : {}),
                },
            });
            if (sourceSql === formatted) {
                logSuccess(false);
                return;
            }
            updateQueryTabDraft(tab.id, {
                formatRestoreSnapshot: {
                    query: fullQuery,
                    createdAt: Date.now(),
                },
            });
            if (editor && monaco && model) {
                const editRange = formatSelection
                    ? selection
                    : (model.getFullModelRange?.()
                        || new monaco.Range(1, 1, model.getLineCount?.() || 1, model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1));
                const currentValue = String(model.getValue?.() || fullQuery);
                if (!formatSelection && currentValue === formatted) {
                    logSuccess(false);
                    return;
                }
                editor.pushUndoStop?.();
                editor.executeEdits?.('gonavi-format-sql', [{
                    range: editRange,
                    text: formatted,
                    forceMoveMarkers: true,
                }]);
                editor.pushUndoStop?.();
                const nextValue = editor.getValue?.();
                applyQueryState(typeof nextValue === 'string' ? nextValue : (formatSelection ? currentValue : formatted));
                refreshObjectDecorations();
                editor.setScrollLeft?.(0);
                logSuccess(true);
                return;
        }
        if (formatSelection) {
            logSuccess(false);
            return;
        }
        syncQueryToEditor(formatted);
        logSuccess(true);
    } catch (e) {
            writeQueryEditorFormatLog(
                'error',
                `[SQL美化] 失败：language=${formatterLanguageLog} dbType=${dbType} driver=${driver} scope=${formatScope} sqlLength=${sqlLength} positional=${positionalParams} durationMs=${formatQueryEditorFormatDuration(startedAt)} error=${formatQueryEditorFormatError(e)}`,
            );
            void message.error(translate('query_editor.message.format_failed'));
        }
    };

    const handleFormatRef = useRef(handleFormat);
    useEffect(() => {
        handleFormatRef.current = handleFormat;
    });

    useEffect(() => {
        const handleFormatActiveQuery = () => {
            if (!isActive) {
                return;
            }
            handleFormatRef.current();
        };

        window.addEventListener('gonavi:format-active-query', handleFormatActiveQuery as EventListener);
        return () => {
            window.removeEventListener('gonavi:format-active-query', handleFormatActiveQuery as EventListener);
        };
    }, [isActive]);

    const handleRestoreLastFormat = () => {
        const previousQuery = tab.formatRestoreSnapshot?.query;
        if (!previousQuery) {
            void message.info(translate('query_editor.message.no_format_restore_snapshot'));
            return;
        }
        syncQueryToEditor(previousQuery);
        updateQueryTabDraft(tab.id, {
            query: previousQuery,
            formatRestoreSnapshot: undefined,
        });
        refreshObjectDecorations();
        void message.success(translate('query_editor.message.format_restore_success'));
    };

    const runAIAction = useQueryEditorAIAction({
        isActive, shortcuts: shortcutOptions, platform: activeShortcutPlatform,
        getSelection: () => editorRef.current?.getModel()?.getValueInRange(editorRef.current.getSelection()) || '',
        getSQL: getCurrentQuery, placeholder: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER,
        connection: connections.find((c) => c.id === currentConnectionId), database: currentDb,
        openGenerate: openTextToSqlModal,
    });
    const handleAIAction = (action: 'generate' | 'explain' | 'optimize' | 'schema') => {
        runAIAction(action);
    };

    const formatSettingsMenu: MenuProps['items'] = [
        {
            type: 'group',
            key: 'format-actions',
            label: translate('query_editor.action.format_sql'),
            children: [
                {
                    key: 'upper',
                    label: translate('query_editor.format.keyword_upper'),
                    icon: <span aria-hidden="true" className="gn-query-format-case-icon gn-query-format-case-icon-upper">AA</span>,
                    onClick: () => setSqlFormatOptions({ keywordCase: 'upper' }),
                },
                {
                    key: 'lower',
                    label: translate('query_editor.format.keyword_lower'),
                    icon: <span aria-hidden="true" className="gn-query-format-case-icon gn-query-format-case-icon-lower">aa</span>,
                    onClick: () => setSqlFormatOptions({ keywordCase: 'lower' }),
                },
                {
                    key: 'restore-last-format',
                    label: translate('query_editor.format.restore_last_format'),
                    icon: <UndoOutlined />,
                    disabled: !tab.formatRestoreSnapshot?.query,
                    onClick: handleRestoreLastFormat,
                },
            ],
        },
        {
            type: 'group',
            key: 'format-settings',
            label: translate('settings.title'),
            children: [
                {
                    key: 'snippet-settings',
                    label: translate('query_editor.format.snippet_settings'),
                    icon: <CodeOutlined />,
                    onClick: () => window.dispatchEvent(new CustomEvent('gonavi:open-snippet-settings')),
                },
                {
                    key: 'shortcut-settings',
                    label: translate('query_editor.format.shortcut_settings'),
                    icon: <KeyOutlined />,
                    onClick: () => window.dispatchEvent(new CustomEvent('gonavi:open-shortcut-settings')),
                },
            ],
        },
    ];
    return { handleFormat, handleFormatRef, handleAIAction, formatSettingsMenu };
};

export type QueryEditorFormattingApi = ReturnType<typeof useQueryEditorFormatting>;
