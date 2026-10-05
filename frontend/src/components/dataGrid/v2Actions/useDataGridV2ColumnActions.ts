import { useCallback, useEffect } from 'react';
import { message } from 'antd';
import type { V2ColumnHeaderContextMenuActionKey } from '../../V2TableContextMenu';
import {
  type DataGridClipboardPayload,
  writeClipboardPayloadToEvent,
} from '../../dataGridClipboardPayload';
import type { CopySqlError } from '../../dataGridCopyInsert';
import type { DataGridV2ActionsContext } from '../../useDataGridV2Actions';

export interface UseDataGridV2ColumnActionsInput {
  resolveContextMenuFieldName: DataGridV2ActionsContext['resolveContextMenuFieldName'];
  cellContextMenu: DataGridV2ActionsContext['cellContextMenu'];
  translateDataGrid: DataGridV2ActionsContext['translateDataGrid'];
  setCellContextMenu: DataGridV2ActionsContext['setCellContextMenu'];
  copyToClipboard: DataGridV2ActionsContext['copyToClipboard'];
  columnMetaMap: DataGridV2ActionsContext['columnMetaMap'];
  columnMetaMapByLowerName: DataGridV2ActionsContext['columnMetaMapByLowerName'];
  handleCopyColumnData: DataGridV2ActionsContext['handleCopyColumnData'];
  applyColumnSort: DataGridV2ActionsContext['applyColumnSort'];
  autoFitColumnWidth: DataGridV2ActionsContext['autoFitColumnWidth'];
  connectionId: DataGridV2ActionsContext['connectionId'];
  dbName: DataGridV2ActionsContext['dbName'];
  pinnedLeftColumnScope: DataGridV2ActionsContext['pinnedLeftColumnScope'];
  pinnedLeftColumnNames: DataGridV2ActionsContext['pinnedLeftColumnNames'];
  setTablePinnedLeftColumns: DataGridV2ActionsContext['setTablePinnedLeftColumns'];
  displayColumnNames: DataGridV2ActionsContext['displayColumnNames'];
  toggleColumnVisibility: DataGridV2ActionsContext['toggleColumnVisibility'];
  setQueryOptions: DataGridV2ActionsContext['setQueryOptions'];
  pickRowsForClipboard: DataGridV2ActionsContext['pickRowsForClipboard'];
  mergedDisplayData: DataGridV2ActionsContext['mergedDisplayData'];
  selectedRowKeys: DataGridV2ActionsContext['selectedRowKeys'];
  displayOutputColumnNames: DataGridV2ActionsContext['displayOutputColumnNames'];
  GONAVI_ROW_KEY: DataGridV2ActionsContext['GONAVI_ROW_KEY'];
  rowKeyStr: DataGridV2ActionsContext['rowKeyStr'];
  buildClipboardCsv: DataGridV2ActionsContext['buildClipboardCsv'];
  buildClipboardJson: DataGridV2ActionsContext['buildClipboardJson'];
  buildClipboardMarkdown: DataGridV2ActionsContext['buildClipboardMarkdown'];
  ddlText: DataGridV2ActionsContext['ddlText'];
  navigator: DataGridV2ActionsContext['navigator'];
  currentSelectionRef: DataGridV2ActionsContext['currentSelectionRef'];
  selectedCells: DataGridV2ActionsContext['selectedCells'];
  splitCellKey: DataGridV2ActionsContext['splitCellKey'];
  buildSelectedCellClipboardPayload: DataGridV2ActionsContext['buildSelectedCellClipboardPayload'];
  isActive: DataGridV2ActionsContext['isActive'];
  isTableSurfaceActive: DataGridV2ActionsContext['isTableSurfaceActive'];
  cellEditMode: DataGridV2ActionsContext['cellEditMode'];
  closeCellEditMode: DataGridV2ActionsContext['closeCellEditMode'];
  resetCellSelection: DataGridV2ActionsContext['resetCellSelection'];
  rootRef: DataGridV2ActionsContext['rootRef'];
  selectedRowKeysRef: DataGridV2ActionsContext['selectedRowKeysRef'];
  displayDataRef: DataGridV2ActionsContext['displayDataRef'];
}

