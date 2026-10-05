import {
    type QueryEditorAiEditorSnapshot, type QueryEditorInlineCompletionEdit,
    resolveInlineSqlGhostPreviewText, isQueryEditorInlineTableAliasPending,
    resolveQueryEditorInlineCompletionIntentDetails, resolveQueryEditorInlineMemoryInsertText,
    resolveQueryEditorInlineCompletionEdit, shouldRequestQueryEditorInlineCompletion,
    resolveQueryEditorInlineLocalCompletion, getQueryEditorAiService,
    resolveQueryEditorInlineRuntimeReadiness, requestQueryEditorInlineCompletion,
    shouldTriggerQueryEditorInlineObjectSuggestFallback, type QueryEditorAiContext,
} from '../QueryEditorAiAssist';
import { normalizeEditorPosition, normalizeMetadataDialect } from '../QueryEditorHelpers';
import { sharedActiveEditorModelUri } from '../queryEditorCompletionState';
import { useStore } from '../../../store';
import { QUERY_EDITOR_AI_INLINE_DEBOUNCE_MS } from '../queryEditorRunHelpers';
import { isShortcutMatch } from '../../../utils/shortcuts';
import type { OnMount } from '../../MonacoEditor';
import type { createQueryEditorAiInlineGhostState } from './queryEditorAiInlineGhostState';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';

export interface CreateQueryEditorAiInlineGhostActionsInput {
    clearAiInlineGhost: ReturnType<typeof createQueryEditorAiInlineGhostState>['clearAiInlineGhost'];
    aiInlineGhostRef: React.MutableRefObject<{ insertText: string; editText: string; replacePrefixLength: number; modelUri: string; position: { lineNumber: number; column: number; }; snapshot: QueryEditorAiEditorSnapshot; } | null>;
    clearAiInlineGhostDecorations: ReturnType<typeof createQueryEditorAiInlineGhostState>['clearAiInlineGhostDecorations'];
    editor: Parameters<OnMount>[0];
    aiInlineGhostOverlayRef: React.MutableRefObject<HTMLSpanElement | null>;
    monaco: Parameters<OnMount>[1];
    aiInlineGhostVisibleContextKeyRef: React.MutableRefObject<any>;
    isInlineGhostSnapshotCurrent: ReturnType<typeof createQueryEditorAiInlineGhostState>['isInlineGhostSnapshotCurrent'];
    aiInlineGhostAcceptingRef: React.MutableRefObject<boolean>;
    syncQueryDraft: (nextQuery: string) => void;
    editorRef: React.MutableRefObject<any>;
    aiInlineGhostTimerRef: React.MutableRefObject<number | null>;
    buildInlineGhostEditorSnapshot: ReturnType<typeof createQueryEditorAiInlineGhostState>['buildInlineGhostEditorSnapshot'];
    recoverStrayManualSqlCompletionMarker: ReturnType<typeof createQueryEditorAiInlineGhostState>['recoverStrayManualSqlCompletionMarker'];
    connectionsRef: React.MutableRefObject<SavedConnection[]>;
    currentConnectionIdRef: React.MutableRefObject<string>;
    buildQueryEditorAiContext: () => QueryEditorAiContext;
    inlineSqlMemoryEntries: { sql: string; }[];
    aiInlineGhostRequestSeqRef: React.MutableRefObject<number>;
    ensureQueryEditorAiContextMetadata: (editorSnapshot: QueryEditorAiEditorSnapshot) => Promise<void>;
    triggerStructuredSqlSuggest: ReturnType<typeof createQueryEditorAiInlineGhostState>['triggerStructuredSqlSuggest'];
    triggerAiInlineCompletionRef: React.MutableRefObject<(() => void) | null>;
    acceptAiInlineCompletionRef: React.MutableRefObject<(() => boolean) | null>;
    acceptSqlAiCompletionKeydownDisposableRef: React.MutableRefObject<any>;
    queryEditorActiveRef: React.MutableRefObject<boolean>;
    acceptSqlAiCompletionBindingRef: React.MutableRefObject<{ combo: string; enabled: boolean; }>;
}

