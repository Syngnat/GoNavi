import { useEffect } from 'react';
import {
    resolveEventTargetNode,
    shouldHandleQueryEditorRunShortcutFallback,
} from '../QueryEditorHelpers';
import {
    isEditableElement,
    isShortcutMatch,
    comboToMonacoKeyBinding,
    normalizeShortcutCombo,
} from '../../../utils/shortcuts';
import {
    buildQueryEditorMonacoActionLabel,
    QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO,
    QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID,
} from '../queryEditorRunHelpers';
import { registerQueryEditorShortcutAction } from '../queryEditorShortcutRegistration';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorRunApi } from './useQueryEditorRun';
import type { QueryEditorObjectDecorationsApi } from './useQueryEditorObjectDecorations';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorAiCompletionTriggersApi } from './useQueryEditorAiCompletionTriggers';
import type { QueryEditorDropAndLineEditsApi } from './useQueryEditorDropAndLineEdits';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorEditorActionsInput {
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    editorRef: QueryEditorCoreStateApi['editorRef'];
    editorPaneRef: QueryEditorCoreStateApi['editorPaneRef'];
    queryEditorRootRef: QueryEditorCoreStateApi['queryEditorRootRef'];
    runQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['runQueryShortcutBinding'];
    handleRunSelectedShortcut: QueryEditorRunApi['handleRunSelectedShortcut'];
    handleRun: QueryEditorRunApi['handleRun'];
    objectHoverActionRef: QueryEditorCoreStateApi['objectHoverActionRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    registerShowObjectInfoAction: QueryEditorObjectDecorationsApi['registerShowObjectInfoAction'];
    languagePreference: QueryEditorConnectionContextApi['languagePreference'];
    registerInsertSqlSnippetContextMenuAction: QueryEditorShortcutsAndSnippetsApi['registerInsertSqlSnippetContextMenuAction'];
    insertSqlSnippetActionRef: QueryEditorCoreStateApi['insertSqlSnippetActionRef'];
    registerSqlExecutionContextMenuActions: QueryEditorShortcutsAndSnippetsApi['registerSqlExecutionContextMenuActions'];
    disposeSqlExecutionContextMenuActions: QueryEditorShortcutsAndSnippetsApi['disposeSqlExecutionContextMenuActions'];
    registerTransformCaseContextMenuActions: QueryEditorShortcutsAndSnippetsApi['registerTransformCaseContextMenuActions'];
    disposeTransformCaseContextMenuActions: QueryEditorShortcutsAndSnippetsApi['disposeTransformCaseContextMenuActions'];
    registerTriggerSqlAiCompletionAction: QueryEditorAiCompletionTriggersApi['registerTriggerSqlAiCompletionAction'];
    triggerSqlAiCompletionActionRef: QueryEditorCoreStateApi['triggerSqlAiCompletionActionRef'];
    triggerSqlAiCompletionKeydownDisposableRef: QueryEditorCoreStateApi['triggerSqlAiCompletionKeydownDisposableRef'];
    triggerSqlAiCompletionShortcutBinding: QueryEditorShortcutsAndSnippetsApi['triggerSqlAiCompletionShortcutBinding'];
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    isTriggerSqlAiCompletionShortcutEvent: QueryEditorAiCompletionTriggersApi['isTriggerSqlAiCompletionShortcutEvent'];
    isPossibleTriggerSqlAiCompletionFallbackEvent: QueryEditorAiCompletionTriggersApi['isPossibleTriggerSqlAiCompletionFallbackEvent'];
    triggerSqlAiCompletionFallbackRef: QueryEditorCoreStateApi['triggerSqlAiCompletionFallbackRef'];
    triggerAiInlineCompletionRef: QueryEditorCoreStateApi['triggerAiInlineCompletionRef'];
    runQueryActionRef: QueryEditorCoreStateApi['runQueryActionRef'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    selectCurrentStatementActionRef: QueryEditorCoreStateApi['selectCurrentStatementActionRef'];
    macFindWithSelectionGuardActionRef: QueryEditorCoreStateApi['macFindWithSelectionGuardActionRef'];
    selectCurrentStatementShortcutBinding: QueryEditorShortcutsAndSnippetsApi['selectCurrentStatementShortcutBinding'];
    handleSelectCurrentStatement: QueryEditorDropAndLineEditsApi['handleSelectCurrentStatement'];
    duplicateCurrentLineActionRef: QueryEditorCoreStateApi['duplicateCurrentLineActionRef'];
    duplicateCurrentLineShortcutBinding: QueryEditorShortcutsAndSnippetsApi['duplicateCurrentLineShortcutBinding'];
    handleDuplicateCurrentLine: QueryEditorDropAndLineEditsApi['handleDuplicateCurrentLine'];
}

export const useQueryEditorEditorActions = ({
    isActive, editorRef, editorPaneRef, queryEditorRootRef, runQueryShortcutBinding,
    handleRunSelectedShortcut, handleRun, objectHoverActionRef, monacoRef,
    registerShowObjectInfoAction, languagePreference, registerInsertSqlSnippetContextMenuAction,
    insertSqlSnippetActionRef, registerSqlExecutionContextMenuActions,
    disposeSqlExecutionContextMenuActions, registerTransformCaseContextMenuActions,
    disposeTransformCaseContextMenuActions, registerTriggerSqlAiCompletionAction,
    triggerSqlAiCompletionActionRef, triggerSqlAiCompletionKeydownDisposableRef,
    triggerSqlAiCompletionShortcutBinding, isElasticsearchMode,
    isTriggerSqlAiCompletionShortcutEvent, isPossibleTriggerSqlAiCompletionFallbackEvent,
    triggerSqlAiCompletionFallbackRef, triggerAiInlineCompletionRef, runQueryActionRef,
    activeShortcutPlatform, selectCurrentStatementActionRef, macFindWithSelectionGuardActionRef,
    selectCurrentStatementShortcutBinding, handleSelectCurrentStatement,
    duplicateCurrentLineActionRef, duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine,
}: UseQueryEditorEditorActionsInput) => {
    useEffect(() => {
        const handleSelectAllInEditor = (event: KeyboardEvent) => {
            if (!isActive) {
                return;
            }
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') {
                return;
            }

            const editor = editorRef.current;
            if (!editor) {
                return;
            }

            const targetNode = resolveEventTargetNode(event.target);
            const editorHasFocus = !!editor.hasTextFocus?.();
            const inEditorPane = !!(targetNode && editorPaneRef.current?.contains(targetNode));
            const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
            if (isEditableElement(event.target)) {
                return;
            }
            if (!editorHasFocus && !inEditorPane) {
                return;
            }
            if (!editorHasFocus && !inQueryEditor) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            editor.focus?.();
            editor.trigger('keyboard', 'editor.action.selectAll', null);
        };

        window.addEventListener('keydown', handleSelectAllInEditor, true);
        return () => {
            window.removeEventListener('keydown', handleSelectAllInEditor, true);
        };
    }, [isActive]);

    useEffect(() => {
        const binding = runQueryShortcutBinding;
        if (!binding?.enabled || !binding.combo) {
            return;
        }

        const handleRunShortcut = (event: KeyboardEvent) => {
            if (!isActive) {
                return;
            }
            if (!isShortcutMatch(event, binding.combo)) {
                return;
            }
            const editorHasFocus = !!editorRef.current?.hasTextFocus?.();
            const targetNode = resolveEventTargetNode(event.target);
            if (!shouldHandleQueryEditorRunShortcutFallback({
                editorHasFocus,
                targetNode,
                editorPane: editorPaneRef.current,
            })) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            void handleRunSelectedShortcut();
        };

        window.addEventListener('keydown', handleRunShortcut, true);
        return () => {
            window.removeEventListener('keydown', handleRunShortcut, true);
        };
    }, [isActive, runQueryShortcutBinding, handleRun]);

    // Re-register Monaco internal keybinding when runQuery shortcut changes
    useEffect(() => {
        if (objectHoverActionRef.current) {
            objectHoverActionRef.current.dispose();
            objectHoverActionRef.current = null;
        }

        if (!editorRef.current || !monacoRef.current) return;

        registerShowObjectInfoAction();

        return () => {
            if (objectHoverActionRef.current) {
                objectHoverActionRef.current.dispose();
                objectHoverActionRef.current = null;
            }
        };
    }, [languagePreference, registerShowObjectInfoAction]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        registerInsertSqlSnippetContextMenuAction(editor);

        return () => {
            if (insertSqlSnippetActionRef.current) {
                insertSqlSnippetActionRef.current.dispose();
                insertSqlSnippetActionRef.current = null;
            }
        };
    }, [languagePreference, registerInsertSqlSnippetContextMenuAction]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        registerSqlExecutionContextMenuActions(editor);

        return () => {
            disposeSqlExecutionContextMenuActions();
        };
    }, [disposeSqlExecutionContextMenuActions, languagePreference, registerSqlExecutionContextMenuActions]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        registerTransformCaseContextMenuActions(editor);

        return () => {
            disposeTransformCaseContextMenuActions();
        };
    }, [languagePreference, disposeTransformCaseContextMenuActions, registerTransformCaseContextMenuActions]);

    useEffect(() => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        registerTriggerSqlAiCompletionAction(editor, monaco);

        return () => {
            if (triggerSqlAiCompletionActionRef.current) {
                triggerSqlAiCompletionActionRef.current.dispose();
                triggerSqlAiCompletionActionRef.current = null;
            }
        };
    }, [languagePreference, registerTriggerSqlAiCompletionAction]);

    useEffect(() => {
        triggerSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
        triggerSqlAiCompletionKeydownDisposableRef.current = null;

        const editor = editorRef.current;
        const binding = triggerSqlAiCompletionShortcutBinding;
        if (isElasticsearchMode || !editor?.onKeyDown || !binding?.enabled || !binding.combo) {
            return;
        }

        triggerSqlAiCompletionKeydownDisposableRef.current = editor.onKeyDown((event: any) => {
            if (!isActive) {
                return;
            }

            const browserEvent = event?.browserEvent || event?.event || event;
            if (!browserEvent) {
                return;
            }
            if (!isTriggerSqlAiCompletionShortcutEvent(browserEvent)) {
                if (isPossibleTriggerSqlAiCompletionFallbackEvent(browserEvent)) {
                    triggerSqlAiCompletionFallbackRef.current = { observedAt: Date.now() };
                }
                return;
            }

            triggerSqlAiCompletionFallbackRef.current = null;
            event?.preventDefault?.();
            event?.stopPropagation?.();
            browserEvent.preventDefault?.();
            browserEvent.stopPropagation?.();
            triggerAiInlineCompletionRef.current?.();
        });

        return () => {
            triggerSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
            triggerSqlAiCompletionKeydownDisposableRef.current = null;
        };
    }, [isActive, isElasticsearchMode, isPossibleTriggerSqlAiCompletionFallbackEvent, isTriggerSqlAiCompletionShortcutEvent, triggerSqlAiCompletionShortcutBinding]);

    useEffect(() => {
        if (runQueryActionRef.current) {
            runQueryActionRef.current.dispose();
            runQueryActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const binding = runQueryShortcutBinding;
        if (!binding?.enabled || !binding.combo) return;

        const keyBinding = comboToMonacoKeyBinding(
            binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
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

        return () => {
            if (runQueryActionRef.current) {
                runQueryActionRef.current.dispose();
                runQueryActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, languagePreference, runQueryShortcutBinding]);

    useEffect(() => {
        if (selectCurrentStatementActionRef.current) {
            selectCurrentStatementActionRef.current.dispose();
            selectCurrentStatementActionRef.current = null;
        }
        if (macFindWithSelectionGuardActionRef.current) {
            macFindWithSelectionGuardActionRef.current.dispose();
            macFindWithSelectionGuardActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const binding = selectCurrentStatementShortcutBinding;
        if (binding?.enabled && binding.combo) {
            const keyBinding = comboToMonacoKeyBinding(
                binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
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
                QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO,
                monaco.KeyMod,
                monaco.KeyCode,
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
                        binding?.enabled
                        && normalizeShortcutCombo(binding.combo) === QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO
                    ) {
                        void handleSelectCurrentStatement();
                    }
                },
            });
        }

        return () => {
            if (selectCurrentStatementActionRef.current) {
                selectCurrentStatementActionRef.current.dispose();
                selectCurrentStatementActionRef.current = null;
            }
            if (macFindWithSelectionGuardActionRef.current) {
                macFindWithSelectionGuardActionRef.current.dispose();
                macFindWithSelectionGuardActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, languagePreference, selectCurrentStatementShortcutBinding, handleSelectCurrentStatement]);

    useEffect(() => {
        if (duplicateCurrentLineActionRef.current) {
            duplicateCurrentLineActionRef.current.dispose();
            duplicateCurrentLineActionRef.current = null;
        }

        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        duplicateCurrentLineActionRef.current = registerQueryEditorShortcutAction({
            editor,
            monaco,
            platform: activeShortcutPlatform,
            id: 'gonavi.duplicateCurrentLine',
            label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.duplicateCurrentLine.label'),
            combo: duplicateCurrentLineShortcutBinding?.combo,
            enabled: duplicateCurrentLineShortcutBinding?.enabled,
            run: handleDuplicateCurrentLine,
        });

        return () => {
            if (duplicateCurrentLineActionRef.current) {
                duplicateCurrentLineActionRef.current.dispose();
                duplicateCurrentLineActionRef.current = null;
            }
        };
    }, [activeShortcutPlatform, duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, languagePreference]);
};

export type QueryEditorEditorActionsApi = ReturnType<typeof useQueryEditorEditorActions>;