export const useDataGridV2ColumnActions = ({
  resolveContextMenuFieldName, cellContextMenu, translateDataGrid, setCellContextMenu,
  copyToClipboard, columnMetaMap, columnMetaMapByLowerName, handleCopyColumnData, applyColumnSort,
  autoFitColumnWidth, connectionId, dbName, pinnedLeftColumnScope, pinnedLeftColumnNames,
  setTablePinnedLeftColumns, displayColumnNames, toggleColumnVisibility, setQueryOptions,
  pickRowsForClipboard, mergedDisplayData, selectedRowKeys, displayOutputColumnNames,
  GONAVI_ROW_KEY, rowKeyStr, buildClipboardCsv, buildClipboardJson, buildClipboardMarkdown, ddlText,
  navigator, currentSelectionRef, selectedCells, splitCellKey, buildSelectedCellClipboardPayload,
  isActive, isTableSurfaceActive, cellEditMode, closeCellEditMode, resetCellSelection, rootRef,
  selectedRowKeysRef, displayDataRef,
}: UseDataGridV2ColumnActionsInput) => {
  const handleV2ColumnHeaderContextMenuAction = useCallback((action: V2ColumnHeaderContextMenuActionKey) => {
        const columnName = resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title);
        if (!columnName) {
            void message.info(translateDataGrid('data_grid.message.no_field_name'));
            setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
            return;
        }
  
        switch (action) {
            case 'copy-field-name':
                copyToClipboard(columnName);
                break;
            case 'copy-column-comment': {
                const columnMeta = columnMetaMap[columnName]
                    || columnMetaMapByLowerName[columnName.toLowerCase()];
                const comment = String(columnMeta?.comment || '').trim();
                if (!comment) {
                    void message.info(translateDataGrid('data_grid.context_menu.column_no_comment'));
                    break;
                }
                copyToClipboard(comment);
                break;
            }
            case 'copy-column-data':
                handleCopyColumnData(columnName);
                break;
            case 'sort-asc':
                applyColumnSort(columnName, 'ascend');
                break;
            case 'sort-desc':
                applyColumnSort(columnName, 'descend');
                break;
            case 'clear-sort':
                applyColumnSort(columnName, null);
                break;
            case 'auto-fit-column':
                autoFitColumnWidth(columnName);
                break;
            case 'pin-column-left': {
                if (!connectionId || !dbName || !pinnedLeftColumnScope) {
                    void message.info(translateDataGrid('data_grid.message.pin_column_unavailable'));
                    break;
                }
                const nextPinned = [
                    ...pinnedLeftColumnNames.filter((col: string) => col !== columnName),
                    columnName,
                ];
                setTablePinnedLeftColumns(connectionId, dbName, pinnedLeftColumnScope, nextPinned);
                break;
            }
            case 'unpin-column-left': {
                if (!connectionId || !dbName || !pinnedLeftColumnScope) break;
                const nextPinned = pinnedLeftColumnNames.filter((col: string) => col !== columnName);
                setTablePinnedLeftColumns(connectionId, dbName, pinnedLeftColumnScope, nextPinned);
                break;
            }
            case 'hide-column':
                if (displayColumnNames.length <= 1) {
                    void message.info(translateDataGrid('data_grid.message.keep_one_visible_column'));
                    break;
                }
                toggleColumnVisibility(columnName, false);
                break;
            case 'show-column-type':
                setQueryOptions({ showColumnType: true });
                break;
            case 'hide-column-type':
                setQueryOptions({ showColumnType: false });
                break;
            case 'show-column-comment':
                setQueryOptions({ showColumnComment: true });
                break;
            case 'hide-column-comment':
                setQueryOptions({ showColumnComment: false });
                break;
            default:
                break;
        }
        setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
    }, [
        applyColumnSort,
        autoFitColumnWidth,
        cellContextMenu.dataIndex,
        cellContextMenu.title,
        connectionId,
        columnMetaMap,
        columnMetaMapByLowerName,
        copyToClipboard,
        dbName,
        displayColumnNames.length,
        handleCopyColumnData,
        pinnedLeftColumnNames,
        setQueryOptions,
        setTablePinnedLeftColumns,
        pinnedLeftColumnScope,
        translateDataGrid,
        toggleColumnVisibility,
    ]);
  
    const getClipboardRows = useCallback(() => (
        pickRowsForClipboard({
            rows: mergedDisplayData as Array<Record<string, unknown>>,
            selectedRowKeys,
            columnNames: displayOutputColumnNames,
            rowKeyField: GONAVI_ROW_KEY,
            rowKeyToString: rowKeyStr,
        })
    ), [mergedDisplayData, selectedRowKeys, displayOutputColumnNames, rowKeyStr]);
  
    const getClipboardColumnNames = useCallback((rows: Array<Record<string, unknown>>) => {
        if (rows.length === 0) return [];
        return displayOutputColumnNames;
    }, [displayOutputColumnNames]);
  
    const handleCopyQueryResultCsv = useCallback(() => {
        const rows = getClipboardRows();
        const columns = getClipboardColumnNames(rows);
        const text = buildClipboardCsv(rows, columns);
        if (!text) {
            void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
            return;
        }
        copyToClipboard(text);
    }, [copyToClipboard, getClipboardColumnNames, getClipboardRows, translateDataGrid]);
  
    const handleCopyQueryResultJson = useCallback(() => {
        const rows = getClipboardRows();
        const text = buildClipboardJson(rows);
        if (!text) {
            void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
            return;
        }
        copyToClipboard(text);
    }, [copyToClipboard, getClipboardRows, translateDataGrid]);
  
    const handleCopyQueryResultMarkdown = useCallback(() => {
        const rows = getClipboardRows();
        const columns = getClipboardColumnNames(rows);
        const text = buildClipboardMarkdown(rows, columns);
        if (!text) {
            void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
            return;
        }
        copyToClipboard(text);
    }, [copyToClipboard, getClipboardColumnNames, getClipboardRows, translateDataGrid]);
  
    const handleCopyDdl = useCallback(() => {
        if (!ddlText.trim()) {
            void message.info(translateDataGrid('data_grid.message.no_ddl_to_copy'));
            return;
        }
        navigator.clipboard.writeText(ddlText)
            .then(() => message.success(translateDataGrid('data_grid.message.ddl_copied')))
            .catch(() => message.error(translateDataGrid('data_grid.message.ddl_copy_failed')));
    }, [ddlText, translateDataGrid]);
  
    const buildSelectedCellsClipboardPayload = useCallback((): DataGridClipboardPayload | null => {
        const activeSelection = currentSelectionRef.current.size > 0 ? currentSelectionRef.current : selectedCells;
        if (activeSelection.size === 0) {
            void message.info(translateDataGrid('data_grid.message.drag_select_cells_to_copy'));
            return null;
        }
  
        const parsed = Array.from(activeSelection)
            .map((cellKey) => splitCellKey(cellKey))
            .filter((item): item is { rowKey: string; colName: string } => !!item);
        if (parsed.length === 0) {
            void message.info(translateDataGrid('data_grid.message.no_copyable_cells'));
            return null;
        }
  
        const payload = buildSelectedCellClipboardPayload({
            selectedCells: parsed,
            rows: mergedDisplayData as Array<Record<string, any>>,
            columnOrder: displayColumnNames,
            rowKeyField: GONAVI_ROW_KEY,
        });
        if (!payload.plainText) {
            void message.info(translateDataGrid('data_grid.message.selection_no_copyable_content'));
            return null;
        }
  
        return payload;
    }, [
        GONAVI_ROW_KEY,
        buildSelectedCellClipboardPayload,
        currentSelectionRef,
        displayColumnNames,
        mergedDisplayData,
        selectedCells,
        splitCellKey,
        translateDataGrid,
    ]);
  
    const handleCopySelectedCellsToClipboard = useCallback(() => {
        const payload = buildSelectedCellsClipboardPayload();
        if (!payload) return;
        copyToClipboard(payload);
    }, [buildSelectedCellsClipboardPayload, copyToClipboard]);
  
    useEffect(() => {
        if (!isActive || !isTableSurfaceActive || (!cellEditMode && selectedCells.size === 0)) return;
  
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            const activeElement = document.activeElement as HTMLElement | null;
            const eventTarget = event.target instanceof HTMLElement ? event.target : null;
            const nativeShortcutGuard = 'input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover, [data-gonavi-close-shortcut-guard]';
            if (activeElement?.closest(nativeShortcutGuard) || eventTarget?.closest(nativeShortcutGuard)) {
                return;
            }
  
            if (event.key === 'Escape') {
                const activeSelection = currentSelectionRef.current.size > 0 ? currentSelectionRef.current : selectedCells;
                if (activeSelection.size === 0) {
                    if (cellEditMode) {
                        event.preventDefault();
                        closeCellEditMode();
                    }
                    return;
                }
                event.preventDefault();
                resetCellSelection();
                return;
            }
  
        };
  
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [cellEditMode, selectedCells, resetCellSelection, closeCellEditMode, isActive, isTableSurfaceActive]);
  
    useEffect(() => {
        if (!isActive || !isTableSurfaceActive || selectedCells.size === 0) return;
  
        const onCopy = (event: ClipboardEvent) => {
            if (event.defaultPrevented) return;
            const activeElement = document.activeElement as HTMLElement | null;
            const eventTarget = event.target instanceof HTMLElement ? event.target : null;
            const nativeShortcutGuard = 'input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover, [data-gonavi-close-shortcut-guard]';
            if (activeElement?.closest(nativeShortcutGuard) || eventTarget?.closest(nativeShortcutGuard)) return;
            if (document.getSelection?.()?.toString()) return;
  
            const payload = buildSelectedCellsClipboardPayload();
            if (!payload) return;
            if (writeClipboardPayloadToEvent(event, payload)) {
                void message.success(translateDataGrid('data_grid.message.copied_to_clipboard'));
                return;
            }
            copyToClipboard(payload);
        };
  
        window.addEventListener('copy', onCopy);
        return () => window.removeEventListener('copy', onCopy);
    }, [buildSelectedCellsClipboardPayload, copyToClipboard, isActive, isTableSurfaceActive, selectedCells.size, translateDataGrid]);
  
    useEffect(() => {
        if (!isActive || !isTableSurfaceActive || (!cellEditMode && selectedCells.size === 0)) return;
  
        const onPointerDown = (event: MouseEvent) => {
            const root = rootRef.current;
            const target = event.target instanceof Node ? event.target : null;
            if (!root || !target || root.contains(target)) return;
            if (target instanceof HTMLElement
                && target.closest('.ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover')) {
                return;
            }
            if (cellEditMode) {
                closeCellEditMode();
            } else {
                resetCellSelection();
            }
        };
  
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [cellEditMode, closeCellEditMode, isActive, isTableSurfaceActive, resetCellSelection, selectedCells.size]);
  
    const getTargets = useCallback((clickedRecord: any) => {
        const selKeys = selectedRowKeysRef.current;
        const currentData = displayDataRef.current;
        const clickedKey = clickedRecord?.[GONAVI_ROW_KEY];
        if (clickedKey !== undefined && selKeys.includes(clickedKey)) {
            return currentData.filter((d: any) => selKeys.includes(d?.[GONAVI_ROW_KEY]));
        }
        return [clickedRecord];
    }, []);
  
    const getContextMenuTargetRows = useCallback((clickedRecord: any) => {
        if (!clickedRecord) return [];
        const selKeys = selectedRowKeysRef.current;
        const clickedKey = clickedRecord?.[GONAVI_ROW_KEY];
        const clickedKeyStr = clickedKey === undefined || clickedKey === null ? '' : rowKeyStr(clickedKey);
        const selectedKeyStrSet = new Set(selKeys.map(rowKeyStr));
        if (clickedKeyStr && selectedKeyStrSet.has(clickedKeyStr)) {
            return mergedDisplayData.filter((row: any) => {
                const rowKey = row?.[GONAVI_ROW_KEY];
                return rowKey !== undefined && rowKey !== null && selectedKeyStrSet.has(rowKeyStr(rowKey));
            });
        }
        return [clickedRecord];
    }, [mergedDisplayData, rowKeyStr]);
  
    const translateCopySqlError = useCallback((error: CopySqlError): string => {
        if (typeof error === 'string') {
            return error;
        }
        switch (error.key) {
            case 'data_grid.copy_sql.error.missing_table_name':
                return translateDataGrid('data_grid.copy_sql.error.missing_table_name', error.params);
            case 'data_grid.copy_sql.error.no_copyable_fields':
                return translateDataGrid('data_grid.copy_sql.error.no_copyable_fields');
            case 'data_grid.copy_sql.error.missing_safe_where':
            default:
                return translateDataGrid('data_grid.copy_sql.error.missing_safe_where');
        }
    }, [translateDataGrid]);
  return {
    handleV2ColumnHeaderContextMenuAction, getClipboardColumnNames, handleCopyQueryResultCsv,
    handleCopyQueryResultJson, handleCopyQueryResultMarkdown, handleCopyDdl,
    handleCopySelectedCellsToClipboard, getTargets, getContextMenuTargetRows, translateCopySqlError,
  };
};

export type DataGridV2ColumnActionsApi = ReturnType<typeof useDataGridV2ColumnActions>;
