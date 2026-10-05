import React, { useCallback, useEffect } from 'react';
import { message } from 'antd';
import { commitDataGridFixedCellOffset } from '../../dataGridVirtualScroll';
import {
    EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS,
    VIRTUAL_HORIZONTAL_RANGE_COMMIT_THRESHOLD_PX,
} from '../dataGridScrollTiming';
import {
    shouldCommitVirtualHorizontalRange,
    resolveDataGridColumnQuickFindScrollLeft,
} from '../../dataGridLayout';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridPageFindApi } from './useDataGridPageFind';
import type { DataGridColumnsApi } from './useDataGridColumns';
import type { DataGridHorizontalVirtualScrollApi } from './useDataGridHorizontalVirtualScroll';
import type { DataGridCoreStateApi } from './useDataGridCoreState';

export interface UseDataGridExternalScrollInput {
    externalScrollSettleRafRef: DataGridCellEditorStateApi['externalScrollSettleRafRef'];
    externalScrollSequenceRef: DataGridCellEditorStateApi['externalScrollSequenceRef'];
    isExternalScrollbarInteractionActive: DataGridPageFindApi['isExternalScrollbarInteractionActive'];
    externalSyncRafRef: DataGridCellEditorStateApi['externalSyncRafRef'];
    pendingExternalScrollLeftRef: DataGridCellEditorStateApi['pendingExternalScrollLeftRef'];
    externalIdleCommitSchedulerRef: DataGridCellEditorStateApi['externalIdleCommitSchedulerRef'];
    virtualHorizontalPreviewActiveRef: DataGridCellEditorStateApi['virtualHorizontalPreviewActiveRef'];
    horizontalSyncSourceRef: DataGridCellEditorStateApi['horizontalSyncSourceRef'];
    externalHorizontalScrollRef: DataGridCellEditorStateApi['externalHorizontalScrollRef'];
    tableContainerRef: DataGridCellEditorStateApi['tableContainerRef'];
    lastExternalScrollLeftRef: DataGridCellEditorStateApi['lastExternalScrollLeftRef'];
    enableVirtual: DataGridColumnsApi['enableVirtual'];
    readVirtualHorizontalOffset: DataGridHorizontalVirtualScrollApi['readVirtualHorizontalOffset'];
    lastTableScrollLeftRef: DataGridCellEditorStateApi['lastTableScrollLeftRef'];
    virtualListItemColumnVirtual: DataGridHorizontalVirtualScrollApi['virtualListItemColumnVirtual'];
    lastCommittedVirtualHorizontalOffsetRef: DataGridCellEditorStateApi['lastCommittedVirtualHorizontalOffsetRef'];
    virtualListItemHorizontalOffsetComposited: DataGridHorizontalVirtualScrollApi['virtualListItemHorizontalOffsetComposited'];
    resolveVirtualHorizontalElements: DataGridHorizontalVirtualScrollApi['resolveVirtualHorizontalElements'];
    virtualHorizontalMaxScrollRef: DataGridCellEditorStateApi['virtualHorizontalMaxScrollRef'];
    applyVirtualHorizontalOffset: DataGridHorizontalVirtualScrollApi['applyVirtualHorizontalOffset'];
    syncVirtualHorizontalVisualOffset: DataGridHorizontalVirtualScrollApi['syncVirtualHorizontalVisualOffset'];
    virtualHorizontalPostCommitGuardRef: DataGridCellEditorStateApi['virtualHorizontalPostCommitGuardRef'];
    externalIdleCommitHandlerRef: DataGridCellEditorStateApi['externalIdleCommitHandlerRef'];
    externalScrollInteractionUntilRef: DataGridCellEditorStateApi['externalScrollInteractionUntilRef'];
    tableScrollTargetsRef: DataGridCellEditorStateApi['tableScrollTargetsRef'];
    clearExternalScrollbarInteraction: DataGridPageFindApi['clearExternalScrollbarInteraction'];
    externalScrollbarDraggingRef: DataGridCellEditorStateApi['externalScrollbarDraggingRef'];
    rootRef: DataGridCellEditorStateApi['rootRef'];
    pickTableToExternalSyncTargets: DataGridPageFindApi['pickTableToExternalSyncTargets'];
    syncExternalScrollFromTargets: DataGridPageFindApi['syncExternalScrollFromTargets'];
    pickHorizontalScrollTargets: DataGridPageFindApi['pickHorizontalScrollTargets'];
    scheduleSyncExternalScrollFromTargets: DataGridPageFindApi['scheduleSyncExternalScrollFromTargets'];
    highlightColumnQuickFindTarget: DataGridPageFindApi['highlightColumnQuickFindTarget'];
    columnQuickFindText: DataGridCoreStateApi['columnQuickFindText'];
    setColumnQuickFindText: DataGridCoreStateApi['setColumnQuickFindText'];
    resolveColumnQuickFindTarget: DataGridPageFindApi['resolveColumnQuickFindTarget'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    horizontalScrollVisible: DataGridHorizontalVirtualScrollApi['horizontalScrollVisible'];
}

export const useDataGridExternalScroll = ({
    externalScrollSettleRafRef, externalScrollSequenceRef, isExternalScrollbarInteractionActive,
    externalSyncRafRef, pendingExternalScrollLeftRef, externalIdleCommitSchedulerRef,
    virtualHorizontalPreviewActiveRef, horizontalSyncSourceRef, externalHorizontalScrollRef,
    tableContainerRef, lastExternalScrollLeftRef, enableVirtual, readVirtualHorizontalOffset,
    lastTableScrollLeftRef, virtualListItemColumnVirtual, lastCommittedVirtualHorizontalOffsetRef,
    virtualListItemHorizontalOffsetComposited, resolveVirtualHorizontalElements,
    virtualHorizontalMaxScrollRef, applyVirtualHorizontalOffset, syncVirtualHorizontalVisualOffset,
    virtualHorizontalPostCommitGuardRef, externalIdleCommitHandlerRef,
    externalScrollInteractionUntilRef, tableScrollTargetsRef, clearExternalScrollbarInteraction,
    externalScrollbarDraggingRef, rootRef, pickTableToExternalSyncTargets,
    syncExternalScrollFromTargets, pickHorizontalScrollTargets,
    scheduleSyncExternalScrollFromTargets, highlightColumnQuickFindTarget, columnQuickFindText,
    setColumnQuickFindText, resolveColumnQuickFindTarget, translateDataGrid,
    horizontalScrollVisible,
}: UseDataGridExternalScrollInput) => {
    const scheduleExternalHorizontalScrollSettle = useCallback((syncSequence: number) => {
        if (externalScrollSettleRafRef.current !== null) {
            cancelAnimationFrame(externalScrollSettleRafRef.current);
        }
        externalScrollSettleRafRef.current = requestAnimationFrame(() => {
            externalScrollSettleRafRef.current = null;
            if (externalScrollSequenceRef.current !== syncSequence) {
                if (
                    !isExternalScrollbarInteractionActive()
                    && externalSyncRafRef.current === null
                    && pendingExternalScrollLeftRef.current === null
                    && !externalIdleCommitSchedulerRef.current?.hasPending()
                ) {
                    virtualHorizontalPreviewActiveRef.current = false;
                    horizontalSyncSourceRef.current = '';
                }
                return;
            }

            const latestExternalScroll = externalHorizontalScrollRef.current;
            if (!(latestExternalScroll instanceof HTMLDivElement)) {
                virtualHorizontalPreviewActiveRef.current = false;
                horizontalSyncSourceRef.current = '';
                return;
            }

            const tableContainer = tableContainerRef.current;
            if (isExternalScrollbarInteractionActive()) {
                lastExternalScrollLeftRef.current = latestExternalScroll.scrollLeft;
                return;
            }

            let resolvedScrollLeft = enableVirtual && tableContainer instanceof HTMLElement
                ? readVirtualHorizontalOffset(tableContainer)
                : lastTableScrollLeftRef.current;
            if (enableVirtual && tableContainer instanceof HTMLElement) {
                // 拖动/滚轮期间只做 DOM 视觉位移；空闲后才在这里一次性同步
                // rc-virtual-list 内部 offsetLeft，避免大结果集每帧触发行渲染。
                const alreadyCommitted = virtualListItemColumnVirtual
                    && Math.abs(lastCommittedVirtualHorizontalOffsetRef.current - resolvedScrollLeft) < 0.5;
                if (alreadyCommitted && !virtualListItemHorizontalOffsetComposited) {
                    const { innerEl } = resolveVirtualHorizontalElements(tableContainer);
                    if (innerEl instanceof HTMLElement) {
                        commitDataGridFixedCellOffset(tableContainer, innerEl, resolvedScrollLeft, virtualHorizontalMaxScrollRef.current);
                    }
                }
                const applied = alreadyCommitted
                    || applyVirtualHorizontalOffset(tableContainer, resolvedScrollLeft, { forceInternalScroll: true });
                if (applied) {
                    resolvedScrollLeft = readVirtualHorizontalOffset(tableContainer);
                } else {
                    const synced = syncVirtualHorizontalVisualOffset(tableContainer, resolvedScrollLeft);
                    if (synced) {
                        resolvedScrollLeft = synced.clampedOffset;
                    }
                }
            }
            lastTableScrollLeftRef.current = resolvedScrollLeft;

            if (Math.abs(latestExternalScroll.scrollLeft - resolvedScrollLeft) > 1) {
                latestExternalScroll.scrollLeft = resolvedScrollLeft;
            }
            lastExternalScrollLeftRef.current = latestExternalScroll.scrollLeft;
            if (!virtualHorizontalPostCommitGuardRef.current?.hasPending()) {
                virtualHorizontalPreviewActiveRef.current = false;
            }
            horizontalSyncSourceRef.current = '';
        });
    }, [applyVirtualHorizontalOffset, enableVirtual, isExternalScrollbarInteractionActive, readVirtualHorizontalOffset, resolveVirtualHorizontalElements, syncVirtualHorizontalVisualOffset, virtualListItemColumnVirtual, virtualListItemHorizontalOffsetComposited]);

    externalIdleCommitHandlerRef.current = (syncSequence) => {
        externalScrollInteractionUntilRef.current = 0;
        scheduleExternalHorizontalScrollSettle(syncSequence);
    };

    const refreshExternalScrollbarInteraction = useCallback(() => {
        externalScrollInteractionUntilRef.current = Date.now() + EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS;
        externalIdleCommitSchedulerRef.current?.schedule(externalScrollSequenceRef.current);
    }, []);

    const applyExternalScrollToTableTargets = useCallback(() => {
        const externalScroll = externalHorizontalScrollRef.current;
        if (
            !(externalScroll instanceof HTMLDivElement)
            || horizontalSyncSourceRef.current === 'table'
        ) {
            return;
        }

        const nextExternalScrollLeft = Math.max(0, externalScroll.scrollLeft);
        if (
            Math.abs(lastExternalScrollLeftRef.current - nextExternalScrollLeft) < 1
            && pendingExternalScrollLeftRef.current === null
        ) {
            return;
        }

        pendingExternalScrollLeftRef.current = nextExternalScrollLeft;
        lastExternalScrollLeftRef.current = nextExternalScrollLeft;
        externalScrollSequenceRef.current += 1;
        refreshExternalScrollbarInteraction();
        if (externalSyncRafRef.current !== null) {
            return;
        }

        horizontalSyncSourceRef.current = 'external';
        externalSyncRafRef.current = requestAnimationFrame(() => {
            externalSyncRafRef.current = null;
            const syncSequence = externalScrollSequenceRef.current;
            const latestExternalScroll = externalHorizontalScrollRef.current;
            if (!(latestExternalScroll instanceof HTMLDivElement)) {
                pendingExternalScrollLeftRef.current = null;
                virtualHorizontalPreviewActiveRef.current = false;
                horizontalSyncSourceRef.current = '';
                return;
            }

            const requestedExternalScrollLeft = pendingExternalScrollLeftRef.current ?? latestExternalScroll.scrollLeft;
            pendingExternalScrollLeftRef.current = null;
            const tableContainer = tableContainerRef.current;
            // 用户连续拖动/滚动时，只写平台对应的横移属性和当前固定单元格。
            // 不在每一帧调用 Table.scrollTo，否则 rc-virtual-list 会随数据量放大渲染开销。
            if (enableVirtual && tableContainer instanceof HTMLElement) {
                if (isExternalScrollbarInteractionActive()) {
                    const visual = syncVirtualHorizontalVisualOffset(tableContainer, requestedExternalScrollLeft);
                    if (visual) {
                        lastTableScrollLeftRef.current = visual.clampedOffset;
                        if (
                            virtualListItemColumnVirtual
                            && shouldCommitVirtualHorizontalRange({
                                nextOffset: visual.clampedOffset,
                                lastCommittedOffset: lastCommittedVirtualHorizontalOffsetRef.current,
                                thresholdPx: VIRTUAL_HORIZONTAL_RANGE_COMMIT_THRESHOLD_PX,
                            })
                        ) {
                            applyVirtualHorizontalOffset(tableContainer, visual.clampedOffset, { forceInternalScroll: true });
                        }
                        return;
                    }
                }

                const applied = applyVirtualHorizontalOffset(tableContainer, requestedExternalScrollLeft, { forceInternalScroll: true });
                if (applied) {
                    scheduleExternalHorizontalScrollSettle(syncSequence);
                    return;
                }

                // 空数据回退：virtual-holder 不存在时，直接滚动表头。
                const headerEl = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
                const contentEl = tableContainer.querySelector('.ant-table-content') as HTMLElement | null;
                const fallbackTargets = [headerEl, contentEl].filter((el): el is HTMLElement => el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1);
                fallbackTargets.forEach((target) => {
                    if (Math.abs(target.scrollLeft - requestedExternalScrollLeft) > 1) {
                        target.scrollLeft = requestedExternalScrollLeft;
                    }
                });
                lastTableScrollLeftRef.current = requestedExternalScrollLeft;
                scheduleExternalHorizontalScrollSettle(syncSequence);
                return;
            }

            // 非虚拟表格路径：依赖 liveTargets 进行 scrollLeft 同步。
            const liveTargets = tableScrollTargetsRef.current;
            liveTargets.forEach((target) => {
                if (target.scrollWidth <= target.clientWidth + 1) {
                    return;
                }
                if (Math.abs(target.scrollLeft - requestedExternalScrollLeft) > 1) {
                    target.scrollLeft = requestedExternalScrollLeft;
                }
            });
            lastTableScrollLeftRef.current = requestedExternalScrollLeft;
            scheduleExternalHorizontalScrollSettle(syncSequence);
        });
    }, [applyVirtualHorizontalOffset, enableVirtual, isExternalScrollbarInteractionActive, refreshExternalScrollbarInteraction, scheduleExternalHorizontalScrollSettle, syncVirtualHorizontalVisualOffset, virtualListItemColumnVirtual]);

    const handleExternalHorizontalScrollPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        clearExternalScrollbarInteraction();
        externalScrollSequenceRef.current += 1;
        virtualHorizontalPostCommitGuardRef.current?.cancel();
        externalScrollbarDraggingRef.current = true;
        horizontalSyncSourceRef.current = 'external';
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }, [clearExternalScrollbarInteraction]);

    const finishExternalScrollbarDrag = useCallback(() => {
        if (!externalScrollbarDraggingRef.current) {
            return;
        }
        externalScrollbarDraggingRef.current = false;

        // 保留最后一个 native scroll 建立的空闲窗口，避免 pointerup 早于最后一帧
        // rc-virtual-list 更新时又把正在停止的 thumb 拉回旧位置。
        if (isExternalScrollbarInteractionActive()) {
            return;
        }

        // The timer may already be queued when pointerup runs. Flush consumes it
        // and invalidates the stale callback so the final Table.scrollTo happens once.
        if (externalIdleCommitSchedulerRef.current?.flush()) {
            return;
        }

        // 正在排队的外部同步会自行结算；没有待处理任务时才立即安排最终对齐。
        if (
            externalSyncRafRef.current === null
            && pendingExternalScrollLeftRef.current === null
            && externalScrollSettleRafRef.current === null
        ) {
            scheduleExternalHorizontalScrollSettle(externalScrollSequenceRef.current);
        }
    }, [isExternalScrollbarInteractionActive, scheduleExternalHorizontalScrollSettle]);

    const handleExternalHorizontalScrollPointerRelease = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        finishExternalScrollbarDrag();
    }, [finishExternalScrollbarDrag]);

    const handleExternalHorizontalScrollLostPointerCapture = useCallback(() => {
        finishExternalScrollbarDrag();
    }, [finishExternalScrollbarDrag]);

    const focusColumnQuickFindTarget = useCallback((columnName: string): boolean => {
        const root = rootRef.current;
        const tableContainer = tableContainerRef.current;
        if (!(root instanceof HTMLElement) || !(tableContainer instanceof HTMLElement)) return false;
        const headerTarget = Array.from(root.querySelectorAll('[data-column-name]')).find((node) => {
            const el = node as HTMLElement;
            return el.getAttribute('data-column-name') === columnName;
        }) as HTMLElement | undefined;
        if (!headerTarget) return false;

        const externalScroll = externalHorizontalScrollRef.current;
        const tableToExternalTargets = pickTableToExternalSyncTargets(tableContainer);
        const referenceScrollTarget =
            tableToExternalTargets.find((target) => target.scrollWidth > target.clientWidth + 1)
            || tableToExternalTargets[0]
            || (tableContainer.querySelector('.ant-table-header') as HTMLElement | null);
        if (!(referenceScrollTarget instanceof HTMLElement)) {
            return false;
        }

        const currentScrollLeft = enableVirtual
            ? readVirtualHorizontalOffset(tableContainer)
            : referenceScrollTarget.scrollLeft;
        const targetRect = headerTarget.getBoundingClientRect();
        const viewportRect = referenceScrollTarget.getBoundingClientRect();
        const nextScrollLeft = resolveDataGridColumnQuickFindScrollLeft({
            currentScrollLeft,
            columnLeft: currentScrollLeft + (targetRect.left - viewportRect.left),
            columnWidth: targetRect.width,
            viewportWidth: referenceScrollTarget.clientWidth,
            scrollWidth: referenceScrollTarget.scrollWidth,
        });

        if (enableVirtual) {
            const applied = applyVirtualHorizontalOffset(tableContainer, nextScrollLeft);
            if (applied) {
                lastTableScrollLeftRef.current = readVirtualHorizontalOffset(tableContainer);
                syncExternalScrollFromTargets();
                requestAnimationFrame(() => {
                    syncExternalScrollFromTargets();
                });
            } else {
                tableToExternalTargets.forEach((target) => {
                    if (target.scrollWidth <= target.clientWidth + 1) {
                        return;
                    }
                    if (Math.abs(target.scrollLeft - nextScrollLeft) > 1) {
                        target.scrollLeft = nextScrollLeft;
                    }
                });
                lastTableScrollLeftRef.current = nextScrollLeft;
                syncExternalScrollFromTargets(tableToExternalTargets, tableToExternalTargets[0] ?? referenceScrollTarget);
            }
        } else {
            const targets = pickHorizontalScrollTargets(tableContainer);
            const liveTargets = targets.length > 0 ? targets : tableToExternalTargets;
            liveTargets.forEach((target) => {
                if (target.scrollWidth <= target.clientWidth + 1) {
                    return;
                }
                if (Math.abs(target.scrollLeft - nextScrollLeft) > 1) {
                    target.scrollLeft = nextScrollLeft;
                }
            });
            lastTableScrollLeftRef.current = nextScrollLeft;
            scheduleSyncExternalScrollFromTargets(liveTargets[0] ?? referenceScrollTarget);
        }

        highlightColumnQuickFindTarget(columnName);
        return true;
    }, [
        applyVirtualHorizontalOffset,
        enableVirtual,
        highlightColumnQuickFindTarget,
        pickHorizontalScrollTargets,
        pickTableToExternalSyncTargets,
        readVirtualHorizontalOffset,
        scheduleSyncExternalScrollFromTargets,
        syncExternalScrollFromTargets,
    ]);

    const handleSubmitColumnQuickFind = useCallback((submittedValue?: string) => {
        const effectiveQuery = String(submittedValue ?? columnQuickFindText);
        const targetColumnName = resolveColumnQuickFindTarget(effectiveQuery);
        if (!targetColumnName) {
            if (effectiveQuery.trim()) {
                void message.warning(translateDataGrid('data_grid.message.column_quick_find_not_found', { query: effectiveQuery.trim() }));
            }
            return;
        }
        setColumnQuickFindText(targetColumnName);
        const tryFocus = () => focusColumnQuickFindTarget(targetColumnName);
        if (tryFocus()) return;
        requestAnimationFrame(() => {
            if (tryFocus()) return;
            requestAnimationFrame(() => {
                if (tryFocus()) return;
                void message.warning(translateDataGrid('data_grid.message.column_quick_find_not_rendered', { column: targetColumnName }));
            });
        });
    }, [columnQuickFindText, focusColumnQuickFindTarget, resolveColumnQuickFindTarget, translateDataGrid]);

    // 外部水平滚动条的 wheel 处理（通过原生事件绑定，确保 preventDefault 生效）
    useEffect(() => {
        const externalScroll = externalHorizontalScrollRef.current;
        if (!externalScroll || !horizontalScrollVisible) return;

        const handleExternalWheel = (e: WheelEvent) => {
            // 鼠标在水平滚动条区域时，始终阻止垂直滚动冒泡
            e.preventDefault();
            e.stopPropagation();

            const dominantDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (!Number.isFinite(dominantDelta) || Math.abs(dominantDelta) < 0.5) return;

            const maxScrollLeft = Math.max(0, externalScroll.scrollWidth - externalScroll.clientWidth);
            if (maxScrollLeft <= 0) return;

            externalScroll.scrollLeft = Math.max(0, Math.min(maxScrollLeft, externalScroll.scrollLeft + dominantDelta));
        };

        externalScroll.addEventListener('wheel', handleExternalWheel, { passive: false, capture: true });
        window.addEventListener('blur', finishExternalScrollbarDrag);
        return () => {
            externalScroll.removeEventListener('wheel', handleExternalWheel, { capture: true } as EventListenerOptions);
            window.removeEventListener('blur', finishExternalScrollbarDrag);
            if (externalSyncRafRef.current !== null) {
                cancelAnimationFrame(externalSyncRafRef.current);
                externalSyncRafRef.current = null;
            }
            if (externalScrollSettleRafRef.current !== null) {
                cancelAnimationFrame(externalScrollSettleRafRef.current);
                externalScrollSettleRafRef.current = null;
            }
            virtualHorizontalPostCommitGuardRef.current?.cancel();
            pendingExternalScrollLeftRef.current = null;
            externalScrollbarDraggingRef.current = false;
            clearExternalScrollbarInteraction();
            virtualHorizontalPreviewActiveRef.current = false;
            horizontalSyncSourceRef.current = '';
        };
    }, [clearExternalScrollbarInteraction, finishExternalScrollbarDrag, horizontalScrollVisible]);
    return {
        applyExternalScrollToTableTargets, handleExternalHorizontalScrollPointerDown,
        handleExternalHorizontalScrollPointerRelease,
        handleExternalHorizontalScrollLostPointerCapture, handleSubmitColumnQuickFind,
    };
};

export type DataGridExternalScrollApi = ReturnType<typeof useDataGridExternalScroll>;
