import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Segmented, Tag, Tabs, Tooltip, message, type MenuProps } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, BugOutlined, ClearOutlined, CloseOutlined, CopyOutlined, DiffOutlined, ExportOutlined, EyeInvisibleOutlined, PushpinOutlined } from '@ant-design/icons';

import { useStore } from '../store';
import type { EditRowLocator } from '../utils/rowLocator';
import type { FilterCondition } from '../utils/sql';
import type { GridSortInfoItem } from '../utils/dataGridSort';
import type { ColumnMeta } from './dataGridColumnMeta';
import type { QueryResultPaginationState } from '../utils/queryResultPagination';
import { filterColumnNamesByGlobalHiddenColumns, useGlobalHiddenColumns } from '../utils/globalHiddenColumns';
import { buildQueryResultColumnPinScope } from '../utils/queryResultColumnPinScope';
import { t as defaultTranslate } from '../i18n';
import { QUERY_EDITOR_PARAMS_PANEL_KEY, type QueryParamBindingInput } from './queryEditor/params/queryEditorParamsModel';
import { useOptionalI18n } from '../i18n/provider';
import {
  resolveNativeDetachPreferredBounds,
  isReleasedOutsideViewport,
  shouldDetachTabByDrag,
  type DetachedWindowBounds,
} from '../utils/detachedWindow';
import DetachDragPreview, {
  buildDetachDragPreviewState,
  type DetachDragPreviewState,
} from './DetachDragPreview';
import QueryEditorResultTruncatedIndicator from './QueryEditorResultTruncatedIndicator';
import DataGrid from './DataGrid';
import QueryEditorResultTabContent, {
  isAffectedRowsResult,
  resolveVisibleQueryResultColumns,
  type QueryEditorResultTabActions,
} from './QueryEditorResultTabContent';
import LogPanel from './LogPanel';
import { renderV2ActionMenuPopup } from './common/V2ActionMenuPopup';
import { QueryEditorExecutionStatus } from './queryEditor/QueryEditorExecutionStatus';
import { QueryEditorExecutionErrorCard } from './queryEditor/QueryEditorExecutionErrorCard';
import { isQueryEditorStatementSummary } from './queryEditor/run/queryEditorRunStatementSummary';
import {
    resolveVisibleQueryEditorExecutionLifecycle,
    type QueryEditorExecutionLifecycleState,
} from './queryEditor/queryEditorExecutionLifecycle';

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
    /** 批量写语句汇总行（见 queryEditorRunStatementSummary），渲染为「执行摘要」。 */
    summaryKind?: string;
    summaryStatementCount?: number;
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
    /** 参数化执行时的绑定值快照：分页/总计数/刷新等远端重跑路径必须原样携带 */
    executionBindings?: QueryParamBindingInput[];
    // 与 executionBindings 同时拍下：引号中的 {name} 当时是否当作参数。
    executionQuotedPlaceholders?: boolean;
    pkColumns: string[];
    columnMetaMap?: Record<string, ColumnMeta>;
    uniqueKeyGroups?: string[][];
    editLocator?: EditRowLocator;
    readOnly: boolean;
    showRowNumberColumn?: boolean;
    truncated?: boolean;
    pkLoading?: boolean;
    sortInfo?: GridSortInfoItem[];
    page?: QueryResultPaginationState & { loading?: boolean };
    pinned?: boolean;
    filterConditions?: FilterCondition[];
    quickWhereCondition?: string;
    selectedRowKeys?: React.Key[];
    selectedCellKeys?: string[];
    scrollSnapshot?: { top: number; left: number };
    hasPendingChanges?: boolean;
};

export type QueryEditorResultViewState = Pick<
    QueryEditorResultSet,
    'filterConditions' | 'quickWhereCondition' | 'selectedRowKeys' | 'selectedCellKeys' | 'scrollSnapshot' | 'hasPendingChanges'
>;

export const resolveEffectiveActiveResultKey = (
    resultSets: Pick<QueryEditorResultSet, 'key'>[],
    activeResultKey: string,
    showSqlLogTab: boolean,
    showParamsTab = false,
): string => {
    if (resultSets.some((result) => result.key === activeResultKey)) {
        return activeResultKey;
    }
    if (showSqlLogTab && activeResultKey === QUERY_EDITOR_SQL_LOG_TAB_KEY) {
        return QUERY_EDITOR_SQL_LOG_TAB_KEY;
    }
    if (showParamsTab && activeResultKey === QUERY_EDITOR_PARAMS_PANEL_KEY) {
        return QUERY_EDITOR_PARAMS_PANEL_KEY;
    }
    return resultSets[0]?.key || (showSqlLogTab ? QUERY_EDITOR_SQL_LOG_TAB_KEY : '');
};

