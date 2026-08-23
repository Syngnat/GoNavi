import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Segmented, Tag, Tabs, Tooltip, message, type MenuProps } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, BugOutlined, ClearOutlined, CloseOutlined, CopyOutlined, DiffOutlined, ExportOutlined, EyeInvisibleOutlined, PushpinOutlined, RobotOutlined } from '@ant-design/icons';

import { useStore } from '../store';
import type { EditRowLocator } from '../utils/rowLocator';
import type { GridSortInfoItem } from '../utils/dataGridSort';
import type { QueryResultPaginationState } from '../utils/queryResultPagination';
import { filterColumnNamesByGlobalHiddenColumns, useGlobalHiddenColumns } from '../utils/globalHiddenColumns';
import { buildQueryResultColumnPinScope } from '../utils/queryResultColumnPinScope';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import {
  resolveNativeDetachPreferredBounds,
  shouldDetachAtScreenPoint,
  shouldDetachTabByDrag,
  type DetachedWindowBounds,
} from '../utils/detachedWindow';
import DetachDragPreview, {
  buildDetachDragPreviewState,
  type DetachDragPreviewState,
} from './DetachDragPreview';
import DataGrid from './DataGrid';
import LogPanel from './LogPanel';
import { renderV2ActionMenuPopup } from './common/V2ActionMenuPopup';

export type OpenResultInWindowPreferred = Partial<Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>>;

export const QUERY_EDITOR_SQL_LOG_TAB_KEY = '__gonavi_sql_execution_log__';

export type QueryEditorResultSet = {
    key: string;
    sql: string;
    exportSql?: string;
    sourceStatementIndex?: number;
    statementResultIndex?: number;
    rows: any[];
    columns: string[];
    messages?: string[];
    resultType?: 'grid' | 'message' | 'elasticsearch';
    requestLabel?: string;
    httpStatus?: number;
    rawResponse?: string;
    partialFailure?: boolean;
    outcomeUnknown?: boolean;
    tableName?: string;
    /** 列类型/注释元数据所属库（跨库 SELECT 时可能与 currentDb 不同） */
    metadataDbName?: string;
    /** 列元数据查询用表名（PG 等可能为 schema.table） */
    metadataTableName?: string;
    /** DDL 查询目标，与列元数据目标独立，避免多段限定名被误解析。 */
    ddlDbName?: string;
    ddlTableName?: string;
    /** 查询执行时的连接参数快照，用于保持 PG schema/search_path 上下文。 */
    executionConnectionParams?: string;
    executionConnectionId?: string;
    executionDbName?: string;
    pkColumns: string[];
    editLocator?: EditRowLocator;
    readOnly: boolean;
    showRowNumberColumn?: boolean;
    truncated?: boolean;
    pkLoading?: boolean;
    sortInfo?: GridSortInfoItem[];
    page?: QueryResultPaginationState & { loading?: boolean };
    pinned?: boolean;
};

export const resolveEffectiveActiveResultKey = (
    resultSets: Pick<QueryEditorResultSet, 'key'>[],
    activeResultKey: string,
    showSqlLogTab: boolean,
): string => {
    if (resultSets.some((result) => result.key === activeResultKey)) {
        return activeResultKey;
    }
    if (showSqlLogTab && activeResultKey === QUERY_EDITOR_SQL_LOG_TAB_KEY) {
        return QUERY_EDITOR_SQL_LOG_TAB_KEY;
    }
    return resultSets[0]?.key || (showSqlLogTab ? QUERY_EDITOR_SQL_LOG_TAB_KEY : '');
};

interface QueryEditorResultsPanelProps {
    resultSets: QueryEditorResultSet[];
    activeResultKey: string;
    isActive: boolean;
    loading: boolean;
    executionError: string;
    sqlLogCount: number;
    darkMode: boolean;
    isV2Ui: boolean;
    currentDb: string;
    currentConnectionId: string;
    dataPreviewRequest?: { resultKey: string; requestId: string } | null;
    toggleShortcutLabel: string;
    onActiveResultKeyChange: (key: string) => void;
    onHide: () => void;
    onCloseResult: (key: string) => void;
    onCloseOtherResultTabs: (key: string) => void;
    onCloseResultTabsToLeft: (key: string) => void;
    onCloseResultTabsToRight: (key: string) => void;
    onCloseAllResultTabs: () => void;
    onResultPinnedChange: (key: string, pinned: boolean) => void;
    onOpenResultInWindow?: (key: string, preferred?: OpenResultInWindowPreferred) => void;
    onReloadResult: (key: string, sql: string) => void | Promise<void>;
    onResultPageChange: (key: string, page: number, pageSize: number) => void | Promise<void>;
    onResultSort: (key: string, field: string, order: string) => void;
    onRequestResultTotalCount?: (key: string) => void;
    onCancelResultTotalCount?: (key: string) => void;
    onDiagnoseExecutionError: () => void;
    onCompareResult?: (resultKey: string) => void;
}

