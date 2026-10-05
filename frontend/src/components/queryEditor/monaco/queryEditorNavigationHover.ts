import {
    clearQueryEditorLinkDecorations, normalizeMetadataDialect,
    resolveQueryEditorNavigationDecorations, isQueryEditorTableSourceAtPosition,
    normalizeEditorPosition, hasQueryEditorCtrlMetaModifier, type CompletionTableMeta,
    type CompletionViewMeta, type CompletionTriggerMeta, type CompletionRoutineMeta,
    type CompletionSequenceMeta, type CompletionPackageMeta,
} from '../QueryEditorHelpers';
import { setQueryEditorMouseCursor } from './queryEditorMouseCursor';
import { buildQueryEditorTableSourceProbeContext } from '../queryEditorHoverDdl';
import { useStore } from '../../../store';
import { isImeComposingKeyEvent } from '../../../utils/shortcuts';
import type { OnMount } from '../../MonacoEditor';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';

export interface CreateQueryEditorNavigationHoverInput {
    ctrlMetaPressedRef: React.MutableRefObject<boolean>;
    editor: Parameters<OnMount>[0];
    linkDecorationIdsRef: React.MutableRefObject<string[]>;
    connectionsRef: React.MutableRefObject<SavedConnection[]>;
    currentConnectionIdRef: React.MutableRefObject<string>;
    currentDbRef: React.MutableRefObject<string>;
    visibleDbsRef: React.MutableRefObject<string[]>;
    tablesRef: React.MutableRefObject<CompletionTableMeta[]>;
    viewsRef: React.MutableRefObject<CompletionViewMeta[]>;
    materializedViewsRef: React.MutableRefObject<CompletionViewMeta[]>;
    triggersRef: React.MutableRefObject<CompletionTriggerMeta[]>;
    routinesRef: React.MutableRefObject<CompletionRoutineMeta[]>;
    sequencesRef: React.MutableRefObject<CompletionSequenceMeta[]>;
    packagesRef: React.MutableRefObject<CompletionPackageMeta[]>;
    primaryShortcutModifierLabel: string;
    currentSchemaRef: React.MutableRefObject<string>;
    monaco: Parameters<OnMount>[1];
    lastHoverTargetPositionRef: React.MutableRefObject<{ lineNumber: number; column: number; } | null>;
    lastEditorCursorPositionRef: React.MutableRefObject<any>;
}

