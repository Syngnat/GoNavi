import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import type { ColumnType, SortOrder } from 'antd/es/table/interface';
import { Form, TimePicker, DatePicker, Input } from 'antd';
import {
    GONAVI_ROW_KEY,
    isCellValueEqualForDiff,
    renderCellDisplayValue,
    CELL_ELLIPSIS_STYLE,
    type Item,
    hasDataGridVirtualEditRenderVersionChanged,
    isCellValueEqualForRender,
    VIRTUAL_EDITING_CELL_STYLE,
    INLINE_EDIT_FORM_ITEM_STYLE,
    getCellFieldName,
    setCellFieldValue,
    GONAVI_ROW_NUMBER_COLUMN_KEY,
    ROW_NUMBER_COLUMN_WIDTH,
} from '../../DataGridCore';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import {
    getTemporalPickerType,
    resolveTemporalEditorSaveValue,
    TEMPORAL_FORMATS,
    getTemporalPickerFormat,
} from '../../dataGridTemporal';
import { resolveDataTableColumnWidth } from '../../../utils/dataGridDisplay';
import { hasDataGridDisplayRenderVersionChanged } from '../../dataGridDisplayRenderVersion';
import { hasDataGridFindRenderVersionChanged } from '../../../utils/dataGridFind';
import {
    hasDataGridColumnOrderDragPayload,
    decodeDataGridColumnOrderDragPayload,
    DATA_GRID_COLUMN_ORDER_DRAG_MIME,
} from '../../dataGridColumnOrder';
import { noAutoCapInputProps } from '../../../utils/inputAutoCap';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridCellEditingApi } from './useDataGridCellEditing';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridRowEditorsApi } from './useDataGridRowEditors';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridColumnsInput {
    rowEditorRowKey: DataGridCellEditorStateApi['rowEditorRowKey'];
    rowEditorForm: DataGridCellEditorStateApi['rowEditorForm'];
    rowEditorBaseRawRef: DataGridCellEditorStateApi['rowEditorBaseRawRef'];
    closeRowEditor: DataGridCellEditorStateApi['closeRowEditor'];
    addedRows: DataGridTableMetricsApi['addedRows'];
    setAddedRows: DataGridTableMetricsApi['setAddedRows'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    columnMetaMap: DataGridTableMetricsApi['columnMetaMap'];
    columnMetaMapByLowerName: DataGridTableMetricsApi['columnMetaMapByLowerName'];
    dbType: DataGridCoreStateApi['dbType'];
    currentConnConfig: DataGridCoreStateApi['currentConnConfig'];
    normalizeMongoEditedCellValue: DataGridCoreStateApi['normalizeMongoEditedCellValue'];
    visibleColumnNames: DataGridCoreStateApi['visibleColumnNames'];
    setModifiedRows: DataGridTableMetricsApi['setModifiedRows'];
    isTableSurfaceActive: DataGridColumnTitlesApi['isTableSurfaceActive'];
    canModifyData: DataGridCoreStateApi['canModifyData'];
    virtualEditingCellForRender: DataGridCellEditorStateApi['virtualEditingCellForRender'];
    virtualInlineInputRef: DataGridCellEditorStateApi['virtualInlineInputRef'];
    onSort: DataGridProps['onSort'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    renderColumnTitle: DataGridColumnTitlesApi['renderColumnTitle'];
    columnWidths: DataGridCellEditorStateApi['columnWidths'];
    dataTableDensity: DataGridCoreStateApi['dataTableDensity'];
    pinnedLeftColumnSet: DataGridCoreStateApi['pinnedLeftColumnSet'];
    sortInfo: DataGridCellEditorStateApi['sortInfo'];
    normalizedPageFindText: DataGridCoreStateApi['normalizedPageFindText'];
    displayColumnTypeMap: DataGridTableMetricsApi['displayColumnTypeMap'];
    columnOrderDragScopeRef: DataGridCoreStateApi['columnOrderDragScopeRef'];
    showColumnComment: DataGridCoreStateApi['showColumnComment'];
    showColumnType: DataGridCoreStateApi['showColumnType'];
    language: DataGridCoreStateApi['language'];
    handleResizeStart: DataGridCellEditingApi['handleResizeStart'];
    handleResizeAutoFit: DataGridCellEditingApi['handleResizeAutoFit'];
    reorderVisibleColumns: DataGridCoreStateApi['reorderVisibleColumns'];
    showColumnHeaderContextMenu: DataGridCellEditorStateApi['showColumnHeaderContextMenu'];
    cellEditMode: DataGridCellEditorStateApi['cellEditMode'];
    selectEditableColumnCells: DataGridCellEditingApi['selectEditableColumnCells'];
    deletedRowKeys: DataGridTableMetricsApi['deletedRowKeys'];
    modifiedColumns: DataGridTableMetricsApi['modifiedColumns'];
    gridColumnAlignMap: DataGridTableMetricsApi['gridColumnAlignMap'];
    dataPanelOpenRef: DataGridInlineEditorApi['dataPanelOpenRef'];
    updateFocusedCell: DataGridInlineEditorApi['updateFocusedCell'];
    handleCellSave: DataGridCellEditingApi['handleCellSave'];
    openCellEditor: DataGridCellEditorStateApi['openCellEditor'];
    inputCellPadding: DataGridCoreStateApi['inputCellPadding'];
    handleSharedCellContextMenu: DataGridInlineEditorApi['handleSharedCellContextMenu'];
    handleSharedCellDoubleClick: DataGridInlineEditorApi['handleSharedCellDoubleClick'];
    handleVirtualCellContextMenu: DataGridInlineEditorApi['handleVirtualCellContextMenu'];
    virtualInlinePickerPendingValueRef: DataGridCellEditorStateApi['virtualInlinePickerPendingValueRef'];
    scheduleVirtualInlinePickerInteraction: DataGridRowEditorsApi['scheduleVirtualInlinePickerInteraction'];
    isVirtualEditingSessionCurrent: DataGridCellEditorStateApi['isVirtualEditingSessionCurrent'];
    virtualInlinePickerOpenRef: DataGridCellEditorStateApi['virtualInlinePickerOpenRef'];
    lockVirtualInlineTableScroll: DataGridTableMetricsApi['lockVirtualInlineTableScroll'];
    cancelVirtualInlinePickerInteraction: DataGridTableMetricsApi['cancelVirtualInlinePickerInteraction'];
    form: DataGridCoreStateApi['form'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    commitVirtualInlinePickerValue: DataGridRowEditorsApi['commitVirtualInlinePickerValue'];
    saveVirtualInlineEditor: DataGridRowEditorsApi['saveVirtualInlineEditor'];
    closeVirtualInlineEditor: DataGridTableMetricsApi['closeVirtualInlineEditor'];
    handleVirtualCellActivate: DataGridInlineEditorApi['handleVirtualCellActivate'];
    setSelectedRowKeys: DataGridCellEditorStateApi['setSelectedRowKeys'];
    handleViewModeChange: DataGridColumnTitlesApi['handleViewModeChange'];
}

export const useDataGridColumns = ({
    rowEditorRowKey, rowEditorForm, rowEditorBaseRawRef, closeRowEditor, addedRows, setAddedRows,
    rowKeyStr, effectiveEditLocator, columnMetaMap, columnMetaMapByLowerName, dbType,
    currentConnConfig, normalizeMongoEditedCellValue, visibleColumnNames, setModifiedRows,
    isTableSurfaceActive, canModifyData, virtualEditingCellForRender, virtualInlineInputRef, onSort,
    displayColumnNames, renderColumnTitle, columnWidths, dataTableDensity, pinnedLeftColumnSet,
    sortInfo, normalizedPageFindText, displayColumnTypeMap, columnOrderDragScopeRef,
    showColumnComment, showColumnType, language, handleResizeStart, handleResizeAutoFit,
    reorderVisibleColumns, showColumnHeaderContextMenu, cellEditMode, selectEditableColumnCells,
    deletedRowKeys, modifiedColumns, gridColumnAlignMap, dataPanelOpenRef, updateFocusedCell,
    handleCellSave, openCellEditor, inputCellPadding, handleSharedCellContextMenu,
    handleSharedCellDoubleClick, handleVirtualCellContextMenu, virtualInlinePickerPendingValueRef,
    scheduleVirtualInlinePickerInteraction, isVirtualEditingSessionCurrent,
    virtualInlinePickerOpenRef, lockVirtualInlineTableScroll, cancelVirtualInlinePickerInteraction,
    form, translateDataGrid, commitVirtualInlinePickerValue, saveVirtualInlineEditor,
    closeVirtualInlineEditor, handleVirtualCellActivate, setSelectedRowKeys, handleViewModeChange,
}: UseDataGridColumnsInput) => {
    const applyRowEditor = useCallback(() => {
        const keyStr = rowEditorRowKey;
        if (!keyStr) return;
        const values = rowEditorForm.getFieldsValue(true) || {};
        const baseRawMap = rowEditorBaseRawRef.current || {};

        const isAdded = addedRows.some(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr);
        if (isAdded) {
            // 日期时间类型: 将 dayjs 对象转回格式化字符串
            const convertedValues: Record<string, any> = {};
            Object.entries(values).forEach(([col, val]) => {
                if (!isWritableResultColumn(col, effectiveEditLocator)) return;
                const baseVal = baseRawMap[col];
                if (val && dayjs.isDayjs(val)) {
                    const colMeta = columnMetaMap[col] || columnMetaMapByLowerName[col.toLowerCase()];
                    const rowPickerType = getTemporalPickerType(colMeta?.type, dbType, currentConnConfig);
                    convertedValues[col] = resolveTemporalEditorSaveValue(
                        undefined,
                        val as dayjs.Dayjs,
                        rowPickerType,
                        baseVal,
                    );
                } else {
                    convertedValues[col] = normalizeMongoEditedCellValue(col, val, baseVal);
                }
            });
            setAddedRows(prev => prev.map(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr ? { ...r, ...convertedValues } : r));
            closeRowEditor();
            return;
        }

        const patch: Record<string, any> = {};
        visibleColumnNames.forEach((col) => {
            if (!isWritableResultColumn(col, effectiveEditLocator)) return;
            let nextVal = values[col];
            // 日期时间类型: 将 dayjs 对象转回格式化字符串
            if (nextVal && dayjs.isDayjs(nextVal)) {
                const colMeta = columnMetaMap[col] || columnMetaMapByLowerName[col.toLowerCase()];
                const rowPickerType = getTemporalPickerType(colMeta?.type, dbType, currentConnConfig);
                nextVal = resolveTemporalEditorSaveValue(
                    undefined,
                    nextVal as dayjs.Dayjs,
                    rowPickerType,
                    baseRawMap[col],
                );
            } else {
                nextVal = normalizeMongoEditedCellValue(col, nextVal, baseRawMap[col]);
            }
            const baseVal = baseRawMap[col];
            if (!isCellValueEqualForDiff(baseVal, nextVal)) patch[col] = nextVal;
        });

        setModifiedRows(prev => {
            const next = { ...prev };
            if (Object.keys(patch).length === 0) delete next[keyStr];
            else next[keyStr] = patch;
            return next;
        });

        closeRowEditor();
    }, [addedRows, closeRowEditor, columnMetaMap, columnMetaMapByLowerName, currentConnConfig, dbType, effectiveEditLocator, normalizeMongoEditedCellValue, rowEditorForm, rowEditorRowKey, rowKeyStr, visibleColumnNames]);

    const enableVirtual = isTableSurfaceActive;
    const enableInlineEditableCell = canModifyData;
    const useInlineEditableBodyCell = enableInlineEditableCell && !enableVirtual;

    useEffect(() => {
        if (!virtualEditingCellForRender) return;
        const rafId = requestAnimationFrame(() => {
            virtualInlineInputRef.current?.focus?.();
            try {
                const inputElement = virtualInlineInputRef.current?.input as HTMLInputElement | undefined;
                inputElement?.select?.();
            } catch {
                // ignore
            }
        });
        return () => cancelAnimationFrame(rafId);
    }, [virtualEditingCellForRender]);

    const columns: (ColumnType<any> & { editable?: boolean })[] = useMemo(() => {
        return displayColumnNames.map(key => ({
            title: renderColumnTitle(key),
            dataIndex: key,
            key: key,
            // 不使用 ellipsis，避免 Ant Design 的 Tooltip 展开行为
            width: resolveDataTableColumnWidth({
                manualWidth: columnWidths[key],
                density: dataTableDensity,
            }),
            ...(pinnedLeftColumnSet.has(key) ? { fixed: 'left' as const } : {}),
            sorter: onSort ? { multiple: displayColumnNames.indexOf(key) + 1 } : false,
            sortOrder: (sortInfo.find(s => s.columnKey === key && s.enabled !== false)?.order || null) as SortOrder | undefined,
            editable: canModifyData && isWritableResultColumn(key, effectiveEditLocator),
            render: (text: any) => {
                const renderedContent = renderCellDisplayValue(text, normalizedPageFindText, displayColumnTypeMap[key], currentConnConfig);
                if (enableVirtual) {
                    return renderedContent;
                }
                return (
                    <div style={CELL_ELLIPSIS_STYLE}>
                        {renderedContent}
                    </div>
                );
            },
            shouldCellUpdate: (record: Item, prevRecord: Item) => {
                const rowKeyChanged = record?.[GONAVI_ROW_KEY] !== prevRecord?.[GONAVI_ROW_KEY];
                if (rowKeyChanged) return true;
                if (hasDataGridDisplayRenderVersionChanged(record, prevRecord)) return true;
                if (hasDataGridFindRenderVersionChanged(record, prevRecord)) return true;
                if (hasDataGridVirtualEditRenderVersionChanged(record, prevRecord)) return true;
                return !isCellValueEqualForRender(record?.[key], prevRecord?.[key]);
            },
            onHeaderCell: (column: any) => ({
                id: key,
                'data-col-name': key,
                columnOrderDragScope: columnOrderDragScopeRef.current,
                width: column.width,
                className: `gonavi-sortable-header-cell${showColumnComment || showColumnType ? '' : ' is-single-line-title'}`,
                'data-i18n-language': language,
                onResizeStart: handleResizeStart(key), // Only need start
                onResizeAutoFit: handleResizeAutoFit(key),
                onDragOver: (event: React.DragEvent<HTMLElement>) => {
                    if (!hasDataGridColumnOrderDragPayload(event.dataTransfer)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                },
                onDrop: (event: React.DragEvent<HTMLElement>) => {
                    if (!hasDataGridColumnOrderDragPayload(event.dataTransfer)) return;
                    const payload = decodeDataGridColumnOrderDragPayload(
                        event.dataTransfer.getData(DATA_GRID_COLUMN_ORDER_DRAG_MIME),
                    );
                    if (!payload || payload.scope !== columnOrderDragScopeRef.current) return;
                    event.preventDefault();
                    event.stopPropagation();
                    reorderVisibleColumns(payload.columnName, key);
                },
                onContextMenu: (event: React.MouseEvent<HTMLElement>) => {

                    showColumnHeaderContextMenu(event, key);
                },
                onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
                    const eventTarget = event.target as HTMLElement | null;
                    if (eventTarget?.closest?.('[data-grid-fk-jump="true"]')) return;
                    if (eventTarget?.closest?.('[data-grid-column-filter-trigger="true"]')) return;
                    if (eventTarget?.closest?.('[data-grid-column-filter-popover="true"]')) return;
                    if (eventTarget?.closest?.('.ant-select-dropdown')) return;
                    if (eventTarget?.closest?.('.react-resizable-handle')) return;
                    if (onSort) {
                        const headerCell = event.currentTarget as HTMLElement;
                        const upArrow = headerCell.querySelector('.ant-table-column-sorter-up') as HTMLElement | null;
                        const downArrow = headerCell.querySelector('.ant-table-column-sorter-down') as HTMLElement | null;
                        const isInArrow = [upArrow, downArrow].some((el) => {
                            if (!el) return false;
                            const rect = el.getBoundingClientRect();
                            return (
                                event.clientX >= rect.left &&
                                event.clientX <= rect.right &&
                                event.clientY >= rect.top &&
                                event.clientY <= rect.bottom
                            );
                        });
                        if (isInArrow) return;
                    }
                    if (cellEditMode && canModifyData && isWritableResultColumn(key, effectiveEditLocator)) {
                        event.preventDefault();
                        event.stopPropagation();
                        selectEditableColumnCells(key);
                        return;
                    }
                    if (!onSort) return;
                    // 仅允许点击上下箭头触发排序，点击字段名或表头其它区域不触发排序。
                    event.preventDefault();
                    event.stopPropagation();
                },
            }),
        }));
    }, [canModifyData, cellEditMode, columnWidths, currentConnConfig, dataTableDensity, displayColumnNames, displayColumnTypeMap, effectiveEditLocator, enableVirtual, handleResizeAutoFit, handleResizeStart, language, normalizedPageFindText, onSort, pinnedLeftColumnSet, renderColumnTitle, reorderVisibleColumns, selectEditableColumnCells, showColumnComment, showColumnHeaderContextMenu, showColumnType, sortInfo]);

    const mergedColumns = useMemo(() => columns.map((col): ColumnType<any> => {
        const dataIndex = String(col.dataIndex);
        // 即使不可编辑，也需要通过 onCell/render 绑定右键菜单
        return {
            ...col,
            onCell: (record: Item) => {
                const rowKey = record?.[GONAVI_ROW_KEY];
                const rowKeyText = rowKey === undefined || rowKey === null ? '' : rowKeyStr(rowKey);
                const rowDeletedForCell = !!rowKeyText && deletedRowKeys.has(rowKeyText);
                const isVirtualInlineEditingCell = !rowDeletedForCell
                    && !!virtualEditingCellForRender
                    && virtualEditingCellForRender.rowKey === rowKeyText
                    && virtualEditingCellForRender.dataIndex === dataIndex;
                const isModifiedCell = !!rowKeyText
                    && !rowDeletedForCell
                    && !isVirtualInlineEditingCell
                    && !!modifiedColumns[rowKeyText]?.has(dataIndex);
                const cellProps: any = {
                    'data-row-key': rowKey === undefined || rowKey === null ? undefined : String(rowKey),
                    'data-col-name': dataIndex,
                    'data-cell-modified': isModifiedCell ? 'true' : undefined,
                    'data-cell-editing': isVirtualInlineEditingCell ? 'true' : undefined,
                    // 数值/日期时间列数据右对齐；其余列与表头保持左对齐。
                    style: gridColumnAlignMap[dataIndex] === 'right' ? { textAlign: 'right' } : undefined,
                };
                if (!enableVirtual && dataPanelOpenRef.current) {
                    // 非虚拟表保留最直接的点击同步；虚拟表改走容器级事件委托，避免每格闭包。
                    cellProps.onClick = () => {
                        updateFocusedCell(record, dataIndex);
                    };
                }

                if (col.editable && useInlineEditableBodyCell) {
                    // 可编辑模式（非虚拟）：传递给 EditableCell 的 props
                    cellProps.record = record;
                    cellProps.editable = col.editable;
                    cellProps.dataIndex = col.dataIndex;
                    cellProps.title = dataIndex;
                    cellProps.handleSave = handleCellSave;
                    cellProps.focusCell = openCellEditor;
                    cellProps.columnType = displayColumnTypeMap[dataIndex];
                    cellProps.dbType = dbType;
                    cellProps.connectionConfig = currentConnConfig;
                    cellProps.inputCellPadding = inputCellPadding;
                    cellProps.modifiedColumns = modifiedColumns;
                    cellProps.rowKeyStr = rowKeyStr;
                    cellProps.deletedRowKeys = deletedRowKeys;
                } else if (enableVirtual) {
                    // 虚拟表格主要走容器级事件委托；这里保留共享 handler，
                    // 兼容测试桩与非标准事件分发，同时避免为每个单元格创建闭包。
                    cellProps.onContextMenu = handleSharedCellContextMenu;
                } else {
                    // 不可编辑（只读查询结果）：共享右键菜单 handler，减少单元格闭包。
                    cellProps.onContextMenu = handleSharedCellContextMenu;
                    cellProps.onDoubleClick = handleSharedCellDoubleClick;
                }
                return cellProps;
            },
            render: (text: any, record: Item, index: number) => {
                const originalRenderContent = col.render ? (col.render as any)(text, record, index) : text;
                const rowKey = record?.[GONAVI_ROW_KEY];
                const rowKeyText = rowKey === undefined || rowKey === null ? '' : rowKeyStr(rowKey);
                const rowDeletedForRender = !!rowKeyText && deletedRowKeys.has(rowKeyText);
                const columnType = displayColumnTypeMap[dataIndex];
                const isVirtualInlineEditingCell = !!virtualEditingCellForRender
                    && virtualEditingCellForRender.rowKey === rowKeyText
                    && virtualEditingCellForRender.dataIndex === dataIndex;
                if (enableVirtual && enableInlineEditableCell) {
                    const pickerType = getTemporalPickerType(columnType, dbType, currentConnConfig);
                    const isDateTimeField = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(record?.[dataIndex] || '')));
                    const virtualEditable = !!col.editable && !rowDeletedForRender;
                    if (isVirtualInlineEditingCell && virtualEditable && virtualEditingCellForRender) {
                        const currentVirtualEditingCell = virtualEditingCellForRender;
                        return (
                            <div
                                style={VIRTUAL_EDITING_CELL_STYLE}
                                className="data-grid-virtual-inline-editing"
                                onContextMenu={(e) => handleVirtualCellContextMenu(e, record, dataIndex)}
                            >
                                <Form.Item className="data-grid-inline-editor-form-item" style={INLINE_EDIT_FORM_ITEM_STYLE} name={getCellFieldName(record, dataIndex)}>
                                    {isDateTimeField ? (
                                        pickerType === 'time' ? (
                                            <TimePicker
                                                ref={virtualInlineInputRef}
                                                style={{ width: '100%' }}
                                                format={TEMPORAL_FORMATS[pickerType]}
                                                onChange={(value) => {
                                                    virtualInlinePickerPendingValueRef.current = value;
                                                    scheduleVirtualInlinePickerInteraction(currentVirtualEditingCell, 'save', value);
                                                }}
                                                onOpenChange={(open) => {
                                                    if (!isVirtualEditingSessionCurrent(currentVirtualEditingCell)) return;
                                                    virtualInlinePickerOpenRef.current = open;
                                                    lockVirtualInlineTableScroll(open);
                                                    if (open) {
                                                        cancelVirtualInlinePickerInteraction();
                                                    } else {
                                                        scheduleVirtualInlinePickerInteraction(currentVirtualEditingCell, 'save');
                                                    }
                                                }}
                                                onBlur={(event) => scheduleVirtualInlinePickerInteraction(
                                                    currentVirtualEditingCell,
                                                    'save',
                                                    undefined,
                                                    event?.relatedTarget,
                                                )}
                                                needConfirm={false}
                                            />
                                        ) : pickerType === 'datetime' ? (
                                            <DatePicker
                                                ref={virtualInlineInputRef}
                                                style={{ width: '100%' }}
                                                showTime
                                                showNow={false}
                                                format={getTemporalPickerFormat(pickerType)}
                                                renderExtraFooter={() => (
                                                    <a
                                                        style={{ padding: '0 2px' }}
                                                        onMouseDown={(event) => event.preventDefault()}
                                                        onClick={() => {
                                                            if (!isVirtualEditingSessionCurrent(currentVirtualEditingCell)) return;
                                                            setCellFieldValue(form, getCellFieldName(record, dataIndex), dayjs());
                                                        }}
                                                    >{translateDataGrid('data_grid.datetime_picker.now')}</a>
                                                )}
                                                onChange={(value) => {
                                                    virtualInlinePickerPendingValueRef.current = value;
                                                }}
                                                onOk={(value) => commitVirtualInlinePickerValue(
                                                    currentVirtualEditingCell,
                                                    value as dayjs.Dayjs | null | undefined,
                                                )}
                                                onOpenChange={(open) => {
                                                    if (!isVirtualEditingSessionCurrent(currentVirtualEditingCell)) return;
                                                    virtualInlinePickerOpenRef.current = open;
                                                    lockVirtualInlineTableScroll(open);
                                                    if (open) {
                                                        cancelVirtualInlinePickerInteraction();
                                                    } else {
                                                        scheduleVirtualInlinePickerInteraction(currentVirtualEditingCell, 'close');
                                                    }
                                                }}
                                                onBlur={(event) => scheduleVirtualInlinePickerInteraction(
                                                    currentVirtualEditingCell,
                                                    'close',
                                                    undefined,
                                                    event?.relatedTarget,
                                                )}
                                                needConfirm
                                            />
                                        ) : (
                                            <DatePicker
                                                ref={virtualInlineInputRef}
                                                style={{ width: '100%' }}
                                                format={TEMPORAL_FORMATS[pickerType]}
                                                picker={pickerType as any}
                                                onChange={(value) => {
                                                    virtualInlinePickerPendingValueRef.current = value;
                                                    scheduleVirtualInlinePickerInteraction(currentVirtualEditingCell, 'save', value);
                                                }}
                                                onOpenChange={(open) => {
                                                    if (!isVirtualEditingSessionCurrent(currentVirtualEditingCell)) return;
                                                    virtualInlinePickerOpenRef.current = open;
                                                    lockVirtualInlineTableScroll(open);
                                                    if (open) {
                                                        cancelVirtualInlinePickerInteraction();
                                                    } else {
                                                        scheduleVirtualInlinePickerInteraction(currentVirtualEditingCell, 'save');
                                                    }
                                                }}
                                                onBlur={(event) => scheduleVirtualInlinePickerInteraction(
                                                    currentVirtualEditingCell,
                                                    'save',
                                                    undefined,
                                                    event?.relatedTarget,
                                                )}
                                                needConfirm={false}
                                            />
                                        )
                                    ) : (
                                        <Input
                                            {...noAutoCapInputProps}
                                            ref={virtualInlineInputRef}
                                            className="data-grid-inline-editor-input"
                                            style={{ width: '100%', ...inputCellPadding }}
                                            onPressEnter={() => { void saveVirtualInlineEditor(currentVirtualEditingCell); }}
                                            onBlur={() => { void saveVirtualInlineEditor(currentVirtualEditingCell); }}
                                            onFocus={(e) => {
                                                try {
                                                    (e.target as HTMLInputElement)?.select?.();
                                                } catch {
                                                    // ignore
                                                }
                                            }}
                                            onDoubleClick={(e) => {
                                                e.stopPropagation();
                                                try {
                                                    (e.target as HTMLInputElement)?.select?.();
                                                } catch {
                                                    // ignore
                                                }
                                            }}
                                        />
                                    )}
                                </Form.Item>
                            </div>
                        );
                    }
                }
                return originalRenderContent;
            }
        };
    }), [cancelVirtualInlinePickerInteraction, closeVirtualInlineEditor, columns, commitVirtualInlinePickerValue, currentConnConfig, dbType, deletedRowKeys, displayColumnTypeMap, gridColumnAlignMap, enableInlineEditableCell, enableVirtual, form, handleCellSave, handleSharedCellContextMenu, handleSharedCellDoubleClick, handleVirtualCellActivate, inputCellPadding, isVirtualEditingSessionCurrent, lockVirtualInlineTableScroll, modifiedColumns, openCellEditor, rowKeyStr, saveVirtualInlineEditor, scheduleVirtualInlinePickerInteraction, updateFocusedCell, useInlineEditableBodyCell, virtualEditingCellForRender]);

    const rowNumberColumnWidth = useMemo(() => {
        const manual = columnWidths[GONAVI_ROW_NUMBER_COLUMN_KEY];
        if (typeof manual === 'number' && Number.isFinite(manual) && manual > 0) {
            // 序号列允许拖宽，但保持较窄下限，避免挤占过多数据列
            return Math.max(28, Math.min(120, Math.round(manual)));
        }
        return ROW_NUMBER_COLUMN_WIDTH;
    }, [columnWidths]);

    const handleRowNumberClick = useCallback((record: Item) => {
        const key = record?.[GONAVI_ROW_KEY];
        if (key === undefined || key === null) return;
        setSelectedRowKeys((previousKeys) => (
            previousKeys.length === 1 && previousKeys[0] === key ? [] : [key]
        ));
    }, []);

    const handleViewModeChangeRef = useRef(handleViewModeChange);
    handleViewModeChangeRef.current = handleViewModeChange;
    const handleRowNumberDoubleClick = useCallback((index: number) => {
        handleViewModeChangeRef.current('text', { textRecordIndex: index });
    }, []);
    return {
        applyRowEditor, enableVirtual, useInlineEditableBodyCell, mergedColumns,
        rowNumberColumnWidth, handleRowNumberClick, handleRowNumberDoubleClick,
    };
};

export type DataGridColumnsApi = ReturnType<typeof useDataGridColumns>;
