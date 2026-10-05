import { useEffect, useMemo, useCallback } from 'react';
import {
    resolveDataGridHorizontalWheelDelta,
    shouldLetNativeHorizontalWheelPass,
    resolveNativeHorizontalWheelScrollLeft,
} from '../../dataGridLayout';
import { useDataGridLayoutEffect } from '../dataGridScrollTiming';
import {
    resolvePaginationTotalForControl,
    resolvePaginationSummaryText,
    resolvePaginationPageText,
} from '../../../utils/dataGridPagination';
import { resolveShortcutDisplay, DEFAULT_SHORTCUT_OPTIONS } from '../../../utils/shortcuts';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridColumnsApi } from './useDataGridColumns';
import type { DataGridHorizontalVirtualScrollApi } from './useDataGridHorizontalVirtualScroll';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridPageFindApi } from './useDataGridPageFind';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridRowEditorsApi } from './useDataGridRowEditors';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridLayoutEffectsInput {
    isTableSurfaceActive: DataGridColumnTitlesApi['isTableSurfaceActive'];
    tableContainerRef: DataGridCellEditorStateApi['tableContainerRef'];
    enableVirtual: DataGridColumnsApi['enableVirtual'];
    horizontalSyncSourceRef: DataGridCellEditorStateApi['horizontalSyncSourceRef'];
    lastTableScrollLeftRef: DataGridCellEditorStateApi['lastTableScrollLeftRef'];
    externalHorizontalScrollRef: DataGridCellEditorStateApi['externalHorizontalScrollRef'];
    lastExternalScrollLeftRef: DataGridCellEditorStateApi['lastExternalScrollLeftRef'];
    virtualListItemHorizontalOffsetComposited: DataGridHorizontalVirtualScrollApi['virtualListItemHorizontalOffsetComposited'];
    isWindowsLike: DataGridCoreStateApi['isWindowsLike'];
    scheduleVirtualHorizontalWheel: DataGridPageFindApi['scheduleVirtualHorizontalWheel'];
    pickHorizontalScrollTargets: DataGridPageFindApi['pickHorizontalScrollTargets'];
    tableHorizontalWheelRafRef: DataGridCellEditorStateApi['tableHorizontalWheelRafRef'];
    pendingTableHorizontalDeltaRef: DataGridCellEditorStateApi['pendingTableHorizontalDeltaRef'];
    pagination: DataGridProps['pagination'];
    recalculateTableMetrics: DataGridTableMetricsApi['recalculateTableMetrics'];
    containerRef: DataGridCellEditorStateApi['containerRef'];
    totalWidth: DataGridHorizontalVirtualScrollApi['totalWidth'];
    mergedDisplayData: DataGridInlineEditorApi['mergedDisplayData'];
    horizontalScrollVisible: DataGridHorizontalVirtualScrollApi['horizontalScrollVisible'];
    scheduleVirtualHorizontalAlignment: DataGridHorizontalVirtualScrollApi['scheduleVirtualHorizontalAlignment'];
    virtualHorizontalAlignmentRafRef: DataGridCellEditorStateApi['virtualHorizontalAlignmentRafRef'];
    tableRenderData: DataGridRowEditorsApi['tableRenderData'];
    tableScrollX: DataGridHorizontalVirtualScrollApi['tableScrollX'];
    virtualEditingCellForRender: DataGridCellEditorStateApi['virtualEditingCellForRender'];
    onScrollSnapshotChange: DataGridProps['onScrollSnapshotChange'];
    scrollSnapshot: DataGridProps['scrollSnapshot'];
    scrollSnapshotRafRef: DataGridCellEditorStateApi['scrollSnapshotRafRef'];
    didRestoreScrollRef: DataGridCellEditorStateApi['didRestoreScrollRef'];
    pickVerticalScrollTarget: DataGridPageFindApi['pickVerticalScrollTarget'];
    lastReportedScrollRef: DataGridCellEditorStateApi['lastReportedScrollRef'];
    data: DataGridProps['data'];
    applyVirtualHorizontalOffset: DataGridHorizontalVirtualScrollApi['applyVirtualHorizontalOffset'];
    readVirtualHorizontalOffset: DataGridHorizontalVirtualScrollApi['readVirtualHorizontalOffset'];
    resolveVirtualHorizontalElements: DataGridHorizontalVirtualScrollApi['resolveVirtualHorizontalElements'];
    syncVirtualHorizontalVisualOffset: DataGridHorizontalVirtualScrollApi['syncVirtualHorizontalVisualOffset'];
    scheduleNativeVirtualHorizontalScroll: DataGridPageFindApi['scheduleNativeVirtualHorizontalScroll'];
    scheduleSyncExternalScrollFromTargets: DataGridPageFindApi['scheduleSyncExternalScrollFromTargets'];
    pickTableToExternalSyncTargets: DataGridPageFindApi['pickTableToExternalSyncTargets'];
    tableScrollTargetsRef: DataGridCellEditorStateApi['tableScrollTargetsRef'];
    syncExternalScrollFromTargets: DataGridPageFindApi['syncExternalScrollFromTargets'];
    tableTargetSyncRafRef: DataGridCellEditorStateApi['tableTargetSyncRafRef'];
    pendingTableTargetSyncSourceRef: DataGridCellEditorStateApi['pendingTableTargetSyncSourceRef'];
    supportsApproximateTotalPages: DataGridCoreStateApi['supportsApproximateTotalPages'];
    prefersManualTotalCount: DataGridCoreStateApi['prefersManualTotalCount'];
    supportsApproximateTableCount: DataGridCoreStateApi['supportsApproximateTableCount'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    onPageChange: DataGridProps['onPageChange'];
    queryMaxRows: DataGridProps['queryMaxRows'];
    shortcutOptions: DataGridCoreStateApi['shortcutOptions'];
    activeShortcutPlatform: DataGridCoreStateApi['activeShortcutPlatform'];
}

export const useDataGridLayoutEffects = ({
    isTableSurfaceActive, tableContainerRef, enableVirtual, horizontalSyncSourceRef,
    lastTableScrollLeftRef, externalHorizontalScrollRef, lastExternalScrollLeftRef,
    virtualListItemHorizontalOffsetComposited, isWindowsLike, scheduleVirtualHorizontalWheel,
    pickHorizontalScrollTargets, tableHorizontalWheelRafRef, pendingTableHorizontalDeltaRef,
    pagination, recalculateTableMetrics, containerRef, totalWidth, mergedDisplayData,
    horizontalScrollVisible, scheduleVirtualHorizontalAlignment, virtualHorizontalAlignmentRafRef,
    tableRenderData, tableScrollX, virtualEditingCellForRender, onScrollSnapshotChange,
    scrollSnapshot, scrollSnapshotRafRef, didRestoreScrollRef, pickVerticalScrollTarget,
    lastReportedScrollRef, data, applyVirtualHorizontalOffset, readVirtualHorizontalOffset,
    resolveVirtualHorizontalElements, syncVirtualHorizontalVisualOffset,
    scheduleNativeVirtualHorizontalScroll, scheduleSyncExternalScrollFromTargets,
    pickTableToExternalSyncTargets, tableScrollTargetsRef, syncExternalScrollFromTargets,
    tableTargetSyncRafRef, pendingTableTargetSyncSourceRef, supportsApproximateTotalPages,
    prefersManualTotalCount, supportsApproximateTableCount, translateDataGrid, onPageChange,
    queryMaxRows, shortcutOptions, activeShortcutPlatform,
}: UseDataGridLayoutEffectsInput) => {
    // 支持在数据区直接使用触摸板/Shift+滚轮进行横向滚动。
    // 虚拟表格与普通表格统一走外部横向滚动条，避免内部轨道覆盖最后一行。
    useEffect(() => {
        if (!isTableSurfaceActive) return;
        const container = tableContainerRef.current;
        if (!(container instanceof HTMLElement)) return;

        const isTableDataAreaTarget = (target: EventTarget | null) => {
            const element = target instanceof HTMLElement ? target : null;
            if (!element) return false;
            // 排除外部滚动条与工具栏，其余容器内元素一律视为数据区域
            if (element.closest('.data-grid-external-horizontal-scroll')) return false;
            if (element.closest('.data-grid-toolbar')) return false;
            return true;
        };

        const handleContainerHorizontalWheel = (event: WheelEvent) => {
            // applyVirtualHorizontalOffset 分发的合成 WheelEvent（isTrusted=false）
            // 需要传播到 rc-virtual-list 的内部 handler，此处不拦截。
            if (!event.isTrusted) return;

            const horizontalDelta = resolveDataGridHorizontalWheelDelta({
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                shiftKey: event.shiftKey,
            });
            if (!Number.isFinite(horizontalDelta) || Math.abs(horizontalDelta) < 0.5) return;
            if (!isTableDataAreaTarget(event.target)) return;

            if (enableVirtual) {
                // 空数据回退：virtual-holder 不存在时，手动滚动表头
                const virtualHolder = container.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
                if (!virtualHolder) {
                    event.preventDefault();
                    event.stopPropagation();
                    horizontalSyncSourceRef.current = 'table';
                    const headerEl = container.querySelector('.ant-table-header') as HTMLElement | null;
                    const contentEl = container.querySelector('.ant-table-content') as HTMLElement | null;
                    const fallbackTargets = [headerEl, contentEl].filter((el): el is HTMLElement => el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1);
                    if (fallbackTargets.length > 0) {
                        fallbackTargets.forEach((target) => {
                            const max = Math.max(0, target.scrollWidth - target.clientWidth);
                            target.scrollLeft = Math.max(0, Math.min(max, target.scrollLeft + horizontalDelta));
                        });
                        lastTableScrollLeftRef.current = (fallbackTargets[0]).scrollLeft;
                        const externalScroll = externalHorizontalScrollRef.current;
                        if (externalScroll && Math.abs(externalScroll.scrollLeft - lastTableScrollLeftRef.current) > 1) {
                            externalScroll.scrollLeft = lastTableScrollLeftRef.current;
                            lastExternalScrollLeftRef.current = lastTableScrollLeftRef.current;
                        }
                    }
                    horizontalSyncSourceRef.current = '';
                    return;
                }

                const nativeHorizontalEnabled = virtualListItemHorizontalOffsetComposited
                    && virtualHolder.contains(event.target as Node);
                const nativeHorizontalScroll = shouldLetNativeHorizontalWheelPass({
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                    shiftKey: event.shiftKey,
                    nativeHorizontalEnabled,
                });
                if (nativeHorizontalScroll) {
                    const maxScrollLeft = Math.max(0, virtualHolder.scrollWidth - virtualHolder.clientWidth);
                    const nextScrollLeft = resolveNativeHorizontalWheelScrollLeft({
                        delta: horizontalDelta,
                        currentScrollLeft: virtualHolder.scrollLeft,
                        maxScrollLeft,
                    });
                    if (Math.abs(nextScrollLeft - virtualHolder.scrollLeft) >= 0.5) {
                        // Do not preventDefault: WebKit can move the native scroll layer
                        // immediately, while the passive scroll listener synchronizes
                        // the header, external thumb, and virtual column window later.
                        return;
                    }
                }
                if (isWindowsLike && nativeHorizontalEnabled) {
                    event.preventDefault();
                    event.stopPropagation();
                    const maxScrollLeft = Math.max(0, virtualHolder.scrollWidth - virtualHolder.clientWidth);
                    virtualHolder.scrollLeft = resolveNativeHorizontalWheelScrollLeft({
                        delta: horizontalDelta,
                        currentScrollLeft: virtualHolder.scrollLeft,
                        maxScrollLeft,
                    });
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                horizontalSyncSourceRef.current = 'table';

                // 有数据：合并同一帧内的横向滚轮增量，再驱动 rc-virtual-list。
                scheduleVirtualHorizontalWheel(container, horizontalDelta);
                return;
            }

            // 非虚拟模式：拦截事件并手动同步
            const targets = pickHorizontalScrollTargets(container);
            event.preventDefault();
            event.stopPropagation();

            horizontalSyncSourceRef.current = 'table';
            const activeTarget = targets.find((target) => target.scrollWidth > target.clientWidth + 1) || targets[0];
            if (!(activeTarget instanceof HTMLElement)) {
                horizontalSyncSourceRef.current = '';
                return;
            }
            const maxScrollLeft = Math.max(0, activeTarget.scrollWidth - activeTarget.clientWidth);
            if (maxScrollLeft <= 0) {
                horizontalSyncSourceRef.current = '';
                return;
            }
            const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, activeTarget.scrollLeft + horizontalDelta));
            if (Math.abs(nextScrollLeft - activeTarget.scrollLeft) < 1) {
                horizontalSyncSourceRef.current = '';
                return;
            }
            activeTarget.scrollLeft = nextScrollLeft;
            lastTableScrollLeftRef.current = nextScrollLeft;

            const externalScroll = externalHorizontalScrollRef.current;
            if (externalScroll && Math.abs(externalScroll.scrollLeft - nextScrollLeft) > 1) {
                externalScroll.scrollLeft = nextScrollLeft;
                lastExternalScrollLeftRef.current = nextScrollLeft;
            }
            horizontalSyncSourceRef.current = '';
        };

        container.addEventListener('wheel', handleContainerHorizontalWheel, { passive: false, capture: true });
        return () => {
            container.removeEventListener('wheel', handleContainerHorizontalWheel, { capture: true } as EventListenerOptions);
            if (tableHorizontalWheelRafRef.current !== null) {
                cancelAnimationFrame(tableHorizontalWheelRafRef.current);
                tableHorizontalWheelRafRef.current = null;
            }
            pendingTableHorizontalDeltaRef.current = 0;
        };
    }, [
        enableVirtual,
        isTableSurfaceActive,
        isWindowsLike,
        pickHorizontalScrollTargets,
        scheduleVirtualHorizontalWheel,
        virtualListItemHorizontalOffsetComposited,
    ]);

    useDataGridLayoutEffect(() => {
        if (!isTableSurfaceActive) return;
        const rafId = requestAnimationFrame(() => recalculateTableMetrics(containerRef.current));
        return () => cancelAnimationFrame(rafId);
    }, [isTableSurfaceActive, totalWidth, mergedDisplayData.length, pagination?.total, pagination?.pageSize, recalculateTableMetrics]);

    useEffect(() => {
        if (!isTableSurfaceActive || (!horizontalScrollVisible && !virtualListItemHorizontalOffsetComposited)) return;
        scheduleVirtualHorizontalAlignment();
        return () => {
            if (virtualHorizontalAlignmentRafRef.current !== null) {
                cancelAnimationFrame(virtualHorizontalAlignmentRafRef.current);
                virtualHorizontalAlignmentRafRef.current = null;
            }
        };
    }, [horizontalScrollVisible, isTableSurfaceActive, scheduleVirtualHorizontalAlignment, tableRenderData, tableScrollX, virtualEditingCellForRender, virtualListItemHorizontalOffsetComposited]);

    // 虚拟表列对齐：antd 虚拟表 body 使用 <div>+<td>（非 <table>），
    // 不会自动拉伸列宽到视口。而 header <table> 会被 antd 的 CSS 或 JS
    // 设置为 width:100% 自动拉伸。强制 header table 宽度等于 scroll.x，
    // 使 header 列宽与 body 单元格宽度精确一致。
    useEffect(() => {
        if (!isTableSurfaceActive) return;
        const container = tableContainerRef.current;
        if (!container) return;
        const syncHeaderWidth = () => {
            const headerTable = container.querySelector('.ant-table-header > table') as HTMLElement;
            if (headerTable) {
                if (!headerTable.style.translate) {
                    headerTable.style.removeProperty('margin-left');
                    headerTable.style.removeProperty('transform');
                }
                headerTable.style.setProperty('width', `${tableScrollX}px`, 'important');
                headerTable.style.setProperty('min-width', `${tableScrollX}px`, 'important');
                headerTable.style.setProperty('max-width', 'none', 'important');
            }
        };
        syncHeaderWidth();
        const rafId = requestAnimationFrame(syncHeaderWidth);
        return () => { cancelAnimationFrame(rafId); };
    }, [isTableSurfaceActive, tableScrollX, mergedDisplayData.length]);

    useEffect(() => {
        if (!isTableSurfaceActive || !onScrollSnapshotChange) return;
        const tableContainer = tableContainerRef.current;
        if (!(tableContainer instanceof HTMLElement)) return;

        let rafId: number | null = null;
        let boundVerticalTarget: HTMLElement | null = null;
        let boundHorizontalTargets: HTMLElement[] = [];
        const externalScroll = horizontalScrollVisible ? externalHorizontalScrollRef.current : null;
        const hasStoredScroll = !!scrollSnapshot && (Math.abs(scrollSnapshot.top) > 0.5 || Math.abs(scrollSnapshot.left) > 0.5);

        const emitSnapshotNow = () => {
            scrollSnapshotRafRef.current = null;
            if (!didRestoreScrollRef.current && hasStoredScroll) {
                return;
            }
            const verticalTarget = boundVerticalTarget || pickVerticalScrollTarget(tableContainer);
            const horizontalTargets = boundHorizontalTargets.length > 0 ? boundHorizontalTargets : pickHorizontalScrollTargets(tableContainer);
            const top = verticalTarget ? verticalTarget.scrollTop : 0;
            const left = externalScroll?.scrollLeft ?? horizontalTargets[0]?.scrollLeft ?? 0;
            if (Math.abs(lastReportedScrollRef.current.top - top) < 1 && Math.abs(lastReportedScrollRef.current.left - left) < 1) {
                return;
            }
            lastReportedScrollRef.current = { top, left };
            onScrollSnapshotChange({ top, left });
        };
        const emitSnapshot = () => {
            if (scrollSnapshotRafRef.current !== null) return;
            scrollSnapshotRafRef.current = requestAnimationFrame(emitSnapshotNow);
        };

        const bindTargets = () => {
            if (boundVerticalTarget) {
                boundVerticalTarget.removeEventListener('scroll', emitSnapshot);
            }
            boundHorizontalTargets.forEach(target => target.removeEventListener('scroll', emitSnapshot));
            externalScroll?.removeEventListener('scroll', emitSnapshot);

            boundVerticalTarget = pickVerticalScrollTarget(tableContainer);
            boundHorizontalTargets = externalScroll ? [] : pickHorizontalScrollTargets(tableContainer);

            boundVerticalTarget?.addEventListener('scroll', emitSnapshot, { passive: true });
            externalScroll?.addEventListener('scroll', emitSnapshot, { passive: true });
            boundHorizontalTargets.forEach(target => target.addEventListener('scroll', emitSnapshot, { passive: true }));
            emitSnapshot();
        };

        rafId = requestAnimationFrame(bindTargets);
        return () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
            if (scrollSnapshotRafRef.current !== null) {
                cancelAnimationFrame(scrollSnapshotRafRef.current);
                scrollSnapshotRafRef.current = null;
                emitSnapshotNow();
            }
            if (boundVerticalTarget) {
                boundVerticalTarget.removeEventListener('scroll', emitSnapshot);
            }
            boundHorizontalTargets.forEach(target => target.removeEventListener('scroll', emitSnapshot));
            externalScroll?.removeEventListener('scroll', emitSnapshot);
        };
    }, [horizontalScrollVisible, isTableSurfaceActive, mergedDisplayData.length, onScrollSnapshotChange, pickHorizontalScrollTargets, pickVerticalScrollTarget, scrollSnapshot]);

    useEffect(() => {
        if (!isTableSurfaceActive) return;
        if (!scrollSnapshot) return;
        if (didRestoreScrollRef.current) return;
        const tableContainer = tableContainerRef.current;
        if (!(tableContainer instanceof HTMLElement)) return;
        if (mergedDisplayData.length === 0) return;

        let rafId = requestAnimationFrame(() => {
            const verticalTarget = pickVerticalScrollTarget(tableContainer);
            const nextTop = Math.max(0, scrollSnapshot.top);
            const nextLeft = Math.max(0, scrollSnapshot.left);
            if (verticalTarget && Math.abs(verticalTarget.scrollTop - scrollSnapshot.top) > 1) {
                verticalTarget.scrollTop = nextTop;
            }
            let resolvedLeft = nextLeft;
            if (Math.abs(nextLeft) > 0.5) {
                if (enableVirtual) {
                    const applied = applyVirtualHorizontalOffset(tableContainer, nextLeft);
                    if (applied) {
                        resolvedLeft = readVirtualHorizontalOffset(tableContainer);
                    } else {
                        const fallbackTargets = pickHorizontalScrollTargets(tableContainer);
                        fallbackTargets.forEach(target => {
                            if (Math.abs(target.scrollLeft - nextLeft) > 1) {
                                target.scrollLeft = nextLeft;
                            }
                        });
                        resolvedLeft = fallbackTargets[0]?.scrollLeft ?? nextLeft;
                    }
                } else {
                    const horizontalTargets = pickHorizontalScrollTargets(tableContainer);
                    horizontalTargets.forEach(target => {
                        if (Math.abs(target.scrollLeft - nextLeft) > 1) {
                            target.scrollLeft = nextLeft;
                        }
                    });
                    resolvedLeft = horizontalTargets[0]?.scrollLeft ?? nextLeft;
                }
                const externalScroll = externalHorizontalScrollRef.current;
                if (externalScroll && Math.abs(externalScroll.scrollLeft - resolvedLeft) > 1) {
                    externalScroll.scrollLeft = resolvedLeft;
                }
                lastTableScrollLeftRef.current = resolvedLeft;
                lastExternalScrollLeftRef.current = resolvedLeft;
            }
            lastReportedScrollRef.current = { top: nextTop, left: resolvedLeft };
            didRestoreScrollRef.current = true;
            onScrollSnapshotChange?.({ top: nextTop, left: resolvedLeft });
        });

        return () => cancelAnimationFrame(rafId);
    }, [applyVirtualHorizontalOffset, data, enableVirtual, isTableSurfaceActive, mergedDisplayData.length, onScrollSnapshotChange, pickHorizontalScrollTargets, pickVerticalScrollTarget, readVirtualHorizontalOffset, scrollSnapshot]);

    useEffect(() => {
        if (!isTableSurfaceActive) return;
        const tableContainer = tableContainerRef.current;
        const externalScroll = externalHorizontalScrollRef.current;
        if (!(tableContainer instanceof HTMLElement) || !(externalScroll instanceof HTMLDivElement)) return;

        let rafId: number | null = null;
        let boundTargets: HTMLElement[] = [];

        const handleTargetScroll = (event: Event) => {
            const source = event.target as HTMLElement | null;
            if (
                virtualListItemHorizontalOffsetComposited
                && source?.classList.contains('ant-table-header')
            ) {
                const { holderEl } = resolveVirtualHorizontalElements(tableContainer);
                if (holderEl) syncVirtualHorizontalVisualOffset(tableContainer, holderEl.scrollLeft);
                return;
            }
            if (
                virtualListItemHorizontalOffsetComposited
                && source?.classList.contains('ant-table-tbody-virtual-holder')
            ) {
                if (horizontalSyncSourceRef.current === 'external') return;
                lastTableScrollLeftRef.current = source.scrollLeft;
                scheduleNativeVirtualHorizontalScroll(tableContainer);
                return;
            }
            if (horizontalSyncSourceRef.current) return;
            scheduleSyncExternalScrollFromTargets(source);
        };

        const bindCurrentTableTargets = () => {
            // Unbind previous targets
            boundTargets.forEach(t => t.removeEventListener('scroll', handleTargetScroll, true));
            const nextTargets = pickTableToExternalSyncTargets(tableContainer);
            tableScrollTargetsRef.current = nextTargets;
            const headerEl = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
            const nextBoundTargets = virtualListItemHorizontalOffsetComposited
                && headerEl
                && !nextTargets.includes(headerEl)
                ? [...nextTargets, headerEl]
                : nextTargets;
            boundTargets = nextBoundTargets;
            // Bind scroll listener on new targets
            nextBoundTargets.forEach(t => t.addEventListener('scroll', handleTargetScroll, { passive: true, capture: true }));
            syncExternalScrollFromTargets(nextTargets);
        };

        const scheduleBind = () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
            rafId = requestAnimationFrame(() => {
                bindCurrentTableTargets();
            });
        };

        window.addEventListener('resize', scheduleBind);
        scheduleBind();

        return () => {
            window.removeEventListener('resize', scheduleBind);
            boundTargets.forEach(t => t.removeEventListener('scroll', handleTargetScroll, true));
            tableScrollTargetsRef.current = [];
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
            if (tableTargetSyncRafRef.current !== null) {
                cancelAnimationFrame(tableTargetSyncRafRef.current);
                tableTargetSyncRafRef.current = null;
            }
            pendingTableTargetSyncSourceRef.current = null;
        };
    }, [
        isTableSurfaceActive,
        tableScrollX,
        mergedDisplayData.length,
        pickTableToExternalSyncTargets,
        isWindowsLike,
        resolveVirtualHorizontalElements,
        scheduleNativeVirtualHorizontalScroll,
        scheduleSyncExternalScrollFromTargets,
        syncVirtualHorizontalVisualOffset,
        syncExternalScrollFromTargets,
        virtualListItemHorizontalOffsetComposited,
    ]);

    const paginationControlTotal = useMemo(() => {
        if (!pagination) return 0;
        return resolvePaginationTotalForControl({
            pagination,
            supportsApproximateTotalPages,
        });
    }, [pagination, supportsApproximateTotalPages]);

    const paginationHasKnownTotalPages = useMemo(() => {
        if (!pagination) return false;
        if (pagination.totalKnown !== false) return true;
        if (!supportsApproximateTotalPages || !pagination.totalApprox) return false;
        const approximateTotal = Number(pagination.approximateTotal);
        return Number.isFinite(approximateTotal) && approximateTotal > 0;
    }, [pagination, supportsApproximateTotalPages]);

    const paginationTotalPages = useMemo(() => {
        if (!pagination) return 1;
        if (pagination.pageSize === 0) return 1;
        if (!Number.isFinite(paginationControlTotal) || paginationControlTotal <= 0) {
            return Math.max(1, pagination.current);
        }
        return Math.max(1, Math.ceil(paginationControlTotal / Math.max(1, pagination.pageSize)));
    }, [pagination, paginationControlTotal]);

    const paginationV2SummaryText = useMemo(() => {
        if (!pagination) return '';
        return resolvePaginationSummaryText({
            pagination,
            prefersManualTotalCount,
            supportsApproximateTableCount,
            translate: translateDataGrid,
        });
    }, [
        pagination,
        prefersManualTotalCount,
        supportsApproximateTableCount,
        translateDataGrid,
    ]);

    const paginationPageText = useMemo(() => {
        if (!pagination) return '';
        return resolvePaginationPageText({
            pagination,
            supportsApproximateTotalPages,
            translate: translateDataGrid,
        });
    }, [pagination, supportsApproximateTotalPages, translateDataGrid]);

    const handlePageSizeChange = useCallback((value: string) => {
        if (!pagination || !onPageChange) return;
        if (value === '0' && queryMaxRows !== undefined) {
            onPageChange(1, 0);
            return;
        }
        const nextSize = Number(value);
        if (!Number.isSafeInteger(nextSize) || nextSize <= 0) return;
        const firstRowIndex = Math.max(0, (pagination.current - 1) * pagination.pageSize);
        const nextPage = Math.floor(firstRowIndex / nextSize) + 1;
        onPageChange(nextPage, nextSize);
    }, [pagination, onPageChange, queryMaxRows]);

    const handleV2PageStep = useCallback((direction: 'previous' | 'next') => {
        if (!pagination || !onPageChange) return;
        const nextPage = direction === 'previous'
            ? Math.max(1, pagination.current - 1)
            : Math.min(paginationTotalPages, pagination.current + 1);
        if (nextPage === pagination.current) return;
        onPageChange(nextPage, pagination.pageSize);
    }, [onPageChange, pagination, paginationTotalPages]);

    const aiShortcutLabel = resolveShortcutDisplay(shortcutOptions ?? DEFAULT_SHORTCUT_OPTIONS, 'toggleAIPanel', activeShortcutPlatform);
    return {
        paginationHasKnownTotalPages, paginationTotalPages, paginationV2SummaryText,
        paginationPageText, handlePageSizeChange, handleV2PageStep, aiShortcutLabel,
    };
};

export type DataGridLayoutEffectsApi = ReturnType<typeof useDataGridLayoutEffects>;