interface QueryEditorResultsPanelProps {
    workbenchTabId?: string;
    paramsPanel?: React.ReactNode;
    resultSets: QueryEditorResultSet[];
    activeResultKey: string;
    isActive: boolean;
    loading: boolean;
    executionError: string;
    sqlLogCount: number;
    darkMode: boolean;
    currentDb: string;
    currentConnectionId: string;
    maxRows?: number;
    dataPreviewRequest?: { resultKey: string; requestId: string } | null;
    /** ES 结果 table/raw 视图模式。状态由调用方持有，结果面板因隐藏/全屏重挂时不丢失。 */
    elasticsearchViewModes?: Record<string, 'table' | 'raw'>;
    onElasticsearchViewModeChange?: (key: string, mode: 'table' | 'raw') => void;
    toggleShortcutLabel: string;
    diagnoseShortcutLabel?: string;
    onActiveResultKeyChange: (key: string) => void;
    onHide: () => void;
    onCloseResult: (key: string) => void;
    onCloseOtherResultTabs: (key: string) => void;
    onCloseResultTabsToLeft: (key: string) => void;
    onCloseResultTabsToRight: (key: string) => void;
    onCloseAllResultTabs: () => void;
    onResultPinnedChange: (key: string, pinned: boolean) => void;
    onOpenResultInWindow?: (key: string, preferred?: OpenResultInWindowPreferred) => void;
    onReloadResult: (
        key: string,
        sql: string,
        executionContext?: {
            executionConnectionId?: string;
            executionDbName?: string;
            executionConnectionParams?: string;
            statementResultIndex?: number;
        },
    ) => void | Promise<void>;
    onResultPageChange: (key: string, page: number, pageSize: number) => void | Promise<void>;
    onResultSort: (key: string, field: string, order: string) => void;
    onRequestResultTotalCount?: (key: string) => void;
    onCancelResultTotalCount?: (key: string) => void;
    onDiagnoseExecutionError: () => void;
    onLocateExecutionError?: () => void;
    onCompareResult?: (resultKey: string) => void;
    executionLifecycle?: QueryEditorExecutionLifecycleState | null;
}

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
    paramsPanel,
    workbenchTabId,
    resultSets,
    activeResultKey,
    isActive,
    loading,
    executionError,
    sqlLogCount,
    darkMode,
    currentDb,
    currentConnectionId,
    maxRows,
    dataPreviewRequest,
    elasticsearchViewModes,
    onElasticsearchViewModeChange,
    toggleShortcutLabel,
    diagnoseShortcutLabel,
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
    onLocateExecutionError,
    onCompareResult,
    executionLifecycle = null,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;
    const clearSqlLogs = useStore(state => state.clearSqlLogs);
    const globalHiddenColumns = useGlobalHiddenColumns();
    const [draggingResultKey, setDraggingResultKey] = useState<string | null>(null);
    const [detachDragPreview, setDetachDragPreview] = useState<DetachDragPreviewState | null>(null);
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
            return t(isQueryEditorStatementSummary(rs)
                ? 'query_editor.results_panel.summary.title'
                : 'query_editor.results_panel.tab.message', { index: index + 1 });
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
            const releasedOutsideHost = isReleasedOutsideViewport(upEvent.clientX, upEvent.clientY);
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

    const logTabCountLabel = sqlLogCount > 999 ? '999+' : String(sqlLogCount);
    const hideTooltipTitle = toggleShortcutLabel
        ? t('query_editor.results_panel.tooltip.hide_with_shortcut', { shortcut: toggleShortcutLabel })
        : t('query_editor.results_panel.tooltip.hide');
    const resolvedActiveResultKey = resolveEffectiveActiveResultKey(
        resultSets,
        activeResultKey,
        true,
        Boolean(paramsPanel),
    );

    // The per-result content reads actions through a ref so its props stay
    // identity-stable; that is what lets a result switch skip untouched grids.
    const resultTabActionsRef = useRef<QueryEditorResultTabActions>({
        onHide,
        onResultPageChange,
        onResultSort,
        onReloadResult,
        onRequestResultTotalCount,
        onCancelResultTotalCount,
    });
    resultTabActionsRef.current = {
        onHide,
        onResultPageChange,
        onResultSort,
        onReloadResult,
        onRequestResultTotalCount,
        onCancelResultTotalCount,
    };

    const handleElasticsearchViewModeChange = useCallback((key: string, mode: 'table' | 'raw') => {
        onElasticsearchViewModeChange?.(key, mode);
    }, [onElasticsearchViewModeChange]);

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
            className="gn-v2-data-grid-toolbar-action gn-v2-query-result-toolbar-hide"
                icon={<EyeInvisibleOutlined />}
                onClick={onHide}
            />
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
                rootClassName={'gn-v2-tab-context-menu-popup'}
                popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
                    title: rs.resultType === 'message'
                        ? t(isQueryEditorStatementSummary(rs)
                            ? 'query_editor.results_panel.summary.title'
                            : 'query_editor.results_panel.tab.message', { index: idx + 1 })
                        : t('query_editor.results_panel.tab.result', { index: idx + 1 }),
                    showHeader: false,
                })}
            >
                <div
                    className={`query-result-tab-label${onOpenResultInWindow ? ' is-detachable' : ''}${draggingResultKey === rs.key ? ' is-dragging-detach' : ''}`}
                    data-query-result-tab="true"
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
                        <span className="query-result-tab-text" data-query-result-tab-title="true">
                            {rs.resultType === 'elasticsearch' && rs.requestLabel
                                ? rs.requestLabel
                                : rs.resultType === 'message'
                                ? t(isQueryEditorStatementSummary(rs)
                                    ? 'query_editor.results_panel.summary.title'
                                    : 'query_editor.results_panel.tab.message', { index: idx + 1 })
                                : t('query_editor.results_panel.tab.result', { index: idx + 1 })}
                        </span>
                    </Tooltip>
                    {rs.pinned ? (
                        <Tooltip title={t('query_editor.results_panel.menu.unpin')}>
                            <PushpinOutlined className="query-result-tab-pin" />
                        </Tooltip>
                    ) : null}
                    {rs.truncated ? <QueryEditorResultTruncatedIndicator /> : null}
                    {(() => {
                        if (isQueryEditorStatementSummary(rs)) {
                            return <span className="query-result-tab-count" data-query-result-tab-count="true">{rs.summaryStatementCount ?? 0}</span>;
                        }
                        if (rs.resultType === 'message') return <span className="query-result-tab-count" data-query-result-tab-count="true">i</span>;
                        if (isAffectedRowsResult(rs)) return <span className="query-result-tab-count" data-query-result-tab-count="true">✓</span>;
                        if (!Array.isArray(rs.rows)) return null;
                        return <span className="query-result-tab-count" data-query-result-tab-count="true">{rs.rows.length}</span>;
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
        children: (
            <QueryEditorResultTabContent
                rs={rs}
                workbenchTabId={workbenchTabId}
                isResultActive={isActive && resolvedActiveResultKey === rs.key}
                darkMode={darkMode}
                currentDb={currentDb}
                currentConnectionId={currentConnectionId}
                maxRows={maxRows}
                globalHiddenColumns={globalHiddenColumns}
                dataPreviewRequest={dataPreviewRequest}
                elasticsearchViewMode={elasticsearchViewModes?.[rs.key]}
                onElasticsearchViewModeChange={handleElasticsearchViewModeChange}
                actionsRef={resultTabActionsRef}
            />
        ),
    }));

    const logTabItem = {
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
                    diagnoseShortcutLabel={executionError ? diagnoseShortcutLabel : undefined}
                    onLocateExecutionError={executionError ? onLocateExecutionError : undefined}
                />
            ),
        };
    const paramsTabItem = paramsPanel ? {
            key: QUERY_EDITOR_PARAMS_PANEL_KEY,
            label: (
                <Tooltip title={t('query_editor.params.panel_title')}>
                    <div className="query-result-tab-label">
                        <span className="query-result-tab-text">{t('query_editor.params.panel_title')}</span>
                    </div>
                </Tooltip>
            ),
            children: paramsPanel,
        } : null;
    const tabItems = [logTabItem, ...(paramsTabItem ? [paramsTabItem] : []), ...resultTabItems];
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
    const visibleExecutionLifecycle = resolveVisibleQueryEditorExecutionLifecycle(loading, executionLifecycle);

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
            <div data-gonavi-close-shortcut-scope="result" className="gn-v2-query-results" style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {tabItems.length > 0 ? (
                    <Tabs className="query-result-tabs" activeKey={resolvedActiveResultKey} onChange={onActiveResultKeyChange} animated={false} style={{ flex: 1, minHeight: 0 }} tabBarExtraContent={tabsExtraContent} items={tabItems} />
                ) : executionError ? (
                    <>
                        <div className="query-result-panel-header gn-v2-query-result-panel-header">
                            <span className="query-result-panel-header-title">{t('query_editor.results_panel.panel.title')}</span>
                            {hideButton}
                        </div>
                        <div className="gn-v2-query-error" style={{ flex: 1, minHeight: 0, padding: 24, display: 'flex', flexDirection: 'column', background: darkMode ? '#1e1e1e' : '#fafafa', overflow: 'auto' }}>
                            <QueryEditorExecutionErrorCard
                                darkMode={darkMode}
                                error={executionError}
                                onDiagnose={onDiagnoseExecutionError}
                                diagnoseShortcutLabel={diagnoseShortcutLabel}
                                onLocate={onLocateExecutionError}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <div className="query-result-panel-header gn-v2-query-result-panel-header">
                            <span className="query-result-panel-header-title">{t('query_editor.results_panel.panel.title')}</span>
                            {hideButton}
                        </div>
                        {visibleExecutionLifecycle ? (
                            <QueryEditorExecutionStatus lifecycle={visibleExecutionLifecycle} />
                        ) : (
                            <div className="gn-v2-query-empty" style={{ flex: 1, minHeight: 0 }}>
                                <div>
                                    <strong>{t('query_editor.empty_state.title')}</strong>
                                    <span>{t('query_editor.empty_state.description')}</span>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
            <DetachDragPreview
                preview={detachDragPreview}
                darkMode={darkMode}
            />
        </>
    );
};

export default QueryEditorResultsPanel;
