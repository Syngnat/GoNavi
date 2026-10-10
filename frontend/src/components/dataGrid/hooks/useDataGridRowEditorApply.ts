import { useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import { message } from 'antd';
import { GONAVI_ROW_KEY, isCellValueEqualForDiff } from '../../DataGridCore';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import { omitTruncatedPatchEntries } from '../../../utils/dataGridTruncatedValue';
import { getTemporalPickerType, resolveTemporalEditorSaveValue } from '../../dataGridTemporal';
import type { UseDataGridColumnsInput } from './useDataGridColumns';

type RowEditorApplyInput = Pick<UseDataGridColumnsInput,
    | 'rowEditorRowKey' | 'rowEditorForm' | 'rowEditorBaseRawRef' | 'closeRowEditor'
    | 'addedRows' | 'setAddedRows' | 'rowKeyStr' | 'effectiveEditLocator' | 'columnMetaMap'
    | 'columnMetaMapByLowerName' | 'dbType' | 'currentConnConfig' | 'normalizeMongoEditedCellValue'
    | 'visibleColumnNames' | 'setModifiedRows' | 'translateDataGrid' | 'canModifyData'
>;

export const useDataGridRowEditorApply = (input: RowEditorApplyInput) => {
    const runtimeRef = useRef(input);
    runtimeRef.current = input;
    return useCallback(() => {
        const {
            canModifyData, rowEditorRowKey, rowEditorForm, rowEditorBaseRawRef,
            addedRows, setAddedRows, rowKeyStr, effectiveEditLocator, columnMetaMap,
            columnMetaMapByLowerName, dbType, currentConnConfig, normalizeMongoEditedCellValue,
            visibleColumnNames, setModifiedRows, translateDataGrid, closeRowEditor,
        } = runtimeRef.current;
        if (!canModifyData || !rowEditorRowKey) return;
        const keyStr = rowEditorRowKey;
        const values: Record<string, unknown> = rowEditorForm.getFieldsValue(true) || {};
        const baseRawMap = rowEditorBaseRawRef.current || {};
        const normalizeValue = (column: string, value: unknown): unknown => {
            const baseValue = baseRawMap[column];
            if (dayjs.isDayjs(value)) {
                const meta = columnMetaMap[column] || columnMetaMapByLowerName[column.toLowerCase()];
                return resolveTemporalEditorSaveValue(
                    undefined, value, getTemporalPickerType(meta?.type, dbType, currentConnConfig), baseValue,
                );
            }
            return normalizeMongoEditedCellValue(column, value, baseValue);
        };
        if (addedRows.some(row => rowKeyStr(row?.[GONAVI_ROW_KEY]) === keyStr)) {
            const convertedValues: Record<string, unknown> = {};
            Object.entries(values).forEach(([column, value]) => {
                if (isWritableResultColumn(column, effectiveEditLocator)) {
                    convertedValues[column] = normalizeValue(column, value);
                }
            });
            setAddedRows(prev => prev.map(row => (
                rowKeyStr(row?.[GONAVI_ROW_KEY]) === keyStr ? { ...row, ...convertedValues } : row
            )));
            closeRowEditor();
            return;
        }
        const builtPatch: Record<string, unknown> = {};
        visibleColumnNames.forEach(column => {
            if (!isWritableResultColumn(column, effectiveEditLocator)) return;
            const value = normalizeValue(column, values[column]);
            if (!isCellValueEqualForDiff(baseRawMap[column], value)) builtPatch[column] = value;
        });
        // Row edits bypass cell saving; truncated baseline values must remain unwritable.
        const { patch, skippedColumns } = omitTruncatedPatchEntries(builtPatch, baseRawMap);
        setModifiedRows(prev => {
            const next = { ...prev };
            if (Object.keys(patch).length === 0) delete next[keyStr];
            else next[keyStr] = patch;
            return next;
        });
        if (skippedColumns.length > 0) {
            void message.warning(translateDataGrid('data_grid.message.truncated_cells_skipped', { count: skippedColumns.length }));
        }
        closeRowEditor();
    }, []);
};
