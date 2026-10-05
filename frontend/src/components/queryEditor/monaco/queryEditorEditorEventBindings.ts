import { message } from 'antd';
import { buildQueryEditorMonacoActionLabel } from '../queryEditorRunHelpers';
import { t as translate } from '../../../i18n';
import {
    normalizeEditorPosition, normalizeMetadataDialect, QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
    collectQueryEditorReferencedDatabaseNames, clearQueryEditorLinkDecorations,
} from '../QueryEditorHelpers';
import { bindQueryEditorSelectionPublisher } from '../queryEditorAiSelection';
import {
    resolveQueryEditorInlineCompletionIntentDetails, type QueryEditorAiEditorSnapshot,
} from '../QueryEditorAiAssist';
import { buildQueryEditorMetadataIdentityKey } from '../queryEditorCompletionTables';
import { setQueryEditorMouseCursor } from './queryEditorMouseCursor';
import type { OnMount } from '../../MonacoEditor';
import type { TabData } from '../../../types';
import type { createQueryEditorAiInlineGhostState } from './queryEditorAiInlineGhostState';
import type { QueryEditorMonacoLanguage } from '../queryEditorEditorState';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';
import type { createQueryEditorImeAndDropHandlers } from './queryEditorImeAndDropHandlers';
import type { createQueryEditorAiInlineGhostActions } from './queryEditorAiInlineGhostActions';
import type { createQueryEditorNavigationHover } from './queryEditorNavigationHover';

export interface BindQueryEditorEditorEventsInput {
    monaco: Parameters<OnMount>[1];
    darkMode: boolean;
    objectHoverActionRef: React.MutableRefObject<any>;
    editor: Parameters<OnMount>[0];
    lastHoverTargetPositionRef: React.MutableRefObject<{ lineNumber: number; column: number; } | null>;
    showObjectInfoAtPosition: (position?: { lineNumber: number; column: number; } | null) => boolean;
    lastEditorCursorPositionRef: React.MutableRefObject<any>;
    aiInlineGhostRef: React.MutableRefObject<{ insertText: string; editText: string; replacePrefixLength: number; modelUri: string; position: { lineNumber: number; column: number; }; snapshot: QueryEditorAiEditorSnapshot; } | null>;
    clearAiInlineGhost: ReturnType<typeof createQueryEditorAiInlineGhostState>['clearAiInlineGhost'];
    tab: TabData;
    currentConnectionIdRef: React.MutableRefObject<string>;
    currentDbRef: React.MutableRefObject<string>;
    queryEditorMonacoLanguage: QueryEditorMonacoLanguage;
    triggerSqlAiCompletionFallbackApplyingRef: React.MutableRefObject<boolean>;
    triggerSqlAiCompletionFallbackRef: React.MutableRefObject<{ observedAt: number; } | null>;
    triggerSqlAiCompletionAltGestureAtRef: React.MutableRefObject<number>;
    buildInlineGhostEditorSnapshotFromInsertedTextRemoval: ReturnType<typeof createQueryEditorAiInlineGhostState>['buildInlineGhostEditorSnapshotFromInsertedTextRemoval'];
    connectionsRef: React.MutableRefObject<SavedConnection[]>;
    syncQueryDraft: (nextQuery: string) => void;
    getEditorText: ReturnType<typeof createQueryEditorAiInlineGhostState>['getEditorText'];
    triggerAiInlineCompletionRef: React.MutableRefObject<(() => void) | null>;
    objectDecorationsDirtyRef: React.MutableRefObject<boolean>;
    cancelPendingObjectDecorationRefresh: () => void;
    cancelPendingSqlReferencedMetadataRefresh: () => void;
    imeCompositionFallbackTimerRef: React.MutableRefObject<number | null>;
    clearImeCompositionFallbackTimer: ReturnType<typeof createQueryEditorImeAndDropHandlers>['clearImeCompositionFallbackTimer'];
    refreshObjectDecorations: (maxTextLength?: number) => void;
    sqlReferencedMetadataTimerRef: React.MutableRefObject<number | null>;
    editorRef: React.MutableRefObject<any>;
    visibleDbsRef: React.MutableRefObject<string[]>;
    lastSqlReferencedMetadataKeyRef: React.MutableRefObject<string>;
    metadataRetryPendingRef: React.MutableRefObject<boolean>;
    setQueryEditorMetadataReloadTick: React.Dispatch<React.SetStateAction<number>>;
    scheduleObjectDecorationRefresh: (editor: any, maxTextLength?: number) => void;
    setSqlReferencedMetadataKey: React.Dispatch<React.SetStateAction<string>>;
    aiInlineGhostAcceptingRef: React.MutableRefObject<boolean>;
    didModelContentAcceptCurrentAiInlineGhost: ReturnType<typeof createQueryEditorAiInlineGhostState>['didModelContentAcceptCurrentAiInlineGhost'];
    requestAiInlineGhost: ReturnType<typeof createQueryEditorAiInlineGhostActions>['requestAiInlineGhost'];
    scheduleAiInlineGhost: ReturnType<typeof createQueryEditorAiInlineGhostActions>['scheduleAiInlineGhost'];
    repositionAiInlineGhost: ReturnType<typeof createQueryEditorAiInlineGhostActions>['repositionAiInlineGhost'];
    syncModifierState: ReturnType<typeof createQueryEditorNavigationHover>['syncModifierState'];
    applyNavigationHoverState: ReturnType<typeof createQueryEditorNavigationHover>['applyNavigationHoverState'];
    linkDecorationIdsRef: React.MutableRefObject<string[]>;
    handleWindowBlur: ReturnType<typeof createQueryEditorNavigationHover>['handleWindowBlur'];
    handleSqlFieldDragEnd: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleSqlFieldDragEnd'];
    editorDomNode: ReturnType<typeof createQueryEditorImeAndDropHandlers>['editorDomNode'];
    handleImeBeforeInput: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleImeBeforeInput'];
    handleImeCompositionStart: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleImeCompositionStart'];
    handleImeCompositionEnd: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleImeCompositionEnd'];
    handleEditorDragOver: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleEditorDragOver'];
    handleEditorDragLeave: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleEditorDragLeave'];
    handleEditorDrop: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleEditorDrop'];
}