export const createQueryEditorAiInlineGhostActions = ({
    clearAiInlineGhost, aiInlineGhostRef, clearAiInlineGhostDecorations, editor,
    aiInlineGhostOverlayRef, monaco, aiInlineGhostVisibleContextKeyRef,
    isInlineGhostSnapshotCurrent, aiInlineGhostAcceptingRef, syncQueryDraft, editorRef,
    aiInlineGhostTimerRef, buildInlineGhostEditorSnapshot, recoverStrayManualSqlCompletionMarker,
    connectionsRef, currentConnectionIdRef, buildQueryEditorAiContext, inlineSqlMemoryEntries,
    aiInlineGhostRequestSeqRef, ensureQueryEditorAiContextMetadata, triggerStructuredSqlSuggest,
    triggerAiInlineCompletionRef, acceptAiInlineCompletionRef,
    acceptSqlAiCompletionKeydownDisposableRef, queryEditorActiveRef,
    acceptSqlAiCompletionBindingRef,
}: CreateQueryEditorAiInlineGhostActionsInput) => {
    const renderAiInlineGhost = (
        model: any,
        position: { lineNumber: number; column: number },
        insertText: string,
        snapshot: QueryEditorAiEditorSnapshot,
        edit?: QueryEditorInlineCompletionEdit,
    ) => {
        const resolvedEdit = edit || {
            previewText: insertText,
            editText: insertText,
            replacePrefixLength: 0,
        };
        const previewText = resolveInlineSqlGhostPreviewText(resolvedEdit.previewText);
        if (!previewText) {
            clearAiInlineGhost(false);
            return;
        }

        const modelUri = String(model?.uri?.toString?.() || '');
        aiInlineGhostRef.current = {
            insertText: resolvedEdit.previewText,
            editText: resolvedEdit.editText,
            replacePrefixLength: resolvedEdit.replacePrefixLength,
            modelUri,
            position,
            snapshot,
        };
        clearAiInlineGhostDecorations();
        const visiblePosition = editor.getScrolledVisiblePosition?.(position);
        const editorDomNode = editor.getDomNode?.();
        if (!visiblePosition || !editorDomNode) {
            clearAiInlineGhost(false);
            return;
        }

        const overlay = aiInlineGhostOverlayRef.current || document.createElement('span');
        if (!aiInlineGhostOverlayRef.current) {
            overlay.className = 'gonavi-query-editor-ai-inline-ghost-overlay';
            editorDomNode.appendChild(overlay);
            aiInlineGhostOverlayRef.current = overlay;
        }

        const fontInfoOption = monaco.editor?.EditorOption?.fontInfo;
        const fontInfo = fontInfoOption !== undefined ? editor.getOption?.(fontInfoOption) : null;
        overlay.textContent = previewText;
        overlay.style.left = `${Math.max(0, visiblePosition.left)}px`;
        overlay.style.top = `${Math.max(0, visiblePosition.top)}px`;
        overlay.style.height = `${Math.max(1, visiblePosition.height || fontInfo?.lineHeight || 20)}px`;
        overlay.style.lineHeight = `${Math.max(1, visiblePosition.height || fontInfo?.lineHeight || 20)}px`;
        if (fontInfo) {
            overlay.style.fontFamily = String(fontInfo.fontFamily || '');
            overlay.style.fontSize = `${Number(fontInfo.fontSize || 14)}px`;
            overlay.style.fontWeight = String(fontInfo.fontWeight || 'normal');
        }
        aiInlineGhostVisibleContextKeyRef.current?.set?.(true);
    };

    const acceptAiInlineGhost = (): boolean => {
        const ghost = aiInlineGhostRef.current;
        const model = editor.getModel?.();
        const position = normalizeEditorPosition(editor.getPosition?.());
        if (!ghost || !model || !position) {
            return false;
        }
        const modelUri = String(model?.uri?.toString?.() || '');
        if (
            ghost.modelUri !== modelUri
            || ghost.position.lineNumber !== position.lineNumber
            || ghost.position.column !== position.column
            || !isInlineGhostSnapshotCurrent(model, position, ghost.snapshot)
        ) {
            clearAiInlineGhost();
            return false;
        }

        aiInlineGhostAcceptingRef.current = true;
        try {
            editor.pushUndoStop?.();
            const replacePrefixLength = Math.max(
                0,
                Math.min(ghost.replacePrefixLength, Math.max(0, position.column - 1)),
            );
            const editStartPosition = {
                lineNumber: position.lineNumber,
                column: position.column - replacePrefixLength,
            };
            const startOffset = typeof model.getOffsetAt === 'function'
                ? Number(model.getOffsetAt(editStartPosition))
                : Number.NaN;
            editor.executeEdits?.('gonavi-ai-inline-sql-completion', [{
                range: new monaco.Range(
                    editStartPosition.lineNumber,
                    editStartPosition.column,
                    position.lineNumber,
                    position.column,
                ),
                text: ghost.editText,
                forceMoveMarkers: true,
            }]);
            editor.pushUndoStop?.();
            syncQueryDraft(String(editor.getValue?.() ?? model.getValue?.() ?? ''));
            if (Number.isFinite(startOffset) && typeof model.getPositionAt === 'function') {
                const nextPosition = normalizeEditorPosition(model.getPositionAt(startOffset + ghost.editText.length));
                if (nextPosition) {
                    editor.setPosition?.(nextPosition);
                }
            }
        } finally {
            aiInlineGhostAcceptingRef.current = false;
            clearAiInlineGhost();
        }
        requestAiInlineGhost(0);
        return true;
    };

    const requestAiInlineGhost = (delayMs: number, focusEditor = false, manualTrigger = false) => {
        clearAiInlineGhost();
        if (aiInlineGhostAcceptingRef.current || editorRef.current !== editor) {
            return;
        }
        // Automatic ghost completion is debounced to keep model snapshotting
        // off the Monaco content-change hot path. Manual triggers still use
        // delay 0 and retain their immediate behavior.
        if (delayMs > 0) {
            aiInlineGhostTimerRef.current = setTimeout(() => {
                aiInlineGhostTimerRef.current = null;
                requestAiInlineGhost(0, focusEditor, manualTrigger);
            }, delayMs);
            return;
        }
        if (focusEditor) {
            editor.focus?.();
        }

        const model = editor.getModel?.();
        let position = normalizeEditorPosition(editor.getPosition?.());
        if (!model || !position) {
            return;
        }
        if (String(model.getLanguageId?.() || '') === 'elasticsearch-console') {
            return;
        }

        const modelUri = String(model?.uri?.toString?.() || '');
        if (modelUri && sharedActiveEditorModelUri && modelUri !== sharedActiveEditorModelUri) {
            return;
        }

        let editorSnapshot = buildInlineGhostEditorSnapshot(model, position);
        if (manualTrigger) {
            const normalizedState = recoverStrayManualSqlCompletionMarker(model, position, editorSnapshot);
            position = normalizedState.position;
            editorSnapshot = normalizedState.snapshot;
        }
        const autoAddTableAlias = useStore.getState().appearance.autoAddTableAlias !== false;
        const inlineDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        if (!autoAddTableAlias && isQueryEditorInlineTableAliasPending(editorSnapshot, inlineDialect)) {
            return;
        }
        const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot, inlineDialect);
        const shouldUseInlineMemory = manualTrigger || intent.intent !== 'general_sql';
        let memoryInsertText = '';
        if (shouldUseInlineMemory) {
            const initialAiContext = buildQueryEditorAiContext();
            memoryInsertText = resolveQueryEditorInlineMemoryInsertText({
                editorSnapshot,
                memoryEntries: inlineSqlMemoryEntries,
                sourceType: initialAiContext.sourceType,
                sqlDialect: initialAiContext.sqlDialect,
            });
            // Empty fragments do not need metadata-based case correction and retain
            // the previous immediate memory-completion behavior.
            if (memoryInsertText.trim() && !intent.fragment) {
                const memoryEdit = resolveQueryEditorInlineCompletionEdit({
                    aiContext: initialAiContext,
                    editorSnapshot,
                    insertText: memoryInsertText,
                });
                renderAiInlineGhost(model, position, memoryEdit.previewText, editorSnapshot, memoryEdit);
                return;
            }
        }
        const requestId = ++aiInlineGhostRequestSeqRef.current;
        const runRequest = () => {
            if (aiInlineGhostTimerRef.current !== null) {
                aiInlineGhostTimerRef.current = null;
            }
        void (async () => {
                if (
                    requestId !== aiInlineGhostRequestSeqRef.current
                    || editorRef.current !== editor
                ) {
                    return;
                }
                try {
                    if (shouldUseInlineMemory) {
                        if (!memoryInsertText.trim()) {
                            const initialAiContext = buildQueryEditorAiContext();
                            memoryInsertText = resolveQueryEditorInlineMemoryInsertText({
                                editorSnapshot,
                                memoryEntries: inlineSqlMemoryEntries,
                                sourceType: initialAiContext.sourceType,
                                sqlDialect: initialAiContext.sqlDialect,
                            });
                        }
                        if (memoryInsertText.trim()) {
                            if (
                                (intent.intent === 'table_name' || intent.intent === 'column_name')
                                && intent.fragment
                            ) {
                                await ensureQueryEditorAiContextMetadata(editorSnapshot);
                                if (
                                    requestId !== aiInlineGhostRequestSeqRef.current
                                    || editorRef.current !== editor
                                ) {
                                    return;
                                }
                            }
                            const aiContext = buildQueryEditorAiContext();
                            const memoryEdit = resolveQueryEditorInlineCompletionEdit({
                                aiContext,
                                editorSnapshot,
                                insertText: memoryInsertText,
                            });
                            renderAiInlineGhost(model, position, memoryEdit.previewText, editorSnapshot, memoryEdit);
                            return;
                        }
                    }
                    if (!shouldRequestQueryEditorInlineCompletion(editorSnapshot, inlineDialect)) {
                        return;
                    }
                    const aiContext = buildQueryEditorAiContext();
                    const localCompletion = resolveQueryEditorInlineLocalCompletion({
                        aiContext,
                        editorSnapshot,
                        deferEmptySchemaCompletion: true,
                        autoAddTableAlias,
                    });
                    if (localCompletion.handled) {
                        if (localCompletion.insertText.trim()) {
                            const localEdit = resolveQueryEditorInlineCompletionEdit({
                                aiContext,
                                editorSnapshot,
                                insertText: localCompletion.insertText,
                            });
                            renderAiInlineGhost(model, position, localEdit.previewText, editorSnapshot, localEdit);
                        }
                        return;
                    }
                    const aiService = getQueryEditorAiService();
                    const readiness = await resolveQueryEditorInlineRuntimeReadiness(aiService);
                    if (
                        !readiness.ready
                        || requestId !== aiInlineGhostRequestSeqRef.current
                        || editorRef.current !== editor
                    ) {
                        return;
                    }
                    await ensureQueryEditorAiContextMetadata(editorSnapshot);
                    if (
                        requestId !== aiInlineGhostRequestSeqRef.current
                        || editorRef.current !== editor
                    ) {
                        return;
                    }
                    const insertText = await requestQueryEditorInlineCompletion({
                        service: aiService,
                        aiContext: buildQueryEditorAiContext(),
                        editorSnapshot,
                        autoAddTableAlias,
                    });
                    const currentPosition = normalizeEditorPosition(editor.getPosition?.());
                    if (
                        requestId !== aiInlineGhostRequestSeqRef.current
                        || !currentPosition
                        || currentPosition.lineNumber !== position.lineNumber
                        || currentPosition.column !== position.column
                        || !isInlineGhostSnapshotCurrent(model, currentPosition, editorSnapshot)
                        ) {
                        return;
                    }
                    if (!insertText.trim()) {
                        // Keep the manual AI action on the AI path; silently downgrading to plain suggest is misleading.
                        if (!manualTrigger && (intent.intent === 'table_name' || intent.intent === 'column_name')) {
                            const shouldTriggerStructuredSuggest = shouldTriggerQueryEditorInlineObjectSuggestFallback({
                                aiContext: buildQueryEditorAiContext(),
                                editorSnapshot,
                            });
                            if (shouldTriggerStructuredSuggest) {
                                triggerStructuredSqlSuggest('gonavi-ai-inline-auto', true);
                            }
                        }
                        return;
                    }
                    const inlineEdit = resolveQueryEditorInlineCompletionEdit({
                        aiContext: buildQueryEditorAiContext(),
                        editorSnapshot,
                        insertText,
                    });
                    renderAiInlineGhost(model, position, inlineEdit.previewText, editorSnapshot, inlineEdit);
                } catch (error) {
                    console.warn('GoNavi AI inline SQL ghost failed', error);
                }
            })();
        };

        if (delayMs > 0) {
            aiInlineGhostTimerRef.current = setTimeout(runRequest, delayMs);
            return;
        }
        runRequest();
    };

    const scheduleAiInlineGhost = () => {
        requestAiInlineGhost(QUERY_EDITOR_AI_INLINE_DEBOUNCE_MS);
    };

    triggerAiInlineCompletionRef.current = () => {
        requestAiInlineGhost(0, true, true);
    };
    acceptAiInlineCompletionRef.current = () => acceptAiInlineGhost();
    acceptSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
    acceptSqlAiCompletionKeydownDisposableRef.current = editor.onKeyDown((event: any) => {
        if (!queryEditorActiveRef.current) {
            return;
        }
        const binding = acceptSqlAiCompletionBindingRef.current;
        if (!binding?.enabled || !binding?.combo) {
            return;
        }
        const browserEvent = event?.browserEvent || event?.event || event;
        if (!browserEvent) {
            return;
        }
        if (!isShortcutMatch(browserEvent, binding.combo)) {
            return;
        }
        // 接受成功才拦截按键;幽灵不存在或已过期时返回 false,键走默认行为。
        if (acceptAiInlineCompletionRef.current?.() === true) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            browserEvent.preventDefault?.();
            browserEvent.stopPropagation?.();
        }
    });

    if (monaco?.KeyCode?.RightArrow) {
        editor.addCommand?.(
            monaco.KeyCode.RightArrow,
            () => {
                void editor.getAction?.('editor.action.inlineSuggest.commit')?.run?.();
            },
            'inlineSuggestionVisible',
        );
    }

    const repositionAiInlineGhost = () => {
        const ghost = aiInlineGhostRef.current;
        const model = editor.getModel?.();
        if (!ghost || !model) {
            return;
        }
        const modelUri = String(model?.uri?.toString?.() || '');
        if (ghost.modelUri !== modelUri) {
            clearAiInlineGhost();
            return;
        }
        renderAiInlineGhost(model, ghost.position, ghost.insertText, ghost.snapshot, {
            previewText: ghost.insertText,
            editText: ghost.editText,
            replacePrefixLength: ghost.replacePrefixLength,
        });
    };
    return { requestAiInlineGhost, scheduleAiInlineGhost, repositionAiInlineGhost };
};
