import { useCallback, useEffect, useMemo } from 'react';
import {
    EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS,
    VIRTUAL_HORIZONTAL_RANGE_COMMIT_THRESHOLD_PX,
} from '../dataGridScrollTiming';
import {
    shouldCommitVirtualHorizontalRange,
    resolveDataGridColumnQuickFindScrollLeft,
} from '../../dataGridLayout';
import type {
    CellSelectionAutoScrollViewport,
    CellSelectionAutoScrollController,
} from '../../useDataGridBatchActions';
import {
    type DataGridFindMatch,
    type DataGridFindNavigationDirection,
    resolveDataGridFindNavigationIndex,
    matchesDataGridColumnQuickFind,
    resolveDataGridColumnQuickFindTarget,
} from '../../../utils/dataGridFind';
import { makeCellKey, GONAVI_ROW_KEY } from '../../DataGridCore';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridHorizontalVirtualScrollApi } from './useDataGridHorizontalVirtualScroll';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridColumnsApi } from './useDataGridColumns';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridRowEditorsApi } from './useDataGridRowEditors';

export interface UseDataGridPageFindInput {
    tableHorizontalWheelRafRef: DataGridCellEditorStateApi['tableHorizontalWheelRafRef'];
    pendingTableHorizontalDeltaRef: DataGridCellEditorStateApi['pendingTableHorizontalDeltaRef'];
    horizontalSyncSourceRef: DataGridCellEditorStateApi['horizontalSyncSourceRef'];
    readVirtualHorizontalOffset: DataGridHorizontalVirtualScrollApi['readVirtualHorizontalOffset'];
    syncVirtualHorizontalVisualOffset: DataGridHorizontalVirtualScrollApi['syncVirtualHorizontalVisualOffset'];
    lastTableScrollLeftRef: DataGridCellEditorStateApi['lastTableScrollLeftRef'];
    externalHorizontalScrollRef: DataGridCellEditorStateApi['externalHorizontalScrollRef'];
    lastExternalScrollLeftRef: DataGridCellEditorStateApi['lastExternalScrollLeftRef'];
    externalScrollSequenceRef: DataGridCellEditorStateApi['externalScrollSequenceRef'];
    externalScrollInteractionUntilRef: DataGridCellEditorStateApi['externalScrollInteractionUntilRef'];
    virtualListItemColumnVirtual: DataGridHorizontalVirtualScrollApi['virtualListItemColumnVirtual'];
    lastCommittedVirtualHorizontalOffsetRef: DataGridCellEditorStateApi['lastCommittedVirtualHorizontalOffsetRef'];
    applyVirtualHorizontalOffset: DataGridHorizontalVirtualScrollApi['applyVirtualHorizontalOffset'];
    externalIdleCommitSchedulerRef: DataGridCellEditorStateApi['externalIdleCommitSchedulerRef'];
    nativeHorizontalSyncRafRef: DataGridCellEditorStateApi['nativeHorizontalSyncRafRef'];
    virtualListItemHorizontalOffsetComposited: DataGridHorizontalVirtualScrollApi['virtualListItemHorizontalOffsetComposited'];
    resolveVirtualHorizontalElements: DataGridHorizontalVirtualScrollApi['resolveVirtualHorizontalElements'];
    isWindowsLike: DataGridCoreStateApi['isWindowsLike'];
    enableVirtual: DataGridColumnsApi['enableVirtual'];
    isTableSurfaceActive: DataGridColumnTitlesApi['isTableSurfaceActive'];
    tableContainerRef: DataGridCellEditorStateApi['tableContainerRef'];
    tableScrollX: DataGridHorizontalVirtualScrollApi['tableScrollX'];
    tableRef: DataGridCellEditorStateApi['tableRef'];
    cellSelectionAutoScrollControllerRef: DataGridCellEditorStateApi['cellSelectionAutoScrollControllerRef'];
    markCellSelectionUserSelection: DataGridColumnTitlesApi['markCellSelectionUserSelection'];
    markCellSelectionDeleteEligible: DataGridColumnTitlesApi['markCellSelectionDeleteEligible'];
    cellSelectionAnchorSourceRef: DataGridCellEditorStateApi['cellSelectionAnchorSourceRef'];
    setSelectedCells: DataGridCellEditorStateApi['setSelectedCells'];
    currentSelectionRef: DataGridCellEditorStateApi['currentSelectionRef'];
    selectionStartRef: DataGridCellEditorStateApi['selectionStartRef'];
    mergedDisplayData: DataGridInlineEditorApi['mergedDisplayData'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    dataPanelOpenRef: DataGridInlineEditorApi['dataPanelOpenRef'];
    updateFocusedCell: DataGridInlineEditorApi['updateFocusedCell'];
    containerRef: DataGridCellEditorStateApi['containerRef'];
    updateCellSelection: DataGridColumnTitlesApi['updateCellSelection'];
    activePageFindMatchIndex: DataGridCoreStateApi['activePageFindMatchIndex'];
    setActivePageFindMatchIndex: DataGridCoreStateApi['setActivePageFindMatchIndex'];
    pageFindMatches: DataGridRowEditorsApi['pageFindMatches'];
    normalizedColumnQuickFindText: DataGridCoreStateApi['normalizedColumnQuickFindText'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    setHighlightedColumnName: DataGridCoreStateApi['setHighlightedColumnName'];
    columnQuickFindHighlightTimerRef: DataGridCoreStateApi['columnQuickFindHighlightTimerRef'];
    externalScrollbarDraggingRef: DataGridCellEditorStateApi['externalScrollbarDraggingRef'];
    horizontalScrollVisible: DataGridHorizontalVirtualScrollApi['horizontalScrollVisible'];
    tableScrollTargetsRef: DataGridCellEditorStateApi['tableScrollTargetsRef'];
    pendingTableTargetSyncSourceRef: DataGridCellEditorStateApi['pendingTableTargetSyncSourceRef'];
    tableTargetSyncRafRef: DataGridCellEditorStateApi['tableTargetSyncRafRef'];
}

export const useDataGridPageFind = ({
    tableHorizontalWheelRafRef, pendingTableHorizontalDeltaRef, horizontalSyncSourceRef,
    readVirtualHorizontalOffset, syncVirtualHorizontalVisualOffset, lastTableScrollLeftRef,
    externalHorizontalScrollRef, lastExternalScrollLeftRef, externalScrollSequenceRef,
    externalScrollInteractionUntilRef, virtualListItemColumnVirtual,
    lastCommittedVirtualHorizontalOffsetRef, applyVirtualHorizontalOffset,
    externalIdleCommitSchedulerRef, nativeHorizontalSyncRafRef,
    virtualListItemHorizontalOffsetComposited, resolveVirtualHorizontalElements, isWindowsLike,
    enableVirtual, isTableSurfaceActive, tableContainerRef, tableScrollX, tableRef,
    cellSelectionAutoScrollControllerRef, markCellSelectionUserSelection,
    markCellSelectionDeleteEligible, cellSelectionAnchorSourceRef, setSelectedCells,
    currentSelectionRef, selectionStartRef, mergedDisplayData, rowKeyStr, dataPanelOpenRef,
    updateFocusedCell, containerRef, updateCellSelection, activePageFindMatchIndex,
    setActivePageFindMatchIndex, pageFindMatches, normalizedColumnQuickFindText, displayColumnNames,
    setHighlightedColumnName, columnQuickFindHighlightTimerRef, externalScrollbarDraggingRef,
    horizontalScrollVisible, tableScrollTargetsRef, pendingTableTargetSyncSourceRef,
    tableTargetSyncRafRef,
}: UseDataGridPageFindInput) => {
    const flushVirtualHorizontalWheel = useCallback((tableContainer: HTMLElement) => {
        tableHorizontalWheelRafRef.current = null;
        const delta = pendingTableHorizontalDeltaRef.current;
        pendingTableHorizontalDeltaRef.current = 0;
        if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) {
            horizontalSyncSourceRef.current = '';
            return;
        }

        const currentOffset = readVirtualHorizontalOffset(tableContainer);
        const visual = syncVirtualHorizontalVisualOffset(tableContainer, currentOffset + delta);
        if (!visual) {
            horizontalSyncSourceRef.current = '';
            return;
        }
        const nextScrollLeft = visual.clampedOffset;
        lastTableScrollLeftRef.current = nextScrollLeft;
        const externalScroll = externalHorizontalScrollRef.current;
        if (externalScroll && Math.abs(externalScroll.scrollLeft - nextScrollLeft) > 1) {
            externalScroll.scrollLeft = nextScrollLeft;
            lastExternalScrollLeftRef.current = nextScrollLeft;
        }
        const syncSequence = ++externalScrollSequenceRef.current;
        externalScrollInteractionUntilRef.current = Date.now() + EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS;
        if (
            virtualListItemColumnVirtual
            && shouldCommitVirtualHorizontalRange({
                nextOffset: nextScrollLeft,
                lastCommittedOffset: lastCommittedVirtualHorizontalOffsetRef.current,
                thresholdPx: VIRTUAL_HORIZONTAL_RANGE_COMMIT_THRESHOLD_PX,
            })
        ) {
            applyVirtualHorizontalOffset(tableContainer, nextScrollLeft, { forceInternalScroll: true });
        }
        externalIdleCommitSchedulerRef.current?.schedule(syncSequence);
    }, [applyVirtualHorizontalOffset, readVirtualHorizontalOffset, syncVirtualHorizontalVisualOffset, virtualListItemColumnVirtual]);

    const scheduleVirtualHorizontalWheel = useCallback((tableContainer: HTMLElement, delta: number) => {
        pendingTableHorizontalDeltaRef.current += delta;
        if (tableHorizontalWheelRafRef.current !== null) return;
        tableHorizontalWheelRafRef.current = requestAnimationFrame(() => flushVirtualHorizontalWheel(tableContainer));
    }, [flushVirtualHorizontalWheel]);

    const flushNativeVirtualHorizontalScroll = useCallback((tableContainer: HTMLElement) => {
        nativeHorizontalSyncRafRef.current = null;
        if (!virtualListItemHorizontalOffsetComposited) return;

        const { holderEl } = resolveVirtualHorizontalElements(tableContainer);
        if (!(holderEl instanceof HTMLElement)) return;

        // Native list commits its own column window before this visual pass.
        horizontalSyncSourceRef.current = 'table';
        const visual = syncVirtualHorizontalVisualOffset(tableContainer, holderEl.scrollLeft);
        if (!visual) {
            return;
        }
        lastTableScrollLeftRef.current = visual.clampedOffset;
        if (!isWindowsLike) {
            const externalScroll = externalHorizontalScrollRef.current;
            if (externalScroll && Math.abs(externalScroll.scrollLeft - visual.clampedOffset) > 1) externalScroll.scrollLeft = visual.clampedOffset;
            lastExternalScrollLeftRef.current = externalScroll?.scrollLeft ?? visual.clampedOffset;
        }
        const syncSequence = ++externalScrollSequenceRef.current;
        externalScrollInteractionUntilRef.current = Date.now() + EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS;
        externalIdleCommitSchedulerRef.current?.schedule(syncSequence);
        horizontalSyncSourceRef.current = '';
    }, [
        applyVirtualHorizontalOffset,
        isWindowsLike,
        resolveVirtualHorizontalElements,
        syncVirtualHorizontalVisualOffset,
        virtualListItemColumnVirtual,
        virtualListItemHorizontalOffsetComposited,
    ]);

    const scheduleNativeVirtualHorizontalScroll = useCallback((tableContainer: HTMLElement) => {
        if (nativeHorizontalSyncRafRef.current !== null) return;
        nativeHorizontalSyncRafRef.current = requestAnimationFrame(() => {
            flushNativeVirtualHorizontalScroll(tableContainer);
        });
    }, [flushNativeVirtualHorizontalScroll]);

    const pickHorizontalScrollTargets = useCallback((tableContainer: HTMLElement): HTMLElement[] => {
        const virtualBody = tableContainer.querySelector('.ant-table-tbody-virtual-holder');
        const body = tableContainer.querySelector('.ant-table-body');
        const content = tableContainer.querySelector('.ant-table-content');
        const virtualHolder = tableContainer.querySelector('.rc-virtual-list-holder');
        const candidates = [virtualBody, virtualHolder, body, content].filter((node): node is HTMLElement => node instanceof HTMLElement);
        if (candidates.length === 0) {
            return [];
        }
        const active = candidates.find((target) => target.scrollWidth > target.clientWidth + 1) || candidates[0];
        return active ? [active] : [];
    }, []);

    const pickTableToExternalSyncTargets = useCallback((tableContainer: HTMLElement): HTMLElement[] => {
        if (enableVirtual) {
            const holderEl = tableContainer.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
            if (virtualListItemHorizontalOffsetComposited && holderEl) {
                return [holderEl];
            }
            const headerEl = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
            const contentEl = tableContainer.querySelector('.ant-table-content') as HTMLElement | null;
            const candidates = [headerEl, contentEl].filter((node): node is HTMLElement => node instanceof HTMLElement);
            const active = candidates.find((target) => target.scrollWidth > target.clientWidth + 1) || candidates[0];
            if (active) {
                return [active];
            }
        }
        return pickHorizontalScrollTargets(tableContainer);
    }, [enableVirtual, pickHorizontalScrollTargets, virtualListItemHorizontalOffsetComposited]);

    const pickVerticalScrollTarget = useCallback((tableContainer: HTMLElement): HTMLElement | null => {
        const virtualHolder = tableContainer.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
        const rcVirtualHolder = tableContainer.querySelector('.rc-virtual-list-holder') as HTMLElement | null;
        const body = tableContainer.querySelector('.ant-table-body') as HTMLElement | null;
        return virtualHolder || rcVirtualHolder || body;
    }, []);

    const getCellSelectionAutoScrollViewport = useCallback((): CellSelectionAutoScrollViewport | null => {
        if (!enableVirtual || !isTableSurfaceActive) return null;
        const tableContainer = tableContainerRef.current;
        if (!(tableContainer instanceof HTMLElement)) return null;

        const verticalTarget = pickVerticalScrollTarget(tableContainer);
        if (!(verticalTarget instanceof HTMLElement)) return null;

        const horizontalTarget = pickHorizontalScrollTargets(tableContainer)[0] || verticalTarget;
        const rect = verticalTarget.getBoundingClientRect();
        const clientWidth = Math.max(0, horizontalTarget.clientWidth || verticalTarget.clientWidth);
        return {
            rect,
            scrollTop: Number.isFinite(verticalTarget.scrollTop) ? verticalTarget.scrollTop : 0,
            scrollLeft: readVirtualHorizontalOffset(tableContainer),
            maxScrollTop: Math.max(0, verticalTarget.scrollHeight - verticalTarget.clientHeight),
            maxScrollLeft: Math.max(0, tableScrollX - clientWidth),
        };
    }, [enableVirtual, isTableSurfaceActive, pickHorizontalScrollTargets, pickVerticalScrollTarget, readVirtualHorizontalOffset, tableScrollX]);

    const scrollCellSelectionBy = useCallback((deltaX: number, deltaY: number): boolean => {
        if (!enableVirtual || !isTableSurfaceActive) return false;
        const tableContainer = tableContainerRef.current;
        if (!(tableContainer instanceof HTMLElement)) return false;

        let didScroll = false;
        if (deltaY !== 0) {
            const verticalTarget = pickVerticalScrollTarget(tableContainer);
            if (verticalTarget instanceof HTMLElement) {
                const currentTop = Number.isFinite(verticalTarget.scrollTop) ? verticalTarget.scrollTop : 0;
                const maxTop = Math.max(0, verticalTarget.scrollHeight - verticalTarget.clientHeight);
                const nextTop = Math.max(0, Math.min(maxTop, currentTop + deltaY));
                if (Math.abs(nextTop - currentTop) > 0.5) {
                    const tableInstance = tableRef.current;
                    if (tableInstance && typeof tableInstance.scrollTo === 'function') {
                        tableInstance.scrollTo({ top: nextTop });
                    } else {
                        verticalTarget.scrollTop = nextTop;
                    }
                    didScroll = true;
                }
            }
        }

        if (deltaX !== 0) {
            const currentLeft = readVirtualHorizontalOffset(tableContainer);
            const applied = applyVirtualHorizontalOffset(tableContainer, currentLeft + deltaX, {
                forceInternalScroll: true,
            });
            if (applied) {
                const resolvedLeft = readVirtualHorizontalOffset(tableContainer);
                const externalScroll = externalHorizontalScrollRef.current;
                if (externalScroll && Math.abs(externalScroll.scrollLeft - resolvedLeft) > 1) {
                    externalScroll.scrollLeft = resolvedLeft;
                }
                lastTableScrollLeftRef.current = resolvedLeft;
                lastExternalScrollLeftRef.current = externalScroll?.scrollLeft ?? resolvedLeft;
                didScroll = didScroll || Math.abs(resolvedLeft - currentLeft) > 0.5;
            }
        }

        return didScroll;
    }, [applyVirtualHorizontalOffset, enableVirtual, isTableSurfaceActive, pickVerticalScrollTarget, readVirtualHorizontalOffset]);

    useEffect(() => {
        if (!enableVirtual || !isTableSurfaceActive) {
            cellSelectionAutoScrollControllerRef.current = null;
            return;
        }

        const controller: CellSelectionAutoScrollController = {
            getViewport: getCellSelectionAutoScrollViewport,
            scrollBy: scrollCellSelectionBy,
        };
        cellSelectionAutoScrollControllerRef.current = controller;
        return () => {
            if (cellSelectionAutoScrollControllerRef.current === controller) {
                cellSelectionAutoScrollControllerRef.current = null;
            }
        };
    }, [enableVirtual, getCellSelectionAutoScrollViewport, isTableSurfaceActive, scrollCellSelectionBy]);

    const focusPageFindMatch = useCallback((match: DataGridFindMatch) => {
        if (!match) return;
        const nextSelection = new Set([makeCellKey(match.rowKey, match.columnName)]);
        markCellSelectionUserSelection(false);
        markCellSelectionDeleteEligible(false);
        cellSelectionAnchorSourceRef.current = 'page-find';
        setSelectedCells(nextSelection);
        currentSelectionRef.current = nextSelection;
        selectionStartRef.current = {
            rowKey: match.rowKey,
            colName: match.columnName,
            rowIndex: match.rowIndex,
            colIndex: match.columnIndex,
        };

        const targetRow = mergedDisplayData[match.rowIndex] || mergedDisplayData.find((row) => {
            const rowKey = row?.[GONAVI_ROW_KEY];
            return rowKey !== undefined && rowKey !== null && rowKeyStr(rowKey) === match.rowKey;
        });
        if (targetRow && dataPanelOpenRef.current) {
            updateFocusedCell(targetRow, match.columnName);
        }

        const applyVisibleFocus = () => {
            const root = containerRef.current;
            if (!root) return false;
            const cell = Array.from(root.querySelectorAll('.ant-table-cell[data-row-key][data-col-name]')).find((node) => {
                const el = node as HTMLElement;
                return el.getAttribute('data-row-key') === match.rowKey && el.getAttribute('data-col-name') === match.columnName;
            }) as HTMLElement | undefined;
            updateCellSelection(nextSelection);
            if (!cell) return false;
            cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            return true;
        };

        const tableContainer = tableContainerRef.current;
        if (tableContainer instanceof HTMLElement) {
            // Column-window virtualization removes far-off body cells. Move the
            // full header first so the target column exists for the focus retry.
            // Do this even when the cell is already rendered in overscan: calling
            // scrollIntoView on that offscreen cell first would move the holder's
            // native scrollLeft without updating rc-table or the external track.
            const headerTarget = Array.from(tableContainer.querySelectorAll<HTMLElement>('[data-column-name]')).find(
                (element) => element.getAttribute('data-column-name') === match.columnName,
            );
            const headerScroll = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
            if (headerTarget && headerScroll) {
                const currentScrollLeft = enableVirtual
                    ? readVirtualHorizontalOffset(tableContainer)
                    : headerScroll.scrollLeft;
                const targetRect = headerTarget.getBoundingClientRect();
                const viewportRect = headerScroll.getBoundingClientRect();
                const fixedHeaderCell = headerTarget.closest('.ant-table-cell-fix-left, .ant-table-cell-fix-right');
                const nextScrollLeft = fixedHeaderCell
                    ? currentScrollLeft
                    : resolveDataGridColumnQuickFindScrollLeft({
                        currentScrollLeft,
                        columnLeft: currentScrollLeft + (targetRect.left - viewportRect.left),
                        columnWidth: targetRect.width,
                        viewportWidth: headerScroll.clientWidth,
                        scrollWidth: headerScroll.scrollWidth,
                    });
                if (enableVirtual) {
                    externalScrollSequenceRef.current += 1;
                    applyVirtualHorizontalOffset(tableContainer, nextScrollLeft, { forceInternalScroll: true });
                } else {
                    headerScroll.scrollLeft = nextScrollLeft;
                }
                const externalScroll = externalHorizontalScrollRef.current;
                if (externalScroll) {
                    externalScroll.scrollLeft = nextScrollLeft;
                    lastExternalScrollLeftRef.current = nextScrollLeft;
                }
                lastTableScrollLeftRef.current = nextScrollLeft;
            }
        }

        if (applyVisibleFocus()) return;

        if (tableContainer instanceof HTMLElement) {
            const verticalTarget = pickVerticalScrollTarget(tableContainer);
            if (verticalTarget) {
                const firstCell = tableContainer.querySelector('.ant-table-cell[data-row-key]') as HTMLElement | null;
                const rowHeight = Math.max(24, Math.ceil(firstCell?.getBoundingClientRect().height || 38));
                verticalTarget.scrollTop = Math.max(0, (match.rowIndex - 1) * rowHeight);
            }
        }

        requestAnimationFrame(() => {
            if (applyVisibleFocus()) return;
            requestAnimationFrame(() => {
                applyVisibleFocus();
            });
        });
    }, [applyVirtualHorizontalOffset, enableVirtual, markCellSelectionDeleteEligible, markCellSelectionUserSelection, mergedDisplayData, pickVerticalScrollTarget, readVirtualHorizontalOffset, rowKeyStr, updateCellSelection, updateFocusedCell]);

    const handleNavigatePageFind = useCallback((direction: DataGridFindNavigationDirection) => {
        const nextIndex = resolveDataGridFindNavigationIndex(activePageFindMatchIndex, pageFindMatches.length, direction);
        if (nextIndex < 0) return;
        setActivePageFindMatchIndex(nextIndex);
        const match = pageFindMatches[nextIndex];
        if (match) focusPageFindMatch(match);
    }, [activePageFindMatchIndex, pageFindMatches, focusPageFindMatch]);

    const visibleColumnQuickFindMatches = useMemo(() => {
        if (!normalizedColumnQuickFindText) return [];
        return displayColumnNames.filter((columnName) => (
            matchesDataGridColumnQuickFind(columnName, normalizedColumnQuickFindText)
        ));
    }, [displayColumnNames, normalizedColumnQuickFindText]);

    const columnQuickFindOptions = useMemo(
        () => visibleColumnQuickFindMatches.slice(0, 12).map((columnName) => ({ value: columnName, label: columnName })),
        [visibleColumnQuickFindMatches],
    );

    const resolveColumnQuickFindTarget = useCallback((query: string): string => (
        resolveDataGridColumnQuickFindTarget(displayColumnNames, query)
    ), [displayColumnNames]);

    const highlightColumnQuickFindTarget = useCallback((columnName: string) => {
        setHighlightedColumnName(columnName);
        if (columnQuickFindHighlightTimerRef.current) {
            clearTimeout(columnQuickFindHighlightTimerRef.current);
        }
        columnQuickFindHighlightTimerRef.current = setTimeout(() => {
            setHighlightedColumnName((prev) => (prev === columnName ? '' : prev));
            columnQuickFindHighlightTimerRef.current = null;
        }, 1600);
    }, []);

    const isExternalScrollbarInteractionActive = useCallback(() => (
        externalScrollbarDraggingRef.current
        || Date.now() < externalScrollInteractionUntilRef.current
    ), []);

    const clearExternalScrollbarInteraction = useCallback(() => {
        externalIdleCommitSchedulerRef.current?.cancel();
        externalScrollInteractionUntilRef.current = 0;
    }, []);

    const syncExternalScrollFromTargets = useCallback((targets?: HTMLElement[], source?: HTMLElement | null) => {
        const externalScroll = horizontalScrollVisible ? externalHorizontalScrollRef.current : null;
        if (
            !(externalScroll instanceof HTMLDivElement)
            || horizontalSyncSourceRef.current === 'external'
            || isExternalScrollbarInteractionActive()
        ) {
            return;
        }
        const tableContainer = tableContainerRef.current;
        if (enableVirtual && tableContainer instanceof HTMLElement) {
            const nextScrollLeft = readVirtualHorizontalOffset(tableContainer);
            if (Math.abs(lastTableScrollLeftRef.current - nextScrollLeft) < 1 && Math.abs(externalScroll.scrollLeft - nextScrollLeft) < 1) {
                return;
            }
            lastTableScrollLeftRef.current = nextScrollLeft;
            if (Math.abs(externalScroll.scrollLeft - nextScrollLeft) > 1) {
                externalScroll.scrollLeft = nextScrollLeft;
                lastExternalScrollLeftRef.current = nextScrollLeft;
            }
            return;
        }
        const nextTargets = targets && targets.length > 0 ? targets : tableScrollTargetsRef.current;
        if (!nextTargets || nextTargets.length === 0) {
            return;
        }
        const activeTarget = source || nextTargets.find((target) => target.scrollWidth > target.clientWidth + 1) || nextTargets[0];
        if (!(activeTarget instanceof HTMLElement)) {
            return;
        }
        const nextScrollLeft = activeTarget.scrollLeft;
        if (Math.abs(lastTableScrollLeftRef.current - nextScrollLeft) < 1 && Math.abs(externalScroll.scrollLeft - nextScrollLeft) < 1) {
            return;
        }
        lastTableScrollLeftRef.current = nextScrollLeft;
        if (Math.abs(externalScroll.scrollLeft - nextScrollLeft) > 1) {
            externalScroll.scrollLeft = nextScrollLeft;
            lastExternalScrollLeftRef.current = nextScrollLeft;
        }
    }, [enableVirtual, horizontalScrollVisible, isExternalScrollbarInteractionActive, readVirtualHorizontalOffset]);

    const scheduleSyncExternalScrollFromTargets = useCallback((source?: HTMLElement | null) => {
        if (isExternalScrollbarInteractionActive()) {
            return;
        }
        pendingTableTargetSyncSourceRef.current = source ?? null;
        if (tableTargetSyncRafRef.current !== null) {
            return;
        }
        tableTargetSyncRafRef.current = requestAnimationFrame(() => {
            tableTargetSyncRafRef.current = null;
            const pendingSource = pendingTableTargetSyncSourceRef.current;
            pendingTableTargetSyncSourceRef.current = null;
            if (horizontalSyncSourceRef.current === 'external' || isExternalScrollbarInteractionActive()) {
                return;
            }
            horizontalSyncSourceRef.current = 'table';
            syncExternalScrollFromTargets(undefined, pendingSource);
            horizontalSyncSourceRef.current = '';
        });
    }, [isExternalScrollbarInteractionActive, syncExternalScrollFromTargets]);
    return {
        scheduleVirtualHorizontalWheel, scheduleNativeVirtualHorizontalScroll,
        pickHorizontalScrollTargets, pickTableToExternalSyncTargets, pickVerticalScrollTarget,
        handleNavigatePageFind, columnQuickFindOptions, resolveColumnQuickFindTarget,
        highlightColumnQuickFindTarget, isExternalScrollbarInteractionActive,
        clearExternalScrollbarInteraction, syncExternalScrollFromTargets,
        scheduleSyncExternalScrollFromTargets,
    };
};

export type DataGridPageFindApi = ReturnType<typeof useDataGridPageFind>;
