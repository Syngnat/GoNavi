import { useCallback, useMemo, useEffect } from 'react';
import dayjs from 'dayjs';
import { message } from 'antd';
import {
    type VirtualEditingCellState,
    getCellFieldName,
    isCellValueEqualForDiff,
    formatCellDisplayText,
    GONAVI_ROW_KEY,
    attachDataGridVirtualEditRenderVersion,
    normalizeValueForJsonView,
    normalizeBitHexDisplayText,
    normalizeDateTimeString,
    isPlainObject,
    isJsonViewValueEqual,
    coerceJsonEditorValueForStorage,
} from '../../DataGridCore';
import {
    getTemporalPickerType,
    resolveTemporalEditorSaveValue,
    isTemporalPickerPopupFocused,
    TEMPORAL_PICKER_INTERACTION_DELAY_MS,
    parseToDayjs,
} from '../../dataGridTemporal';
import {
    collectDataGridFindResult,
    attachDataGridFindRenderVersion,
} from '../../../utils/dataGridFind';
import { attachDataGridDisplayRenderVersion } from '../../dataGridDisplayRenderVersion';
import { pickDataGridOutputRows } from '../../dataGridOutput';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridCellEditingApi } from './useDataGridCellEditing';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';

export interface UseDataGridRowEditorsInput {
    isVirtualEditingSessionCurrent: DataGridCellEditorStateApi['isVirtualEditingSessionCurrent'];
    virtualInlinePickerSaveSessionRef: DataGridCellEditorStateApi['virtualInlinePickerSaveSessionRef'];
    cancelVirtualInlinePickerInteraction: DataGridTableMetricsApi['cancelVirtualInlinePickerInteraction'];
    virtualInlinePickerPendingValueRef: DataGridCellEditorStateApi['virtualInlinePickerPendingValueRef'];
    mergedDisplayDataByRowKeyRef: DataGridInlineEditorApi['mergedDisplayDataByRowKeyRef'];
    closeVirtualInlineEditor: DataGridTableMetricsApi['closeVirtualInlineEditor'];
    dbType: DataGridCoreStateApi['dbType'];
    currentConnConfig: DataGridCoreStateApi['currentConnConfig'];
    form: DataGridCoreStateApi['form'];
    handleCellSaveRef: DataGridCellEditingApi['handleCellSaveRef'];
    virtualInlinePickerInteractionTimerRef: DataGridCellEditorStateApi['virtualInlinePickerInteractionTimerRef'];
    virtualInlinePickerInteractionTokenRef: DataGridCellEditorStateApi['virtualInlinePickerInteractionTokenRef'];
    virtualInlinePickerOpenRef: DataGridCellEditorStateApi['virtualInlinePickerOpenRef'];
    virtualInlinePickerCommitSessionRef: DataGridCellEditorStateApi['virtualInlinePickerCommitSessionRef'];
    mergedDisplayData: DataGridInlineEditorApi['mergedDisplayData'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    normalizedPageFindText: DataGridCoreStateApi['normalizedPageFindText'];
    columnMetaMap: DataGridTableMetricsApi['columnMetaMap'];
    columnMetaMapByLowerName: DataGridTableMetricsApi['columnMetaMapByLowerName'];
    setActivePageFindMatchIndex: DataGridCoreStateApi['setActivePageFindMatchIndex'];
    markCellSelectionUserSelection: DataGridColumnTitlesApi['markCellSelectionUserSelection'];
    setSelectedCells: DataGridCellEditorStateApi['setSelectedCells'];
    currentSelectionRef: DataGridCellEditorStateApi['currentSelectionRef'];
    selectionStartRef: DataGridCellEditorStateApi['selectionStartRef'];
    cellSelectionAnchorSourceRef: DataGridCellEditorStateApi['cellSelectionAnchorSourceRef'];
    updateCellSelection: DataGridColumnTitlesApi['updateCellSelection'];
    activePageFindMatchIndex: DataGridCoreStateApi['activePageFindMatchIndex'];
    theme: DataGridCoreStateApi['theme'];
    dataTableDensity: DataGridCoreStateApi['dataTableDensity'];
    effectiveUiScale: DataGridCoreStateApi['effectiveUiScale'];
    virtualEditingCellForRender: DataGridCellEditorStateApi['virtualEditingCellForRender'];
    setTextRecordIndex: DataGridCoreStateApi['setTextRecordIndex'];
    viewMode: DataGridColumnTitlesApi['viewMode'];
    displayOutputColumnNames: DataGridCoreStateApi['displayOutputColumnNames'];
    textRecordIndex: DataGridCoreStateApi['textRecordIndex'];
    canModifyData: DataGridCoreStateApi['canModifyData'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    baseData: DataGridColumnTitlesApi['baseData'];
    addedRows: DataGridTableMetricsApi['addedRows'];
    visibleColumnNames: DataGridCoreStateApi['visibleColumnNames'];
    mongoAwareFormText: DataGridCoreStateApi['mongoAwareFormText'];
    openRowEditor: DataGridCellEditorStateApi['openRowEditor'];
    openJsonEditor: DataGridCellEditorStateApi['openJsonEditor'];
    cellContextMenu: DataGridCellEditorStateApi['cellContextMenu'];
    setCellContextMenu: DataGridCellEditorStateApi['setCellContextMenu'];
    jsonEditorValue: DataGridCellEditorStateApi['jsonEditorValue'];
    setJsonEditorValue: DataGridCellEditorStateApi['setJsonEditorValue'];
    closeJsonEditor: DataGridCellEditorStateApi['closeJsonEditor'];
    setAddedRows: DataGridTableMetricsApi['setAddedRows'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    setModifiedRows: DataGridTableMetricsApi['setModifiedRows'];
    rowEditorForm: DataGridCellEditorStateApi['rowEditorForm'];
    openCellEditor: DataGridCellEditorStateApi['openCellEditor'];
}

export const useDataGridRowEditors = ({
    isVirtualEditingSessionCurrent, virtualInlinePickerSaveSessionRef,
    cancelVirtualInlinePickerInteraction, virtualInlinePickerPendingValueRef,
    mergedDisplayDataByRowKeyRef, closeVirtualInlineEditor, dbType, currentConnConfig, form,
    handleCellSaveRef, virtualInlinePickerInteractionTimerRef,
    virtualInlinePickerInteractionTokenRef, virtualInlinePickerOpenRef,
    virtualInlinePickerCommitSessionRef, mergedDisplayData, displayColumnNames,
    normalizedPageFindText, columnMetaMap, columnMetaMapByLowerName, setActivePageFindMatchIndex,
    markCellSelectionUserSelection, setSelectedCells, currentSelectionRef, selectionStartRef,
    cellSelectionAnchorSourceRef, updateCellSelection, activePageFindMatchIndex, theme,
    dataTableDensity, effectiveUiScale, virtualEditingCellForRender, setTextRecordIndex, viewMode,
    displayOutputColumnNames, textRecordIndex, canModifyData, translateDataGrid, rowKeyStr,
    baseData, addedRows, visibleColumnNames, mongoAwareFormText, openRowEditor, openJsonEditor,
    cellContextMenu, setCellContextMenu, jsonEditorValue, setJsonEditorValue, closeJsonEditor,
    setAddedRows, effectiveEditLocator, setModifiedRows, rowEditorForm, openCellEditor,
}: UseDataGridRowEditorsInput) => {
    const saveVirtualInlineEditor = useCallback(async (
        editingCell: VirtualEditingCellState,
        pickerValue?: dayjs.Dayjs | null,
    ) => {
        if (!isVirtualEditingSessionCurrent(editingCell)) return;
        if (virtualInlinePickerSaveSessionRef.current === editingCell.sessionId) return;
        virtualInlinePickerSaveSessionRef.current = editingCell.sessionId;
        cancelVirtualInlinePickerInteraction();
        virtualInlinePickerPendingValueRef.current = undefined;

        const record = mergedDisplayDataByRowKeyRef.current.get(editingCell.rowKey);
        if (!record) {
            closeVirtualInlineEditor(editingCell.sessionId);
            return;
        }

        const pickerType = getTemporalPickerType(editingCell.columnType, dbType, currentConnConfig);
        const isDateTimeField = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(record?.[editingCell.dataIndex] || '')));
        const fieldName = getCellFieldName(record, editingCell.dataIndex);
        try {
            await form.validateFields([fieldName]);
            if (!isVirtualEditingSessionCurrent(editingCell)) return;
            const currentRecord = mergedDisplayDataByRowKeyRef.current.get(editingCell.rowKey);
            if (!currentRecord) {
                closeVirtualInlineEditor(editingCell.sessionId);
                return;
            }
            let nextValue = form.getFieldValue(fieldName);
            if (isDateTimeField) {
                nextValue = resolveTemporalEditorSaveValue(nextValue, pickerValue, pickerType, currentRecord?.[editingCell.dataIndex]);
            }
            closeVirtualInlineEditor(editingCell.sessionId);
            if (!isCellValueEqualForDiff(currentRecord?.[editingCell.dataIndex], nextValue)) {
                handleCellSaveRef.current({ ...currentRecord, [editingCell.dataIndex]: nextValue });
            }
        } catch (errInfo) {
            if (!isVirtualEditingSessionCurrent(editingCell)) return;
            console.log('Virtual inline save failed:', errInfo);
            if (isDateTimeField) {
                closeVirtualInlineEditor(editingCell.sessionId);
            }
        } finally {
            if (virtualInlinePickerSaveSessionRef.current === editingCell.sessionId) {
                virtualInlinePickerSaveSessionRef.current = null;
            }
        }
    }, [cancelVirtualInlinePickerInteraction, closeVirtualInlineEditor, currentConnConfig, dbType, form, isVirtualEditingSessionCurrent]);

    const scheduleVirtualInlinePickerInteraction = useCallback((
        editingCell: VirtualEditingCellState,
        action: 'save' | 'close',
        pickerValue?: dayjs.Dayjs | null,
        relatedTarget?: EventTarget | null,
    ) => {
        if (!isVirtualEditingSessionCurrent(editingCell)) return;
        if (virtualInlinePickerInteractionTimerRef.current !== null) {
            clearTimeout(virtualInlinePickerInteractionTimerRef.current);
        }
        const token = ++virtualInlinePickerInteractionTokenRef.current;
        const sessionId = editingCell.sessionId;
        virtualInlinePickerInteractionTimerRef.current = setTimeout(() => {
            virtualInlinePickerInteractionTimerRef.current = null;
            if (
                token !== virtualInlinePickerInteractionTokenRef.current
                || !isVirtualEditingSessionCurrent(editingCell)
                || virtualInlinePickerOpenRef.current
                || virtualInlinePickerCommitSessionRef.current === sessionId
                || isTemporalPickerPopupFocused(relatedTarget)
            ) {
                return;
            }
            if (action === 'save') {
                const value = pickerValue !== undefined
                    ? pickerValue
                    : virtualInlinePickerPendingValueRef.current;
                virtualInlinePickerPendingValueRef.current = undefined;
                void saveVirtualInlineEditor(editingCell, value);
                return;
            }
            closeVirtualInlineEditor(sessionId);
        }, TEMPORAL_PICKER_INTERACTION_DELAY_MS);
    }, [closeVirtualInlineEditor, isVirtualEditingSessionCurrent, saveVirtualInlineEditor]);

    const commitVirtualInlinePickerValue = useCallback((
        editingCell: VirtualEditingCellState,
        pickerValue?: dayjs.Dayjs | null,
    ) => {
        if (!isVirtualEditingSessionCurrent(editingCell)) return;
        const sessionId = editingCell.sessionId;
        virtualInlinePickerCommitSessionRef.current = sessionId;
        cancelVirtualInlinePickerInteraction();
        virtualInlinePickerPendingValueRef.current = undefined;
        void saveVirtualInlineEditor(editingCell, pickerValue).finally(() => {
            if (virtualInlinePickerCommitSessionRef.current === sessionId) {
                virtualInlinePickerCommitSessionRef.current = null;
            }
        });
    }, [cancelVirtualInlinePickerInteraction, isVirtualEditingSessionCurrent, saveVirtualInlineEditor]);

    const pageFindResult = useMemo(() => collectDataGridFindResult(
        mergedDisplayData,
        displayColumnNames,
        normalizedPageFindText,
        (value, _row, columnName) => formatCellDisplayText(
            value,
            (columnMetaMap[columnName] || columnMetaMapByLowerName[columnName.toLowerCase()])?.type,
            currentConnConfig,
        ),
        (row, rowIndex) => String(row?.[GONAVI_ROW_KEY] ?? `row-${rowIndex}`),
    ), [mergedDisplayData, displayColumnNames, normalizedPageFindText, columnMetaMap, columnMetaMapByLowerName, currentConnConfig]);
    const pageFindMatches = pageFindResult.matches;
    const pageFindSummary = pageFindResult.summary;

    useEffect(() => {
        setActivePageFindMatchIndex(-1);
    }, [normalizedPageFindText, mergedDisplayData, displayColumnNames]);

    useEffect(() => {
        if (normalizedPageFindText) return;
        const emptySelection = new Set<string>();
        markCellSelectionUserSelection(false);
        setSelectedCells(emptySelection);
        currentSelectionRef.current = emptySelection;
        selectionStartRef.current = null;
        cellSelectionAnchorSourceRef.current = null;
        updateCellSelection(emptySelection);
    }, [markCellSelectionUserSelection, normalizedPageFindText, updateCellSelection]);

    const activePageFindPosition = activePageFindMatchIndex >= 0 && activePageFindMatchIndex < pageFindMatches.length
        ? activePageFindMatchIndex + 1
        : 0;

    const displayRenderVersion = useMemo(() => (
        `v2|${theme}|${dataTableDensity}|${effectiveUiScale}`
    ), [dataTableDensity, effectiveUiScale, theme]);

    const tableRenderData = useMemo(
        () => attachDataGridVirtualEditRenderVersion(
            attachDataGridFindRenderVersion(
                attachDataGridDisplayRenderVersion(mergedDisplayData, displayRenderVersion),
                normalizedPageFindText,
            ),
            virtualEditingCellForRender,
        ),
        [displayRenderVersion, mergedDisplayData, normalizedPageFindText, virtualEditingCellForRender]
    );

    useEffect(() => {
        setTextRecordIndex(prev => {
            if (mergedDisplayData.length === 0) return 0;
            return Math.min(prev, mergedDisplayData.length - 1);
        });
    }, [mergedDisplayData.length]);

    const jsonViewText = useMemo(() => {
        if (viewMode !== 'json') return '';
        const cleanRows = pickDataGridOutputRows(mergedDisplayData, displayOutputColumnNames)
            .map((row) => normalizeValueForJsonView(row));
        return JSON.stringify(cleanRows, null, 2);
    }, [viewMode, mergedDisplayData, displayOutputColumnNames]);

    const textViewRows = useMemo(() => {
        if (viewMode !== 'text') return [];
        return pickDataGridOutputRows(mergedDisplayData, displayOutputColumnNames);
    }, [viewMode, mergedDisplayData, displayOutputColumnNames]);

    const currentTextRow = useMemo(() => {
        if (viewMode !== 'text') return null;
        if (textViewRows.length === 0) return null;
        return textViewRows[textRecordIndex] || null;
    }, [viewMode, textViewRows, textRecordIndex]);

    const formatTextViewValue = useCallback((val: any, columnName?: string): string => {
        const columnType = columnName
            ? (columnMetaMap[columnName] || columnMetaMapByLowerName[columnName.toLowerCase()])?.type
            : undefined;
        const bitText = normalizeBitHexDisplayText(val, columnType);
        if (bitText !== null) return bitText;
        if (val === null) return 'NULL';
        if (val === undefined) return '';
        if (typeof val === 'string') return normalizeDateTimeString(val);
        if (typeof val === 'object') {
            try {
                return JSON.stringify(val, null, 2);
            } catch {
                return String(val);
            }
        }
        return String(val);
    }, [columnMetaMap, columnMetaMapByLowerName]);

    const openRowEditorByKey = useCallback((keyStr?: string) => {
        if (!canModifyData) return;
        if (!keyStr) {
            void message.info(translateDataGrid('data_grid.message.locate_record_to_edit'));
            return;
        }
        const displayRow = mergedDisplayData.find(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr);
        if (!displayRow) {
            void message.error(translateDataGrid('data_grid.message.target_row_not_found'));
            return;
        }

        const baseRow =
            baseData.find(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr) ||
            addedRows.find(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr) ||
            displayRow;

        const baseRawMap: Record<string, any> = {};
        const displayMap: Record<string, string> = {};
        const formMap: Record<string, any> = {};
        const nullCols = new Set<string>();

        visibleColumnNames.forEach((col) => {
            const baseVal = (baseRow as any)?.[col];
            const displayVal = (displayRow as any)?.[col];
            baseRawMap[col] = baseVal;
            displayMap[col] = mongoAwareFormText(displayVal, col);
            // 日期时间类型: 将字符串值转为 dayjs 对象供 DatePicker 使用
            const colMeta = columnMetaMap[col] || columnMetaMapByLowerName[col.toLowerCase()];
            const rowPickerType = getTemporalPickerType(colMeta?.type, dbType, currentConnConfig);
            if (rowPickerType && displayVal !== null && displayVal !== undefined) {
                const dVal = parseToDayjs(displayVal, rowPickerType);
                formMap[col] = dVal;
            } else {
                formMap[col] = displayVal === null || displayVal === undefined ? undefined : mongoAwareFormText(displayVal, col);
            }
            if (baseVal === null || baseVal === undefined) nullCols.add(col);
        });

        openRowEditor({
            rowKey: keyStr,
            baseRawMap,
            displayMap,
            nullCols,
            formValues: formMap,
        });
    }, [addedRows, baseData, canModifyData, columnMetaMap, columnMetaMapByLowerName, currentConnConfig, dbType, mergedDisplayData, mongoAwareFormText, openRowEditor, rowKeyStr, translateDataGrid, visibleColumnNames]);

    const openCurrentViewRowEditor = useCallback(() => {
        if (!canModifyData) return;
        const currentRow = mergedDisplayData[textRecordIndex];
        const rowKey = currentRow?.[GONAVI_ROW_KEY];
        if (rowKey === undefined || rowKey === null) {
            void message.info(translateDataGrid('data_grid.message.current_record_not_editable'));
            return;
        }
        openRowEditorByKey(rowKeyStr(rowKey));
    }, [canModifyData, mergedDisplayData, textRecordIndex, rowKeyStr, openRowEditorByKey, translateDataGrid]);

    const handleOpenJsonEditor = useCallback(() => {
        if (!canModifyData) return;
        openJsonEditor(jsonViewText);
    }, [canModifyData, jsonViewText, openJsonEditor]);

    const handleOpenContextMenuRowEditor = useCallback(() => {
        if (!canModifyData) return;
        const rowKey = cellContextMenu.record?.[GONAVI_ROW_KEY];
        if (rowKey === undefined || rowKey === null) return;
        openRowEditorByKey(rowKeyStr(rowKey));
        setCellContextMenu(prev => ({ ...prev, visible: false }));
    }, [canModifyData, cellContextMenu.record, openRowEditorByKey, rowKeyStr]);

    const handleFormatJsonEditor = useCallback(() => {
        try {
            const parsed = JSON.parse(jsonEditorValue);
            setJsonEditorValue(JSON.stringify(parsed, null, 2));
        } catch (e: any) {
            const rawErrorMessage = e?.message || String(e);
            void message.error(translateDataGrid('data_grid.json_editor.invalid_format', { error: rawErrorMessage }));
        }
    }, [jsonEditorValue, translateDataGrid]);

    const applyJsonEditor = useCallback(() => {
        if (!canModifyData) return;
        let parsed: any;
        try {
            parsed = JSON.parse(jsonEditorValue);
        } catch (e: any) {
            const rawErrorMessage = e?.message || String(e);
            void message.error(translateDataGrid('data_grid.message.json_parse_failed', { detail: rawErrorMessage }));
            return;
        }

        if (!Array.isArray(parsed)) {
            void message.error(translateDataGrid('data_grid.message.json_view_must_be_array'));
            return;
        }
        if (parsed.length !== mergedDisplayData.length) {
            void message.error(translateDataGrid('data_grid.message.json_record_count_mismatch', { current: mergedDisplayData.length, json: parsed.length }));
            return;
        }

        const addedKeySet = new Set<string>();
        addedRows.forEach((r) => {
            const key = r?.[GONAVI_ROW_KEY];
            if (key === undefined) return;
            addedKeySet.add(rowKeyStr(key));
        });

        const originalMap = new Map<string, any>();
        baseData.forEach((r) => {
            const key = r?.[GONAVI_ROW_KEY];
            if (key === undefined) return;
            originalMap.set(rowKeyStr(key), r);
        });

        const addedPatchMap = new Map<string, Record<string, any>>();
        const updatePatchMap = new Map<string, Record<string, any>>();

        for (let idx = 0; idx < parsed.length; idx += 1) {
            const nextItem = parsed[idx];
            if (!isPlainObject(nextItem)) {
                void message.error(translateDataGrid('data_grid.message.json_record_not_object', { index: idx + 1 }));
                return;
            }

            const currentRow = mergedDisplayData[idx];
            const rowKey = currentRow?.[GONAVI_ROW_KEY];
            if (rowKey === undefined || rowKey === null) {
                void message.error(translateDataGrid('data_grid.message.json_record_missing_row_key', { index: idx + 1 }));
                return;
            }
            const keyStr = rowKeyStr(rowKey);
            const normalizedNext: Record<string, any> = {};
            let hasAnyWritableChange = false;
            visibleColumnNames.forEach((col) => {
                if (!isWritableResultColumn(col, effectiveEditLocator)) return;
                const currentVal = (currentRow as any)?.[col];
                const editedVal = Object.prototype.hasOwnProperty.call(nextItem, col) ? (nextItem as any)[col] : currentVal;
                if (!isJsonViewValueEqual(currentVal, editedVal)) hasAnyWritableChange = true;
                normalizedNext[col] = coerceJsonEditorValueForStorage(currentVal, editedVal);
            });

            if (!hasAnyWritableChange) {
                continue;
            }

            if (addedKeySet.has(keyStr)) {
                addedPatchMap.set(keyStr, normalizedNext);
                continue;
            }

            const originalRow = originalMap.get(keyStr);
            if (!originalRow) continue;
            const patch: Record<string, any> = {};
            visibleColumnNames.forEach((col) => {
                if (!isWritableResultColumn(col, effectiveEditLocator)) return;
                const prevVal = (originalRow as any)?.[col];
                const nextVal = normalizedNext[col];
                if (!isCellValueEqualForDiff(prevVal, nextVal)) patch[col] = nextVal;
            });
            updatePatchMap.set(keyStr, patch);
        }

        setAddedRows((prev) => prev.map((row) => {
            const key = row?.[GONAVI_ROW_KEY];
            if (key === undefined) return row;
            const patch = addedPatchMap.get(rowKeyStr(key));
            if (!patch) return row;
            return { ...row, ...patch };
        }));

        setModifiedRows((prev) => {
            const next = { ...prev };
            updatePatchMap.forEach((patch, keyStr) => {
                if (Object.keys(patch).length === 0) delete next[keyStr];
                else next[keyStr] = patch;
            });
            return next;
        });

        closeJsonEditor();
        void message.success(translateDataGrid('data_grid.message.json_applied'));
    }, [canModifyData, jsonEditorValue, mergedDisplayData, addedRows, rowKeyStr, baseData, visibleColumnNames, effectiveEditLocator, closeJsonEditor, translateDataGrid]);

    const openRowEditorFieldEditor = useCallback((dataIndex: string) => {
        if (!dataIndex) return;
        if (!isWritableResultColumn(dataIndex, effectiveEditLocator)) {
            void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
            return;
        }
        const val = rowEditorForm.getFieldValue(dataIndex);
        openCellEditor(
            { [dataIndex]: val ?? '' },
            dataIndex,
            dataIndex,
            (nextVal) => rowEditorForm.setFieldsValue({ [dataIndex]: nextVal }),
        );
    }, [rowEditorForm, openCellEditor, effectiveEditLocator, translateDataGrid]);
    return {
        saveVirtualInlineEditor, scheduleVirtualInlinePickerInteraction,
        commitVirtualInlinePickerValue, pageFindMatches, pageFindSummary, activePageFindPosition,
        tableRenderData, jsonViewText, textViewRows, currentTextRow, formatTextViewValue,
        openCurrentViewRowEditor, handleOpenJsonEditor, handleOpenContextMenuRowEditor,
        handleFormatJsonEditor, applyJsonEditor, openRowEditorFieldEditor,
    };
};

export type DataGridRowEditorsApi = ReturnType<typeof useDataGridRowEditors>;
