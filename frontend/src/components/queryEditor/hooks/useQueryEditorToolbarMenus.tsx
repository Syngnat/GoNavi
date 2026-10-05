import { useCallback, useMemo } from 'react';
import { MenuProps } from 'antd';
import {
    FileTextOutlined,
    ApiOutlined,
    SaveOutlined,
    EditOutlined,
    ExportOutlined,
} from '@ant-design/icons';
import { normalizeEditorPosition } from '../QueryEditorHelpers';
import { buildElasticsearchConsoleTemplates } from '../../../utils/elasticsearchConsole';
import { t as translate } from '../../../i18n';
import { getShortcutDisplayLabel } from '../../../utils/shortcuts';
import { buildQueryEditorAnalysisMenuItems } from '../queryEditorAnalysisMenuItems';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorAiAssistActionsApi } from './useQueryEditorAiAssistActions';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorSaveActionsApi } from './useQueryEditorSaveActions';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorToolbarMenusInput {
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    syncQueryToEditor: QueryEditorAiAssistActionsApi['syncQueryToEditor'];
    applyQueryState: QueryEditorDraftSyncApi['applyQueryState'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    elasticsearchServerMajor: QueryEditorConnectionContextApi['elasticsearchServerMajor'];
    tab: QueryEditorProps['tab'];
    currentConnectionConfig: QueryEditorConnectionContextApi['currentConnectionConfig'];
    setIsDuckDBAttachPickerOpen: QueryEditorCoreStateApi['setIsDuckDBAttachPickerOpen'];
    currentSavedQuery: QueryEditorQueryContextApi['currentSavedQuery'];
    saveQueryAsShortcutBinding: QueryEditorShortcutsAndSnippetsApi['saveQueryAsShortcutBinding'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    handleSaveQueryAs: QueryEditorSaveActionsApi['handleSaveQueryAs'];
    handleRenameQuery: QueryEditorSaveActionsApi['handleRenameQuery'];
    handleExportSQLFile: QueryEditorSaveActionsApi['handleExportSQLFile'];
    diagnoseQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['diagnoseQueryShortcutBinding'];
    showSlowQueriesShortcutBinding: QueryEditorShortcutsAndSnippetsApi['showSlowQueriesShortcutBinding'];
    currentConnectionCapabilities: QueryEditorConnectionContextApi['currentConnectionCapabilities'];
    openQueryHistoryWorkbench: QueryEditorShortcutsAndSnippetsApi['openQueryHistoryWorkbench'];
    openSqlAnalysisWorkbench: QueryEditorShortcutsAndSnippetsApi['openSqlAnalysisWorkbench'];
}

export const useQueryEditorToolbarMenus = ({
    editorRef, monacoRef, getCurrentQuery, syncQueryToEditor, applyQueryState, currentDb,
    elasticsearchServerMajor, tab, currentConnectionConfig, setIsDuckDBAttachPickerOpen,
    currentSavedQuery, saveQueryAsShortcutBinding, activeShortcutPlatform, handleSaveQueryAs,
    handleRenameQuery, handleExportSQLFile, diagnoseQueryShortcutBinding,
    showSlowQueriesShortcutBinding, currentConnectionCapabilities, openQueryHistoryWorkbench,
    openSqlAnalysisWorkbench,
}: UseQueryEditorToolbarMenusInput) => {
    const insertElasticsearchConsoleTemplate = useCallback((templateSource: string) => {
        const source = String(templateSource || '');
        if (!source) return;
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        if (!editor || !monaco?.Range || !model) {
            const current = getCurrentQuery();
            syncQueryToEditor(current.trim() ? `${current.trimEnd()}\n\n${source}` : source);
            return;
        }
        const current = String(model.getValue?.() || '');
        const selection = editor.getSelection?.();
        const position = normalizeEditorPosition(editor.getPosition?.())
            || { lineNumber: model.getLineCount?.() || 1, column: model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1 };
        const range = current.trim()
            ? (selection || new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column))
            : (model.getFullModelRange?.() || new monaco.Range(1, 1, 1, 1));
        const selectedText = selection ? String(model.getValueInRange?.(selection) || '') : '';
        const hasSelection = !!selectedText;
        const cursorOffset = typeof model.getOffsetAt === 'function'
            ? Number(model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }))
            : current.length;
        const leading = current.trim() && !hasSelection && cursorOffset > 0 ? '\n\n' : '';
        const trailing = current.trim() && !hasSelection && cursorOffset < current.length ? '\n\n' : '';
        editor.focus?.();
        editor.pushUndoStop?.();
        editor.executeEdits?.('gonavi-insert-elasticsearch-template', [{
            range,
            text: `${leading}${source}${trailing}`,
            forceMoveMarkers: true,
        }]);
        editor.pushUndoStop?.();
        applyQueryState(String(editor.getValue?.() || source));
    }, [applyQueryState, getCurrentQuery]);

    const elasticsearchTemplateMenuItems: MenuProps['items'] = useMemo(() => (
        buildElasticsearchConsoleTemplates(currentDb, {
            majorVersion: elasticsearchServerMajor || 8,
        }).map((template) => ({
            key: template.id,
            icon: <FileTextOutlined />,
            danger: template.dangerous,
            label: template.dangerous
                ? `${translate('query_editor.elasticsearch.danger_badge')} · ${translate(template.labelKey)}`
                : translate(template.labelKey),
            onClick: () => insertElasticsearchConsoleTemplate(template.source),
        }))
    ), [currentDb, elasticsearchServerMajor, insertElasticsearchConsoleTemplate]);

    const saveMoreMenuItems: MenuProps['items'] = [
        {
            type: 'group',
            key: 'query-actions',
            label: translate('tab_manager.kind_badge.query'),
            children: [
                ...(String(currentConnectionConfig?.type || '').toLowerCase() === 'duckdb' ? [{
                    key: 'duckdb-attach-datasource',
                    icon: <ApiOutlined />,
                    label: translate('query_editor.duckdb_attach.menu'),
                    onClick: () => setIsDuckDBAttachPickerOpen(true),
                }] : []),
                ...(currentSavedQuery && !tab.filePath ? [{
                    key: 'save-query-as',
                    icon: <SaveOutlined />,
                    label: (
                        <span className="gn-v2-context-menu-item-title">
                            {translate('query_editor.action.save_as')}
                            {saveQueryAsShortcutBinding?.enabled && saveQueryAsShortcutBinding.combo && (
                                <span className="gn-v2-context-menu-kbd">
                                    {getShortcutDisplayLabel(saveQueryAsShortcutBinding.combo, activeShortcutPlatform)}
                                </span>
                            )}
                        </span>
                    ),
                    onClick: handleSaveQueryAs,
                }] : []),
                {
                    key: 'rename-query',
                    label: translate('query_editor.action.rename_query'),
                    icon: <EditOutlined />,
                    disabled: !!tab.filePath,
                    onClick: handleRenameQuery,
                },
                {
                    key: 'export-sql-file',
                    label: translate('query_editor.action.export_sql_file'),
                    icon: <ExportOutlined />,
                    onClick: () => void handleExportSQLFile(),
                },
            ],
        },
    ];

    const analysisMenuItems = buildQueryEditorAnalysisMenuItems({
        translate,
        activeShortcutPlatform,
        diagnoseQueryShortcutBinding,
        showSlowQueriesShortcutBinding,
        supportsExplainDiagnosis: currentConnectionCapabilities.supportsExplainDiagnosis,
        onOpenQueryHistory: openQueryHistoryWorkbench,
        onDiagnoseQuery: () => openSqlAnalysisWorkbench('diagnose', getCurrentQuery()),
        onOpenSlowQueries: () => openSqlAnalysisWorkbench('slow-query'),
    });
    return { elasticsearchTemplateMenuItems, saveMoreMenuItems, analysisMenuItems };
};

export type QueryEditorToolbarMenusApi = ReturnType<typeof useQueryEditorToolbarMenus>;