export const bindQueryEditorEditorEvents = ({
    monaco, darkMode, objectHoverActionRef, editor, lastHoverTargetPositionRef,
    showObjectInfoAtPosition, lastEditorCursorPositionRef, aiInlineGhostRef, clearAiInlineGhost,
    tab, currentConnectionIdRef, currentDbRef, queryEditorMonacoLanguage,
    triggerSqlAiCompletionFallbackApplyingRef, triggerSqlAiCompletionFallbackRef,
    triggerSqlAiCompletionAltGestureAtRef, buildInlineGhostEditorSnapshotFromInsertedTextRemoval,
    connectionsRef, syncQueryDraft, getEditorText, triggerAiInlineCompletionRef,
    objectDecorationsDirtyRef, cancelPendingObjectDecorationRefresh,
    cancelPendingSqlReferencedMetadataRefresh, imeCompositionFallbackTimerRef,
    clearImeCompositionFallbackTimer, refreshObjectDecorations, sqlReferencedMetadataTimerRef,
    editorRef, visibleDbsRef, lastSqlReferencedMetadataKeyRef, metadataRetryPendingRef,
    setQueryEditorMetadataReloadTick, scheduleObjectDecorationRefresh, setSqlReferencedMetadataKey,
    aiInlineGhostAcceptingRef, didModelContentAcceptCurrentAiInlineGhost, requestAiInlineGhost,
    scheduleAiInlineGhost, repositionAiInlineGhost, syncModifierState, applyNavigationHoverState,
    linkDecorationIdsRef, handleWindowBlur, handleSqlFieldDragEnd, editorDomNode,
    handleImeBeforeInput, handleImeCompositionStart, handleImeCompositionEnd, handleEditorDragOver,
    handleEditorDragLeave, handleEditorDrop,
}: BindQueryEditorEditorEventsInput) => {
    // 应用透明主题（主题由 MonacoEditor 包装组件按需注册）
    monaco.editor.setTheme(darkMode ? 'transparent-dark' : 'transparent-light');

    objectHoverActionRef.current?.dispose?.();
    const showObjectInfoKeybinding = monaco.KeyMod?.CtrlCmd && monaco.KeyCode?.KeyQ
        ? [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ]
        : undefined;
    objectHoverActionRef.current = editor.addAction({
        id: 'gonavi.queryEditor.showObjectInfo',
        label: buildQueryEditorMonacoActionLabel('query_editor.action.show_object_info'),
        keybindings: showObjectInfoKeybinding,
        run: () => {
            const preferredPosition = lastHoverTargetPositionRef.current || editor.getPosition?.();
            const shown = showObjectInfoAtPosition(preferredPosition);
            if (!shown) {
                void message.info({
                    key: 'gonavi-query-editor-object-info-miss',
                    content: translate('query_editor.message.object_info_target_not_found'),
                });
            }
        },
    });

    editor.onDidChangeCursorPosition?.((event: any) => {
        const position = normalizeEditorPosition(event?.position);
        if (position) {
            lastEditorCursorPositionRef.current = position;
        }
        const ghost = aiInlineGhostRef.current;
        if (
            ghost
            && (!position
                || ghost.position.lineNumber !== position.lineNumber
                || ghost.position.column !== position.column)
        ) {
            clearAiInlineGhost();
        }
    });

    bindQueryEditorSelectionPublisher(editor, () => ({
        tabId: tab.id,
        tabTitle: tab.title,
        connectionId: currentConnectionIdRef.current || tab.connectionId,
        dbName: currentDbRef.current || tab.dbName,
        language: queryEditorMonacoLanguage,
    }));

    const recoverTriggerSqlAiCompletionFallback = (event: any): boolean => {
        if (triggerSqlAiCompletionFallbackApplyingRef.current) {
            return true;
        }

        const pending = triggerSqlAiCompletionFallbackRef.current;
        const altGestureAge = Date.now() - Number(triggerSqlAiCompletionAltGestureAtRef.current || 0);
        const hasRecentAltGesture = altGestureAge >= 0 && altGestureAge <= 1200;
        const changes = Array.isArray(event?.changes) ? event.changes : [];
        const backslashChange = changes.find((change: any) => String(change?.text ?? '') === '\\');
        if (!backslashChange) {
            if (pending && (Date.now() - pending.observedAt) > 1200) {
                triggerSqlAiCompletionFallbackRef.current = null;
            }
            return false;
        }

        const model = editor.getModel?.();
        if (!model || typeof model.getOffsetAt !== 'function' || typeof model.getValue !== 'function') {
            return false;
        }

        let markerOffset = Number.NaN;
        let startPosition = normalizeEditorPosition(backslashChange?.range
            ? {
                lineNumber: Number(backslashChange.range.startLineNumber || 1),
                column: Number(backslashChange.range.startColumn || 1),
            }
            : null);
        let endPosition = normalizeEditorPosition(backslashChange?.range
            ? {
                lineNumber: Number(backslashChange.range.endLineNumber || 1),
                column: Number(backslashChange.range.endColumn || 1),
            }
            : null);

        const rangeOffset = Number(backslashChange?.rangeOffset);
        if (Number.isFinite(rangeOffset)) {
            markerOffset = rangeOffset;
        } else if (startPosition) {
            markerOffset = Number(model.getOffsetAt(startPosition));
        } else {
            const currentPosition = normalizeEditorPosition(editor.getPosition?.());
            const currentOffset = currentPosition ? Number(model.getOffsetAt(currentPosition)) : Number.NaN;
            if (Number.isFinite(currentOffset) && currentOffset > 0) {
                markerOffset = currentOffset - 1;
            }
        }

        if (!Number.isFinite(markerOffset) || markerOffset < 0) {
            return false;
        }
        const currentModelText = String(model?.getValue?.() ?? '');
        if (currentModelText.slice(markerOffset, markerOffset + 1) !== '\\') {
            return false;
        }
        startPosition = normalizeEditorPosition(model?.getPositionAt?.(markerOffset));
        endPosition = normalizeEditorPosition(model?.getPositionAt?.(markerOffset + 1));
        const fallbackSnapshot = buildInlineGhostEditorSnapshotFromInsertedTextRemoval(
            currentModelText,
            markerOffset,
            1,
        );
        const fallbackDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        const fallbackIntent = fallbackSnapshot
            ? resolveQueryEditorInlineCompletionIntentDetails(fallbackSnapshot, fallbackDialect)
            : null;
        const hasStructuredSqlCompletionContext = fallbackIntent?.intent === 'table_name'
            || fallbackIntent?.intent === 'column_name';
        if (!pending && !hasRecentAltGesture && !hasStructuredSqlCompletionContext) {
            return false;
        }
        if (pending && (Date.now() - pending.observedAt) > 1200) {
            triggerSqlAiCompletionFallbackRef.current = null;
            if (!hasRecentAltGesture && !hasStructuredSqlCompletionContext) {
                return false;
            }
        }

        if (!startPosition || !endPosition) {
            return false;
        }

        triggerSqlAiCompletionFallbackRef.current = null;
        triggerSqlAiCompletionFallbackApplyingRef.current = true;
        try {
            editor.executeEdits?.('gonavi-trigger-sql-ai-completion-fallback', [{
                range: new monaco.Range(
                    startPosition.lineNumber,
                    startPosition.column,
                    endPosition.lineNumber,
                    endPosition.column,
                ),
                text: '',
                forceMoveMarkers: true,
            }]);
            editor.setPosition?.(startPosition);
            syncQueryDraft(getEditorText());
        } finally {
            triggerSqlAiCompletionFallbackApplyingRef.current = false;
        }
        triggerAiInlineCompletionRef.current?.();
        return true;
    };

    editor.onDidChangeModelContent?.((event: any) => {
        objectDecorationsDirtyRef.current = true;
        cancelPendingObjectDecorationRefresh();
        cancelPendingSqlReferencedMetadataRefresh();
        if (recoverTriggerSqlAiCompletionFallback(event)) {
            return;
        }
        if (imeCompositionFallbackTimerRef.current !== null) {
            clearImeCompositionFallbackTimer();
            syncQueryDraft(getEditorText());
        }
        const hasSlashCommandMarker = Array.isArray(event?.changes)
            && event.changes.some((change: any) => /__AI_\w+__/.test(String(change?.text || '')));
        if (hasSlashCommandMarker) {
            refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
        }
        // SQL 文本变更后，按引用库集合防抖触发跨库元数据拉取（db.table / schema.table / db.schema.table）
        sqlReferencedMetadataTimerRef.current = window.setTimeout(() => {
            sqlReferencedMetadataTimerRef.current = null;
            if (editorRef.current !== editor) {
                return;
            }
            const modelText = String(editor.getModel?.()?.getValue?.() || '');
            const referencedConnection = connectionsRef.current.find(
                (item) => item.id === String(currentConnectionIdRef.current || '').trim(),
            );
            const referencedDbs = collectQueryEditorReferencedDatabaseNames(
                modelText,
                currentDbRef.current ?? '',
                visibleDbsRef.current,
                referencedConnection ? normalizeMetadataDialect(referencedConnection) : '',
            );
            const metadataDialect = referencedConnection
                ? normalizeMetadataDialect(referencedConnection)
                : '';
            const nextKey = [
                String(currentConnectionIdRef.current || '').trim(),
                ...referencedDbs.map((dbName) => (
                    buildQueryEditorMetadataIdentityKey(metadataDialect, dbName)
                )).sort(),
            ].join('\u0000');
            const sameReferenceKey = nextKey === lastSqlReferencedMetadataKeyRef.current;
            if (metadataRetryPendingRef.current) {
                metadataRetryPendingRef.current = false;
                lastSqlReferencedMetadataKeyRef.current = nextKey;
                setQueryEditorMetadataReloadTick((tick) => tick + 1);
                return;
            }
            if (sameReferenceKey) {
                if (!hasSlashCommandMarker) {
                    scheduleObjectDecorationRefresh(editor);
                }
                return;
            }
            lastSqlReferencedMetadataKeyRef.current = nextKey;
            setSqlReferencedMetadataKey(nextKey);
        }, 450);
        const acceptedCurrentAiGhost = !aiInlineGhostAcceptingRef.current
            && didModelContentAcceptCurrentAiInlineGhost(event);
        if (acceptedCurrentAiGhost) {
            clearAiInlineGhost(false);
            window.setTimeout(() => {
                if (editorRef.current !== editor) {
                    return;
                }
                requestAiInlineGhost(0);
            }, 0);
            return;
        }
        if (!aiInlineGhostAcceptingRef.current) {
            scheduleAiInlineGhost();
        }
    });

    // 滚动/布局事件可达每帧多次，rAF 合并避免高频 DOM 重排。
    let repositionAiInlineGhostRafId: number | null = null;
    const scheduleRepositionAiInlineGhost = () => {
        if (!aiInlineGhostRef.current || repositionAiInlineGhostRafId !== null) {
            return;
        }
        repositionAiInlineGhostRafId = window.requestAnimationFrame(() => {
            repositionAiInlineGhostRafId = null;
            if (editorRef.current !== editor) {
                return;
            }
            repositionAiInlineGhost();
        });
    };

    editor.onDidScrollChange?.(() => {
        scheduleRepositionAiInlineGhost();
    });
    editor.onDidLayoutChange?.(() => {
        scheduleRepositionAiInlineGhost();
    });

    editor.onMouseMove?.((event: any) => {
        syncModifierState(event?.event || null);
        applyNavigationHoverState(event);
    });
    editor.onMouseLeave?.(() => {
        lastHoverTargetPositionRef.current = null;
        clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
        editor.updateOptions?.({ mouseStyle: 'text' });
        setQueryEditorMouseCursor(editor, '');
    });

    window.addEventListener('keydown', syncModifierState);
    window.addEventListener('keyup', syncModifierState);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('dragend', handleSqlFieldDragEnd);
    window.addEventListener('drop', handleSqlFieldDragEnd);
    editorDomNode?.addEventListener('beforeinput', handleImeBeforeInput, true);
    editorDomNode?.addEventListener('compositionstart', handleImeCompositionStart, true);
    editorDomNode?.addEventListener('compositionend', handleImeCompositionEnd, true);
    editorDomNode?.addEventListener('dragover', handleEditorDragOver, true);
    editorDomNode?.addEventListener('dragleave', handleEditorDragLeave, true);
    editorDomNode?.addEventListener('drop', handleEditorDrop, true);
};
