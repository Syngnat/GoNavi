import { useMemo, useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { useDataGridMetadata } from '../../useDataGridMetadata';
import { type GridColumnAlign, resolveGridColumnAlign } from '../../dataGridColumnAlign';
import { type DataExportFileOptions, resolveDataExportColumns } from '../../DataExportDialog';
import { pickDataGridOutputRows } from '../../dataGridOutput';
import { ExportDataWithOptions } from '../../../../wailsjs/go/app/App';
import { parseMongoEditedValue } from '../../../utils/mongodb';
import {
    shouldOmitBlankDataGridInsertValue,
    type ForeignKeyTarget,
    setGlobalDeletedRowKeys,
    buildGridFieldSelectOptions,
} from '../../DataGridCore';
import { isTemporalColumnType } from '../../dataGridTemporal';
import { normalizeTemporalLiteralText } from '../../dataGridCopyInsert';
import { buildDataGridCssText } from '../../dataGridStyles';
import { measureDataGridMetrics, observeDataGridMetrics } from '../../dataGridLayout';
import { useDataGridLayoutEffect } from '../dataGridScrollTiming';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridTableMetricsInput {
    connectionId: DataGridProps['connectionId'];
    connectionParamsOverride: DataGridProps['connectionParamsOverride'];
    dbName: DataGridProps['dbName'];
    tableName: DataGridProps['tableName'];
    exportScope: Exclude<DataGridProps['exportScope'], undefined>;
    loading: DataGridProps['loading'];
    initialColumnMetaMap: DataGridProps['initialColumnMetaMap'];
    initialUniqueKeyGroups: DataGridProps['initialUniqueKeyGroups'];
    connections: DataGridCoreStateApi['connections'];
    visibleColumnNames: DataGridCoreStateApi['visibleColumnNames'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    alignNumericTemporalRight: DataGridCoreStateApi['alignNumericTemporalRight'];
    dbType: DataGridCoreStateApi['dbType'];
    currentConnConfig: DataGridCoreStateApi['currentConnConfig'];
    displayOutputColumnNames: DataGridCoreStateApi['displayOutputColumnNames'];
    isQueryResultExport: DataGridCoreStateApi['isQueryResultExport'];
    supportsCopyInsert: DataGridCoreStateApi['supportsCopyInsert'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    runExportWithProgress: DataGridCoreStateApi['runExportWithProgress'];
    isMongoDBConnection: DataGridCoreStateApi['isMongoDBConnection'];
    schemaName: DataGridProps['schemaName'];
    setActiveContext: DataGridCoreStateApi['setActiveContext'];
    addTab: DataGridCoreStateApi['addTab'];
    virtualInlineScrollLockRef: DataGridCellEditorStateApi['virtualInlineScrollLockRef'];
    tableContainerRef: DataGridCellEditorStateApi['tableContainerRef'];
    virtualInlinePickerInteractionTimerRef: DataGridCellEditorStateApi['virtualInlinePickerInteractionTimerRef'];
    virtualInlinePickerInteractionTokenRef: DataGridCellEditorStateApi['virtualInlinePickerInteractionTokenRef'];
    virtualEditingSessionRef: DataGridCellEditorStateApi['virtualEditingSessionRef'];
    virtualInlinePickerOpenRef: DataGridCellEditorStateApi['virtualInlinePickerOpenRef'];
    virtualInlinePickerPendingValueRef: DataGridCellEditorStateApi['virtualInlinePickerPendingValueRef'];
    virtualInlinePickerCommitSessionRef: DataGridCellEditorStateApi['virtualInlinePickerCommitSessionRef'];
    virtualInlinePickerSaveSessionRef: DataGridCellEditorStateApi['virtualInlinePickerSaveSessionRef'];
    setVirtualEditingCell: DataGridCellEditorStateApi['setVirtualEditingCell'];
    virtualEditingCell: DataGridCellEditorStateApi['virtualEditingCell'];
    virtualEditingUnavailable: DataGridCellEditorStateApi['virtualEditingUnavailable'];
    virtualEditingPermissionLost: DataGridCellEditorStateApi['virtualEditingPermissionLost'];
    darkMode: DataGridCoreStateApi['darkMode'];
    bgContent: DataGridCoreStateApi['bgContent'];
    floatingScrollbarThumbBg: DataGridCoreStateApi['floatingScrollbarThumbBg'];
    floatingScrollbarThumbBorderColor: DataGridCoreStateApi['floatingScrollbarThumbBorderColor'];
    floatingScrollbarThumbHoverBg: DataGridCoreStateApi['floatingScrollbarThumbHoverBg'];
    floatingScrollbarThumbShadow: DataGridCoreStateApi['floatingScrollbarThumbShadow'];
    horizontalScrollbarThumbBg: DataGridCoreStateApi['horizontalScrollbarThumbBg'];
    horizontalScrollbarThumbHoverBg: DataGridCoreStateApi['horizontalScrollbarThumbHoverBg'];
    paginationAccentBg: DataGridCoreStateApi['paginationAccentBg'];
    paginationAccentBorderColor: DataGridCoreStateApi['paginationAccentBorderColor'];
    paginationActiveItemBg: DataGridCoreStateApi['paginationActiveItemBg'];
    paginationActiveItemBorderColor: DataGridCoreStateApi['paginationActiveItemBorderColor'];
    paginationActiveItemTextColor: DataGridCoreStateApi['paginationActiveItemTextColor'];
    paginationChipBg: DataGridCoreStateApi['paginationChipBg'];
    paginationChipBorderColor: DataGridCoreStateApi['paginationChipBorderColor'];
    paginationHoverBg: DataGridCoreStateApi['paginationHoverBg'];
    paginationPrimaryTextColor: DataGridCoreStateApi['paginationPrimaryTextColor'];
    paginationSecondaryTextColor: DataGridCoreStateApi['paginationSecondaryTextColor'];
    paginationShellBg: DataGridCoreStateApi['paginationShellBg'];
    paginationShellBorderColor: DataGridCoreStateApi['paginationShellBorderColor'];
    paginationShellShadow: DataGridCoreStateApi['paginationShellShadow'];
    rowAddedBg: DataGridCoreStateApi['rowAddedBg'];
    rowModBg: DataGridCoreStateApi['rowModBg'];
    selectionAccentHex: DataGridCoreStateApi['selectionAccentHex'];
    selectionAccentRgb: DataGridCoreStateApi['selectionAccentRgb'];
    verticalScrollbarTrackBg: DataGridCoreStateApi['verticalScrollbarTrackBg'];
    dataGridBackdropFilter: DataGridCoreStateApi['dataGridBackdropFilter'];
    dataTableVerticalBorderRule: DataGridCoreStateApi['dataTableVerticalBorderRule'];
    densityParams: DataGridCoreStateApi['densityParams'];
    floatingScrollbarBottomOffset: DataGridCoreStateApi['floatingScrollbarBottomOffset'];
    floatingScrollbarHeight: DataGridCoreStateApi['floatingScrollbarHeight'];
    floatingScrollbarInset: DataGridCoreStateApi['floatingScrollbarInset'];
    gridId: DataGridCoreStateApi['gridId'];
    horizontalScrollbarThumbBorderColor: DataGridCoreStateApi['horizontalScrollbarThumbBorderColor'];
    horizontalScrollbarThumbShadow: DataGridCoreStateApi['horizontalScrollbarThumbShadow'];
    horizontalScrollbarTrackBg: DataGridCoreStateApi['horizontalScrollbarTrackBg'];
    horizontalScrollbarTrackBorderColor: DataGridCoreStateApi['horizontalScrollbarTrackBorderColor'];
    horizontalScrollbarTrackShadow: DataGridCoreStateApi['horizontalScrollbarTrackShadow'];
    panelRadius: DataGridCoreStateApi['panelRadius'];
    themeStyles: DataGridCoreStateApi['themeStyles'];
    opacity: DataGridCoreStateApi['opacity'];
    containerRef: DataGridCellEditorStateApi['containerRef'];
    externalHorizontalScrollRef: DataGridCellEditorStateApi['externalHorizontalScrollRef'];
    floatingScrollbarGap: DataGridCoreStateApi['floatingScrollbarGap'];
    isWindowsLike: DataGridCoreStateApi['isWindowsLike'];
}

export const useDataGridTableMetrics = ({
    connectionId, connectionParamsOverride, dbName, tableName, exportScope, loading,
    initialColumnMetaMap, initialUniqueKeyGroups, connections, visibleColumnNames,
    displayColumnNames, alignNumericTemporalRight, dbType, currentConnConfig,
    displayOutputColumnNames, isQueryResultExport, supportsCopyInsert, translateDataGrid,
    runExportWithProgress, isMongoDBConnection, schemaName, setActiveContext, addTab,
    virtualInlineScrollLockRef, tableContainerRef, virtualInlinePickerInteractionTimerRef,
    virtualInlinePickerInteractionTokenRef, virtualEditingSessionRef, virtualInlinePickerOpenRef,
    virtualInlinePickerPendingValueRef, virtualInlinePickerCommitSessionRef,
    virtualInlinePickerSaveSessionRef, setVirtualEditingCell, virtualEditingCell,
    virtualEditingUnavailable, virtualEditingPermissionLost, darkMode, bgContent,
    floatingScrollbarThumbBg, floatingScrollbarThumbBorderColor, floatingScrollbarThumbHoverBg,
    floatingScrollbarThumbShadow, horizontalScrollbarThumbBg, horizontalScrollbarThumbHoverBg,
    paginationAccentBg, paginationAccentBorderColor, paginationActiveItemBg,
    paginationActiveItemBorderColor, paginationActiveItemTextColor, paginationChipBg,
    paginationChipBorderColor, paginationHoverBg, paginationPrimaryTextColor,
    paginationSecondaryTextColor, paginationShellBg, paginationShellBorderColor,
    paginationShellShadow, rowAddedBg, rowModBg, selectionAccentHex, selectionAccentRgb,
    verticalScrollbarTrackBg, dataGridBackdropFilter, dataTableVerticalBorderRule, densityParams,
    floatingScrollbarBottomOffset, floatingScrollbarHeight, floatingScrollbarInset, gridId,
    horizontalScrollbarThumbBorderColor, horizontalScrollbarThumbShadow, horizontalScrollbarTrackBg,
    horizontalScrollbarTrackBorderColor, horizontalScrollbarTrackShadow, panelRadius, themeStyles,
    opacity, containerRef, externalHorizontalScrollRef, floatingScrollbarGap, isWindowsLike,
}: UseDataGridTableMetricsInput) => {
    const {
        allTableColumnNames,
        columnMetaCacheRef,
        columnMetaMap,
        columnMetaMapByLowerName,
        columnTypeMapByLowerName,
        foreignKeyCacheRef,
        foreignKeyMap,
        foreignKeyMapByLowerName,
        getColumnFilterType,
        metadataCacheKey,
        metadataReloadVersion,
        setMetadataReloadVersion,
        uniqueKeyGroups,
        uniqueKeyGroupsCacheRef,
    } = useDataGridMetadata({
        connections,
        connectionId,
        connectionParamsOverride,
        dbName,
        tableName,
        exportScope,
        visibleColumnNames,
        loading,
        initialColumnMetaMap,
        initialUniqueKeyGroups,
    });

    const displayColumnTypeMap = useMemo(() => {
        const next: Record<string, string> = {};
        displayColumnNames.forEach((columnName) => {
            const normalizedName = String(columnName || '').trim();
            if (!normalizedName) return;
            next[normalizedName] = columnMetaMap[normalizedName]?.type || columnTypeMapByLowerName[normalizedName.toLowerCase()] || '';
        });
        return next;
    }, [displayColumnNames, columnMetaMap, columnTypeMapByLowerName]);

    // 仅数据格右对齐：数值与日期时间列右对齐，其余保持左对齐；表头不受影响。
    // 由显示设置开关控制，默认关闭（全左）。
    const gridColumnAlignMap = useMemo<Record<string, GridColumnAlign>>(() => {
        const next: Record<string, GridColumnAlign> = {};
        displayColumnNames.forEach((columnName) => {
            next[columnName] = alignNumericTemporalRight
                ? resolveGridColumnAlign(displayColumnTypeMap[columnName], dbType, currentConnConfig)
                : 'left';
        });
        return next;
    }, [displayColumnNames, displayColumnTypeMap, dbType, currentConnConfig, alignNumericTemporalRight]);

    const insertSQLColumnTypes = useMemo(() => {
        const next: Record<string, string> = {};
        displayOutputColumnNames.forEach((columnName) => {
            const normalizedName = String(columnName || '').trim();
            if (!normalizedName) return;
            const columnType = columnMetaMap[normalizedName]?.type
                || columnMetaMapByLowerName[normalizedName.toLowerCase()]?.type
                || columnTypeMapByLowerName[normalizedName.toLowerCase()]
                || '';
            next[normalizedName.toLowerCase()] = columnType;
        });
        return next;
    }, [columnMetaMap, columnMetaMapByLowerName, columnTypeMapByLowerName, displayOutputColumnNames]);

    const insertSQLTargetColumns = useMemo(() => {
        const actualNameByLower = new Map<string, string>();
        Object.keys(columnMetaMap).forEach((columnName) => {
            const normalizedName = String(columnName || '').trim();
            if (normalizedName) actualNameByLower.set(normalizedName.toLowerCase(), normalizedName);
        });
        const next: Record<string, string> = {};
        displayOutputColumnNames.forEach((columnName) => {
            const normalizedName = String(columnName || '').trim();
            const actualName = actualNameByLower.get(normalizedName.toLowerCase());
            if (normalizedName && actualName) {
                next[normalizedName.toLowerCase()] = actualName;
            }
        });
        return next;
    }, [columnMetaMap, displayOutputColumnNames]);

    const hasResolvedInsertSQLTarget = !!tableName
        && Object.keys(insertSQLTargetColumns).length === displayOutputColumnNames.length;
    const canExportInsertSQL = isQueryResultExport
        && supportsCopyInsert
        && displayOutputColumnNames.length > 0;

    const buildBackendExportOptions = useCallback((options: DataExportFileOptions): DataExportFileOptions => {
        if (options.format !== 'sql') {
            return options;
        }
        return {
            ...options,
            insertSQLDialect: dbType,
            insertSQLTargetTable: hasResolvedInsertSQLTarget ? String(tableName || '').trim() : '',
            insertSQLColumnTypes,
            insertSQLTargetColumns: hasResolvedInsertSQLTarget ? insertSQLTargetColumns : {},
            insertSQLAllowEmptyTargetTable: !hasResolvedInsertSQLTarget,
        };
    }, [dbType, hasResolvedInsertSQLTarget, insertSQLColumnTypes, insertSQLTargetColumns, tableName]);

    // Helper to export specific data
    const exportData = async (rows: any[], options: DataExportFileOptions) => {
        const exportColumns = resolveDataExportColumns(options.columns, displayOutputColumnNames)
            || displayOutputColumnNames;
        const cleanRows = pickDataGridOutputRows(rows, exportColumns);
        const exportTitle = String(tableName || '').trim()
            ? translateDataGrid('file.backend.dialog.export_table', { table: tableName })
            : translateDataGrid('file.backend.dialog.export_data');
        await runExportWithProgress({
            title: exportTitle,
            targetName: tableName || 'export',
            format: options.format,
            totalRows: cleanRows.length,
            run: (jobId) => ExportDataWithOptions(
                cleanRows,
                exportColumns,
                tableName || 'export',
                {
                    ...buildBackendExportOptions(options),
                    jobId,
                    totalRowsHint: cleanRows.length,
                    totalRowsKnown: true,
                } as any,
            ),
        });
    };

    const normalizeCommitCellValue = useCallback(
        (columnName: string, value: any, mode: 'insert' | 'update') => {
            if (value === undefined) return undefined;
            if (isMongoDBConnection) {
                return parseMongoEditedValue(columnName, value, undefined);
            }
            const normalizedName = String(columnName || '').trim();
            const meta = columnMetaMap[normalizedName] || columnMetaMapByLowerName[normalizedName.toLowerCase()];
            if (shouldOmitBlankDataGridInsertValue(value, mode, meta)) {
                return undefined;
            }
            const temporal = isTemporalColumnType(meta?.type, dbType);

            if (!temporal) {
                return value;
            }

            if (value === null) {
                return null;
            }

            if (typeof value === 'string') {
                const raw = value.trim();
                if (raw === '') {
                    // INSERT 空时间值直接忽略字段，让数据库默认值生效；UPDATE 空时间值转 NULL。
                    return mode === 'insert' ? undefined : null;
                }
                return normalizeTemporalLiteralText(value, meta?.type, true);
            }

            return value;
        },
        [columnMetaMap, columnMetaMapByLowerName, dbType, isMongoDBConnection]
    );

    const openTableByName = useCallback((nextTableName: string) => {
        const normalizedTableName = String(nextTableName || '').trim();
        if (!connectionId || !normalizedTableName || normalizedTableName === '-') return;
        const targetDbName = String(dbName || '').trim();
        const targetSchemaName = String(schemaName || '').trim();
        const tabId = `${connectionId}-${targetDbName}${targetSchemaName ? `-${targetSchemaName}` : ''}-table-${normalizedTableName}`;
        setActiveContext({
            connectionId,
            dbName: targetDbName,
            schemaName: targetSchemaName || undefined,
        });
        addTab({
            id: tabId,
            title: normalizedTableName,
            type: 'table',
            connectionId,
            dbName: targetDbName,
            tableName: normalizedTableName,
            schemaName: targetSchemaName || undefined,
            objectType: 'table',
        });
    }, [addTab, connectionId, dbName, schemaName, setActiveContext]);

    const openForeignKeyTarget = useCallback((target: ForeignKeyTarget) => {
        openTableByName(String(target?.refTableName || '').trim());
    }, [openTableByName]);

    const lockVirtualInlineTableScroll = useCallback((lock: boolean) => {
        if (lock) {
            if (virtualInlineScrollLockRef.current) {
                return;
            }
            const tableWrapper = tableContainerRef.current?.closest?.('.ant-table-wrapper') as HTMLElement | null;
            if (!tableWrapper) {
                return;
            }
            const handler = (e: WheelEvent) => {
                e.preventDefault();
                e.stopPropagation();
            };
            tableWrapper.addEventListener('wheel', handler, { capture: true, passive: false });
            virtualInlineScrollLockRef.current = { el: tableWrapper, handler };
            return;
        }
        if (!virtualInlineScrollLockRef.current) {
            return;
        }
        const { el, handler } = virtualInlineScrollLockRef.current;
        el.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
        virtualInlineScrollLockRef.current = null;
    }, []);

    const cancelVirtualInlinePickerInteraction = useCallback(() => {
        if (virtualInlinePickerInteractionTimerRef.current !== null) {
            clearTimeout(virtualInlinePickerInteractionTimerRef.current);
            virtualInlinePickerInteractionTimerRef.current = null;
        }
        virtualInlinePickerInteractionTokenRef.current += 1;
    }, []);

    const closeVirtualInlineEditor = useCallback((expectedSessionId?: number) => {
        if (
            expectedSessionId !== undefined
            && virtualEditingSessionRef.current?.sessionId !== expectedSessionId
        ) {
            return;
        }
        cancelVirtualInlinePickerInteraction();
        virtualEditingSessionRef.current = null;
        lockVirtualInlineTableScroll(false);
        virtualInlinePickerOpenRef.current = false;
        virtualInlinePickerPendingValueRef.current = undefined;
        virtualInlinePickerCommitSessionRef.current = null;
        virtualInlinePickerSaveSessionRef.current = null;
        setVirtualEditingCell((current) => (
            expectedSessionId === undefined || current?.sessionId === expectedSessionId
                ? null
                : current
        ));
    }, [cancelVirtualInlinePickerInteraction, lockVirtualInlineTableScroll]);

    useEffect(() => () => {
        // Do not leave a portal interaction timer or capture-phase wheel listener
        // behind when the table itself disappears.
        cancelVirtualInlinePickerInteraction();
        virtualEditingSessionRef.current = null;
        virtualInlinePickerOpenRef.current = false;
        virtualInlinePickerPendingValueRef.current = undefined;
        virtualInlinePickerCommitSessionRef.current = null;
        virtualInlinePickerSaveSessionRef.current = null;
        lockVirtualInlineTableScroll(false);
    }, [cancelVirtualInlinePickerInteraction, lockVirtualInlineTableScroll]);

    useEffect(() => {
        if (!virtualEditingCell) return;
        if (virtualEditingUnavailable) {
            closeVirtualInlineEditor(virtualEditingCell.sessionId);
            return;
        }
        if (virtualEditingPermissionLost) {
            void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
            closeVirtualInlineEditor(virtualEditingCell.sessionId);
        }
    }, [closeVirtualInlineEditor, translateDataGrid, virtualEditingCell, virtualEditingPermissionLost, virtualEditingUnavailable]);

    // Dynamic Height
    const [tableHeight, setTableHeight] = useState(500);
    const [tableViewportWidth, setTableViewportWidth] = useState(0);
    const [measuredHorizontalScrollMetrics, setMeasuredHorizontalScrollMetrics] = useState({
        scrollWidth: 0,
        clientWidth: 0,
        trackClientWidth: 0,
    });
    const [tableBodyBottomPadding, setTableBodyBottomPadding] = useState(0);

    // P0 性能优化：CSS 模板字符串 memoize，仅在主题/布局变量变化时重算
    const gridCssText = useMemo(
        () => buildDataGridCssText({
            darkMode,
            // 固定列实心底必须跟表格内容底一致，禁止写死 #141414 / #1f1f1f
            bgContent,
            dataGridBackdropFilter,
            dataTableVerticalBorderRule,
            densityParams,
            floatingScrollbarBottomOffset,
            floatingScrollbarHeight,
            floatingScrollbarInset,
            floatingScrollbarThumbBg,
            floatingScrollbarThumbBorderColor,
            floatingScrollbarThumbHoverBg,
            floatingScrollbarThumbShadow,
            gridId,
            horizontalScrollbarThumbBg,
            horizontalScrollbarThumbBorderColor,
            horizontalScrollbarThumbHoverBg,
            horizontalScrollbarThumbShadow,
            horizontalScrollbarTrackBg,
            horizontalScrollbarTrackBorderColor,
            horizontalScrollbarTrackShadow,
            paginationAccentBg,
            paginationAccentBorderColor,
            paginationActiveItemBg,
            paginationActiveItemBorderColor,
            paginationActiveItemTextColor,
            paginationChipBg,
            paginationChipBorderColor,
            paginationHoverBg,
            paginationPrimaryTextColor,
            paginationSecondaryTextColor,
            paginationShellBg,
            paginationShellBorderColor,
            paginationShellShadow,
            panelRadius,
            rowAddedBg,
            rowModBg,
            selectionAccentHex,
            selectionAccentRgb,
            tableBodyBottomPadding,
            verticalScrollbarTrackBg,
        }),
        [themeStyles, gridId, tableBodyBottomPadding, darkMode, opacity, dataTableVerticalBorderRule, densityParams],
    );

    const recalculateTableMetrics = useCallback((targetElement?: HTMLElement | null) => {
        const target = targetElement || containerRef.current;
        if (!target) return false;
        const metrics = measureDataGridMetrics({
            target,
            externalHorizontalTrack: externalHorizontalScrollRef.current,
            floatingScrollbarHeight,
            floatingScrollbarGap,
            isWindowsLike,
        });
        if (!metrics) return false;
        if (metrics.viewportWidth !== null) setTableViewportWidth(metrics.viewportWidth);
        setMeasuredHorizontalScrollMetrics((current) => (
            current.scrollWidth === metrics.scrollWidth
            && current.clientWidth === metrics.clientWidth
            && current.trackClientWidth === metrics.trackClientWidth
                ? current
                : {
                    scrollWidth: metrics.scrollWidth,
                    clientWidth: metrics.clientWidth,
                    trackClientWidth: metrics.trackClientWidth,
                }
        ));
        setTableBodyBottomPadding(metrics.bodyBottomPadding);
        if (metrics.tableHeight === null) return false;
        setTableHeight(metrics.tableHeight);
        return true;
    }, [floatingScrollbarGap, floatingScrollbarHeight, isWindowsLike]);

    useDataGridLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        return observeDataGridMetrics(el, recalculateTableMetrics);
    }, [recalculateTableMetrics]);

    const [addedRows, setAddedRows] = useState<any[]>([]);
    const [modifiedRows, setModifiedRows] = useState<Record<string, any>>({});
    const [deletedRowKeys, setDeletedRowKeys] = useState<Set<string>>(new Set());
    // 同步到模块级变量，确保 EditableCell 事件处理器始终读取最新删除状态
    setGlobalDeletedRowKeys(deletedRowKeys);
    const [modifiedColumns, setModifiedColumns] = useState<Record<string, Set<string>>>({});
    const [previewModalOpen, setPreviewModalOpen] = useState(false);
    const [previewSqlData, setPreviewSqlData] = useState<{
        deletes: string[];
        updates: string[];
        inserts: string[];
    }>({ deletes: [], updates: [], inserts: [] });

    const gridFieldSelectOptions = useMemo(
        () => buildGridFieldSelectOptions(displayColumnNames),
        [displayColumnNames],
    );
    return {
        allTableColumnNames, columnMetaCacheRef, columnMetaMap, columnMetaMapByLowerName,
        columnTypeMapByLowerName, foreignKeyCacheRef, foreignKeyMap, foreignKeyMapByLowerName,
        getColumnFilterType, metadataCacheKey, setMetadataReloadVersion, uniqueKeyGroups,
        uniqueKeyGroupsCacheRef, displayColumnTypeMap, gridColumnAlignMap, canExportInsertSQL,
        buildBackendExportOptions, exportData, normalizeCommitCellValue, openTableByName,
        openForeignKeyTarget, lockVirtualInlineTableScroll, cancelVirtualInlinePickerInteraction,
        closeVirtualInlineEditor, tableHeight, tableViewportWidth, measuredHorizontalScrollMetrics,
        tableBodyBottomPadding, gridCssText, recalculateTableMetrics, addedRows, setAddedRows,
        modifiedRows, setModifiedRows, deletedRowKeys, setDeletedRowKeys, modifiedColumns,
        setModifiedColumns, previewModalOpen, setPreviewModalOpen, previewSqlData,
        setPreviewSqlData, gridFieldSelectOptions,
    };
};

export type DataGridTableMetricsApi = ReturnType<typeof useDataGridTableMetrics>;
