import {
    type QueryEditorAiEditorSnapshot, resolveQueryEditorInlineCompletionIntentDetails,
} from '../QueryEditorAiAssist';
import { normalizeMetadataDialect } from '../QueryEditorHelpers';
import type { OnMount } from '../../MonacoEditor';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';

export interface CreateQueryEditorAiInlineGhostStateInput {
    editor: Parameters<OnMount>[0];
    aiInlineGhostTimerRef: React.MutableRefObject<number | null>;
    aiInlineGhostDecorationIdsRef: React.MutableRefObject<string[]>;
    aiInlineGhostRequestSeqRef: React.MutableRefObject<number>;
    aiInlineGhostRef: React.MutableRefObject<{ insertText: string; editText: string; replacePrefixLength: number; modelUri: string; position: { lineNumber: number; column: number; }; snapshot: QueryEditorAiEditorSnapshot; } | null>;
    aiInlineGhostVisibleContextKeyRef: React.MutableRefObject<any>;
    aiInlineGhostOverlayRef: React.MutableRefObject<HTMLSpanElement | null>;
    editorRef: React.MutableRefObject<any>;
    monaco: Parameters<OnMount>[1];
    connectionsRef: React.MutableRefObject<SavedConnection[]>;
    currentConnectionIdRef: React.MutableRefObject<string>;
    syncQueryDraft: (nextQuery: string) => void;
}

