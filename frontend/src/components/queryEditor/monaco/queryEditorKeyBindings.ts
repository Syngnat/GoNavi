import { comboToMonacoKeyBinding, normalizeShortcutCombo } from '../../../utils/shortcuts';
import {
    buildQueryEditorMonacoActionLabel, QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO,
    QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID,
} from '../queryEditorRunHelpers';
import { registerQueryEditorShortcutAction } from '../queryEditorShortcutRegistration';
import type { OnMount } from '../../MonacoEditor';
import type { TabData } from '../../../types';
import type { ShortcutPlatformBinding, ShortcutPlatform } from '../../../utils/shortcutDefinitions';
import type { SavedQuery } from '../../../typeDefs/workbenchTypes';

export interface RegisterQueryEditorKeyBindingsInput {
    refreshObjectDecorations: (maxTextLength?: number) => void;
    registerSqlExecutionContextMenuActions: (editor: any) => void;
    editor: Parameters<OnMount>[0];
    registerQueryEditorAiContextMenuActions: (editor: any) => void;
    registerInsertSqlSnippetContextMenuAction: (editor: any) => void;
    registerTransformCaseContextMenuActions: (editor: any) => void;
    registerToggleLineCommentAction: () => void;
    registerTriggerSqlAiCompletionAction: (editor: any, monaco: any) => void;
    monaco: Parameters<OnMount>[1];
    runQueryShortcutBinding: ShortcutPlatformBinding;
    activeShortcutPlatform: ShortcutPlatform;
    runQueryActionRef: React.MutableRefObject<any>;
    selectCurrentStatementShortcutBinding: ShortcutPlatformBinding;
    selectCurrentStatementActionRef: React.MutableRefObject<any>;
    handleSelectCurrentStatement: () => Promise<void>;
    macFindWithSelectionGuardActionRef: React.MutableRefObject<any>;
    duplicateCurrentLineShortcutBinding: ShortcutPlatformBinding;
    duplicateCurrentLineActionRef: React.MutableRefObject<any>;
    handleDuplicateCurrentLine: () => void;
    saveQueryActionRef: React.MutableRefObject<any>;
    saveQueryShortcutBinding: ShortcutPlatformBinding;
    saveQueryAsActionRef: React.MutableRefObject<any>;
    currentSavedQuery: SavedQuery | null;
    tab: TabData;
    saveQueryAsShortcutBinding: ShortcutPlatformBinding;
    findInEditorShortcutCombo: "Meta+F" | "Ctrl+F";
    findInEditorActionRef: React.MutableRefObject<any>;
    formatSqlShortcutBinding: ShortcutPlatformBinding;
    formatSqlActionRef: React.MutableRefObject<any>;
    refreshQueryEditorSlashCommandDefs: () => void;
    toggleQueryResultsPanelShortcutBinding: ShortcutPlatformBinding;
    toggleQueryResultsPanelActionRef: React.MutableRefObject<any>;
    toggleResultPanelVisibility: () => void;
}