export const createQueryEditorNavigationHover = ({
    ctrlMetaPressedRef, editor, linkDecorationIdsRef, connectionsRef, currentConnectionIdRef,
    currentDbRef, visibleDbsRef, tablesRef, viewsRef, materializedViewsRef, triggersRef,
    routinesRef, sequencesRef, packagesRef, primaryShortcutModifierLabel, currentSchemaRef, monaco,
    lastHoverTargetPositionRef, lastEditorCursorPositionRef,
}: CreateQueryEditorNavigationHoverInput) => {
    const applyNavigationHoverStateAtPosition = (targetPosition: { lineNumber: number; column: number } | null) => {
        if (!ctrlMetaPressedRef.current) {
            clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
            editor.updateOptions?.({ mouseStyle: 'text' });
            setQueryEditorMouseCursor(editor, '');
            return;
        }
        if (!targetPosition) {
            clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
            editor.updateOptions?.({ mouseStyle: 'text' });
            setQueryEditorMouseCursor(editor, '');
            return;
        }
        const model = editor.getModel?.();
        const lineContent = String(model?.getLineContent?.(targetPosition.lineNumber) || '');
        const metadataDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        // mousemove 热路径禁止整篇读取模型（大文档性能约束），用光标附近有限行做探针
        const probeContext = buildQueryEditorTableSourceProbeContext(model, targetPosition);
        const decorations = resolveQueryEditorNavigationDecorations(
            lineContent,
            targetPosition.column,
            currentDbRef.current,
            visibleDbsRef.current,
            tablesRef.current,
            viewsRef.current,
            materializedViewsRef.current,
            triggersRef.current,
            routinesRef.current,
            sequencesRef.current,
            packagesRef.current,
            primaryShortcutModifierLabel,
            isQueryEditorTableSourceAtPosition(
                probeContext.text,
                probeContext.lineNumber,
                targetPosition.column,
                metadataDialect,
            ),
            probeContext.context,
            currentSchemaRef.current,
            useStore.getState().appearance.queryTableCtrlClickAction === 'locate'
                ? 'locate'
                : 'open-design',
            metadataDialect,
        );
        if (decorations.length === 0) {
            clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
            editor.updateOptions?.({ mouseStyle: 'text' });
            setQueryEditorMouseCursor(editor, '');
            return;
        }
        linkDecorationIdsRef.current = editor.deltaDecorations(
            linkDecorationIdsRef.current,
            decorations.map((item) => ({
                range: new monaco.Range(
                    targetPosition.lineNumber,
                    item.startColumn,
                    targetPosition.lineNumber,
                    item.endColumn,
                ),
                options: {
                    inlineClassName: 'gonavi-query-editor-link-hint',
                },
            })),
        );
        setQueryEditorMouseCursor(editor, 'pointer');
    };

    const applyNavigationHoverState = (event: any) => {
        const targetPosition = normalizeEditorPosition(event?.target?.position);
        lastHoverTargetPositionRef.current = targetPosition;
        if (!ctrlMetaPressedRef.current) {
            return;
        }
        applyNavigationHoverStateAtPosition(targetPosition);
    };

    const syncModifierState = (keyboardEvent?: KeyboardEvent | MouseEvent | null) => {
        const wasPressed = ctrlMetaPressedRef.current;
        const isKeyboardLikeEvent = keyboardEvent
            && typeof keyboardEvent === 'object'
            && ('key' in keyboardEvent || 'code' in keyboardEvent || 'repeat' in keyboardEvent);
        if (isKeyboardLikeEvent && isImeComposingKeyEvent(keyboardEvent as KeyboardEvent)) {
            return;
        }
        const keyboardEventType = isKeyboardLikeEvent ? String((keyboardEvent as KeyboardEvent).type || '').toLowerCase() : '';
        const keyboardKey = isKeyboardLikeEvent ? String((keyboardEvent as KeyboardEvent).key || '').trim().toLowerCase() : '';
        const keyboardCode = isKeyboardLikeEvent ? String((keyboardEvent as KeyboardEvent).code || '').trim().toLowerCase() : '';
        const isModifierKeyDown = isKeyboardLikeEvent
            && keyboardEventType !== 'keyup'
            && (
                keyboardKey === 'control'
                || keyboardKey === 'ctrl'
                || keyboardKey === 'meta'
                || keyboardKey === 'os'
                || keyboardKey === 'command'
                || keyboardCode.startsWith('control')
                || keyboardCode.startsWith('meta')
                || keyboardCode.startsWith('os')
            );
        const eventHasModifierFlag = hasQueryEditorCtrlMetaModifier(keyboardEvent);
        const nextPressed = isKeyboardLikeEvent
            ? !!(eventHasModifierFlag || isModifierKeyDown)
            : !!(eventHasModifierFlag || wasPressed);
        ctrlMetaPressedRef.current = nextPressed;
        if (!nextPressed && !wasPressed) {
            return;
        }
        if (!nextPressed) {
            clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
            editor.updateOptions?.({ mouseStyle: 'text' });
            setQueryEditorMouseCursor(editor, '');
            return;
        }
        if (!wasPressed || isKeyboardLikeEvent) {
            const keyboardFallbackPosition = isKeyboardLikeEvent
                ? normalizeEditorPosition(editor.getPosition?.()) || lastEditorCursorPositionRef.current
                : null;
            applyNavigationHoverStateAtPosition(lastHoverTargetPositionRef.current || keyboardFallbackPosition);
        }
    };
    const handleWindowBlur = () => {
        ctrlMetaPressedRef.current = false;
        clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
        editor.updateOptions?.({ mouseStyle: 'text' });
        setQueryEditorMouseCursor(editor, '');
    };
    return { applyNavigationHoverState, syncModifierState, handleWindowBlur };
};
