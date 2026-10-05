import React, { useCallback, useEffect, useRef, useState } from 'react';
import { message, type InputRef } from 'antd';
import dayjs from 'dayjs';
import { useDataGridModalEditors } from '../../useDataGridModalEditors';
import {
    toEditableText,
    looksLikeJsonText,
    GONAVI_ROW_KEY,
    isCellValueEqualForDiff,
    type VirtualEditingCellState,
    type Item,
    type VirtualTableScrollReference,
} from '../../DataGridCore';
import { normalizeMongoDocumentForEditing } from '../../../utils/mongodb';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import type { CellSelectionAutoScrollController } from '../../useDataGridBatchActions';
import {
    type DataGridIdleCommitScheduler,
    type DataGridVisualFrameGuard,
    createDataGridIdleCommitScheduler,
} from '../../dataGridVirtualScroll';
import { EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS } from '../dataGridScrollTiming';
import { useControllableDataGridSelection } from '../../useControllableDataGridSelection';
import { isTemporalPickerPopupTarget } from '../../dataGridTemporal';
import {
    calculateAutoFitColumnWidths,
    createDataGridCanvasTextMeasurer,
} from '../../dataGridAutoWidth';
import { MIN_DATA_TABLE_COLUMN_WIDTH } from '../../../utils/dataGridDisplay';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridCellEditorStateInput {
    mongoAwareEditableText: DataGridCoreStateApi['mongoAwareEditableText'];
    cellEditorSourceRef: DataGridCoreStateApi['cellEditorSourceRef'];
    cellEditorRuntimeRef: DataGridCoreStateApi['cellEditorRuntimeRef'];
    data: DataGridProps['data'];
    connectionId: DataGridProps['connectionId'];
    dbName: DataGridProps['dbName'];
    tableName: DataGridProps['tableName'];
    isMongoDBConnection: DataGridCoreStateApi['isMongoDBConnection'];
    canModifyData: DataGridCoreStateApi['canModifyData'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    isActive: Exclude<DataGridProps['isActive'], undefined>;
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    sessionState: DataGridProps['sessionState'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    densityParams: DataGridCoreStateApi['densityParams'];
    form: DataGridCoreStateApi['form'];
    sortInfoExternal: DataGridProps['sortInfoExternal'];
}

export const useDataGridCellEditorState = ({
    mongoAwareEditableText, cellEditorSourceRef, cellEditorRuntimeRef, data, connectionId, dbName,
    tableName, isMongoDBConnection, canModifyData, effectiveEditLocator, isActive,
    translateDataGrid, sessionState, displayColumnNames, densityParams, form, sortInfoExternal,
}: UseDataGridCellEditorStateInput) => {
    const {
        cellEditorOpen,
        cellEditorValue,
        setCellEditorValue,
        cellEditorEscapeApplied,
        setCellEditorEscapeApplied,
        cellEditorIsJson,
        cellEditorMeta,
        cellEditorApplyRef,
        closeCellEditor: closeCellEditorState,
        openCellEditor: openCellEditorState,
        openCellViewer: openCellViewerState,
        jsonEditorOpen,
        jsonEditorValue,
        setJsonEditorValue,
        openJsonEditor,
        closeJsonEditor,
        rowEditorOpen,
        rowEditorRowKey,
        rowEditorBaseRawRef,
        rowEditorDisplayRef,
        rowEditorNullColsRef,
        rowEditorForm,
        closeRowEditor,
        openRowEditor,
        batchEditModalOpen,
        batchEditValue,
        setBatchEditValue,
        batchEditSetNull,
        setBatchEditSetNull,
        openBatchEditModal,
        closeBatchEditModal,
    } = useDataGridModalEditors({
        toEditableText: mongoAwareEditableText,
        toViewerText: toEditableText,
        looksLikeJsonText,
    });
    const isCellEditorSourceCurrent = useCallback(() => {
        const source = cellEditorSourceRef.current;
        const runtime = cellEditorRuntimeRef.current;
        return !!source
            && source.data === runtime.data
            && source.connectionId === runtime.connectionId
            && source.dbName === runtime.dbName
            && source.tableName === runtime.tableName;
    }, []);
    const closeCellEditor = useCallback(() => {
        cellEditorSourceRef.current = null;
        closeCellEditorState();
    }, [closeCellEditorState]);
    const openCellEditor = useCallback((...args: Parameters<typeof openCellEditorState>) => {
        cellEditorSourceRef.current = { data, connectionId, dbName, tableName };
        openCellEditorState(...args);
    }, [connectionId, data, dbName, openCellEditorState, tableName]);
    const openCellViewer = useCallback((...args: Parameters<typeof openCellViewerState>) => {
        cellEditorSourceRef.current = { data, connectionId, dbName, tableName };
        const [record, dataIndex, title] = args;
        const rowKey = record?.[GONAVI_ROW_KEY];
        const rowKeyText = rowKey === undefined || rowKey === null ? '' : String(rowKey);
        const sourceRecord = !rowKeyText
            ? undefined
            : data.find((candidate) => {
                const candidateKey = candidate?.[GONAVI_ROW_KEY];
                return candidateKey !== undefined && candidateKey !== null && String(candidateKey) === rowKeyText;
            });
        const normalizedSourceRecord = isMongoDBConnection && sourceRecord
            ? normalizeMongoDocumentForEditing(sourceRecord)
            : undefined;
        const shouldUseRawMongoValue = !!sourceRecord
            && !!normalizedSourceRecord
            && isCellValueEqualForDiff(record?.[dataIndex], normalizedSourceRecord?.[dataIndex]);
        const viewerRecord = shouldUseRawMongoValue
            ? { ...record, [dataIndex]: sourceRecord[dataIndex] }
            : record;
        openCellViewerState(viewerRecord, dataIndex, title);
    }, [connectionId, data, dbName, isMongoDBConnection, openCellViewerState, tableName]);
    const cellEditorViewerMode = cellEditorMeta?.readOnly === true;
    const cellEditorPermissionLost = !!cellEditorMeta
        && !cellEditorMeta.readOnly
        && (!canModifyData || !isWritableResultColumn(cellEditorMeta.dataIndex, effectiveEditLocator));
    const cellEditorContextChanged = cellEditorOpen && !isCellEditorSourceCurrent();
    const cellEditorUnavailable = cellEditorOpen && (!isActive || cellEditorContextChanged);
    const cellEditorReadOnly = cellEditorViewerMode || cellEditorPermissionLost || cellEditorUnavailable;
    const cellEditorOpenForRender = cellEditorOpen && !cellEditorUnavailable;
    useEffect(() => {
        if (!cellEditorOpen) return;
        if (cellEditorUnavailable) {
            closeCellEditor();
            return;
        }
        if (cellEditorPermissionLost) {
            void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
            closeCellEditor();
        }
    }, [cellEditorOpen, cellEditorPermissionLost, cellEditorUnavailable, closeCellEditor, translateDataGrid]);
    const virtualEditingSessionSequenceRef = useRef(0);
    const virtualEditingSessionRef = useRef<{
        sessionId: number;
        sourceData: typeof data;
        connectionId: typeof connectionId;
        dbName: typeof dbName;
        tableName: typeof tableName;
        rowKey: string;
        dataIndex: string;
    } | null>(null);
    const virtualEditingRuntimeRef = useRef({
        data,
        isActive,
        canModifyData,
        effectiveEditLocator,
        connectionId,
        dbName,
        tableName,
    });
    virtualEditingRuntimeRef.current = {
        data,
        isActive,
        canModifyData,
        effectiveEditLocator,
        connectionId,
        dbName,
        tableName,
    };
    const [virtualEditingCell, setVirtualEditingCell] = useState<VirtualEditingCellState | null>(null);
    const isVirtualEditingSessionCurrent = useCallback((editingCell: VirtualEditingCellState | null) => {
        if (!editingCell) return false;
        const session = virtualEditingSessionRef.current;
        const runtime = virtualEditingRuntimeRef.current;
        return !!session
            && session.sessionId === editingCell.sessionId
            && session.rowKey === editingCell.rowKey
            && session.dataIndex === editingCell.dataIndex
            && session.sourceData === runtime.data
            && session.connectionId === runtime.connectionId
            && session.dbName === runtime.dbName
            && session.tableName === runtime.tableName
            && runtime.isActive
            && runtime.canModifyData
            && isWritableResultColumn(editingCell.dataIndex, runtime.effectiveEditLocator);
    }, []);
    const virtualEditingSession = virtualEditingSessionRef.current;
    const virtualEditingContextChanged = !!virtualEditingCell && (
        !virtualEditingSession
        || virtualEditingSession.sessionId !== virtualEditingCell.sessionId
        || virtualEditingSession.sourceData !== data
        || virtualEditingSession.connectionId !== connectionId
        || virtualEditingSession.dbName !== dbName
        || virtualEditingSession.tableName !== tableName
    );
    const virtualEditingPermissionLost = !!virtualEditingCell
        && (!canModifyData || !isWritableResultColumn(virtualEditingCell.dataIndex, effectiveEditLocator));
    const virtualEditingUnavailable = !!virtualEditingCell
        && (!isActive || virtualEditingContextChanged);
    const virtualEditingCellForRender = virtualEditingUnavailable || virtualEditingPermissionLost
        ? null
        : virtualEditingCell;
    const virtualInlineInputRef = useRef<any>(null);
    const virtualInlinePickerOpenRef = useRef(false);
    const virtualInlinePickerInteractionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const virtualInlinePickerInteractionTokenRef = useRef(0);
    const virtualInlinePickerPendingValueRef = useRef<dayjs.Dayjs | null | undefined>(undefined);
    const virtualInlinePickerCommitSessionRef = useRef<number | null>(null);
    const virtualInlinePickerSaveSessionRef = useRef<number | null>(null);
    const virtualInlineScrollLockRef = useRef<{ el: HTMLElement; handler: (e: WheelEvent) => void } | null>(null);
    // Cell Context Menu State
    const [cellContextMenu, setCellContextMenu] = useState<{
      visible: boolean;
      x: number;
      y: number;
      kind: 'cell' | 'column';
      record: Item | null;
      dataIndex: string;
      title: string;
    }>({
      visible: false,
      x: 0,
      y: 0,
      kind: 'cell',
      record: null,
      dataIndex: '',
      title: '',
    });
    const cellContextMenuPortalRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const pageFindInputRef = useRef<InputRef>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const tableContainerRef = useRef<HTMLDivElement | null>(null);
    const tableRef = useRef<VirtualTableScrollReference | null>(null);
    const cellSelectionAutoScrollControllerRef = useRef<CellSelectionAutoScrollController | null>(null);
    const tableScrollTargetsRef = useRef<HTMLElement[]>([]);
    const externalHorizontalScrollRef = useRef<HTMLDivElement | null>(null);
    const virtualHorizontalElementsRef = useRef<{
        tableContainer: HTMLElement | null;
        holderEl: HTMLElement | null;
        innerEl: HTMLElement | null;
        headerEl: HTMLElement | null;
    }>({
        tableContainer: null,
        holderEl: null,
        innerEl: null,
        headerEl: null,
    });
    const horizontalSyncSourceRef = useRef<'table' | 'external' | ''>('');
    const lastTableScrollLeftRef = useRef(0);
    const lastCommittedVirtualHorizontalOffsetRef = useRef(0);
    // Resolved in the visual-offset sync; consumed by the fixed-cell commit calls so
    // right-pinned cells can be offset from the scroll end.
    const virtualHorizontalMaxScrollRef = useRef(0);
    const lastExternalScrollLeftRef = useRef(0);
    const externalSyncRafRef = useRef<number | null>(null);
    const externalScrollSettleRafRef = useRef<number | null>(null);
    const pendingExternalScrollLeftRef = useRef<number | null>(null);
    const externalScrollSequenceRef = useRef(0);
    const externalScrollbarDraggingRef = useRef(false);
    const externalScrollInteractionUntilRef = useRef(0);
    const externalIdleCommitHandlerRef = useRef<(syncSequence: number) => void>(() => {});
    const externalIdleCommitSchedulerRef = useRef<DataGridIdleCommitScheduler<number> | null>(null);
    const tableTargetSyncRafRef = useRef<number | null>(null);
    const tableHorizontalWheelRafRef = useRef<number | null>(null);
    const nativeHorizontalSyncRafRef = useRef<number | null>(null);
    const virtualHorizontalAlignmentRafRef = useRef<number | null>(null);
    const virtualHorizontalPostCommitFrameHandlerRef = useRef<(offset: number) => void>(() => {});
    const virtualHorizontalPostCommitGuardRef = useRef<DataGridVisualFrameGuard<number> | null>(null);
    const virtualHorizontalPreviewActiveRef = useRef(false);
    const pendingTableHorizontalDeltaRef = useRef(0);
    const pendingTableTargetSyncSourceRef = useRef<HTMLElement | null>(null);
    const scrollSnapshotRafRef = useRef<number | null>(null);
    const pendingScrollToBottomRef = useRef(false);
    const pastedRowSequenceRef = useRef(0);
    const lastReportedScrollRef = useRef<{ top: number; left: number }>({ top: 0, left: 0 });
    const didRestoreScrollRef = useRef(false);

    if (externalIdleCommitSchedulerRef.current === null) {
        externalIdleCommitSchedulerRef.current = createDataGridIdleCommitScheduler<number>({
            delayMs: EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS,
            canCommit: () => !externalScrollbarDraggingRef.current,
            onCommit: (syncSequence) => externalIdleCommitHandlerRef.current(syncSequence),
        });
    }

    useEffect(() => {
        // 结果集刷新后需要允许重新恢复滚动位置；否则筛选/排序重载时可能只保留外部滚动条位置，
        // 但虚拟表格内部横向偏移已被重建为初始值，进而造成表头与单元格错位。
        didRestoreScrollRef.current = false;
    }, [connectionId, dbName, tableName, data]);

    // 批量编辑模式状态
    const [cellEditMode, setCellEditMode] = useState(false);
    const { selectedRowKeys, setSelectedRowKeys, selectedCells, setSelectedCells } = useControllableDataGridSelection(sessionState);
    const [cellSelectionDeleteEligible, setCellSelectionDeleteEligible] = useState(false);
    const cellSelectionSourceDataRef = useRef<Item[] | null>(null);
    // Keep the origin of an explicit user cell selection separate from the
    // editable/delete eligibility guard. Read-only result grids still support
    // selecting cells and should report that selection in the footer.
    const cellSelectionUserSourceDataRef = useRef<Item[] | null>(null);
    const cellSelectionAnchorSourceRef = useRef<'user' | 'page-find' | null>(null);
    const [copiedCellPatch, setCopiedCellPatch] = useState<{ sourceRowKey: string; values: Record<string, any> } | null>(null);
    const [copiedRowsForPaste, setCopiedRowsForPaste] = useState<Array<Record<string, any>>>([]);

    // 使用 ref 来优化拖拽性能，完全避免状态更新
    const cellSelectionRafRef = useRef<number | null>(null);
    const cellSelectionScrollRafRef = useRef<number | null>(null);
    const cellSelectionAutoScrollRafRef = useRef<number | null>(null);
    const cellSelectionPointerRef = useRef<{ x: number; y: number } | null>(null);
    const pendingCellSelectionStartRef = useRef<{ rowKey: string; colName: string; x: number; y: number } | null>(null);
    const suppressCellSelectionClickRef = useRef(false);
    const cellEditModeRef = useRef(false);
    const isDraggingRef = useRef(false);

    // 导入预览 Modal 状态
    const [importPreviewVisible, setImportPreviewVisible] = useState(false);
    const [importFilePath, setImportFilePath] = useState('');
    const currentSelectionRef = useRef<Set<string>>(new Set());
    const selectionStartRef = useRef<{ rowKey: string; colName: string; rowIndex: number; colIndex: number } | null>(null);
    const rowIndexMapRef = useRef<Map<string, number>>(new Map());

    const scrollTableBodyToBottom = useCallback(() => {
        const root = containerRef.current;
        if (!root) return;
        const body = root.querySelector('.ant-table-body') as HTMLElement | null;
        if (!body) return;
        body.scrollTop = body.scrollHeight;
    }, []);

    useEffect(() => () => {
        if (externalSyncRafRef.current !== null) {
            cancelAnimationFrame(externalSyncRafRef.current);
            externalSyncRafRef.current = null;
        }
        if (externalScrollSettleRafRef.current !== null) {
            cancelAnimationFrame(externalScrollSettleRafRef.current);
            externalScrollSettleRafRef.current = null;
        }
        if (tableTargetSyncRafRef.current !== null) {
            cancelAnimationFrame(tableTargetSyncRafRef.current);
            tableTargetSyncRafRef.current = null;
        }
        if (tableHorizontalWheelRafRef.current !== null) {
            cancelAnimationFrame(tableHorizontalWheelRafRef.current);
            tableHorizontalWheelRafRef.current = null;
        }
        if (nativeHorizontalSyncRafRef.current !== null) {
            cancelAnimationFrame(nativeHorizontalSyncRafRef.current);
            nativeHorizontalSyncRafRef.current = null;
        }
        virtualHorizontalPostCommitGuardRef.current?.cancel();
        if (scrollSnapshotRafRef.current !== null) {
            cancelAnimationFrame(scrollSnapshotRafRef.current);
            scrollSnapshotRafRef.current = null;
        }
        pendingTableHorizontalDeltaRef.current = 0;
        pendingExternalScrollLeftRef.current = null;
        externalScrollbarDraggingRef.current = false;
        externalIdleCommitSchedulerRef.current?.cancel();
        externalScrollInteractionUntilRef.current = 0;
        virtualHorizontalPreviewActiveRef.current = false;
        lastCommittedVirtualHorizontalOffsetRef.current = 0;
        horizontalSyncSourceRef.current = '';
        pendingTableTargetSyncSourceRef.current = null;
    }, []);

    // Close cell context menu when clicking outside
    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (cellContextMenu.visible) {
          setCellContextMenu(prev => ({ ...prev, visible: false }));
        }
        // Remove focus from any focused cell when clicking outside the table
        const target = e.target as HTMLElement;
        const tableContainer = containerRef.current;
        if (tableContainer && !tableContainer.contains(target)) {
          // Ant Design renders the picker panel in a body portal. Its controls
          // are outside the table DOM but still belong to the active editor.
          if (isTemporalPickerPopupTarget(target)) {
            return;
          }
          // Remove focus from any input elements in the table
          const focusedElement = document.activeElement as HTMLElement;
          if (focusedElement && focusedElement.tagName === 'INPUT' && tableContainer.contains(focusedElement)) {
            focusedElement.blur();
          }
        }
      };
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }, [cellContextMenu.visible]);

    const resolveContextMenuPosition = useCallback((x: number, y: number, estimatedWidth: number, estimatedHeight: number) => {
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const safeGap = 8;
      let nextY = y;
      let nextX = x;
      if (nextY + estimatedHeight > viewportH - safeGap) {
        nextY = Math.max(safeGap, viewportH - estimatedHeight - safeGap);
      }
      if (nextX + estimatedWidth > viewportW - safeGap) {
        nextX = Math.max(safeGap, viewportW - estimatedWidth - safeGap);
      }
      return { x: nextX, y: nextY };
    }, []);

    const showCellContextMenu = useCallback((e: React.MouseEvent, record: Item, dataIndex: string, title: React.ReactNode) => {
      e.preventDefault();
      e.stopPropagation();
      const titleText = typeof (title as any) === 'string' ? (title as string) : (typeof (title as any) === 'number' ? String(title) : String(dataIndex));
      const { x: menuX, y: menuY } = resolveContextMenuPosition(e.clientX, e.clientY, 264, 420);
      setCellContextMenu({
        visible: true,
        x: menuX,
        y: menuY,
        kind: 'cell',
        record,
        dataIndex,
        title: titleText,
      });
    }, [resolveContextMenuPosition]);

    const showColumnHeaderContextMenu = useCallback((e: React.MouseEvent, columnName: string) => {
      e.preventDefault();
      e.stopPropagation();
      const { x: menuX, y: menuY } = resolveContextMenuPosition(e.clientX, e.clientY, 264, 360);
      setCellContextMenu({
        visible: true,
        x: menuX,
        y: menuY,
        kind: 'column',
        record: null,
        dataIndex: columnName,
        title: columnName,
      });
    }, [resolveContextMenuPosition]);

    const [sortInfo, setSortInfo] = useState<Array<{ columnKey: string, order: string, enabled?: boolean }>>([]);
    const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => calculateAutoFitColumnWidths({
        columnNames: displayColumnNames,
        rows: data,
        dataFontSize: densityParams.dataFontSize,
        defaultWidth: densityParams.defaultColumnWidth,
        minWidth: MIN_DATA_TABLE_COLUMN_WIDTH,
        maxWidth: 600,
        measureTextWidth: createDataGridCanvasTextMeasurer(),
    }));
    const mergedDisplayDataRef = useRef<Item[]>([]);
    const closeCellEditModeRef = useRef<() => void>(() => {});
    const formRef = useRef(form);
    formRef.current = form;

    useEffect(() => {
        const ext = sortInfoExternal || [];
        const extKey = JSON.stringify(ext);
        const curKey = JSON.stringify(sortInfo);
        if (extKey === curKey) return;
        setSortInfo(ext);
    }, [sortInfoExternal, sortInfo]);
    return {
        cellEditorValue, setCellEditorValue, cellEditorEscapeApplied, setCellEditorEscapeApplied,
        cellEditorIsJson, cellEditorMeta, cellEditorApplyRef, jsonEditorOpen, jsonEditorValue,
        setJsonEditorValue, openJsonEditor, closeJsonEditor, rowEditorOpen, rowEditorRowKey,
        rowEditorBaseRawRef, rowEditorDisplayRef, rowEditorNullColsRef, rowEditorForm,
        closeRowEditor, openRowEditor, batchEditModalOpen, batchEditValue, setBatchEditValue,
        batchEditSetNull, setBatchEditSetNull, openBatchEditModal, closeBatchEditModal,
        isCellEditorSourceCurrent, closeCellEditor, openCellEditor, openCellViewer,
        cellEditorViewerMode, cellEditorReadOnly, cellEditorOpenForRender,
        virtualEditingSessionSequenceRef, virtualEditingSessionRef, virtualEditingCell,
        setVirtualEditingCell, isVirtualEditingSessionCurrent, virtualEditingPermissionLost,
        virtualEditingUnavailable, virtualEditingCellForRender, virtualInlineInputRef,
        virtualInlinePickerOpenRef, virtualInlinePickerInteractionTimerRef,
        virtualInlinePickerInteractionTokenRef, virtualInlinePickerPendingValueRef,
        virtualInlinePickerCommitSessionRef, virtualInlinePickerSaveSessionRef,
        virtualInlineScrollLockRef, cellContextMenu, setCellContextMenu, cellContextMenuPortalRef,
        rootRef, pageFindInputRef, containerRef, tableContainerRef, tableRef,
        cellSelectionAutoScrollControllerRef, tableScrollTargetsRef, externalHorizontalScrollRef,
        virtualHorizontalElementsRef, horizontalSyncSourceRef, lastTableScrollLeftRef,
        lastCommittedVirtualHorizontalOffsetRef, virtualHorizontalMaxScrollRef,
        lastExternalScrollLeftRef, externalSyncRafRef, externalScrollSettleRafRef,
        pendingExternalScrollLeftRef, externalScrollSequenceRef, externalScrollbarDraggingRef,
        externalScrollInteractionUntilRef, externalIdleCommitHandlerRef,
        externalIdleCommitSchedulerRef, tableTargetSyncRafRef, tableHorizontalWheelRafRef,
        nativeHorizontalSyncRafRef, virtualHorizontalAlignmentRafRef,
        virtualHorizontalPostCommitFrameHandlerRef, virtualHorizontalPostCommitGuardRef,
        virtualHorizontalPreviewActiveRef, pendingTableHorizontalDeltaRef,
        pendingTableTargetSyncSourceRef, scrollSnapshotRafRef, pendingScrollToBottomRef,
        pastedRowSequenceRef, lastReportedScrollRef, didRestoreScrollRef, cellEditMode,
        setCellEditMode, selectedRowKeys, setSelectedRowKeys, selectedCells, setSelectedCells,
        cellSelectionDeleteEligible, setCellSelectionDeleteEligible, cellSelectionSourceDataRef,
        cellSelectionUserSourceDataRef, cellSelectionAnchorSourceRef, copiedCellPatch,
        setCopiedCellPatch, copiedRowsForPaste, setCopiedRowsForPaste, cellSelectionRafRef,
        cellSelectionScrollRafRef, cellSelectionAutoScrollRafRef, cellSelectionPointerRef,
        pendingCellSelectionStartRef, suppressCellSelectionClickRef, cellEditModeRef, isDraggingRef,
        importPreviewVisible, setImportPreviewVisible, importFilePath, setImportFilePath,
        currentSelectionRef, selectionStartRef, rowIndexMapRef, scrollTableBodyToBottom,
        resolveContextMenuPosition, showCellContextMenu, showColumnHeaderContextMenu, sortInfo,
        setSortInfo, columnWidths, setColumnWidths, mergedDisplayDataRef, closeCellEditModeRef,
        formRef,
    };
};

export type DataGridCellEditorStateApi = ReturnType<typeof useDataGridCellEditorState>;
