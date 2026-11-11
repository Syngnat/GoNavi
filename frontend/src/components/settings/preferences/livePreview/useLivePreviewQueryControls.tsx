import { useRef, useState } from 'react';
import { format } from 'sql-formatter';
import { useStore } from '../../../../store';
import { useOptionalI18n } from '../../../../i18n/provider';
import { t as defaultTranslate } from '../../../../i18n';
import type { OnMount } from '../../../MonacoEditor';
import type { QueryEditorToolbarProps } from '../../../QueryEditorToolbar';
import { QueryEditorToolbarFullscreenAction } from '../../../queryEditor/QueryEditorToolbarFullscreenAction';
import { buildQueryEditorAnalysisMenuItems } from '../../../queryEditor/queryEditorAnalysisMenuItems';
import { getShortcutPlatform, resolveShortcutBinding, type ShortcutAction } from '../../../../utils/shortcuts';
import type { SqlEditorCommitMode } from '../../../QueryEditorTransactionSettings';
import type { SavedConnection } from '../../../../types';

type Props = { value: string; connectionName: string; onChange: (sql: string) => void; onRun: (sql: string) => void; onStatus: (status: string) => void };
export function useLivePreviewQueryControls({ value, connectionName, onChange, onRun, onStatus }: Props) {
  const t = useOptionalI18n()?.t ?? defaultTranslate;
  const shortcuts = useStore(state => state.shortcutOptions);
  const formatOptions = useStore(state => state.sqlFormatOptions);
  const platform = getShortcutPlatform(typeof navigator !== 'undefined' && /Mac/.test(navigator.platform));
  const binding = (action: ShortcutAction) => resolveShortcutBinding(shortcuts, action, platform);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [wordWrap, setWordWrap] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [resultsVisible, setResultsVisible] = useState(true);
  const [commitMode, setCommitMode] = useState<SqlEditorCommitMode>('manual');
  const [commitDelay, setCommitDelay] = useState(0);
  const [keywordCase, setKeywordCase] = useState(formatOptions.keywordCase);
  const [savedSql, setSavedSql] = useState(value);
  const localOnly = () => onStatus(t('settings.preview.local_only'));
  const getSql = () => editorRef.current?.getValue() ?? value;
  const run = () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const selected = selection ? editor?.getModel()?.getValueInRange(selection) : '';
    setResultsVisible(true); setFullscreen(false);
    onRun(selected?.trim() ? selected : getSql());
  };
  const applySql = (sql: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (model && editor) { editor.pushUndoStop(); editor.executeEdits('preview', [{ range: model.getFullModelRange(), text: sql }]); editor.pushUndoStop(); }
    onChange(sql);
  };
  const formatSql = () => {
    try { applySql(format(getSql(), { language: 'mysql', keywordCase })); }
    catch { onStatus(t('query_editor.message.format_failed')); }
  };
  const save = () => { setSavedSql(getSql()); onStatus(t('settings.preview.saved_query')); };
  const connection: SavedConnection = { id: 'preview', name: connectionName, config: { type: 'mysql', host: 'demo.invalid', port: 3306, user: 'demo', database: 'sales' } };
  const toolbar: QueryEditorToolbarProps = {
    currentConnectionId: connection.id, currentDb: 'sales', queryCapableConnections: [connection], dbList: ['sales'],
    sqlEditorCommitMode: commitMode, sqlEditorAutoCommitDelayMs: commitDelay, pendingTransactionToolbar: null,
    activeShortcutPlatform: platform, runQueryShortcutBinding: binding('runQuery'), saveQueryShortcutBinding: binding('saveQuery'),
    formatSqlShortcutBinding: binding('formatSql'), triggerSqlAiCompletionShortcutBinding: binding('triggerSqlAiCompletion'),
    toggleQueryResultsPanelShortcutBinding: binding('toggleQueryResultsPanel'),
    isResultPanelVisible: resultsVisible, showSqlExecutionLog: true, onToggleSqlExecutionLog: localOnly,
    wordWrapEnabled: wordWrap, loading: false,
    saveMoreMenuItems: [{ key: 'restore-preview', label: t('settings.preview.restore_saved_query'), onClick: () => applySql(savedSql) }],
    analysisMenuItems: buildQueryEditorAnalysisMenuItems({ translate: t, activeShortcutPlatform: platform, supportsExplainDiagnosis: true,
      onOpenQueryHistory: localOnly, onDiagnoseQuery: localOnly, onOpenSlowQueries: localOnly }),
    formatSettingsMenu: [
      { key: 'upper', label: t('query_editor.format.keyword_upper'), onClick: () => setKeywordCase('upper') },
      { key: 'lower', label: t('query_editor.format.keyword_lower'), onClick: () => setKeywordCase('lower') },
    ], formatSettingsSelectedKeys: [keywordCase],
    onConnectionChange: localOnly, onDatabaseChange: localOnly,
    onCommitModeChange: setCommitMode, onAutoCommitDelayMsChange: setCommitDelay,
    onCaptureEditorCursorPosition: () => undefined, onRun: run, onCancel: localOnly, onQuickSave: save,
    onFindInEditor: () => { void editorRef.current?.getAction('actions.find')?.run(); },
    onToggleWordWrap: () => setWordWrap(current => !current), onFormat: formatSql,
    onTriggerSqlAiCompletion: localOnly, onToggleResultPanelVisibility: () => setResultsVisible(current => !current), onAIAction: localOnly,
    editorFullscreenAction: <QueryEditorToolbarFullscreenAction active={fullscreen} shortcutBinding={binding('toggleEditorFullscreen')}
      activeShortcutPlatform={platform} onToggle={() => setFullscreen(current => !current)} />,
  };
  return { toolbar, editorRef, wordWrap, fullscreen, resultsVisible };
}