export const createQueryEditorAiInlineGhostState = ({
    editor, aiInlineGhostTimerRef, aiInlineGhostDecorationIdsRef, aiInlineGhostRequestSeqRef,
    aiInlineGhostRef, aiInlineGhostVisibleContextKeyRef, aiInlineGhostOverlayRef, editorRef, monaco,
    connectionsRef, currentConnectionIdRef, syncQueryDraft,
}: CreateQueryEditorAiInlineGhostStateInput) => {
    const getEditorText = () => String(
        editor.getValue?.()
        ?? editor.getModel?.()?.getValue?.()
        ?? '',
    );
    const clearAiInlineGhostTimer = () => {
        if (aiInlineGhostTimerRef.current !== null) {
            clearTimeout(aiInlineGhostTimerRef.current);
            aiInlineGhostTimerRef.current = null;
        }
    };

    const clearAiInlineGhostDecorations = () => {
        if (aiInlineGhostDecorationIdsRef.current.length === 0) {
            return;
        }
        const nextDecorationIds = editor.deltaDecorations?.(
            aiInlineGhostDecorationIdsRef.current,
            [],
        );
        aiInlineGhostDecorationIdsRef.current = Array.isArray(nextDecorationIds) ? nextDecorationIds : [];
    };

    const clearAiInlineGhost = (cancelRequest = true) => {
        clearAiInlineGhostTimer();
        if (cancelRequest) {
            aiInlineGhostRequestSeqRef.current += 1;
        }
        aiInlineGhostRef.current = null;
        aiInlineGhostVisibleContextKeyRef.current?.set?.(false);
        if (aiInlineGhostOverlayRef.current) {
            aiInlineGhostOverlayRef.current.remove();
            aiInlineGhostOverlayRef.current = null;
        }
        clearAiInlineGhostDecorations();
    };

    const triggerStructuredSqlSuggest = (source: string, defer = false) => {
        const run = () => {
            if (editorRef.current !== editor) {
                return;
            }
            editor.trigger?.(source, 'editor.action.triggerSuggest', undefined);
        };
        if (defer) {
            window.setTimeout(run, 0);
            return;
        }
        run();
    };

    const didModelContentAcceptCurrentAiInlineGhost = (event: any): boolean => {
        const ghost = aiInlineGhostRef.current;
        if (!ghost?.insertText) {
            return false;
        }
        const changes = Array.isArray(event?.changes) ? event.changes : [];
        return changes.some((change: any) => {
            const changedText = String(change?.text ?? '');
            return changedText === ghost.insertText || changedText === ghost.editText;
        });
    };

    const buildInlineGhostEditorSnapshot = (model: any, position: { lineNumber: number; column: number }): QueryEditorAiEditorSnapshot => {
        const lineContent = String(model.getLineContent?.(position.lineNumber) || '');
        const lineColumnIndex = Math.max(0, Math.min(Number(position.column || 1) - 1, lineContent.length));
        const lineCount = Number(model.getLineCount?.() || position.lineNumber || 1);
        return {
            prefix: String(model.getValueInRange?.(new monaco.Range(1, 1, position.lineNumber, position.column)) || ''),
            suffix: String(model.getValueInRange?.(new monaco.Range(
                position.lineNumber,
                position.column,
                lineCount,
                Number(model.getLineMaxColumn?.(lineCount) || position.column),
            )) || ''),
            currentLineBeforeCursor: lineContent.slice(0, lineColumnIndex),
            currentLineAfterCursor: lineContent.slice(lineColumnIndex),
        };
    };

    const buildInlineGhostEditorSnapshotFromInsertedTextRemoval = (
        modelText: string,
        rangeOffset: number,
        removedTextLength: number,
    ): QueryEditorAiEditorSnapshot | null => {
        if (!Number.isFinite(rangeOffset)) {
            return null;
        }
        const safeStart = Math.max(0, Math.min(Math.trunc(rangeOffset), modelText.length));
        const safeEnd = Math.max(safeStart, Math.min(safeStart + Math.max(0, removedTextLength), modelText.length));
        const textBeforeInsertion = `${modelText.slice(0, safeStart)}${modelText.slice(safeEnd)}`;
        const prefix = textBeforeInsertion.slice(0, safeStart);
        const suffix = textBeforeInsertion.slice(safeStart);
        const lineStart = Math.max(0, prefix.lastIndexOf('\n') + 1);
        const nextLineBreak = textBeforeInsertion.indexOf('\n', safeStart);
        const lineEnd = nextLineBreak === -1 ? textBeforeInsertion.length : nextLineBreak;
        return {
            prefix,
            suffix,
            currentLineBeforeCursor: prefix.slice(lineStart).replace(/\r/g, ''),
            currentLineAfterCursor: textBeforeInsertion.slice(safeStart, lineEnd).replace(/\r/g, ''),
        };
    };

    const recoverStrayManualSqlCompletionMarker = (
        model: any,
        position: { lineNumber: number; column: number },
        snapshot: QueryEditorAiEditorSnapshot,
    ): {
        position: { lineNumber: number; column: number };
        snapshot: QueryEditorAiEditorSnapshot;
        recovered: boolean;
    } => {
        const prefix = String(snapshot.prefix || '');
        const lineBeforeCursor = String(snapshot.currentLineBeforeCursor || '');
        if (!prefix.endsWith('\\') || !lineBeforeCursor.endsWith('\\')) {
            return { position, snapshot, recovered: false };
        }

        const sanitizedSnapshot: QueryEditorAiEditorSnapshot = {
            prefix: prefix.slice(0, -1),
            suffix: String(snapshot.suffix || ''),
            currentLineBeforeCursor: lineBeforeCursor.slice(0, -1),
            currentLineAfterCursor: String(snapshot.currentLineAfterCursor || ''),
        };
        const markerDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        const intent = resolveQueryEditorInlineCompletionIntentDetails(sanitizedSnapshot, markerDialect);
        if (intent.intent !== 'table_name' && intent.intent !== 'column_name') {
            return { position, snapshot, recovered: false };
        }

        const startColumn = Math.max(1, position.column - 1);
        const startPosition = { lineNumber: position.lineNumber, column: startColumn };
        editor.executeEdits?.('gonavi-manual-sql-ai-strip-marker', [{
            range: new monaco.Range(
                position.lineNumber,
                startColumn,
                position.lineNumber,
                position.column,
            ),
            text: '',
            forceMoveMarkers: true,
        }]);
        editor.setPosition?.(startPosition);
        syncQueryDraft(getEditorText());

        return {
            position: startPosition,
            snapshot: buildInlineGhostEditorSnapshot(model, startPosition),
            recovered: true,
        };
    };

    const isInlineGhostSnapshotCurrent = (
        model: any,
        position: { lineNumber: number; column: number },
        snapshot: QueryEditorAiEditorSnapshot,
    ): boolean => {
        const currentSnapshot = buildInlineGhostEditorSnapshot(model, position);
        return currentSnapshot.prefix === snapshot.prefix
            && currentSnapshot.suffix === snapshot.suffix
            && currentSnapshot.currentLineBeforeCursor === snapshot.currentLineBeforeCursor
            && currentSnapshot.currentLineAfterCursor === snapshot.currentLineAfterCursor;
    };
    return {
        getEditorText, clearAiInlineGhostDecorations, clearAiInlineGhost,
        triggerStructuredSqlSuggest, didModelContentAcceptCurrentAiInlineGhost,
        buildInlineGhostEditorSnapshot, buildInlineGhostEditorSnapshotFromInsertedTextRemoval,
        recoverStrayManualSqlCompletionMarker, isInlineGhostSnapshotCurrent,
    };
};