const isAffectedRowsResult = (result: QueryEditorResultSet): boolean =>
    result.columns.length === 1 && result.columns[0] === 'affectedRows';

const resolveVisibleQueryResultColumns = (columns: string[], globalHiddenColumns: string[]): string[] => {
    const visibleColumns = filterColumnNamesByGlobalHiddenColumns(columns, globalHiddenColumns);
    return visibleColumns.length > 0 || columns.length === 0 ? visibleColumns : columns;
};

const RESULT_TAB_DETACH_INTERACTIVE_SELECTOR = [
    '.query-result-tab-close',
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="menuitem"]',
    '.ant-dropdown-menu',
].join(', ');

export const shouldActivateResultTabDetachPointer = (event: {
    button: number;
    isPrimary?: boolean;
    target: EventTarget | null;
}): boolean => {
    if (event.button !== 0 || event.isPrimary === false) return false;
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    return typeof target?.closest !== 'function'
        || target.closest(RESULT_TAB_DETACH_INTERACTIVE_SELECTOR) === null;
};

const QueryEditorResultsPanel: React.FC<QueryEditorResultsPanelProps> = ({
    resultSets,
    activeResultKey,
    isActive,
    loading,
    executionError,
    sqlLogCount,
    darkMode,
    isV2Ui,
    currentDb,
    currentConnectionId,
    dataPreviewRequest,
    toggleShortcutLabel,
    onActiveResultKeyChange,
    onHide,
    onCloseResult,
    onCloseOtherResultTabs,
    onCloseResultTabsToLeft,
    onCloseResultTabsToRight,
    onCloseAllResultTabs,
    onResultPinnedChange,
    onOpenResultInWindow,
    onReloadResult,
    onResultPageChange,
    onResultSort,
    onRequestResultTotalCount,
    onCancelResultTotalCount,
    onDiagnoseExecutionError,
    onCompareResult,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;
    const clearSqlLogs = useStore(state => state.clearSqlLogs);
    const globalHiddenColumns = useGlobalHiddenColumns();
    const [draggingResultKey, setDraggingResultKey] = useState<string | null>(null);
    const [detachDragPreview, setDetachDragPreview] = useState<DetachDragPreviewState | null>(null);
    const [elasticsearchViewModes, setElasticsearchViewModes] = useState<Record<string, 'table' | 'raw'>>({});
    const resultTabDragRef = useRef<{
        key: string;
        title: string;
        startX: number;
        startY: number;
        startScreenX: number;
        startScreenY: number;
        pointerId: number;
        captureTarget: HTMLElement;
        active: boolean;
    } | null>(null);
    const resultTabDragCleanupRef = useRef<((resetVisualState?: boolean) => void) | null>(null);

    useEffect(() => () => {
        resultTabDragCleanupRef.current?.(false);
    }, []);

    const resolveResultTabTitle = useCallback((key: string) => {
        const index = resultSets.findIndex((item) => item.key === key);
        const rs = index >= 0 ? resultSets[index] : null;
        if (!rs) return t('query_editor.results_panel.menu.open_in_window');
        if (rs.resultType === 'message') {
            return t('query_editor.results_panel.tab.message', { index: index + 1 });
        }
        return t('query_editor.results_panel.tab.result', { index: index + 1 });
    }, [resultSets, t]);

    const handleResultTabPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, key: string) => {
        if (!onOpenResultInWindow || !shouldActivateResultTabDetachPointer(event)) return;
        const openResultInWindow = onOpenResultInWindow;
        resultTabDragCleanupRef.current?.();
        const title = resolveResultTabTitle(key);
        const dragState = {
            key,
            title,
            startX: event.clientX,
            startY: event.clientY,
            startScreenX: event.screenX,
            startScreenY: event.screenY,
            pointerId: event.pointerId,
            captureTarget: event.currentTarget,
            active: false,
        };
        resultTabDragRef.current = dragState;

        const previousUserSelect = document.body.style.userSelect;
        const previousWebkitUserSelect = (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect || '';
        let selectionSuppressed = false;
        let cleaned = false;

        const clearNativeSelection = () => {
            const selection = window.getSelection?.();
            if (selection && selection.rangeCount > 0) {
                selection.removeAllRanges();
            }
        };

        function preventSelectStart(selectEvent: Event) {
            selectEvent.preventDefault();
            selectEvent.stopPropagation();
        }

        function suppressTextSelection() {
            if (!selectionSuppressed) {
                selectionSuppressed = true;
                document.body.style.userSelect = 'none';
                (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none';
                document.documentElement.classList.add('gn-result-tab-detaching');
                window.addEventListener('selectstart', preventSelectStart, true);
                window.addEventListener('dragstart', preventSelectStart, true);
            }
            clearNativeSelection();
        }

        function clearListeners(resetVisualState = true) {
            if (cleaned) return;
            cleaned = true;
            if (resultTabDragCleanupRef.current === clearListeners) {
                resultTabDragCleanupRef.current = null;
            }
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleCancel);
            window.removeEventListener('blur', handleWindowBlur);
            dragState.captureTarget.removeEventListener('lostpointercapture', handleLostPointerCapture);
            window.removeEventListener('selectstart', preventSelectStart, true);
            window.removeEventListener('dragstart', preventSelectStart, true);
            if (selectionSuppressed) {
                document.body.style.userSelect = previousUserSelect;
                (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = previousWebkitUserSelect;
                document.documentElement.classList.remove('gn-result-tab-detaching');
            }
            try {
                if (dragState.captureTarget.hasPointerCapture?.(dragState.pointerId)) {
                    dragState.captureTarget.releasePointerCapture(dragState.pointerId);
                }
            } catch {
                // Capture may already be gone after blur, cancellation, or unmount.
            }
            if (resultTabDragRef.current === dragState) {
                resultTabDragRef.current = null;
            }
            if (resetVisualState) {
                setDraggingResultKey(null);
                setDetachDragPreview(null);
            }
        }

        function handleMove(moveEvent: PointerEvent) {
            if (moveEvent.pointerId !== dragState.pointerId) return;
            if (moveEvent.buttons === 0) {
                clearListeners();
                return;
            }
            const drag = resultTabDragRef.current;
            if (drag !== dragState) return;
            const dx = moveEvent.clientX - drag.startX;
            const dy = moveEvent.clientY - drag.startY;
            if (!drag.active && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
                drag.active = true;
                setDraggingResultKey(key);
                suppressTextSelection();
            }
            if (drag.active) {
                // 拖出过程中禁止浏览器默认选中 SQL 编辑器文本
                moveEvent.preventDefault();
                suppressTextSelection();
                setDetachDragPreview(buildDetachDragPreviewState({
                    title,
                    clientX: moveEvent.clientX,
                    clientY: moveEvent.clientY,
                    deltaY: dy,
                }));
            }
        }

        function handleUp(upEvent: PointerEvent) {
            if (upEvent.pointerId !== dragState.pointerId) return;
            const drag = resultTabDragRef.current;
            if (drag !== dragState) {
                clearListeners();
                return;
            }
            const dy = upEvent.clientY - drag.startY;
            const releaseScreenX = Number.isFinite(upEvent.screenX)
                ? upEvent.screenX
                : drag.startScreenX + (upEvent.clientX - drag.startX);
            const releaseScreenY = Number.isFinite(upEvent.screenY)
                ? upEvent.screenY
                : drag.startScreenY + (upEvent.clientY - drag.startY);
            const releasedOutsideHost = shouldDetachAtScreenPoint(releaseScreenX, releaseScreenY, {
                x: window.screenX,
                y: window.screenY,
                width: window.outerWidth || window.innerWidth,
                height: window.outerHeight || window.innerHeight,
            });
            const shouldDetach = drag.active && (shouldDetachTabByDrag(dy) || releasedOutsideHost);
            if (drag.active) {
                upEvent.preventDefault();
                clearNativeSelection();
            }
            // 先清预览再打开真实窗口，避免叠两层
            clearListeners();
            if (shouldDetach) {
                openResultInWindow(key, resolveNativeDetachPreferredBounds(releaseScreenX, releaseScreenY));
            }
        }

        function handleCancel(cancelEvent: PointerEvent) {
            if (cancelEvent.pointerId === dragState.pointerId) {
                clearListeners();
            }
        }

        function handleWindowBlur() {
            clearListeners();
        }

        function handleLostPointerCapture(lostEvent: Event) {
            if ((lostEvent as PointerEvent).pointerId === dragState.pointerId) {
                clearListeners();
            }
        }

        resultTabDragCleanupRef.current = clearListeners;
        window.addEventListener('pointermove', handleMove, { passive: false });
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleCancel);
        window.addEventListener('blur', handleWindowBlur);
        dragState.captureTarget.addEventListener('lostpointercapture', handleLostPointerCapture);
        try {
            dragState.captureTarget.setPointerCapture(dragState.pointerId);
        } catch {
            // Some embedded WebViews do not expose pointer capture for tab labels.
        }
    }, [onOpenResultInWindow, resolveResultTabTitle]);

    const shouldShowSqlLogTab = isV2Ui;
    const logTabCountLabel = sqlLogCount > 999 ? '999+' : String(sqlLogCount);
    const hideTooltipTitle = toggleShortcutLabel
        ? t('query_editor.results_panel.tooltip.hide_with_shortcut', { shortcut: toggleShortcutLabel })
        : t('query_editor.results_panel.tooltip.hide');
    const resolvedActiveResultKey = resolveEffectiveActiveResultKey(
        resultSets,
        activeResultKey,
        shouldShowSqlLogTab,
    );

    const handleMessageTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.select();
    };

    const handleCopyMessageText = async (text: string) => {
        const safeText = String(text || '');
        if (!safeText.trim()) return;
        try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
                throw new Error(t('query_editor.results_panel.message.copy_unsupported'));
            }
            await navigator.clipboard.writeText(safeText);
            message.success(t('data_grid.message.copied_to_clipboard'));
        } catch (error: any) {
            message.error(t('query_editor.results_panel.message.copy_failed', {
                detail: error?.message || t('common.unknown'),
            }));
        }
    };

    const renderMessageBlock = ({
        text,
        title,
        fontSize,
        fillHeight = false,
        compact = false,
        maxWidth,
        color,
        marginTop,
    }: {
        text: string;
        title?: string;
        fontSize: string;
        fillHeight?: boolean;
        compact?: boolean;
        maxWidth?: number;
        color: string;
        marginTop?: number;
    }) => (
        <div className={`query-result-message-block${compact ? ' is-compact' : ' is-full'}`} style={{
            display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12, padding: compact ? 12 : 16,
            borderRadius: 8, border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(0,0,0,0.08)',
            background: darkMode ? 'rgba(255,255,255,0.03)' : '#fff', textAlign: 'left', alignItems: 'stretch', marginTop,
            width: maxWidth ? `min(100%, ${maxWidth}px)` : '100%', flex: fillHeight ? 1 : undefined, minHeight: fillHeight ? 0 : undefined,
            boxSizing: 'border-box',
        }}>
            <div className="query-result-message-header" style={{
                display: 'flex', alignItems: 'center', justifyContent: title ? 'space-between' : 'flex-end', gap: 12,
                flex: '0 0 auto', minHeight: compact ? 28 : 32,
            }}>
                {title ? <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span> : <span />}
                <Button size="small" icon={<CopyOutlined />} onClick={() => { void handleCopyMessageText(text); }} disabled={!text.trim()}>
                    {t('query_editor.results_panel.message.action.copy')}
                </Button>
            </div>
            <div className="query-result-message-scroll-body" style={{
                flex: fillHeight ? 1 : '0 1 auto', display: 'flex', alignItems: 'stretch', width: '100%', minHeight: compact ? 72 : 0,
                maxHeight: compact ? 160 : undefined, overflow: 'hidden', minWidth: 0, borderRadius: 6,
                border: darkMode ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.10)',
                background: darkMode ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.018)',
            }}>
                <textarea
                    readOnly
                    wrap="off"
                    spellCheck={false}
                    aria-label={title || t('query_editor.results_panel.message.title')}
                    data-query-result-message-textarea={compact ? 'compact' : 'full'}
                    value={text}
                    onKeyDown={handleMessageTextareaKeyDown}
                    style={{
                        display: 'block', flex: '1 1 auto', width: '100%', minWidth: 0, height: '100%', minHeight: compact ? 72 : 0,
                        padding: compact ? '8px 10px' : '10px 12px', margin: 0, border: 'none', resize: 'none', background: 'transparent',
                        color, fontFamily: 'var(--gn-font-mono)', fontSize, lineHeight: 1.6, whiteSpace: 'pre', outline: 'none', boxSizing: 'border-box', overflow: 'auto',
                    }}
                />
            </div>
        </div>
    );

    const toolbarHideButton = (
        <Tooltip title={hideTooltipTitle}>
            <Button
                aria-label={t('query_editor.results_panel.aria.hide')}
                className={isV2Ui ? 'gn-v2-data-grid-toolbar-action gn-v2-query-result-toolbar-hide' : undefined}
                icon={<EyeInvisibleOutlined />}
                onClick={onHide}
            >
                {!isV2Ui && <span>{t('query_editor.results_panel.action.hide')}</span>}
            </Button>
        </Tooltip>
    );

    function buildResultTabMenuItems(key: string, index: number): MenuProps['items'] {
        const result = resultSets[index];
        const comparableCount = resultSets.filter(
            (rs) => rs.resultType !== 'message' && !isAffectedRowsResult(rs) && Array.isArray(rs.columns) && rs.columns.length > 0,
        ).length;
        const hasClosableOtherResult = resultSets.some((item) => item.key !== key && !item.pinned);
        const hasClosableResultToLeft = resultSets.some((item, itemIndex) => itemIndex < index && !item.pinned);
        const hasClosableResultToRight = resultSets.some((item, itemIndex) => itemIndex > index && !item.pinned);
        const hasClosableResult = resultSets.some((item) => !item.pinned);
        return [
            {
                key: result?.pinned ? 'unpin' : 'pin',
                icon: <PushpinOutlined />,
                label: t(result?.pinned
                    ? 'query_editor.results_panel.menu.unpin'
                    : 'query_editor.results_panel.menu.pin'),
                onClick: () => onResultPinnedChange(key, !result?.pinned),
            },
            ...(onOpenResultInWindow
                ? [{
                    key: 'open-in-window',
                    icon: <ExportOutlined />,
                    label: t('query_editor.results_panel.menu.open_in_window'),
                    onClick: () => onOpenResultInWindow(key),
                }]
                : []),
            ...(onCompareResult
                ? [{
                    key: 'compare-results',
                    icon: <DiffOutlined />,
                    label: t('query_editor.results_panel.menu.compare_results'),
                    disabled: comparableCount < 2,
                    onClick: () => onCompareResult(key),
                }]
                : []),
            { type: 'divider' },
            { key: 'close-other', icon: <CloseOutlined />, label: t('query_editor.results_panel.menu.close_other'), disabled: !hasClosableOtherResult, onClick: () => onCloseOtherResultTabs(key) },
            { key: 'close-left', icon: <ArrowLeftOutlined />, label: t('query_editor.results_panel.menu.close_left'), disabled: !hasClosableResultToLeft, onClick: () => onCloseResultTabsToLeft(key) },
            { key: 'close-right', icon: <ArrowRightOutlined />, label: t('query_editor.results_panel.menu.close_right'), disabled: !hasClosableResultToRight, onClick: () => onCloseResultTabsToRight(key) },
            { key: 'close-all', icon: <CloseOutlined />, label: t('query_editor.results_panel.menu.close_all'), disabled: !hasClosableResult, onClick: onCloseAllResultTabs },
        ];
    }

    const resultTabItems = resultSets.map((rs, idx) => ({
        key: rs.key,
        label: (
            <Dropdown
                menu={{ items: buildResultTabMenuItems(rs.key, idx) }}
                trigger={['contextMenu']}
                rootClassName={isV2Ui ? 'gn-v2-tab-context-menu-popup' : undefined}
                popupRender={(menu) => renderV2ActionMenuPopup(menu, isV2Ui, {
                    title: rs.resultType === 'message'
                        ? t('query_editor.results_panel.tab.message', { index: idx + 1 })
                        : t('query_editor.results_panel.tab.result', { index: idx + 1 }),
                    showHeader: false,
                })}
            >
                <div
                    className={`query-result-tab-label${onOpenResultInWindow ? ' is-detachable' : ''}${draggingResultKey === rs.key ? ' is-dragging-detach' : ''}`}
                    title={onOpenResultInWindow ? t('query_editor.results_panel.menu.open_in_window') : undefined}
                    onContextMenu={(event) => event.preventDefault()}
                    onMouseDown={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onCloseResult(rs.key);
                    }}
                    onPointerDown={(event) => handleResultTabPointerDown(event, rs.key)}
                >
                    <Tooltip title={rs.sql}>
                        <span className="query-result-tab-text">
                            {rs.resultType === 'elasticsearch' && rs.requestLabel
                                ? rs.requestLabel
                                : rs.resultType === 'message'
                                ? t('query_editor.results_panel.tab.message', { index: idx + 1 })
                                : t('query_editor.results_panel.tab.result', { index: idx + 1 })}
                        </span>
                    </Tooltip>
                    {rs.pinned ? (
                        <Tooltip title={t('query_editor.results_panel.menu.unpin')}>
                            <PushpinOutlined className="query-result-tab-pin" />
                        </Tooltip>
                    ) : null}
                    {(() => {
                        if (rs.resultType === 'message') return <span className="query-result-tab-count">i</span>;
                        if (isAffectedRowsResult(rs)) return <span className="query-result-tab-count">✓</span>;
                        if (!Array.isArray(rs.rows)) return null;
                        return <span className="query-result-tab-count">{rs.rows.length}</span>;
                    })()}
                    <Tooltip title={t('query_editor.result.close')}>
                        <span
                            className="query-result-tab-close"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onCloseResult(rs.key);
                            }}
                        >
                            <CloseOutlined style={{ fontSize: 12 }} />
                        </span>
                    </Tooltip>
                </div>
            </Dropdown>
        ),
        children: (() => {
            if (rs.resultType === 'message') {
                return (
                    <div className={isV2Ui ? 'gn-v2-query-success' : undefined} style={{
                        flex: 1, minHeight: 0, display: 'flex', justifyContent: 'flex-start', flexDirection: 'column', gap: 12,
                        padding: 24, color: '#666', userSelect: 'text', alignItems: 'stretch', overflow: 'hidden',
                    }}>
                        {renderMessageBlock({
                            text: (rs.messages || []).join('\n'),
                            title: t('query_editor.results_panel.message.title'),
                            fontSize: 'var(--gn-font-size-mono, 13px)',
                            fillHeight: true,
                            color: darkMode ? '#d4d4d4' : '#333',
                        })}
                    </div>
                );
            }
            if (rs.resultType === 'elasticsearch') {
                const hasTable = Array.isArray(rs.rows) && rs.rows.length > 0 && rs.columns.length > 0;
                const viewMode = hasTable ? (elasticsearchViewModes[rs.key] || 'table') : 'raw';
                const status = Number(rs.httpStatus || 0);
                const statusColor = status >= 200 && status < 300
                    ? (rs.partialFailure ? 'orange' : 'green')
                    : 'red';
                return (
                    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                            borderBottom: darkMode ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
                        }}>
                            <span style={{ fontFamily: 'var(--gn-font-mono)', fontWeight: 600 }}>{rs.requestLabel || rs.sql}</span>
                            {status > 0 ? <Tag color={statusColor}>HTTP {status}</Tag> : null}
                            {rs.partialFailure ? <Tag color="orange">{t('query_editor.elasticsearch.partial')}</Tag> : null}
                            {rs.outcomeUnknown ? <Tag color="red">{t('query_editor.elasticsearch.outcome_unknown')}</Tag> : null}
                            <span style={{ flex: 1 }} />
                            {hasTable ? (
                                <Segmented
                                    size="small"
                                    value={viewMode}
                                    options={[
                                        { label: t('query_editor.elasticsearch.table'), value: 'table' },
                                        { label: t('query_editor.elasticsearch.raw'), value: 'raw' },
                                    ]}
                                    onChange={(value) => setElasticsearchViewModes((current) => ({
                                        ...current,
                                        [rs.key]: value as 'table' | 'raw',
                                    }))}
                                />
                            ) : null}
                            {toolbarHideButton}
                        </div>
                        {viewMode === 'raw' ? (
                            <div style={{ flex: 1, minHeight: 0, padding: 12, overflow: 'hidden' }}>
                                {renderMessageBlock({
                                    text: String(rs.rawResponse || ''),
                                    title: t('query_editor.elasticsearch.raw_response'),
                                    fontSize: 'var(--gn-font-size-mono, 13px)',
                                    fillHeight: true,
                                    color: darkMode ? '#d4d4d4' : '#333',
                                })}
                            </div>
                        ) : (
                            <DataGrid
                                data={rs.rows}
                                columnNames={resolveVisibleQueryResultColumns(rs.columns, globalHiddenColumns)}
                                isActive={isActive && resolvedActiveResultKey === rs.key}
                                loading={loading}
                                columnPinScope={buildQueryResultColumnPinScope({ sql: rs.sql })}
                                exportScope="queryResult"
                                resultSql={rs.sql}
                                dbName={currentDb}
                                connectionId={currentConnectionId}
                                pkColumns={[]}
                                readOnly
                            />
                        )}
                    </div>
                );
            }
            if (isAffectedRowsResult(rs)) {
                const affected = Number(rs.rows[0]?.affectedRows ?? 0);
                const messageText = Array.isArray(rs.messages) ? rs.messages.join('\n') : '';
                return (
                    <div className={isV2Ui ? 'gn-v2-query-success' : undefined} style={{
                        flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8,
                        color: '#666', userSelect: 'text',
                    }}>
                        <span style={{ fontSize: 36, color: '#52c41a' }}>✓</span>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{t('query_editor.result.execution_success')}</span>
                        <span style={{ fontSize: 13, color: '#999' }}>{t('query_editor.result.affected_rows', { count: affected })}</span>
                        {messageText
                            ? renderMessageBlock({ text: messageText, fontSize: 'var(--gn-font-size-mono, 12px)', compact: true, maxWidth: 720, color: darkMode ? '#d4d4d4' : '#666', marginTop: 8 })
                            : null}
                    </div>
                );
            }
            const visibleColumns = resolveVisibleQueryResultColumns(rs.columns, globalHiddenColumns);
            const resultTableName = rs.tableName;
            return (
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {Array.isArray(rs.messages) && rs.messages.length > 0 ? (
                        <div style={{ flex: '0 0 auto', margin: '8px 8px 0' }}>
                            {renderMessageBlock({
                                text: rs.messages.join('\n'),
                                fontSize: 'var(--gn-font-size-mono, 12px)',
                                compact: true,
                                color: darkMode ? '#d4d4d4' : '#666',
                            })}
                        </div>
                    ) : null}
                    <DataGrid
                        data={rs.rows}
                        columnNames={visibleColumns}
                        isActive={isActive && resolvedActiveResultKey === rs.key}
                        loading={loading || rs.page?.loading === true}
                        tableName={resultTableName}
                        columnPinScope={resultTableName ? undefined : buildQueryResultColumnPinScope({
                            sql: rs.exportSql || rs.sql,
                            sourceStatementIndex: rs.sourceStatementIndex,
                            statementResultIndex: rs.statementResultIndex,
                        })}
                        exportScope="queryResult"
                        resultSql={rs.exportSql || rs.sql}
                        resultExportAllSql={rs.page?.exportAllSql}
                        dbName={rs.metadataDbName || rs.executionDbName || currentDb}
                        ddlDbName={rs.ddlDbName}
                        ddlTableName={rs.ddlTableName}
                        connectionId={rs.executionConnectionId || currentConnectionId}
                        connectionParamsOverride={rs.executionConnectionParams}
                        initialViewMode={dataPreviewRequest?.resultKey === rs.key ? 'table' : undefined}
                        initialViewModeRequestId={dataPreviewRequest?.resultKey === rs.key ? dataPreviewRequest.requestId : undefined}
                        initialViewModeScope={dataPreviewRequest?.resultKey === rs.key ? 'local' : undefined}
                        pkColumns={rs.pkColumns}
                        editLocator={rs.editLocator}
                        onReload={() => {
                            if (rs.page) {
                                return onResultPageChange(rs.key, rs.page.current, rs.page.pageSize);
                            }
                            return onReloadResult(rs.key, rs.sql);
                        }}
                        pagination={rs.page ? {
                            current: rs.page.current,
                            pageSize: rs.page.pageSize,
                            total: rs.page.total,
                            totalKnown: rs.page.totalKnown,
                            totalCountLoading: rs.page.totalCountLoading,
                            totalCountCancelled: rs.page.totalCountCancelled,
                        } : undefined}
                        onPageChange={rs.page ? ((page, size) => onResultPageChange(rs.key, page, size)) : undefined}
                        onSort={(field, order) => onResultSort(rs.key, field, order)}
                        sortInfoExternal={rs.sortInfo || []}
                        onRequestTotalCount={rs.page && onRequestResultTotalCount
                            ? (() => onRequestResultTotalCount(rs.key))
                            : undefined}
                        onCancelTotalCount={rs.page && onCancelResultTotalCount
                            ? (() => onCancelResultTotalCount(rs.key))
                            : undefined}
                        readOnly={rs.readOnly}
                        toolbarExtraActions={resolvedActiveResultKey === rs.key ? toolbarHideButton : null}
                    />
                </div>
            );
        })(),
    }));

    const logTabItem = shouldShowSqlLogTab
        ? {
            key: QUERY_EDITOR_SQL_LOG_TAB_KEY,
            label: (
                <Tooltip title={t('log_panel.title')}>
                    <div className="query-result-tab-label">
                        <BugOutlined style={{ fontSize: 12 }} />
                        <span className="query-result-tab-text">{t('log_panel.short_title')}</span>
                        <span className="query-result-tab-count">{logTabCountLabel}</span>
                    </div>
                </Tooltip>
            ),
            children: (
                <LogPanel
                    variant="embedded"
                    executionError={executionError}
                    onDiagnoseExecutionError={executionError ? onDiagnoseExecutionError : undefined}
                />
            ),
        }
        : null;
    const tabItems = logTabItem ? [logTabItem, ...resultTabItems] : resultTabItems;
    const activeResultSet = resultSets.find((rs) => rs.key === resolvedActiveResultKey) || null;
    const activeResultUsesDataGrid = Boolean(activeResultSet && activeResultSet.resultType !== 'message' && !isAffectedRowsResult(activeResultSet));

    const hideButton = (
        <Tooltip title={hideTooltipTitle}>
            <Button className="query-result-panel-hide" type="text" size="small" icon={<EyeInvisibleOutlined />} onClick={onHide}>
                {t('query_editor.results_panel.action.hide')}
            </Button>
        </Tooltip>
    );

    const tabsHideButton = (
        <Tooltip title={hideTooltipTitle}>
            <Button aria-label={t('query_editor.results_panel.aria.hide')} className="query-result-panel-hide query-result-panel-tab-action" type="text" size="small" icon={<EyeInvisibleOutlined />} onClick={onHide} />
        </Tooltip>
    );
    const tabsClearButton = (
        <Tooltip title={t('log_panel.action.clear')}>
            <Button aria-label={t('log_panel.action.clear')} className="query-result-panel-clear query-result-panel-tab-action" type="text" size="small" icon={<ClearOutlined />} onClick={clearSqlLogs} />
        </Tooltip>
    );
    const isSqlLogActive = resolvedActiveResultKey === QUERY_EDITOR_SQL_LOG_TAB_KEY;
    const tabsExtraContent = !activeResultUsesDataGrid
        ? {
            right: (
                <div className="query-result-panel-tab-actions">
                    {isSqlLogActive && tabsClearButton}
                    {tabsHideButton}
                </div>
            ),
        }
        : undefined;

    return (
        <>
            <style>{`
              .query-result-tabs { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
              .query-result-tabs .ant-tabs-nav { flex: 0 0 auto; margin: 0; min-height: 36px; padding-right: 8px; }
              .query-result-tabs .ant-tabs-nav-wrap { flex: 0 1 auto; min-width: 0; }
              .query-result-tabs .ant-tabs-extra-content { display: inline-flex; align-items: center; padding-left: 8px; }
              .query-result-tabs .ant-tabs-nav-list { align-items: center; width: auto; }
              .query-result-tabs .ant-tabs-tab { width: auto !important; min-width: 0 !important; max-width: 148px !important; height: 30px !important; min-height: 30px; margin: 0 !important; padding: 0 7px !important; border-radius: 6px !important; border: 0.5px solid transparent !important; border-right: 0.5px solid transparent !important; align-items: center !important; justify-content: center !important; }
              .query-result-tabs .ant-tabs-tab-btn { width: auto !important; height: 100%; max-width: 100%; display: inline-flex !important; align-items: center !important; justify-content: center !important; font-size: 13px !important; line-height: 1 !important; }
              .query-result-tabs .ant-tabs-tab.ant-tabs-tab-active::after { display: none; }
              .query-result-tabs .ant-tabs-content-holder, .query-result-tabs .ant-tabs-content, .query-result-tabs .ant-tabs-tabpane { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
              .query-result-tabs .ant-tabs-tabpane > div { flex: 1 1 auto; min-height: 0; }
              .query-result-tabs .ant-tabs-tabpane-hidden { display: none !important; }
              .query-result-tabs .ant-tabs-ink-bar { transition: none !important; }
              .query-result-tab-label { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 126px; height: 100%; line-height: 1; user-select: none; -webkit-user-select: none; }
              .query-result-tab-label.is-detachable { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
              .query-result-tab-label.is-dragging-detach { cursor: grabbing; opacity: 0.72; }
              html.gn-result-tab-detaching,
              html.gn-result-tab-detaching body,
              html.gn-result-tab-detaching * {
                user-select: none !important;
                -webkit-user-select: none !important;
                cursor: grabbing !important;
              }
              .query-result-tab-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; }
              .query-result-tab-pin { flex: 0 0 auto; font-size: 12px; }
              .query-result-tab-count { flex: 0 0 auto; height: 17px; padding: 0 5px; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; background: var(--gn-bg-active, rgba(148, 163, 184, 0.16)); color: var(--gn-fg-4, inherit); font-family: var(--gn-font-mono); font-size: 9.5px; font-weight: 750; line-height: 17px; }
              .query-result-tab-close { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 999px; color: #999; cursor: pointer; flex: 0 0 auto; }
              .query-result-tab-close:hover { background: rgba(0, 0, 0, 0.06); color: #666; }
              .query-result-panel-header { flex: 0 0 auto; min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.06); background: rgba(255, 255, 255, 0.9); }
              .query-result-panel-header-title { font-size: 13px; font-weight: 600; color: #666; }
              .query-result-panel-hide { display: inline-flex; align-items: center; gap: 4px; }
              .query-result-panel-tab-actions { display: inline-flex; flex-direction: row; align-items: center; gap: 4px; }
              .query-result-tabs .ant-tabs-extra-content .query-result-panel-tab-action { width: 28px; min-width: 28px; height: 28px !important; min-height: 28px !important; padding: 0 !important; display: inline-flex; align-items: center; justify-content: center; }
            `}</style>
            <div data-gonavi-close-shortcut-scope="result" className={isV2Ui ? 'gn-v2-query-results' : undefined} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column' }}>
                {tabItems.length > 0 ? (
                    <Tabs className="query-result-tabs" activeKey={resolvedActiveResultKey} onChange={onActiveResultKeyChange} animated={false} style={{ flex: 1, minHeight: 0 }} tabBarExtraContent={tabsExtraContent} items={tabItems} />
                ) : executionError ? (
                    <>
                        <div className={isV2Ui ? 'query-result-panel-header gn-v2-query-result-panel-header' : 'query-result-panel-header'}>
                            <span className="query-result-panel-header-title">{t('query_editor.results_panel.panel.title')}</span>
                            {hideButton}
                        </div>
                        <div className={isV2Ui ? 'gn-v2-query-error' : undefined} style={{ flex: 1, minHeight: 0, padding: 24, display: 'flex', flexDirection: 'column', gap: 16, background: darkMode ? '#1e1e1e' : '#fafafa', overflow: 'auto' }}>
                            <div style={{ color: '#ff4d4f', fontWeight: 'bold', fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <CloseOutlined />
                                <span>{t('query_editor.result.execution_failed')}</span>
                            </div>
                            <div className="custom-scrollbar" style={{ padding: 16, background: darkMode ? '#2d1a1a' : '#fff2f0', border: `1px solid ${darkMode ? '#5c2020' : '#ffccc7'}`, borderRadius: 6, color: darkMode ? '#ffa39e' : '#cf1322', fontFamily: 'var(--gn-font-mono)', fontSize: 'var(--gn-font-size-mono, 13px)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '40vh', overflow: 'auto' }}>
                                {executionError}
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <Button type="primary" icon={<RobotOutlined />} style={{ background: '#818cf8', borderColor: '#818cf8', boxShadow: '0 2px 0 rgba(129, 140, 248, 0.2)' }} onClick={onDiagnoseExecutionError}>
                                    {t('query_editor.result.ai_diagnose')}
                                </Button>
                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        <div className={isV2Ui ? 'query-result-panel-header gn-v2-query-result-panel-header' : 'query-result-panel-header'}>
                            <span className="query-result-panel-header-title">{t('query_editor.results_panel.panel.title')}</span>
                            {hideButton}
                        </div>
                        <div className={isV2Ui ? 'gn-v2-query-empty' : undefined} style={{ flex: 1, minHeight: 0 }}>
                            {isV2Ui && (
                                <div>
                                    <strong>{t('query_editor.empty_state.title')}</strong>
                                    <span>{t('query_editor.empty_state.description')}</span>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
            <DetachDragPreview
                preview={detachDragPreview}
                darkMode={darkMode}
                readyHint={t('query_editor.results_panel.menu.open_in_window')}
            />
        </>
    );
};

export default QueryEditorResultsPanel;
