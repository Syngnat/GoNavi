import { useCallback } from 'react';
import { message } from 'antd';
import {
    normalizeEditorPosition,
    normalizeCompletionQualifiedName,
    normalizeMetadataDialect,
    readSidebarSqlDropText,
    QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
} from '../QueryEditorHelpers';
import {
    resolveSqlFieldDropCursorOffset,
    resolveSqlFieldDropAnchorRange,
    buildSqlFieldDropEdit,
} from '../../../utils/sqlFieldDrop';
import {
    decodeSidebarSqlEditorDragPayload,
    hasSidebarSqlEditorDragPayload,
    SIDEBAR_SQL_EDITOR_DRAG_MIME,
} from '../../../utils/sidebarSqlDrag';
import { isConnectionScopedQueryEditorMetadata } from '../queryEditorLazyTablesCache';
import { buildQueryEditorTableTargetKey } from '../queryEditorHoverDdl';
import {
    buildQueryEditorMetadataIdentityKey,
    buildCompletionTableMetadataIdentityKey,
} from '../queryEditorCompletionTables';
import { setSharedVisibleDbs, setSharedTablesData } from '../queryEditorCompletionState';
import { t as translate } from '../../../i18n';
import { copyQueryEditorTextToClipboard } from '../queryEditorInlineMemory';
import { duplicateCurrentLineInEditor } from '../queryEditorDuplicateLine';
import {
    resolveToggleLineCommentBindingPlan,
    registerQueryEditorCommentAction,
    runMonacoToggleLineComment,
} from '../queryEditorCommentActions';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorObjectDecorationsApi } from './useQueryEditorObjectDecorations';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorDropAndLineEditsInput {
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    lastEditorCursorPositionRef: QueryEditorCoreStateApi['lastEditorCursorPositionRef'];
    sqlFieldDropDecorationIdsRef: QueryEditorCoreStateApi['sqlFieldDropDecorationIdsRef'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    missingTableMetadataKeysRef: QueryEditorCoreStateApi['missingTableMetadataKeysRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    refreshObjectDecorations: QueryEditorObjectDecorationsApi['refreshObjectDecorations'];
    applyQueryState: QueryEditorDraftSyncApi['applyQueryState'];
    toggleLineCommentActionRef: QueryEditorCoreStateApi['toggleLineCommentActionRef'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    toggleLineCommentShortcutBinding: QueryEditorShortcutsAndSnippetsApi['toggleLineCommentShortcutBinding'];
    languagePreference: QueryEditorConnectionContextApi['languagePreference'];
}

export const useQueryEditorDropAndLineEdits = ({
    editorRef, monacoRef, lastEditorCursorPositionRef, sqlFieldDropDecorationIdsRef, isActive,
    currentConnectionIdRef, currentDbRef, connectionsRef, missingTableMetadataKeysRef,
    visibleDbsRef, tablesRef, refreshObjectDecorations, applyQueryState, toggleLineCommentActionRef,
    activeShortcutPlatform, toggleLineCommentShortcutBinding, languagePreference,
}: UseQueryEditorDropAndLineEditsInput) => {
    const insertTextIntoEditorAtPosition = useCallback((text: string, position?: { lineNumber: number; column: number } | null) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const targetPosition = normalizeEditorPosition(position || editor?.getPosition?.() || lastEditorCursorPositionRef.current);
        if (!editor || !monaco?.Range || !targetPosition || !text) {
            return false;
        }
        editor.focus?.();
        editor.setPosition?.(targetPosition);
        editor.executeEdits?.('gonavi-sidebar-drop', [{
            range: new monaco.Range(
                targetPosition.lineNumber,
                targetPosition.column,
                targetPosition.lineNumber,
                targetPosition.column,
            ),
            text,
            forceMoveMarkers: true,
        }]);
        editor.pushUndoStop?.();
        return true;
    }, []);

    const resolveSqlFieldDropPosition = useCallback((editor: any, event: DragEvent) => {
        const model = editor?.getModel?.();
        if (!editor || !model) return null;

        const monacoTarget = editor.getTargetAtClientPoint?.(event.clientX, event.clientY);
        // CONTENT_EMPTY 会把文字下方的鼠标位置钳制到行尾，必须保留横坐标重新投影。
        let position = Number(monacoTarget?.type) === 6
            ? normalizeEditorPosition(monacoTarget?.position)
            : null;
        if (!position) {
            const editorDomNode = editor.getDomNode?.() as HTMLElement | null;
            const bounds = editorDomNode?.getBoundingClientRect?.();
            const visibleRanges = editor.getVisibleRanges?.() || [];
            if (bounds && visibleRanges.length > 0) {
                const localX = event.clientX - bounds.left;
                const localY = event.clientY - bounds.top;
                const visibleLines: number[] = [];
                visibleRanges.forEach((range: any) => {
                    const startLine = Math.max(1, Number(range?.startLineNumber || 1));
                    const endLine = Math.max(startLine, Number(range?.endLineNumber || startLine));
                    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
                        if (!visibleLines.includes(lineNumber)) visibleLines.push(lineNumber);
                    }
                });
                const nonEmptyLines = visibleLines.filter((lineNumber) => (
                    String(model.getLineContent?.(lineNumber) || '').trim().length > 0
                ));
                const candidateLines = nonEmptyLines.length > 0 ? nonEmptyLines : visibleLines;
                let nearestLine = Number(candidateLines[0] || 1);
                let nearestLineDistance = Number.POSITIVE_INFINITY;
                candidateLines.forEach((lineNumber) => {
                    const visible = editor.getScrolledVisiblePosition?.({ lineNumber, column: 1 });
                    if (!visible) return;
                    const distance = Math.abs(localY - (visible.top + visible.height / 2));
                    if (distance < nearestLineDistance) {
                        nearestLine = lineNumber;
                        nearestLineDistance = distance;
                    }
                });

                const maxColumn = Math.max(1, Number(model.getLineMaxColumn?.(nearestLine) || 1));
                let low = 1;
                let high = maxColumn;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    const visible = editor.getScrolledVisiblePosition?.({ lineNumber: nearestLine, column: middle });
                    if (!visible || visible.left < localX) low = middle + 1;
                    else high = middle;
                }
                const candidateColumns = [Math.max(1, low - 1), low, Math.min(maxColumn, low + 1)];
                const nearestColumn = candidateColumns.reduce((best, column) => {
                    const bestVisible = editor.getScrolledVisiblePosition?.({ lineNumber: nearestLine, column: best });
                    const candidateVisible = editor.getScrolledVisiblePosition?.({ lineNumber: nearestLine, column });
                    if (!candidateVisible) return best;
                    if (!bestVisible) return column;
                    return Math.abs(candidateVisible.left - localX) < Math.abs(bestVisible.left - localX)
                        ? column
                        : best;
                }, candidateColumns[0]);
                position = normalizeEditorPosition({ lineNumber: nearestLine, column: nearestColumn });
            }
        }
        position = position
            || normalizeEditorPosition(editor.getPosition?.())
            || normalizeEditorPosition(lastEditorCursorPositionRef.current);
        if (!position) return null;

        const rawOffset = Number(model.getOffsetAt?.(position));
        if (!Number.isFinite(rawOffset) || typeof model.getPositionAt !== 'function') return position;
        return normalizeEditorPosition(model.getPositionAt(
            resolveSqlFieldDropCursorOffset(String(model.getValue?.() || ''), rawOffset),
        )) || position;
    }, []);

    const clearSqlFieldDropPreview = useCallback((editor: any) => {
        if (!editor?.deltaDecorations) {
            sqlFieldDropDecorationIdsRef.current = [];
            return;
        }
        sqlFieldDropDecorationIdsRef.current = editor.deltaDecorations(
            sqlFieldDropDecorationIdsRef.current,
            [],
        );
    }, []);

    const updateSqlFieldDropPreview = useCallback((editor: any, position: any) => {
        const model = editor?.getModel?.();
        const monaco = monacoRef.current;
        const offset = Number(model?.getOffsetAt?.(position));
        const anchor = model && Number.isFinite(offset)
            ? resolveSqlFieldDropAnchorRange(String(model.getValue?.() || ''), offset)
            : null;
        if (!anchor || !monaco?.Range || typeof model?.getPositionAt !== 'function') {
            clearSqlFieldDropPreview(editor);
            return;
        }
        const start = model.getPositionAt(anchor.startOffset);
        const end = model.getPositionAt(anchor.endOffset);
        sqlFieldDropDecorationIdsRef.current = editor.deltaDecorations(
            sqlFieldDropDecorationIdsRef.current,
            [{
                range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                options: { inlineClassName: 'gonavi-query-editor-field-drop-anchor' },
            }],
        );
    }, [clearSqlFieldDropPreview]);

    const mergeSidebarDropObjectMetadata = useCallback((payload: ReturnType<typeof decodeSidebarSqlEditorDragPayload>) => {
        if (!payload?.text) {
            return;
        }
        const nodeType = String(payload.nodeType || '').trim().toLowerCase();
        if (nodeType && nodeType !== 'table') {
            return;
        }
        const activeConnectionId = String(currentConnectionIdRef.current || '').trim();
        const payloadConnectionId = String(payload.connectionId || activeConnectionId).trim();
        // A cross-connection drop still inserts its textual identifier, but its
        // source metadata must never be merged into the target editor.
        if (payload.connectionId && activeConnectionId && payloadConnectionId !== activeConnectionId) {
            return;
        }
        const payloadHasDatabase = payload.dbName !== undefined;
        const dbName = String(payloadHasDatabase ? payload.dbName ?? '' : currentDbRef.current ?? '').trim();
        const tableName = normalizeCompletionQualifiedName(payload.text);
        const connection = connectionsRef.current.find(
            (item) => item.id === activeConnectionId,
        );
        const metadataDialect = normalizeMetadataDialect(connection);
        if ((!dbName && !isConnectionScopedQueryEditorMetadata(connection)) || !tableName) {
            return;
        }
        if (missingTableMetadataKeysRef.current.has(
            buildQueryEditorTableTargetKey(
                payloadConnectionId,
                dbName,
                tableName,
                metadataDialect,
            ),
        )) {
            return;
        }
        const visibleKey = buildQueryEditorMetadataIdentityKey(metadataDialect, dbName);
        if (dbName && !visibleDbsRef.current.some((db) => (
            buildQueryEditorMetadataIdentityKey(metadataDialect, db) === visibleKey
        ))) {
            visibleDbsRef.current = [...visibleDbsRef.current, dbName];
        }
        const tableKey = buildCompletionTableMetadataIdentityKey(
            metadataDialect,
            dbName,
            tableName,
        );
        if (!tablesRef.current.some((table) => (
            buildCompletionTableMetadataIdentityKey(
                metadataDialect,
                table.dbName,
                table.tableName,
            ) === tableKey
        ))) {
            tablesRef.current = [...tablesRef.current, { dbName, tableName }];
        }
        if (isActive) {
            setSharedVisibleDbs(visibleDbsRef.current);
            setSharedTablesData(tablesRef.current);
        }
    }, [isActive]);

    const handleSidebarObjectDrop = useCallback((event: DragEvent) => {
        if (!hasSidebarSqlEditorDragPayload(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const payload = decodeSidebarSqlEditorDragPayload(String(event.dataTransfer?.getData(SIDEBAR_SQL_EDITOR_DRAG_MIME) || ''));
        const dragText = readSidebarSqlDropText(event, currentConnectionIdRef.current, currentDbRef.current);
        if (!dragText) {
            return;
        }
        const editor = editorRef.current;
        clearSqlFieldDropPreview(editor);
        const payloadNodeType = String(payload?.nodeType || '').trim().toLowerCase();
        const targetPosition = payloadNodeType === 'column'
            ? resolveSqlFieldDropPosition(editor, event)
            : normalizeEditorPosition(editor?.getTargetAtClientPoint?.(event.clientX, event.clientY)?.position)
                || normalizeEditorPosition(editor?.getPosition?.())
                || normalizeEditorPosition(lastEditorCursorPositionRef.current);
        let inserted = false;
        if (payloadNodeType === 'column' && editor && targetPosition) {
            const model = editor.getModel?.();
            const monaco = monacoRef.current;
            const offset = Number(model?.getOffsetAt?.(targetPosition));
            const edit = model && monaco?.Range && typeof model.getPositionAt === 'function' && Number.isFinite(offset)
                ? buildSqlFieldDropEdit({ sql: String(model?.getValue?.() || ''), offset, fieldName: dragText })
                : null;
            if (edit) {
                const start = model.getPositionAt(edit.startOffset);
                const end = model.getPositionAt(edit.endOffset);
                editor.focus?.();
                editor.setPosition?.(targetPosition);
                editor.executeEdits?.('gonavi-result-field-drop', [{
                    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                    text: edit.text,
                    forceMoveMarkers: true,
                }]);
                editor.pushUndoStop?.();
                inserted = true;
            }
        } else {
            inserted = insertTextIntoEditorAtPosition(dragText, targetPosition);
        }
        if (inserted) {
            mergeSidebarDropObjectMetadata(payload);
            refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
        }
    }, [clearSqlFieldDropPreview, insertTextIntoEditorAtPosition, mergeSidebarDropObjectMetadata, refreshObjectDecorations, resolveSqlFieldDropPosition]);

    const handleSelectCurrentStatement = async () => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        if (!editor || !monaco?.Range || !model) {
            return;
        }

        const normalizedPosition = normalizeEditorPosition(editor.getPosition?.())
            || normalizeEditorPosition(lastEditorCursorPositionRef.current);
        if (!normalizedPosition) {
            return;
        }
        lastEditorCursorPositionRef.current = normalizedPosition;
        const lineNumber = normalizedPosition.lineNumber;
        const lineText = String(model.getLineContent?.(lineNumber) || '');
        if (!lineText.trim()) {
            void message.info(translate('query_editor.message.current_line_no_copyable_content'));
            return;
        }

        const maxColumn = Number(model.getLineMaxColumn?.(lineNumber) || 1);
        const selection = new monaco.Range(lineNumber, 1, lineNumber, maxColumn);
        editor.setPosition?.(normalizedPosition);
        editor.setSelection(selection);
        editor.revealRangeInCenterIfOutsideViewport?.(selection);

        const copied = await copyQueryEditorTextToClipboard(lineText);
        editor.setSelection(selection);
        editor.focus?.();
        if (copied) {
            void message.success(translate('data_grid.message.copied_to_clipboard'));
            return;
        }

        void message.error(translate('connection_modal.message.copy_failed'));
    };

    const handleDuplicateCurrentLine = useCallback(() => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) {
            return;
        }
        duplicateCurrentLineInEditor(editor, monaco, applyQueryState);
    }, [applyQueryState]);

    // 「取消/添加注释」右键菜单 + 可配置快捷键：委托 Monaco 内置
    // editor.action.commentLine（当前行/选区生效、一步撤销），语言或改键变化时重注册。
    // 平台默认 Ctrl（Cmd）+/ 恒被吞键命令占用：enabled 时菜单键位委托切换
    // 注释、disabled 时默认键完全静默，保证「禁用/改绑」对内置键位生效。
    const disposeToggleLineCommentAction = useCallback(() => {
        toggleLineCommentActionRef.current?.dispose?.();
        toggleLineCommentActionRef.current = null;
    }, []);

    const registerToggleLineCommentAction = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) {
            return;
        }
        disposeToggleLineCommentAction();
        const plan = resolveToggleLineCommentBindingPlan({
            platform: activeShortcutPlatform,
            combo: toggleLineCommentShortcutBinding?.combo,
            enabled: toggleLineCommentShortcutBinding?.enabled,
            keyModEnum: monacoRef.current.KeyMod,
            keyCodeEnum: monacoRef.current.KeyCode,
        });
        toggleLineCommentActionRef.current = registerQueryEditorCommentAction({
            editor,
            label: translate('query_editor.action.toggle_line_comment'),
            keybindings: plan.menuKeybindings,
            swallowKeybinding: plan.swallowKeybinding,
            // 菜单入口不受快捷键禁用影响；吞键命令恒为空操作
            run: () => runMonacoToggleLineComment(editorRef.current),
        });
    }, [activeShortcutPlatform, disposeToggleLineCommentAction, toggleLineCommentShortcutBinding, languagePreference]);
    return {
        resolveSqlFieldDropPosition, clearSqlFieldDropPreview, updateSqlFieldDropPreview,
        handleSidebarObjectDrop, handleSelectCurrentStatement, handleDuplicateCurrentLine,
        disposeToggleLineCommentAction, registerToggleLineCommentAction,
    };
};

export type QueryEditorDropAndLineEditsApi = ReturnType<typeof useQueryEditorDropAndLineEdits>;
