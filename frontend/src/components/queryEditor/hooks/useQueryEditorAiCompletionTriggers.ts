import { useCallback, useEffect } from 'react';
import {
    isShortcutMatch,
    normalizeShortcutCombo,
    comboToMonacoKeyBinding,
} from '../../../utils/shortcuts';
import { buildQueryEditorMonacoActionLabel } from '../queryEditorRunHelpers';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorAiCompletionTriggersInput {
    triggerSqlAiCompletionShortcutBinding: QueryEditorShortcutsAndSnippetsApi['triggerSqlAiCompletionShortcutBinding'];
    triggerSqlAiCompletionAltPressedRef: QueryEditorCoreStateApi['triggerSqlAiCompletionAltPressedRef'];
    triggerSqlAiCompletionActionRef: QueryEditorCoreStateApi['triggerSqlAiCompletionActionRef'];
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    triggerAiInlineCompletionRef: QueryEditorCoreStateApi['triggerAiInlineCompletionRef'];
    tab: QueryEditorProps['tab'];
    restoredResultSessionRef: QueryEditorCoreStateApi['restoredResultSessionRef'];
    isResultPanelVisibleRef: QueryEditorConnectionContextApi['isResultPanelVisibleRef'];
    setIsResultPanelVisible: QueryEditorConnectionContextApi['setIsResultPanelVisible'];
}

export const useQueryEditorAiCompletionTriggers = ({
    triggerSqlAiCompletionShortcutBinding, triggerSqlAiCompletionAltPressedRef,
    triggerSqlAiCompletionActionRef, isElasticsearchMode, activeShortcutPlatform,
    triggerAiInlineCompletionRef, tab, restoredResultSessionRef, isResultPanelVisibleRef,
    setIsResultPanelVisible,
}: UseQueryEditorAiCompletionTriggersInput) => {
    const isTriggerSqlAiCompletionShortcutEvent = useCallback((event: any): boolean => {
        const binding = triggerSqlAiCompletionShortcutBinding;
        if (!binding?.enabled || !binding.combo) {
            return false;
        }
        if (isShortcutMatch(event, binding.combo)) {
            return true;
        }
        if (normalizeShortcutCombo(binding.combo) !== 'Alt+\\') {
            return false;
        }

        const key = String(
            event?.key
            || event?.nativeEvent?.key
            || event?.browserEvent?.key
            || '',
        ).trim();
        const code = String(
            event?.code
            || event?.nativeEvent?.code
            || event?.browserEvent?.code
            || '',
        ).trim();
        const keyCode = Number(
            event?.keyCode
            ?? event?.which
            ?? event?.nativeEvent?.keyCode
            ?? event?.nativeEvent?.which
            ?? event?.browserEvent?.keyCode
            ?? event?.browserEvent?.which
            ?? 0,
        );
        const isBackslashKey = key === '\\'
            || code === 'Backslash'
            || code === 'IntlBackslash'
            || keyCode === 220
            || keyCode === 226;
        return isBackslashKey && triggerSqlAiCompletionAltPressedRef.current;
    }, [triggerSqlAiCompletionShortcutBinding]);
    const isPossibleTriggerSqlAiCompletionFallbackEvent = useCallback((event: any): boolean => {
        const binding = triggerSqlAiCompletionShortcutBinding;
        if (!binding?.enabled || normalizeShortcutCombo(binding.combo) !== 'Alt+\\') {
            return false;
        }

        const key = String(
            event?.key
            || event?.nativeEvent?.key
            || event?.browserEvent?.key
            || '',
        ).trim();
        const code = String(
            event?.code
            || event?.nativeEvent?.code
            || event?.browserEvent?.code
            || '',
        ).trim();
        const keyCode = Number(
            event?.keyCode
            ?? event?.which
            ?? event?.nativeEvent?.keyCode
            ?? event?.nativeEvent?.which
            ?? event?.browserEvent?.keyCode
            ?? event?.browserEvent?.which
            ?? 0,
        );
        const isLikelyBackslashKey = key === '\\'
            || key === 'Process'
            || code === 'Backslash'
            || code === 'IntlBackslash'
            || keyCode === 220
            || keyCode === 226;
        const hasAltIntent = Boolean(
            event?.altKey
            || event?.nativeEvent?.altKey
            || event?.browserEvent?.altKey
            || triggerSqlAiCompletionAltPressedRef.current
        );
        return isLikelyBackslashKey && hasAltIntent;
    }, [triggerSqlAiCompletionShortcutBinding]);
    const registerTriggerSqlAiCompletionAction = useCallback((editor: any, monaco: any) => {
        if (triggerSqlAiCompletionActionRef.current) {
            triggerSqlAiCompletionActionRef.current.dispose();
            triggerSqlAiCompletionActionRef.current = null;
        }
        if (!editor || !monaco || isElasticsearchMode) {
            return;
        }

        const binding = triggerSqlAiCompletionShortcutBinding;
        const keyBinding = binding?.enabled && binding.combo
            ? comboToMonacoKeyBinding(binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform)
            : null;
        triggerSqlAiCompletionActionRef.current = editor.addAction({
            id: 'gonavi.triggerSqlAiCompletion',
            label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.triggerSqlAiCompletion.label'),
            keybindings: keyBinding ? [keyBinding.keyMod | keyBinding.keyCode] : [],
            contextMenuGroupId: '7_ai',
            contextMenuOrder: 0,
            run: () => {
                triggerAiInlineCompletionRef.current?.();
            },
        });
    }, [activeShortcutPlatform, isElasticsearchMode, triggerSqlAiCompletionShortcutBinding]);
    useEffect(() => {
        // Prefer remount session cache (detach/attach); otherwise follow tab draft flag.
        if (restoredResultSessionRef.current && restoredResultSessionRef.current.isResultPanelVisible !== undefined) {
            const restoredVisible = restoredResultSessionRef.current.isResultPanelVisible === true;
            isResultPanelVisibleRef.current = restoredVisible;
            setIsResultPanelVisible(restoredVisible);
            return;
        }
        const restoredVisible = tab.resultPanelVisible === true;
        isResultPanelVisibleRef.current = restoredVisible;
        setIsResultPanelVisible(restoredVisible);
    }, [tab.id, tab.resultPanelVisible]);
    return {
        isTriggerSqlAiCompletionShortcutEvent, isPossibleTriggerSqlAiCompletionFallbackEvent,
        registerTriggerSqlAiCompletionAction,
    };
};

export type QueryEditorAiCompletionTriggersApi = ReturnType<typeof useQueryEditorAiCompletionTriggers>;
