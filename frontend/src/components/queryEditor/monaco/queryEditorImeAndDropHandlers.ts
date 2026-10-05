import { normalizeEditorPosition } from '../QueryEditorHelpers';
import { QUERY_EDITOR_IME_FALLBACK_DELAY_MS } from '../queryEditorRunHelpers';
import { hasSidebarSqlEditorDragPayload } from '../../../utils/sidebarSqlDrag';
import { hasSqlFieldDragPayload } from '../../../utils/sqlFieldDrop';
import type { OnMount } from '../../MonacoEditor';
import type { createQueryEditorAiInlineGhostState } from './queryEditorAiInlineGhostState';

export interface CreateQueryEditorImeAndDropHandlersInput {
    editor: Parameters<OnMount>[0];
    imeCompositionFallbackTimerRef: React.MutableRefObject<number | null>;
    imeCompositionFallbackRef: React.MutableRefObject<{ editor: any; valueBefore: string; selectionBefore: any; positionBefore: { lineNumber: number; column: number; } | null; committedText: string; } | null>;
    lastEditorCursorPositionRef: React.MutableRefObject<any>;
    monaco: Parameters<OnMount>[1];
    getEditorText: ReturnType<typeof createQueryEditorAiInlineGhostState>['getEditorText'];
    editorRef: React.MutableRefObject<any>;
    syncQueryDraft: (nextQuery: string) => void;
    resolveSqlFieldDropPosition: (editor: any, event: DragEvent) => { lineNumber: number; column: number; } | null;
    updateSqlFieldDropPreview: (editor: any, position: any) => void;
    clearSqlFieldDropPreview: (editor: any) => void;
    handleSidebarObjectDrop: (event: DragEvent) => void;
}

