import React, { useMemo, useCallback, useState, useRef, useDeferredValue, useEffect } from 'react';
import { useSensors, useSensor, PointerSensor } from '@dnd-kit/core';
import { v4 as generateUuid } from 'uuid';
import { message, Form } from 'antd';
import { useStore } from '../../../store';
import {
    useDataGridI18nLanguage,
    DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS,
    GONAVI_ROW_KEY,
    toEditableText,
    toFormText,
} from '../../DataGridCore';
import { t } from '../../../i18n';
import {
    type RowLocatorMessages,
    type EditRowLocator,
    filterHiddenLocatorColumns,
    isWritableResultColumn,
} from '../../../utils/rowLocator';
import {
    isMacLikePlatform,
    isWindowsPlatform,
    resolveAppearanceValues,
    normalizeOpacityForPlatform,
} from '../../../utils/appearance';
import { getShortcutPlatform } from '../../../utils/shortcuts';
import {
    getDensityParams,
    resolveDataTableVerticalBorderRule,
} from '../../../utils/dataGridDisplay';
import {
    useDataGridColumnLayout,
    resolveDataGridDisplayColumnNames,
    moveDataGridColumnInVisibleOrder,
} from '../../dataGridColumnOrder';
import { normalizeDataGridFindQuery } from '../../../utils/dataGridFind';
import { resolveDataGridOutputColumnNames } from '../../dataGridOutput';
import { getDataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import { isConnectionDataImportRestricted } from '../../../utils/connectionReadOnly';
import { formatMongoEditableValue, parseMongoEditedValue } from '../../../utils/mongodb';
import { buildDataGridPaginationPageSizeOptions } from '../dataGridPagingOptions';
import Modal from '../../common/ResizableDraggableModal';
import { useExportProgressDialog } from '../../ExportProgressModal';
import type { DataGridProps } from '../../DataGridCore';
import { registryAllowsImport } from '../../../utils/dataSourceRegistry';
import { getDataGridSaveCapability } from '../dataGridSaveCapability';

export interface UseDataGridCoreStateInput {
    connectionParamsOverride: DataGridProps['connectionParamsOverride'];
    connectionId: DataGridProps['connectionId'];
    showRowNumberColumn: DataGridProps['showRowNumberColumn'];
    editLocator: DataGridProps['editLocator'];
    pkColumns: Exclude<DataGridProps['pkColumns'], undefined>;
    columnNames: DataGridProps['columnNames'];
    readOnly: Exclude<DataGridProps['readOnly'], undefined>;
    tableName: DataGridProps['tableName'];
    dbName: DataGridProps['dbName'];
    columnPinScope: DataGridProps['columnPinScope'];
    exportScope: Exclude<DataGridProps['exportScope'], undefined>;
    ddlDbName: DataGridProps['ddlDbName'];
    ddlTableName: DataGridProps['ddlTableName'];
    objectType: Exclude<DataGridProps['objectType'], undefined>;
    exportSqlWithFilter: DataGridProps['exportSqlWithFilter'];
    queryMaxRows: DataGridProps['queryMaxRows'];
    data: DataGridProps['data'];
    isActive: Exclude<DataGridProps['isActive'], undefined>;
}

export const useDataGridCoreState = ({
    connectionParamsOverride, connectionId, showRowNumberColumn, editLocator, pkColumns,
    columnNames, readOnly, tableName, dbName, columnPinScope, exportScope, ddlDbName, ddlTableName,
    objectType, exportSqlWithFilter, queryMaxRows, data, isActive,
}: UseDataGridCoreStateInput) => {
    const storedConnections = useStore(state => state.connections);
    const connections = useMemo(() => {
        if (connectionParamsOverride === undefined || !connectionId) return storedConnections;
        return storedConnections.map((connection) => (
            connection.id === connectionId
                ? {
                    ...connection,
                    config: {
                        ...connection.config,
                        connectionParams: connectionParamsOverride,
                    },
                }
                : connection
        ));
    }, [connectionId, connectionParamsOverride, storedConnections]);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const addSqlLog = useStore(state => state.addSqlLog);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const setAppearance = useStore(state => state.setAppearance);
    const uiScale = useStore(state => state.uiScale);
    const queryOptions = useStore(state => state.queryOptions);
    const setQueryOptions = useStore(state => state.setQueryOptions);
    const dataEditTransactionOptions = useStore(state => state.dataEditTransactionOptions);
    const setDataEditTransactionOptions = useStore(state => state.setDataEditTransactionOptions);
    const tableColumnOrders = useStore(state => state.tableColumnOrders);
    const enableColumnOrderMemory = useStore(state => state.enableColumnOrderMemory);
    const setTableColumnOrder = useStore(state => state.setTableColumnOrder);
    const setEnableColumnOrderMemory = useStore(state => state.setEnableColumnOrderMemory);
    const clearTableColumnOrder = useStore(state => state.clearTableColumnOrder);
    const tablePinnedLeftColumns = useStore(state => state.tablePinnedLeftColumns);
    const setTablePinnedLeftColumns = useStore(state => state.setTablePinnedLeftColumns);

    const tableHiddenColumns = useStore(state => state.tableHiddenColumns);
    const enableHiddenColumnMemory = useStore(state => state.enableHiddenColumnMemory);
    const setTableHiddenColumns = useStore(state => state.setTableHiddenColumns);
    const setEnableHiddenColumnMemory = useStore(state => state.setEnableHiddenColumnMemory);
    const clearTableHiddenColumns = useStore(state => state.clearTableHiddenColumns);
    const shortcutOptions = useStore(state => state.shortcutOptions);
    const language = useDataGridI18nLanguage();
    const translateDataGrid = useCallback(
        (key: string, rawParams?: Record<string, unknown>) => {
            const params = rawParams as Parameters<typeof t>[1];
            return t(key, params, language);
        },
        [language]
    );
    const localizedDataEditAutoCommitDelayOptions = useMemo(
        () => DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS.map((item) => ({
            value: item.value,
            label: translateDataGrid('data_grid.toolbar.commit_delay.seconds', { seconds: item.seconds }),
        })),
        [translateDataGrid]
    );
    const rowLocatorMessages = useMemo<RowLocatorMessages>(() => ({
        noSafeLocator: () => translateDataGrid('data_grid.message.no_safe_locator'),
        emptyLocatorValue: (column: string) => translateDataGrid('data_grid.message.locator_column_value_empty', { column }),
    }), [translateDataGrid]);

    const isMacLike = useMemo(() => isMacLikePlatform(), []);
    const isWindowsLike = useMemo(() => isWindowsPlatform(), []);
    const effectiveUiScale = Math.min(1.25, Math.max(0.8, Number(uiScale) || 1));
    const activeShortcutPlatform = useMemo(() => getShortcutPlatform(isMacLike), [isMacLike]);
    const darkMode = theme === 'dark';
    const resolvedAppearance = resolveAppearanceValues(appearance);
    const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
    const dataGridBackdropFilter = 'none';
    const showDataTableVerticalBorders = appearance.showDataTableVerticalBorders === true;
    // 未显式传入时跟随外观设置（默认显示行号）；DataViewer / SQL 结果共用
    const resolvedShowRowNumberColumn = typeof showRowNumberColumn === 'boolean'
        ? showRowNumberColumn
        : appearance.showDataTableRowNumber !== false;
    const dataTableDensity = appearance.dataTableDensity;
    const densityParams = useMemo(() => getDensityParams(dataTableDensity), [dataTableDensity]);
    const headerCellMinHeight = densityParams.headerMinHeight;
    const inputCellPadding = useMemo<React.CSSProperties>(
        () => ({ padding: densityParams.inputCellPadding }),
        [densityParams.inputCellPadding],
    );
    const dataTableVerticalBorderRule = resolveDataTableVerticalBorderRule({
        darkMode,
        visible: showDataTableVerticalBorders,
    });
    const effectiveEditLocator = useMemo<EditRowLocator | undefined>(() => {
        if (editLocator) return editLocator;
        if (pkColumns.length === 0) return undefined;
        return {
            strategy: 'primary-key',
            columns: pkColumns,
            valueColumns: pkColumns,
            readOnly: false,
        };
    }, [editLocator, pkColumns]);
    const visibleColumnNames = useMemo(
        () => filterHiddenLocatorColumns(columnNames, effectiveEditLocator),
        [columnNames, effectiveEditLocator]
    );
    const shouldCommitColumn = useCallback((columnName: string): boolean => {
        const normalized = String(columnName || '').trim();
        return normalized !== GONAVI_ROW_KEY && isWritableResultColumn(normalized, effectiveEditLocator);
    }, [effectiveEditLocator]);
    const currentConnConfig = connections.find(c => c.id === connectionId)?.config;
    const canModifyData = getDataGridSaveCapability(currentConnConfig).supported && !readOnly && !!tableName && !!effectiveEditLocator && !effectiveEditLocator.readOnly && effectiveEditLocator.strategy !== 'none';
    const showColumnComment = queryOptions?.showColumnComment ?? true;
    const showColumnType = queryOptions?.showColumnType ?? true;
    // 默认全部左对齐；开启后仅数值/日期时间列的数据格右对齐，表头始终左对齐。
    const alignNumericTemporalRight = queryOptions?.alignNumericTemporalCellsRight ?? false;

    // --- Display Columns Order & Visibility Management ---
    const layoutMemoryKey = connectionId && dbName && tableName ? `${connectionId}-${dbName}-${tableName}` : '';
    const { allOrderedColumnNames, setAllOrderedColumnNames, localHiddenColumns, setLocalHiddenColumns } = useDataGridColumnLayout(
        visibleColumnNames,
        enableColumnOrderMemory && layoutMemoryKey ? tableColumnOrders[layoutMemoryKey] : undefined,
        enableHiddenColumnMemory && layoutMemoryKey ? tableHiddenColumns[layoutMemoryKey] : undefined,
        JSON.stringify([connectionId, dbName, tableName, enableColumnOrderMemory, enableHiddenColumnMemory]),
    );
    const [columnSearchText, setColumnSearchText] = useState('');
    const [columnQuickFindText, setColumnQuickFindText] = useState('');
    const [highlightedColumnName, setHighlightedColumnName] = useState('');
    const [pageFindOpen, setPageFindOpen] = useState(false);
    const [pageFindText, setPageFindText] = useState('');
    const [activePageFindMatchIndex, setActivePageFindMatchIndex] = useState(-1);
    const columnQuickFindHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const deferredColumnQuickFindText = useDeferredValue(columnQuickFindText);
    const deferredPageFindText = useDeferredValue(pageFindText);
    // 大结果集查找属于低优先级渲染；清空仍立即生效，避免旧高亮残留一拍。
    const normalizedPageFindText = useMemo(() => (
        normalizeDataGridFindQuery(pageFindText)
            ? normalizeDataGridFindQuery(deferredPageFindText)
            : ''
    ), [deferredPageFindText, pageFindText]);
    const normalizedColumnQuickFindText = useMemo(
        () => normalizeDataGridFindQuery(deferredColumnQuickFindText),
        [deferredColumnQuickFindText],
    );

    useEffect(() => {
        setColumnQuickFindText('');
        setHighlightedColumnName('');
        setPageFindOpen(false);
        setPageFindText('');
        setActivePageFindMatchIndex(-1);
    }, [connectionId, dbName, tableName]);

    useEffect(() => () => {
        if (columnQuickFindHighlightTimerRef.current) {
            clearTimeout(columnQuickFindHighlightTimerRef.current);
        }
    }, []);

    const toggleColumnVisibility = useCallback((col: string, visible: boolean) => {
        setLocalHiddenColumns(prev => {
            const nextSet = new Set(prev);
            if (visible) nextSet.delete(col);
            else nextSet.add(col);
            const nextArray = Array.from(nextSet);
            if (enableHiddenColumnMemory && connectionId && dbName && tableName) {
                setTableHiddenColumns(connectionId, dbName, tableName, nextArray);
            }
            return nextArray;
        });
    }, [enableHiddenColumnMemory, connectionId, dbName, tableName, setTableHiddenColumns]);

    const toggleAllColumnsVisibility = useCallback((visible: boolean) => {
        setLocalHiddenColumns(() => {
            const nextArray = visible ? [] : [...allOrderedColumnNames];
            if (enableHiddenColumnMemory && connectionId && dbName && tableName) {
                setTableHiddenColumns(connectionId, dbName, tableName, nextArray);
            }
            return nextArray;
        });
    }, [allOrderedColumnNames, enableHiddenColumnMemory, connectionId, dbName, tableName, setTableHiddenColumns]);

    const pinnedLeftColumnScope = columnPinScope || tableName;
    const pinnedLeftColumnMemoryKey = useMemo(() => {
        if (!connectionId || !dbName || !pinnedLeftColumnScope) return '';
        return `${connectionId}-${dbName}-${pinnedLeftColumnScope}`;
    }, [connectionId, dbName, pinnedLeftColumnScope]);

    const pinnedLeftColumnNames = useMemo(() => {
        if (!pinnedLeftColumnMemoryKey) return [] as string[];
        const stored = tablePinnedLeftColumns?.[pinnedLeftColumnMemoryKey];
        return Array.isArray(stored) ? stored.map((col) => String(col || '').trim()).filter(Boolean) : [];
    }, [pinnedLeftColumnMemoryKey, tablePinnedLeftColumns]);

    const pinnedLeftColumnSet = useMemo(
        () => new Set(pinnedLeftColumnNames),
        [pinnedLeftColumnNames],
    );

    // The stored order is synchronized in an effect. Derive the current list
    // from the incoming columns when that snapshot is stale so rows never render
    // a selection/#-only frame while their real fields are already available.
    const displayColumnNames = useMemo(() => resolveDataGridDisplayColumnNames({
        visibleColumnNames,
        orderedColumnNames: allOrderedColumnNames,
        hiddenColumnNames: new Set(localHiddenColumns),
        pinnedLeftColumnNames,
    }), [allOrderedColumnNames, localHiddenColumns, pinnedLeftColumnNames, visibleColumnNames]);

    const displayOutputColumnNames = useMemo(
        () => resolveDataGridOutputColumnNames(
            displayColumnNames.length > 0 || allOrderedColumnNames.length > 0 ? displayColumnNames : visibleColumnNames,
            GONAVI_ROW_KEY,
        ),
        [displayColumnNames, allOrderedColumnNames, visibleColumnNames]
    );
    const dataChangeOutputColumnNames = useMemo(
        () => resolveDataGridOutputColumnNames(columnNames, GONAVI_ROW_KEY),
        [columnNames],
    );

    // Handle Dragging
    const pointerSensorOptions = useMemo(() => ({ activationConstraint: { distance: 8 } }), []);
    const sensors = useSensors(
        useSensor(PointerSensor, pointerSensorOptions),
    );

    const columnOrderDragScopeRef = useRef(generateUuid());
    const reorderVisibleColumns = useCallback((sourceColumnName: string, targetColumnName: string) => {
        setAllOrderedColumnNames((prevAllOrder) => {
            const nextOrder = moveDataGridColumnInVisibleOrder(
                prevAllOrder,
                new Set(localHiddenColumns),
                sourceColumnName,
                targetColumnName,
            );
            if (nextOrder === prevAllOrder) return prevAllOrder;
            if (enableColumnOrderMemory && connectionId && dbName && tableName) {
                setTableColumnOrder(connectionId, dbName, tableName, nextOrder);
            }
            return nextOrder;
        });
    }, [connectionId, dbName, enableColumnOrderMemory, localHiddenColumns, setTableColumnOrder, tableName]);

    const selectionColumnWidth = 46;
    const dataSourceCaps = getDataSourceCapabilities(currentConnConfig);
    const prefersManualTotalCount = dataSourceCaps.preferManualTotalCount;
    const supportsApproximateTableCount = dataSourceCaps.supportsApproximateTableCount;
    const supportsApproximateTotalPages = dataSourceCaps.supportsApproximateTotalPages;
    const designerReadOnly = dataSourceCaps.forceReadOnlyStructureDesigner;
    const importRestricted = isConnectionDataImportRestricted(currentConnConfig);
    const dbType = dataSourceCaps.type;
    const isMongoDBConnection = dbType === 'mongodb';
    const isDuckDBConnection = dataSourceCaps.type === 'duckdb';
    const supportsCopyInsert = dataSourceCaps.supportsCopyInsert;
    const supportsSqlQueryExport = dataSourceCaps.supportsSqlQueryExport;
    const isQueryResultExport = exportScope === 'queryResult';
    const canImport = exportScope === 'table' && !!tableName && !importRestricted
        && registryAllowsImport(currentConnConfig?.type, 'table');
    const canExport = !!connectionId && (isQueryResultExport || !!tableName);
    const resolvedDdlDbName = isQueryResultExport ? ddlDbName : (ddlDbName ?? dbName);
    const resolvedDdlTableName = isQueryResultExport ? ddlTableName : (ddlTableName ?? tableName);
    const canViewDdl = !!connectionId && !!resolvedDdlTableName;
    const canOpenObjectDesigner = exportScope === 'table' && objectType === 'table' && !!connectionId && !!tableName;
    const filteredExportSql = useMemo(() => String(exportSqlWithFilter || '').trim(), [exportSqlWithFilter]);
    const hasFilteredExportSql = exportScope === 'table' && filteredExportSql.length > 0;

    const mongoAwareEditableText = useCallback((value: any, columnName?: string): string => (
        isMongoDBConnection ? formatMongoEditableValue(value, columnName) : toEditableText(value)
    ), [isMongoDBConnection]);

    const mongoAwareFormText = useCallback((value: any, columnName?: string): string => (
        isMongoDBConnection ? formatMongoEditableValue(value, columnName) : toFormText(value)
    ), [isMongoDBConnection]);

    const normalizeMongoEditedCellValue = useCallback((columnName: string, value: any, currentValue?: any) => (
        isMongoDBConnection ? parseMongoEditedValue(columnName, value, currentValue) : value
    ), [isMongoDBConnection]);

    const normalizeMongoEditedRow = useCallback((row: any, currentRow?: any) => {
        if (!isMongoDBConnection || !row || typeof row !== 'object') return row;
        let changed = false;
        const nextRow: any = { ...row };
        Object.keys(row).forEach((columnName) => {
            if (columnName === GONAVI_ROW_KEY) return;
            const normalizedValue = normalizeMongoEditedCellValue(columnName, row[columnName], currentRow?.[columnName]);
            if (normalizedValue !== row[columnName]) {
                nextRow[columnName] = normalizedValue;
                changed = true;
            }
        });
        return changed ? nextRow : row;
    }, [isMongoDBConnection, normalizeMongoEditedCellValue]);

    // --- 主题样式变量（仅在 darkMode / opacity / blur 变化时重算） ---
    const themeStyles = useMemo(() => {
        const _getBg = (darkHex: string) => {
            if (!darkMode) return `rgba(255, 255, 255, ${opacity})`;
            const hex = darkHex.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${opacity})`;
        };
        const _rowBg = (r: number, g: number, b: number) => `rgba(${r}, ${g}, ${b}, ${opacity})`;
        const _glassMode = opacity < 0.999 || resolvedAppearance.blur > 0;

        return {
            bgContent: _getBg('#1d1d1d'),
            bgFilter: _getBg('#262626'),
            bgContextMenu: darkMode ? '#1f1f1f' : '#ffffff',
            rowAddedBg: darkMode ? _rowBg(22, 43, 22) : _rowBg(246, 255, 237),
            rowModBg: darkMode ? _rowBg(22, 34, 56) : _rowBg(230, 247, 255),
            selectionAccentHex: darkMode ? '#f6c453' : '#1890ff',
            selectionAccentRgb: darkMode ? '246, 196, 83' : '24, 144, 255',
            columnMetaHintColor: darkMode ? 'rgba(255, 236, 179, 0.98)' : '#595959',
            columnMetaTooltipColor: darkMode ? 'rgba(255, 236, 179, 0.98)' : '#262626',
            panelFrameColor: darkMode ? 'rgba(0, 0, 0, 0.42)' : 'rgba(0, 0, 0, 0.18)',
            floatingScrollbarThumbBg: darkMode ? 'rgba(255,255,255,0.68)' : 'rgba(0,0,0,0.44)',
            floatingScrollbarThumbHoverBg: darkMode ? 'rgba(255,255,255,0.78)' : 'rgba(0,0,0,0.54)',
            floatingScrollbarThumbBorderColor: darkMode ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.52)',
            floatingScrollbarThumbShadow: 'none',
            verticalScrollbarTrackBg: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
            horizontalScrollbarThumbBg: darkMode ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.14)',
            horizontalScrollbarThumbHoverBg: darkMode ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.24)',
            toolbarDividerColor: darkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)',
            paginationShellBg: darkMode
                ? `linear-gradient(135deg, rgba(17,22,34,${_glassMode ? Math.max(0.22, opacity * 0.38) : 0.82}) 0%, rgba(10,14,24,${_glassMode ? Math.max(0.28, opacity * 0.46) : 0.9}) 100%)`
                : `linear-gradient(135deg, rgba(255,255,255,${_glassMode ? Math.max(0.24, opacity * 0.36) : 0.96}) 0%, rgba(246,248,252,${_glassMode ? Math.max(0.32, opacity * 0.44) : 0.99}) 100%)`,
            paginationShellBorderColor: darkMode
                ? `rgba(255,255,255,${_glassMode ? 0.10 : 0.08})`
                : `rgba(16,24,40,${_glassMode ? 0.08 : 0.08})`,
            paginationShellShadow: isMacLike
                ? 'none'
                : (darkMode
                    ? `0 16px 34px rgba(0,0,0,${_glassMode ? 0.10 : 0.22})`
                    : `0 14px 30px rgba(15,23,42,${_glassMode ? 0.03 : 0.08})`),
            paginationChipBg: darkMode
                ? `rgba(255,255,255,${_glassMode ? Math.max(0.02, opacity * 0.035) : 0.04})`
                : `rgba(255,255,255,${_glassMode ? Math.max(0.18, opacity * 0.26) : 0.86})`,
            paginationChipBorderColor: darkMode
                ? `rgba(255,255,255,${_glassMode ? 0.10 : 0.08})`
                : `rgba(16,24,40,${_glassMode ? 0.10 : 0.08})`,
            paginationHoverBg: darkMode
                ? `rgba(255,255,255,${_glassMode ? Math.max(0.04, opacity * 0.06) : 0.07})`
                : `rgba(255,255,255,${_glassMode ? Math.max(0.24, opacity * 0.34) : 0.96})`,
            paginationPrimaryTextColor: darkMode ? '#f5f7ff' : '#162033',
            paginationSecondaryTextColor: darkMode ? 'rgba(255,255,255,0.54)' : 'rgba(16,24,40,0.56)',
            paginationAccentBg: darkMode ? 'rgba(255,214,102,0.14)' : 'rgba(24,144,255,0.10)',
            paginationAccentBorderColor: darkMode ? 'rgba(255,214,102,0.38)' : 'rgba(24,144,255,0.22)',
            paginationActiveItemBg: darkMode ? 'rgba(255,214,102,0.18)' : 'rgba(24,144,255,0.12)',
            paginationActiveItemBorderColor: darkMode ? 'rgba(255,214,102,0.46)' : 'rgba(24,144,255,0.28)',
            paginationActiveItemTextColor: darkMode ? '#fff7d6' : '#0958d9',
        };
    }, [darkMode, opacity, resolvedAppearance.blur, isMacLike]);

    // 解构常用变量以保持后续代码引用不变
    const dataGridFilterMessageApi = useMemo(() => ({
        warning: (content: string) => {
            void message.warning(content);
        },
    }), []);
    const {
        bgContent, bgFilter, bgContextMenu,
        rowAddedBg, rowModBg,
        selectionAccentHex, selectionAccentRgb,
        columnMetaHintColor, columnMetaTooltipColor,
        panelFrameColor,
        floatingScrollbarThumbBg, floatingScrollbarThumbHoverBg, floatingScrollbarThumbBorderColor, floatingScrollbarThumbShadow,
        verticalScrollbarTrackBg, horizontalScrollbarThumbBg, horizontalScrollbarThumbHoverBg,
        toolbarDividerColor,
        paginationShellBg, paginationShellBorderColor, paginationShellShadow,
        paginationChipBg, paginationChipBorderColor, paginationHoverBg,
        paginationPrimaryTextColor, paginationSecondaryTextColor,
        paginationAccentBg, paginationAccentBorderColor,
        paginationActiveItemBg, paginationActiveItemBorderColor, paginationActiveItemTextColor,
    } = themeStyles;

    // 布局常量（纯数字/字符串，无需 memoize）
    const panelRadius = 10;
    const panelOuterGap = isQueryResultExport ? 2 : 6;
    const panelPaddingY = isQueryResultExport ? 8 : 10;
    const panelPaddingX = 12;
    const toolbarBottomPadding = isQueryResultExport ? 4 : 6;
    const filterTopPadding = 2;
    const floatingScrollbarGap = 8;
    const floatingScrollbarBottomOffset = 0;
    const floatingScrollbarInset = 10;
    const floatingScrollbarHeight = 10;
    const horizontalScrollbarTrackBg = 'transparent';
    const horizontalScrollbarTrackBorderColor = 'transparent';
    const horizontalScrollbarTrackShadow = 'none';
    const horizontalScrollbarThumbBorderColor = 'transparent';
    const horizontalScrollbarThumbShadow = 'none';
    const externalScrollbarMinWidth = 1;
    const paginationPageSizeOptions = useMemo(
        () => buildDataGridPaginationPageSizeOptions(queryMaxRows),
        [queryMaxRows],
    );

    const [form] = Form.useForm();
    const [modal, contextHolder] = Modal.useModal();
    const { exportProgressModal, runExportWithProgress } = useExportProgressDialog();
    const gridId = useMemo(() => `grid-${generateUuid()}`, []);
    const [textRecordIndex, setTextRecordIndex] = useState(0);
    const cellEditorSourceRef = useRef<{
        data: typeof data;
        connectionId: typeof connectionId;
        dbName: typeof dbName;
        tableName: typeof tableName;
    } | null>(null);
    const cellEditorRuntimeRef = useRef({
        data,
        connectionId,
        dbName,
        tableName,
        isActive,
        canModifyData,
        effectiveEditLocator,
    });
    cellEditorRuntimeRef.current = {
        data,
        connectionId,
        dbName,
        tableName,
        isActive,
        canModifyData,
        effectiveEditLocator,
    };
    return {
        connections, addTab, setActiveContext, addSqlLog, theme, setAppearance, setQueryOptions,
        dataEditTransactionOptions, setDataEditTransactionOptions, tableColumnOrders,
        enableColumnOrderMemory, setEnableColumnOrderMemory, clearTableColumnOrder,
        setTablePinnedLeftColumns, tableHiddenColumns, enableHiddenColumnMemory,
        setEnableHiddenColumnMemory, clearTableHiddenColumns, shortcutOptions, language,
        translateDataGrid, localizedDataEditAutoCommitDelayOptions, rowLocatorMessages, isMacLike,
        isWindowsLike, effectiveUiScale, activeShortcutPlatform, darkMode, opacity,
        dataGridBackdropFilter, resolvedShowRowNumberColumn, dataTableDensity, densityParams,
        headerCellMinHeight, inputCellPadding, dataTableVerticalBorderRule, effectiveEditLocator,
        visibleColumnNames, shouldCommitColumn, canModifyData, showColumnComment, showColumnType,
        alignNumericTemporalRight, allOrderedColumnNames, localHiddenColumns, setLocalHiddenColumns,
        columnSearchText, setColumnSearchText, columnQuickFindText, setColumnQuickFindText,
        highlightedColumnName, setHighlightedColumnName, pageFindOpen, setPageFindOpen,
        pageFindText, setPageFindText, activePageFindMatchIndex, setActivePageFindMatchIndex,
        columnQuickFindHighlightTimerRef, normalizedPageFindText, normalizedColumnQuickFindText,
        toggleColumnVisibility, toggleAllColumnsVisibility, pinnedLeftColumnScope,
        pinnedLeftColumnNames, pinnedLeftColumnSet, displayColumnNames, displayOutputColumnNames,
        dataChangeOutputColumnNames, sensors, columnOrderDragScopeRef, reorderVisibleColumns,
        selectionColumnWidth, currentConnConfig, prefersManualTotalCount,
        supportsApproximateTableCount, supportsApproximateTotalPages, designerReadOnly, dbType,
        isMongoDBConnection, supportsCopyInsert, supportsSqlQueryExport, isQueryResultExport,
        canImport, canExport, resolvedDdlDbName, resolvedDdlTableName, canViewDdl,
        canOpenObjectDesigner, hasFilteredExportSql, mongoAwareEditableText, mongoAwareFormText,
        normalizeMongoEditedCellValue, normalizeMongoEditedRow, themeStyles,
        dataGridFilterMessageApi, bgContent, bgFilter, bgContextMenu, rowAddedBg, rowModBg,
        selectionAccentHex, selectionAccentRgb, columnMetaHintColor, columnMetaTooltipColor,
        panelFrameColor, floatingScrollbarThumbBg, floatingScrollbarThumbHoverBg,
        floatingScrollbarThumbBorderColor, floatingScrollbarThumbShadow, verticalScrollbarTrackBg,
        horizontalScrollbarThumbBg, horizontalScrollbarThumbHoverBg, paginationShellBg,
        paginationShellBorderColor, paginationShellShadow, paginationChipBg,
        paginationChipBorderColor, paginationHoverBg, paginationPrimaryTextColor,
        paginationSecondaryTextColor, paginationAccentBg, paginationAccentBorderColor,
        paginationActiveItemBg, paginationActiveItemBorderColor, paginationActiveItemTextColor,
        panelRadius, panelOuterGap, panelPaddingY, panelPaddingX, toolbarBottomPadding,
        filterTopPadding, floatingScrollbarGap, floatingScrollbarBottomOffset,
        floatingScrollbarInset, floatingScrollbarHeight, horizontalScrollbarTrackBg,
        horizontalScrollbarTrackBorderColor, horizontalScrollbarTrackShadow,
        horizontalScrollbarThumbBorderColor, horizontalScrollbarThumbShadow,
        externalScrollbarMinWidth, paginationPageSizeOptions, form, modal, contextHolder,
        exportProgressModal, runExportWithProgress, gridId, textRecordIndex, setTextRecordIndex,
        cellEditorSourceRef, cellEditorRuntimeRef,
    };
};

export type DataGridCoreStateApi = ReturnType<typeof useDataGridCoreState>;