export const registerQueryEditorKeyBindings = ({
    refreshObjectDecorations, registerSqlExecutionContextMenuActions, editor,
    registerQueryEditorAiContextMenuActions, registerInsertSqlSnippetContextMenuAction,
    registerTransformCaseContextMenuActions, registerToggleLineCommentAction,
    registerTriggerSqlAiCompletionAction, monaco, runQueryShortcutBinding, activeShortcutPlatform,
    runQueryActionRef, selectCurrentStatementShortcutBinding, selectCurrentStatementActionRef,
    handleSelectCurrentStatement, macFindWithSelectionGuardActionRef,
    duplicateCurrentLineShortcutBinding, duplicateCurrentLineActionRef, handleDuplicateCurrentLine,
    saveQueryActionRef, saveQueryShortcutBinding, saveQueryAsActionRef, currentSavedQuery, tab,
    saveQueryAsShortcutBinding, findInEditorShortcutCombo, findInEditorActionRef,
    formatSqlShortcutBinding, formatSqlActionRef, refreshQueryEditorSlashCommandDefs,
    toggleQueryResultsPanelShortcutBinding, toggleQueryResultsPanelActionRef,
    toggleResultPanelVisibility,
}: RegisterQueryEditorKeyBindingsInput) => {
    refreshObjectDecorations();

    // 注册 SQL 执行右键菜单操作
    registerSqlExecutionContextMenuActions(editor);
    // 注册 AI 右键菜单操作
    registerQueryEditorAiContextMenuActions(editor);
    registerInsertSqlSnippetContextMenuAction(editor);
    registerTransformCaseContextMenuActions(editor);
    registerToggleLineCommentAction();
    registerTriggerSqlAiCompletionAction(editor, monaco);

    // Register runQuery shortcut inside Monaco so it overrides Monaco's default keybinding
    const runBinding = runQueryShortcutBinding;
    if (runBinding?.enabled && runBinding.combo) {
        const keyBinding = comboToMonacoKeyBinding(
            runBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
        );
        if (keyBinding) {
            runQueryActionRef.current = editor.addAction({
                id: 'gonavi.runQuery',
                label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.runQuery.label'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                keybindingContext: 'editorTextFocus',
                run: () => {
                    window.dispatchEvent(new CustomEvent('gonavi:run-active-query', {
                        detail: { requireSelection: true },
                    }));
                },
            });
        }
    }

    const selectStatementBinding = selectCurrentStatementShortcutBinding;
    if (selectStatementBinding?.enabled && selectStatementBinding.combo) {
        const keyBinding = comboToMonacoKeyBinding(
            selectStatementBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
        );
        if (keyBinding) {
            selectCurrentStatementActionRef.current = editor.addAction({
                id: 'gonavi.selectCurrentStatement',
                label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.selectCurrentStatement.label'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                run: handleSelectCurrentStatement,
            });
        }
    }

    const macFindWithSelectionGuardKeyBinding = activeShortcutPlatform === 'mac'
        ? comboToMonacoKeyBinding(
            QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO, monaco.KeyMod, monaco.KeyCode,
            activeShortcutPlatform,
        )
        : null;
    if (macFindWithSelectionGuardKeyBinding) {
        macFindWithSelectionGuardActionRef.current = editor.addAction({
            id: QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID,
            label: 'GoNavi: Suppress macOS Cmd+E Find with Selection',
            keybindings: [
                macFindWithSelectionGuardKeyBinding.keyMod
                | macFindWithSelectionGuardKeyBinding.keyCode,
            ],
            run: () => {
                if (
                    selectStatementBinding?.enabled
                    && normalizeShortcutCombo(selectStatementBinding.combo) === QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO
                ) {
                    void handleSelectCurrentStatement();
                }
            },
        });
    }

    const duplicateLineBinding = duplicateCurrentLineShortcutBinding;
    if (duplicateLineBinding?.enabled && duplicateLineBinding.combo) {
        const keyBinding = comboToMonacoKeyBinding(
            duplicateLineBinding.combo, monaco.KeyMod, monaco.KeyCode,
            activeShortcutPlatform,
        );
        if (keyBinding) {
            duplicateCurrentLineActionRef.current = editor.addAction({
                id: 'gonavi.duplicateCurrentLine',
                label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.duplicateCurrentLine.label'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                run: handleDuplicateCurrentLine,
            });
        }
    }

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

    saveQueryAsActionRef.current = currentSavedQuery && !tab.filePath
        ? registerQueryEditorShortcutAction({
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
        })
        : null;

    const findInEditorKeyBinding = comboToMonacoKeyBinding(
        findInEditorShortcutCombo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
    );
    if (findInEditorKeyBinding) {
        findInEditorActionRef.current = editor.addAction({
            id: 'gonavi.findInEditor',
            label: buildQueryEditorMonacoActionLabel('query_editor.action.find_in_editor'),
            keybindings: [findInEditorKeyBinding.keyMod | findInEditorKeyBinding.keyCode],
            run: () => {
                window.dispatchEvent(new CustomEvent('gonavi:find-active-query'));
            },
        });
    }

    const formatBinding = formatSqlShortcutBinding;
    if (formatBinding?.enabled && formatBinding.combo) {
        const keyBinding = comboToMonacoKeyBinding(
            formatBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
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
    }

    // 注册 / 斜杠命令 AI 快捷补全
    refreshQueryEditorSlashCommandDefs();
    const toggleResultsBinding = toggleQueryResultsPanelShortcutBinding;
    if (toggleResultsBinding?.enabled && toggleResultsBinding.combo) {
        const keyBinding = comboToMonacoKeyBinding(
            toggleResultsBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
        );
        if (keyBinding) {
            toggleQueryResultsPanelActionRef.current = editor.addAction({
                id: 'gonavi.toggleQueryResultsPanel',
                label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.toggleQueryResultsPanel.label'),
                keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                run: toggleResultPanelVisibility,
            });
        }
    }
};