export const createQueryEditorImeAndDropHandlers = ({
    editor, imeCompositionFallbackTimerRef, imeCompositionFallbackRef, lastEditorCursorPositionRef,
    monaco, getEditorText, editorRef, syncQueryDraft, resolveSqlFieldDropPosition,
    updateSqlFieldDropPreview, clearSqlFieldDropPreview, handleSidebarObjectDrop,
}: CreateQueryEditorImeAndDropHandlersInput) => {
    const editorDomNode = editor.getDomNode?.();
    const isQueryEditorFindWidgetFocused = (): boolean => {
        const activeElement = editorDomNode?.ownerDocument?.activeElement
            || (typeof document !== 'undefined' ? document.activeElement : null);
        try {
            return Boolean(activeElement?.closest?.(
                '.find-widget, .monaco-inputbox, .find-part, .replace-part',
            ));
        } catch {
            return false;
        }
    };
    const isQueryEditorImeInputEvent = (rawEvent: Event): boolean => {
        // Monaco keeps the SQL editor's text-focus state separate from focus in its find/replace widget.
        // Wails can occasionally retarget IME events to the hidden SQL textarea after that focus moved.
        if (editor.hasTextFocus?.() === false || isQueryEditorFindWidgetFocused()) {
            return false;
        }
        const target = (rawEvent as any)?.target;
        // Keep synthetic/test events and older WebView events without a target on the existing path.
        if (!target) {
            return true;
        }

        const safeClosest = (node: any, selector: string): any => {
            try {
                return node?.closest?.(selector) || null;
            } catch {
                return null;
            }
        };
        const hasClass = (node: any, className: string): boolean => {
            try {
                if (node?.classList?.contains?.(className)) {
                    return true;
                }
            } catch {
                // Fall through to className for lightweight DOM shims.
            }
            const rawClassName = typeof node?.className === 'string'
                ? node.className
                : String(node?.className?.baseVal || '');
            return new RegExp(`(?:^|\\s)${className}(?:\\s|$)`).test(rawClassName);
        };
        let eventPath: any[] = [target];
        try {
            const composedPath = (rawEvent as any)?.composedPath?.();
            if (Array.isArray(composedPath) && composedPath.length > 0) {
                eventPath = composedPath;
            }
        } catch {
            // Some WebView event shims expose composedPath but throw when it is unavailable.
        }

        const isFindWidgetEvent = eventPath.some((node) => (
            hasClass(node, 'find-widget')
            || hasClass(node, 'monaco-inputbox')
            || hasClass(node, 'find-part')
            || hasClass(node, 'replace-part')
        )) || Boolean(safeClosest(
            target,
            '.find-widget, .monaco-inputbox, .find-part, .replace-part',
        ));
        if (isFindWidgetEvent) {
            return false;
        }

        const inputArea = eventPath.find((node) => hasClass(node, 'inputarea'))
            || safeClosest(target, '.monaco-editor .inputarea, .inputarea');
        if (!inputArea) {
            return false;
        }

        const owningEditor = safeClosest(inputArea, '.monaco-editor');
        if (owningEditor && editorDomNode && owningEditor !== editorDomNode) {
            return false;
        }
        if (editorDomNode && typeof editorDomNode.contains === 'function') {
            try {
                if (!editorDomNode.contains(inputArea)) {
                    return false;
                }
            } catch {
                // Keep the class-based check when a lightweight DOM shim lacks contains().
            }
        }
        return true;
    };
    const clearImeCompositionFallbackTimer = () => {
        if (imeCompositionFallbackTimerRef.current !== null) {
            clearTimeout(imeCompositionFallbackTimerRef.current);
            imeCompositionFallbackTimerRef.current = null;
        }
    };
    const buildImeFallbackRange = (snapshot: NonNullable<typeof imeCompositionFallbackRef.current>) => {
        const selection = snapshot.selectionBefore;
        const startFromSelection = typeof selection?.getStartPosition === 'function'
            ? normalizeEditorPosition(selection.getStartPosition())
            : null;
        const endFromSelection = typeof selection?.getEndPosition === 'function'
            ? normalizeEditorPosition(selection.getEndPosition())
            : null;
        const startPosition = startFromSelection || normalizeEditorPosition({
            lineNumber: selection?.startLineNumber ?? selection?.selectionStartLineNumber,
            column: selection?.startColumn ?? selection?.selectionStartColumn,
        }) || snapshot.positionBefore || lastEditorCursorPositionRef.current || { lineNumber: 1, column: 1 };
        const endPosition = endFromSelection || normalizeEditorPosition({
            lineNumber: selection?.endLineNumber ?? selection?.positionLineNumber,
            column: selection?.endColumn ?? selection?.positionColumn,
        }) || startPosition;
        return new monaco.Range(
            startPosition.lineNumber,
            startPosition.column,
            endPosition.lineNumber,
            endPosition.column,
        );
    };
    const handleImeCompositionStart = (rawEvent: Event) => {
        if (!isQueryEditorImeInputEvent(rawEvent)) {
            return;
        }
        clearImeCompositionFallbackTimer();
        imeCompositionFallbackRef.current = {
            editor,
            valueBefore: getEditorText(),
            selectionBefore: editor.getSelection?.() || null,
            positionBefore: normalizeEditorPosition(editor.getPosition?.()) || lastEditorCursorPositionRef.current || null,
            committedText: '',
        };
    };
    const handleImeBeforeInput = (rawEvent: Event) => {
        if (!isQueryEditorImeInputEvent(rawEvent)) {
            return;
        }
        const snapshot = imeCompositionFallbackRef.current;
        if (!snapshot || snapshot.editor !== editor) {
            return;
        }
        const inputEvent = rawEvent as InputEvent;
        const nextText = String(inputEvent.data ?? '');
        if (nextText && (inputEvent.isComposing || String(inputEvent.inputType || '').includes('Composition'))) {
            snapshot.committedText = nextText;
        }
    };
    const handleImeCompositionEnd = (rawEvent: Event) => {
        if (!isQueryEditorImeInputEvent(rawEvent)) {
            return;
        }
        const snapshot = imeCompositionFallbackRef.current;
        imeCompositionFallbackRef.current = null;
        const committedText = String((rawEvent as CompositionEvent).data ?? '') || snapshot?.committedText || '';
        if (!committedText || !snapshot || snapshot.editor !== editor) {
            return;
        }

        const fallbackRange = buildImeFallbackRange(snapshot);
        clearImeCompositionFallbackTimer();
        imeCompositionFallbackTimerRef.current = setTimeout(() => {
            imeCompositionFallbackTimerRef.current = null;
            if (
                editorRef.current !== editor
                || editor.hasTextFocus?.() === false
                || isQueryEditorFindWidgetFocused()
            ) {
                return;
            }
            const currentValue = getEditorText();
            if (currentValue !== snapshot.valueBefore) {
                syncQueryDraft(currentValue);
                return;
            }

            editor.executeEdits?.('gonavi-ime-composition-fallback', [{
                range: fallbackRange,
                text: committedText,
                forceMoveMarkers: true,
            }]);
            const nextValue = getEditorText();
            syncQueryDraft(nextValue);

            const model = editor.getModel?.();
            const startOffset = Number(model?.getOffsetAt?.({
                lineNumber: fallbackRange.startLineNumber,
                column: fallbackRange.startColumn,
            }));
            const nextPosition = Number.isFinite(startOffset)
                ? normalizeEditorPosition(model?.getPositionAt?.(startOffset + committedText.length))
                : null;
            if (nextPosition) {
                editor.setPosition?.(nextPosition);
            }
        }, QUERY_EDITOR_IME_FALLBACK_DELAY_MS);
    };
    const handleEditorDragOver = (rawEvent: Event) => {
        const event = rawEvent as DragEvent;
        if (!hasSidebarSqlEditorDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        if (hasSqlFieldDragPayload(event.dataTransfer)) {
            const dropPosition = resolveSqlFieldDropPosition(editor, event);
            if (dropPosition) {
                editor.setPosition?.(dropPosition);
                lastEditorCursorPositionRef.current = dropPosition;
                updateSqlFieldDropPreview(editor, dropPosition);
                editor.render?.(false);
            } else {
                clearSqlFieldDropPreview(editor);
            }
        }
    };
    const handleEditorDragLeave = (rawEvent: Event) => {
        const relatedTarget = (rawEvent as DragEvent).relatedTarget as Node | null;
        if (relatedTarget && editorDomNode?.contains?.(relatedTarget)) return;
        clearSqlFieldDropPreview(editor);
    };
    const handleSqlFieldDragEnd = () => {
        clearSqlFieldDropPreview(editor);
    };
    const handleEditorDrop = (rawEvent: Event) => {
        handleSidebarObjectDrop(rawEvent as DragEvent);
    };
    return {
        editorDomNode, clearImeCompositionFallbackTimer, handleImeCompositionStart,
        handleImeBeforeInput, handleImeCompositionEnd, handleEditorDragOver, handleEditorDragLeave,
        handleSqlFieldDragEnd, handleEditorDrop,
    };
};
