import Modal from './common/ResizableDraggableModal';
import { registerWorkbenchTabCloseGuard } from '../utils/workbenchTabCloseProtection';
// cspell:ignore anticon sqls uuidv uuidv4 hscroll
import React, { useState, useEffect, useRef, useContext, useMemo, useCallback, useDeferredValue } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Table, message, Input, Button, Dropdown, MenuProps, Form, Pagination, Select, Checkbox, Segmented, Tooltip, Popover, DatePicker, TimePicker } from 'antd';
import type { InputRef } from 'antd';
import dayjs from 'dayjs';
import type { SortOrder, ColumnType } from 'antd/es/table/interface';
import type { Reference as TableReference } from 'rc-table';
import { CloseOutlined, ConsoleSqlOutlined, CopyOutlined, EditOutlined, ExportOutlined, FileTextOutlined, LeftOutlined, RightOutlined, SearchOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import {
    DndContext, 
    DragEndEvent, 
    PointerSensor, 
    useSensor, 
    useSensors, 
    closestCenter 
} from '@dnd-kit/core';
import { 
    SortableContext, 
    useSortable, 
    horizontalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    DATA_GRID_COLUMN_ORDER_DRAG_MIME,
    decodeDataGridColumnOrderDragPayload,
    hasDataGridColumnOrderDragPayload,
    moveDataGridColumnInVisibleOrder,
} from './dataGridColumnOrder';
import { ImportData, ExportDataWithOptions, ExportQueryWithOptions, ApplyChanges, PreviewChanges, DBGetColumns, DBGetIndexes, DBGetForeignKeys, DBShowCreateTable } from '../../wailsjs/go/app/App';
import ImportPreviewModal from './ImportPreviewModal';
import { useStore } from '../store';
import { getCurrentLanguage, t } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import type { ColumnDefinition, ForeignKeyDefinition, IndexDefinition } from '../types';
import { v4 as generateUuid } from 'uuid';
import 'react-resizable/css/styles.css';
import '../styles/v2-theme-workbench.css';
import { buildOrderBySQL, buildPaginatedSelectSQL, buildWhereSQL, escapeLiteral, hasExplicitSort, quoteIdentPart, withSortBufferTuningSQL, type FilterCondition } from '../utils/sql';
import { isMacLikePlatform, normalizeOpacityForPlatform, resolveAppearanceValues } from '../utils/appearance';
import { isConnectionDataImportRestricted } from '../utils/connectionReadOnly';
import { confirmProductionRisk } from '../utils/productionRiskConfirm';
import { getDataSourceCapabilities, resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { normalizeOceanBaseProtocol } from '../utils/oceanBaseProtocol';
import {
    getDensityParams,
    resolveDataTableColumnWidth,
    resolveDataTableVerticalBorderColor,
} from '../utils/dataGridDisplay';
import { resolvePaginationPageText, resolvePaginationSummaryText, resolvePaginationTotalForControl } from '../utils/dataGridPagination';
import { countGridColumnValues, filterRowsByGridConditions } from '../utils/dataGridClientFilter';
import { resolveGridSortInfoFromTableSorter } from '../utils/dataGridSort';
import {
    absorbExtraWidthIntoFlexibleColumns,
    calculateTableBodyBottomPadding,
    calculateVirtualTableScrollX,
    resolveDataGridColumnQuickFindScrollLeft,
    resolveDataGridHorizontalWheelDelta,
    resolveExternalHorizontalScrollMetrics,
} from './dataGridLayout';
import {
    applyDataGridFixedCellPreviewOffset,
    commitDataGridFixedCellOffset,
    createDataGridIdleCommitScheduler,
    createDataGridVisualFrameGuard,
    type DataGridIdleCommitScheduler,
    type DataGridVisualFrameGuard,
} from './dataGridVirtualScroll';
import {
    buildCopyDeleteSQL,
    buildCopyInsertSQL,
    buildCopyUpdateSQL,
    normalizeTemporalLiteralText,
    resolveUniqueKeyGroupsFromIndexes,
    type CopySqlError,
} from './dataGridCopyInsert';
import { calculateAutoFitColumnWidth } from './dataGridAutoWidth';
import { buildSelectedCellClipboardPayload } from './dataGridSelectionCopy';
import { buildCopiedRowsForPaste, buildPastedRowsFromCopiedRows } from './dataGridRowClipboard';
import {
    buildDataGridSelectBaseSql,
    pickDataGridOutputRows,
    resolveDataGridOutputColumnNames,
} from './dataGridOutput';
import {
    buildClipboardCsv,
    buildClipboardJson,
    buildClipboardMarkdown,
    pickRowsForClipboard,
} from './dataGridClipboardExport';
import {
    buildTabularClipboardPayloadFromTsv,
    writeClipboardPayload,
    type DataGridClipboardPayload,
} from './dataGridClipboardPayload';
import { applyNoAutoCapAttributesWithin, noAutoCapInputProps } from '../utils/inputAutoCap';
import {
    DEFAULT_SHORTCUT_OPTIONS,
    getShortcutPlatform,
    isEditableElement,
    isShortcutMatch,
    resolveShortcutDisplay,
} from '../utils/shortcuts';
import {
    TEMPORAL_FORMATS,
    getTemporalPickerFormat,
    getTemporalPickerType,
    isTemporalColumnType,
    parseToDayjs,
    resolveTemporalEditorSaveValue,
    isTemporalPickerPopupTarget,
    isTemporalPickerPopupFocused,
    TEMPORAL_PICKER_INTERACTION_DELAY_MS,
    type TemporalConnectionLike,
    type TemporalPickerType,
} from './dataGridTemporal';
import {
    buildEffectiveFilterConditions,
    normalizeQuickWhereCondition,
    resolveWhereConditionSelectedValue,
    resolveWhereConditionSuggestions,
    shouldApplyQuickWhereOnEnter,
    validateQuickWhereCondition,
} from '../utils/dataGridWhereFilter';
import {
    attachDataGridFindRenderVersion,
    collectDataGridFindResult,
    findDataGridTextRanges,
    hasDataGridFindRenderVersionChanged,
    matchesDataGridColumnQuickFind,
    normalizeDataGridFindQuery,
    resolveDataGridColumnQuickFindTarget,
    resolveDataGridFindNavigationIndex,
    type DataGridFindMatch,
    type DataGridFindNavigationDirection,
} from '../utils/dataGridFind';
import {
    filterHiddenLocatorColumns,
    isWritableResultColumn,
    resolveWritableColumnName,
    resolveRowLocatorValues,
    type EditRowLocator,
    type RowLocatorMessages,
} from '../utils/rowLocator';
import {
    getColumnDefinitionComment,
    getColumnDefinitionName,
    getColumnDefinitionType,
} from '../utils/columnDefinition';
import {
    V2CellContextMenuView,
    V2ColumnHeaderContextMenuView,
    type V2CellContextMenuActionKey,
    type V2ColumnHeaderContextMenuActionKey,
} from './V2TableContextMenu';
import DataGridColumnTitle, { type DataGridColumnFilterDraft } from './DataGridColumnTitle';
import DataGridColumnInfoPopoverContent from './DataGridColumnInfoPopoverContent';
import DataGridColumnQuickFind from './DataGridColumnQuickFind';
import DataGridPageFind from './DataGridPageFind';
import DataGridPaginationBar from './DataGridPaginationBar';
import DataGridResultViewSwitcher from './DataGridResultViewSwitcher';
import DataGridSecondaryActions from './DataGridSecondaryActions';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import DataGridShell from './DataGridShell';
import DataGridModals from './DataGridModals';
import DataGridLegacyCellContextMenu from './DataGridLegacyCellContextMenu';
import DataGridPreviewPanel from './DataGridPreviewPanel';
import { buildDataGridTransactionLog } from './dataGridTransactionLog';
import {
    DEFAULT_DATA_EXPORT_FORMAT,
    DEFAULT_XLSX_ROWS_PER_SHEET,
    resolveDataExportColumns,
    showDataExportDialog,
    type DataExportDialogValues,
    type DataExportFileOptions,
    type DataExportScopeOption,
} from './DataExportDialog';
import { DataGridJsonView, DataGridTextView } from './DataGridRecordViews';
import { DataGridV2DdlSideWorkspace, DataGridV2DdlView } from './DataGridV2DdlWorkspace';
import { DataGridV2ErView, DataGridV2FieldsView } from './DataGridV2MetadataViews';
import TableDesigner from './TableDesigner';
import { useExportProgressDialog } from './ExportProgressModal';
import { useDataGridFilters } from './useDataGridFilters';
import { useDataGridDdlView } from './useDataGridDdlView';
import { useDataGridModalEditors } from './useDataGridModalEditors';
import { useDataGridBatchActions } from './useDataGridBatchActions';
import { useDataGridV2Actions } from './useDataGridV2Actions';
import { useDataGridMetadata } from './useDataGridMetadata';
import { useDataGridColumnResize } from './useDataGridColumnResize';
import { useDataGridPreviewPanel } from './useDataGridPreviewPanel';
import { buildTableExportTab } from '../utils/tableExportTab';
import { createSidebarResizeAwareFrameScheduler } from '../utils/sidebarResizeLifecycle';
import { buildDataGridCssText } from './dataGridStyles';
import { syncDataGridCellSelectionVisuals } from './dataGridCellHighlight';
import { formatMongoEditableValue, normalizeMongoDocumentForEditing, parseMongoEditedValue } from '../utils/mongodb';

// --- Error Boundary ---
import {
    DataGridErrorBoundary,
    GONAVI_ROW_KEY,
    GONAVI_ROW_NUMBER_COLUMN_KEY,
    CELL_KEY_SEP,
    CELL_SELECTION_DRAG_THRESHOLD_PX,
    DATE_TIME_CACHE_LIMIT,
    TABLE_CELL_PREVIEW_MAX_CHARS,
    ROW_NUMBER_COLUMN_WIDTH,
    DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS,
    DATA_GRID_DISPLAY_RENDER_VERSION,
    DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION,
    DEFAULT_GRID_MONO_FONT_FAMILY,
    normalizedDateTimeCache,
    objectCellPreviewCache,
    useDataGridI18nLanguage,
    makeCellKey,
    splitCellKey,
    collectDataGridCellSelectionRowKeys,
    filterDataGridCellSelectionToVisibleRows,
    resolveDataGridCellSelectionAnchor,
    collectDataGridFillTemplateTargetRowKeys,
    resolveContextMenuFieldName,
    trimSimpleCache,
    looksLikeDateTimeText,
    normalizeDateTimeString,
    normalizeBitHexDisplayText,
    isDateOnlyColumnType,
    isOceanBaseOracleDisplayConnection,
    normalizeOceanBaseOracleDateDisplayText,
    formatCellDisplayText,
    formatClipboardCellText,
    normalizeClipboardTsvCell,
    buildClipboardTsv,
    renderHighlightedCellText,
    renderCellDisplayValue,
    formatCellValue,
    attachDataGridVirtualEditRenderVersion,
    attachDataGridDisplayRenderVersion,
    hasDataGridDisplayRenderVersionChanged,
    hasDataGridVirtualEditRenderVersionChanged,
    toEditableText,
    toFormText,
    isCellValueEqualForDiff,
    isCellValueEqualForRender,
    INLINE_EDIT_MAX_CHARS,
    shouldOpenModalEditor,
    getCellFieldName,
    setCellFieldValue,
    looksLikeJsonText,
    isPlainObject,
    normalizeValueForJsonView,
    isJsonViewValueEqual,
    coerceJsonEditorValueForStorage,
    ResizableTitle,
    sortableHeaderStaticStyles,
    SortableHeaderCell,
    EditableContext,
    CellContextMenuContext,
    DataContext,
    setGlobalDeletedRowKeys,
    resolveEditableCellRowKey,
    isEditableCellDeleted,
    isEditableCellModified,
    areEditableCellPropsEqual,
    EditableCell,
    ContextMenuRow,
    buildColumnMetaMap,
    hasUsableColumnMeta,
    shouldOmitBlankDataGridInsertValue,
    EXACT_GRID_FILTER_OPERATOR,
    CONTAINS_GRID_FILTER_OPERATOR,
    FILTER_FIELD_SELECT_STYLE,
    FILTER_FIELD_POPUP_WIDTH,
    FILTER_FIELD_OPTION_STYLE,
    STRING_LIKE_GRID_FILTER_TYPES,
    normalizeGridFilterColumnType,
    isStringLikeGridFilterColumnType,
    resolveDefaultGridFilterOperator,
    resolveNextGridFilterOperatorForColumnChange,
    buildGridFieldSelectOptions,
    renderGridFieldSelectOption,
    buildDataGridCommitChangeSet,
    CELL_ELLIPSIS_STYLE,
    VIRTUAL_CELL_TEXT_STYLE,
    READONLY_CELL_WRAP_STYLE,
    INLINE_EDIT_FORM_ITEM_STYLE,
    VIRTUAL_EDITING_CELL_STYLE,
} from './DataGridCore';

import type {
    DataGridErrorBoundaryState,
    DataGridErrorBoundaryProps,
    CellDisplayConnectionLike,
    SortableHeaderCellProps,
    Item,
    EditableCellProps,
    DataGridProps,
    GridFilterCondition,
    GridViewMode,
    DdlViewLayoutMode,
    DataGridExportScope,
    VirtualEditingCellState,
    ColumnMeta,
    ForeignKeyTarget,
    VirtualTableScrollReference,
    NormalizeCommitCellValue,
    DataGridCommitChangeSet,
} from './DataGridCore';
export {
    GONAVI_ROW_KEY,
    GONAVI_ROW_NUMBER_COLUMN_KEY,
    resolveContextMenuFieldName,
    formatCellDisplayText,
    attachDataGridVirtualEditRenderVersion,
    attachDataGridDisplayRenderVersion,
    hasDataGridDisplayRenderVersionChanged,
    hasDataGridVirtualEditRenderVersionChanged,
    isStringLikeGridFilterColumnType,
    resolveDefaultGridFilterOperator,
    resolveNextGridFilterOperatorForColumnChange,
    buildGridFieldSelectOptions,
    buildDataGridCommitChangeSet,
    collectDataGridCellSelectionRowKeys,
    filterDataGridCellSelectionToVisibleRows,
    resolveDataGridCellSelectionAnchor,
    collectDataGridFillTemplateTargetRowKeys,
    buildColumnMetaMap,
    shouldOmitBlankDataGridInsertValue,
} from './DataGridCore';

const DATA_GRID_BASE_PAGE_SIZE_OPTIONS = ['100', '200', '500', '1000'] as const;
const DATA_GRID_SQL_RESULT_PAGE_SIZE_OPTIONS = ['100', '500', '1000', '5000', '20000', '0'] as const;

export const buildDataGridPaginationPageSizeOptions = (queryMaxRows?: number): string[] => {
    if (queryMaxRows === undefined) return [...DATA_GRID_BASE_PAGE_SIZE_OPTIONS];

    const options: string[] = [...DATA_GRID_SQL_RESULT_PAGE_SIZE_OPTIONS];
    if (typeof queryMaxRows === 'number' && Number.isSafeInteger(queryMaxRows) && queryMaxRows > 0) {
        const value = String(queryMaxRows);
        if (!options.includes(value)) {
            options.push(value);
        }
    }
    return options;
};

// Native scroll events can outlive a pointer gesture on macOS. Wait for a brief
// idle window before the virtual table performs its final visual correction.
const EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS = 80;

const DataGrid: React.FC<DataGridProps> = ({
    data, columnNames, loading, tableName, columnPinScope, objectType = 'table', exportScope = 'table', dbName, schemaName, ddlDbName, ddlTableName, connectionId, connectionParamsOverride, pkColumns = [], editLocator, readOnly = false,
    resultSql,
    resultExportAllSql,
    onReload, onSort, onPageChange, onLastPage, queryMaxRows, pagination, onRequestTotalCount, onCancelTotalCount, sortInfoExternal, showFilter, onToggleFilter, exportSqlWithFilter, onApplyFilter, appliedFilterConditions, quickWhereCondition,
    onApplyQuickWhereCondition,
    scrollSnapshot, onScrollSnapshotChange, toolbarExtraActions, showRowNumberColumn, isActive = true, enableSqlLogEvent = false,
    initialViewMode,
    initialViewModeRequestId,
    initialViewModeScope,
    onDataViewActivate,
    onDataChange,
    workbenchTabId,
}) => {
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
  const isV2Ui = true;
  const effectiveUiScale = Math.min(1.25, Math.max(0.8, Number(uiScale) || 1));
  const activeShortcutPlatform = useMemo(() => getShortcutPlatform(isMacLike), [isMacLike]);
  const darkMode = theme === 'dark';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const useVirtualHolderPaintHints = !isMacLike && !isV2Ui;
  const useVirtualRowCellContain = !isMacLike && !isV2Ui;
  const useVirtualCellContentContain = false;
  const useVirtualEditablePaintContain = !isMacLike && !isV2Ui;
  const useVirtualEditableVisibilityHints = !isMacLike && !isV2Ui;
  const dataGridBackdropFilter = isV2Ui || isMacLike ? 'none' : (opacity < 0.999 ? 'blur(14px)' : 'none');
  const showDataTableVerticalBorders = appearance.showDataTableVerticalBorders === true;
  // 未显式传入时跟随外观设置（默认显示行号）；DataViewer / SQL 结果共用
  const resolvedShowRowNumberColumn = typeof showRowNumberColumn === 'boolean'
      ? showRowNumberColumn
      : appearance.showDataTableRowNumber !== false;
  const dataTableDensity = appearance.dataTableDensity;
  const densityParams = useMemo(() => getDensityParams(dataTableDensity), [dataTableDensity]);
  const virtualCellWrapperStyle = useMemo<React.CSSProperties>(() => ({
      margin: -8,
      padding: densityParams.cellPadding,
      display: 'block',
      minWidth: 0,
      width: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      contain: useVirtualCellContentContain ? 'layout style' : undefined,
  }), [densityParams, useVirtualCellContentContain]);
  const headerCellMinHeight = densityParams.headerMinHeight;
  const inputCellPadding: React.CSSProperties = { padding: densityParams.inputCellPadding };
  const dataTableVerticalBorderColor = resolveDataTableVerticalBorderColor({
      darkMode,
      visible: showDataTableVerticalBorders,
  });
  const dataTableVerticalBorderRule = showDataTableVerticalBorders
      ? `1px solid ${dataTableVerticalBorderColor}`
      : 'none';
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
  const canModifyData = !readOnly && !!tableName && !!effectiveEditLocator && !effectiveEditLocator.readOnly && effectiveEditLocator.strategy !== 'none';
  const showColumnComment = queryOptions?.showColumnComment ?? true;
  const showColumnType = queryOptions?.showColumnType ?? true;

  // --- Display Columns Order & Visibility Management ---
  const [allOrderedColumnNames, setAllOrderedColumnNames] = useState<string[]>([]);
  const [displayColumnNames, setDisplayColumnNames] = useState<string[]>([]);
  const [localHiddenColumns, setLocalHiddenColumns] = useState<string[]>([]);
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

  // Sync hidden columns from store
  useEffect(() => {
      if (enableHiddenColumnMemory && connectionId && dbName && tableName) {
          const storedHidden = tableHiddenColumns[`${connectionId}-${dbName}-${tableName}`];
          setLocalHiddenColumns(Array.isArray(storedHidden) ? storedHidden : []);
      } else {
          setLocalHiddenColumns([]);
      }
  }, [tableHiddenColumns, enableHiddenColumnMemory, connectionId, dbName, tableName]);

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

  // Sync display order from incoming prop and store memory
  useEffect(() => {
    let nextOrder = [...visibleColumnNames];
    if (enableColumnOrderMemory && connectionId && dbName && tableName) {
      const storedOrder = tableColumnOrders[`${connectionId}-${dbName}-${tableName}`];
      if (Array.isArray(storedOrder) && storedOrder.length > 0) {
        // Only layout known columns. Filter out missing or new columns.
        const storedSet = new Set(storedOrder);
        const incomingSet = new Set(nextOrder);
        const validStored = storedOrder.filter(col => incomingSet.has(col));
        const missingNew = nextOrder.filter(col => !storedSet.has(col));
        nextOrder = [...validStored, ...missingNew];
      }
    }
    setAllOrderedColumnNames(nextOrder);
  }, [visibleColumnNames, tableColumnOrders, enableColumnOrderMemory, connectionId, dbName, tableName]);

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

  // Compute final display columns（固定列须连续靠左，否则 ant Table fixed 会错位）
  useEffect(() => {
      const hiddenSet = new Set(localHiddenColumns);
      const visible = allOrderedColumnNames.filter((col) => !hiddenSet.has(col));
      if (pinnedLeftColumnNames.length === 0) {
          setDisplayColumnNames(visible);
          return;
      }
      const pinnedSet = new Set(pinnedLeftColumnNames);
      const pinnedVisible = pinnedLeftColumnNames.filter((col) => visible.includes(col));
      const restVisible = visible.filter((col) => !pinnedSet.has(col));
      setDisplayColumnNames([...pinnedVisible, ...restVisible]);
  }, [allOrderedColumnNames, localHiddenColumns, pinnedLeftColumnNames]);

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
  const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
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

  const handleDragEnd = (event: DragEndEvent) => {
    // 防御性检查：若正在调整列宽，忽略拖拽排序事件
    if (isResizingRef.current) return;
    const { active, over } = event;
    if (active.id !== over?.id && over) {
      reorderVisibleColumns(String(active.id), String(over.id));
    }
  };

  const selectionColumnWidth = 46;
  const currentConnConfig = connections.find(c => c.id === connectionId)?.config;
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
  const canImport = exportScope === 'table' && !!tableName && !importRestricted;
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
          floatingScrollbarThumbShadow: (isMacLike || isV2Ui) ? 'none' : (darkMode ? '0 4px 14px rgba(0,0,0,0.42)' : '0 4px 10px rgba(0,0,0,0.20)'),
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
  }, [darkMode, opacity, resolvedAppearance.blur, isMacLike, isV2Ui]);

  // 解构常用变量以保持后续代码引用不变
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
  const {
      cellEditorOpen,
      cellEditorValue,
      setCellEditorValue,
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
  const [virtualRowHeightMeasurement, setVirtualRowHeightMeasurement] = useState<{
      signature: string;
      height: number;
  } | null>(null);
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
  const tableScrollTargetsRef = useRef<HTMLElement[]>([]);
  const externalHorizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const virtualHorizontalElementsRef = useRef<{
      tableContainer: HTMLElement | null;
      holderEl: HTMLElement | null;
      innerEl: HTMLElement | null;
      headerEl: HTMLElement | null;
  }>({ tableContainer: null, holderEl: null, innerEl: null, headerEl: null });
  const horizontalSyncSourceRef = useRef<'table' | 'external' | ''>('');
  const lastTableScrollLeftRef = useRef(0);
  const lastCommittedVirtualHorizontalOffsetRef = useRef(0);
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
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [cellSelectionDeleteEligible, setCellSelectionDeleteEligible] = useState(false);
  const cellSelectionSourceDataRef = useRef<Item[] | null>(null);
  // Keep the origin of an explicit user cell selection separate from the
  // editable/delete eligibility guard. Read-only result grids still support
  // selecting cells and should report that selection in the footer.
  const cellSelectionUserSourceDataRef = useRef<Item[] | null>(null);
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
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
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
          useVirtualEditablePaintContain,
          useVirtualEditableVisibilityHints,
          useVirtualHolderPaintHints,
          useVirtualRowCellContain,
          verticalScrollbarTrackBg,
      }),
      [themeStyles, gridId, tableBodyBottomPadding, darkMode, opacity, dataTableVerticalBorderColor, densityParams],
  );

  const recalculateTableMetrics = useCallback((targetElement?: HTMLElement | null) => {
      const target = targetElement || containerRef.current;
      if (!target) return;

      // P5 性能优化：合并 getBoundingClientRect 调用，减少 DOM 查询次数
      const rect = target.getBoundingClientRect();
      const height = rect.height;
      const width = rect.width;
      if (!Number.isFinite(height) || height < 50) return;
      if (Number.isFinite(width) && width > 0) {
          setTableViewportWidth(Math.floor(width));
      }

      const headerEl =
          (target.querySelector('.ant-table-header') as HTMLElement | null) ||
          (target.querySelector('.ant-table-thead') as HTMLElement | null);
      const rawHeaderHeight = headerEl ? headerEl.getBoundingClientRect().height : NaN;
      const headerHeight =
          Number.isFinite(rawHeaderHeight) && rawHeaderHeight >= 24 && rawHeaderHeight <= 120 ? rawHeaderHeight : 42;
      const paginationEl = target.querySelector('.data-grid-pagination-wrap') as HTMLElement | null;
      const rawPaginationHeight = paginationEl ? paginationEl.getBoundingClientRect().height : 0;
      const paginationHeight =
          Number.isFinite(rawPaginationHeight) && rawPaginationHeight > 0 ? rawPaginationHeight : 0;

      const bodyEl = target.querySelector('.ant-table-body') as HTMLElement | null;
      const virtualBodyEl = target.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
      const rcVirtualHolderEl = target.querySelector('.rc-virtual-list-holder') as HTMLElement | null;
      const virtualScrollbarEl = target.querySelector('.ant-table-tbody-virtual-scrollbar-horizontal') as HTMLElement | null;
      const scrollableEl = virtualBodyEl || rcVirtualHolderEl || bodyEl;
      const measuredScrollWidth = scrollableEl?.scrollWidth || 0;
      const measuredClientWidth = scrollableEl?.clientWidth || 0;
      const measuredTrackClientWidth = externalHorizontalScrollRef.current?.clientWidth || 0;
      const hasHorizontalOverflow = measuredScrollWidth - measuredClientWidth > 1;
      setMeasuredHorizontalScrollMetrics((current) => (
          current.scrollWidth === measuredScrollWidth
          && current.clientWidth === measuredClientWidth
          && current.trackClientWidth === measuredTrackClientWidth
              ? current
              : {
                  scrollWidth: measuredScrollWidth,
                  clientWidth: measuredClientWidth,
                  trackClientWidth: measuredTrackClientWidth,
              }
      ));
      // 普通表格可通过 body 底部内边距避开悬浮横向滚动条；
      // 但虚拟表格的内部横向滚动轨道会直接覆盖在可视区底部，需要同时从 y 高度里扣掉安全区。
      const nextBodyBottomPadding = calculateTableBodyBottomPadding({
          hasHorizontalOverflow,
          floatingScrollbarHeight,
          floatingScrollbarGap,
      });
      setTableBodyBottomPadding(nextBodyBottomPadding);
      const extraBottom = 2;
      const virtualScrollbarViewportReserve = hasHorizontalOverflow && !!virtualScrollbarEl
          ? Math.ceil(virtualScrollbarEl.getBoundingClientRect().height || (floatingScrollbarHeight + floatingScrollbarGap + 4))
          : 0;
      const nextHeight = Math.max(
          100,
          Math.floor(height - headerHeight - paginationHeight - extraBottom - virtualScrollbarViewportReserve)
      );
      setTableHeight(nextHeight);
  }, [floatingScrollbarGap, floatingScrollbarHeight]);

  useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const scheduler = createSidebarResizeAwareFrameScheduler(() => {
          recalculateTableMetrics(containerRef.current);
      });
      const resizeObserver = new ResizeObserver(() => scheduler.schedule());

      resizeObserver.observe(el);
      scheduler.schedule();
      return () => {
          resizeObserver.disconnect();
          scheduler.dispose();
      };
  }, [recalculateTableMetrics]);

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
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

  const {
      filterConditions,
      setFilterConditions,
      quickWhereDraft,
      setQuickWhereDraft,
      quickWhereSuggestionsOpen,
      setQuickWhereSuggestionsOpen,
      filterPanelRef,
      filterOpOptions,
      filterLogicOptions,
      quickWhereSuggestionOptions,
      handleQuickWherePaste,
      stopQuickWhereClipboardPropagation,
      isNoValueOp,
      isBetweenOp,
      isListOp,
      addFilter,
      updateFilter,
      removeFilter,
      applyColumnFilter,
      clearColumnFilter,
      applyQuickWhereCondition,
      clearQuickWhereCondition,
      clearAllFiltersAndSorts,
      applyFilters,
      applyAllFiltersEnabled,
      applyAllFiltersDisabled,
  } = useDataGridFilters({
      appliedFilterConditions,
      quickWhereCondition,
      showFilter,
      displayColumnNames,
      allTableColumnNames,
      columnMetaMap,
      dbType,
      darkMode,
      onApplyFilter,
      onApplyQuickWhereCondition,
      onSort,
      messageApi: {
          warning: (content) => {
              void message.warning(content);
          },
      },
      translate: translateDataGrid,
      getColumnFilterType,
      resolveDefaultGridFilterOperator,
      resolveNextGridFilterOperatorForColumnChange,
  });

  // 表数据页：服务端筛选（onApplyFilter）；查询结果页：列头筛选 + 客户端过滤当前结果
  const baseData = useMemo(() => (
      isMongoDBConnection
          ? data.map((row) => normalizeMongoDocumentForEditing(row))
          : data
  ), [data, isMongoDBConnection]);
  const rowsBeforeClientFilter = useMemo(() => [...baseData, ...addedRows], [addedRows, baseData]);
  const getCurrentColumnValueCounts = useMemo(() => {
      const cache = new Map<string, ReturnType<typeof countGridColumnValues>>();
      return (columnName: string) => {
          const cached = cache.get(columnName);
          if (cached) return cached;
          const rowsForValueCounts = exportScope === 'queryResult'
              ? filterRowsByGridConditions(rowsBeforeClientFilter, filterConditions.filter((condition) => (
                  String(condition?.column || '') !== columnName
              )))
              : rowsBeforeClientFilter;
          const counts = countGridColumnValues(rowsForValueCounts, columnName);
          cache.set(columnName, counts);
          return counts;
      };
  }, [exportScope, filterConditions, rowsBeforeClientFilter]);
  const columnHeaderFilterEnabled = !!onApplyFilter || exportScope === 'queryResult';
  const columnHeaderFilterOpOptions = useMemo(
      () => filterOpOptions.filter((option) => option.value !== 'CUSTOM'),
      [filterOpOptions],
  );
  const getColumnHeaderFilterState = useCallback((columnName: string) => {
      const normalizedName = String(columnName || '').trim();
      const columnFilterConditions = filterConditions.filter((cond) => (
          String(cond?.column || '') === normalizedName && String(cond?.op || '') !== 'CUSTOM'
      ));
      const firstCondition = columnFilterConditions[0];
      const defaultOperator = resolveDefaultGridFilterOperator(getColumnFilterType(normalizedName));
      return {
          active: columnFilterConditions.some((cond) => cond.enabled !== false),
          defaultOperator,
          initialOperator: String(firstCondition?.op || defaultOperator),
          initialValue: String(firstCondition?.value ?? ''),
          initialValue2: String(firstCondition?.value2 ?? ''),
          initialValueSelection: firstCondition?.valueSelection,
      };
  }, [filterConditions, getColumnFilterType]);

  const applyColumnHeaderFilter = useCallback((columnName: string, draft: DataGridColumnFilterDraft) => {
      return applyColumnFilter({
          column: columnName,
          op: draft.op,
          value: draft.value,
          value2: draft.value2,
          valueSelection: draft.valueSelection,
      });
  }, [applyColumnFilter]);

  const renderColumnTitle = useCallback((name: string): React.ReactNode => {
      const normalizedName = String(name || '');
      const meta = columnMetaMap[normalizedName] || columnMetaMapByLowerName[normalizedName.toLowerCase()];
      const foreignKeyTarget = foreignKeyMap[normalizedName] || foreignKeyMapByLowerName[normalizedName.toLowerCase()];
      const columnFilterState = columnHeaderFilterEnabled ? getColumnHeaderFilterState(normalizedName) : null;

      return (
          <DataGridColumnTitle
              columnName={normalizedName}
              columnMeta={meta}
              foreignKeyTarget={foreignKeyTarget}
              showColumnType={showColumnType}
              showColumnComment={showColumnComment}
              metaFontSize={densityParams.metaFontSize}
              columnMetaHintColor={columnMetaHintColor}
              columnMetaTooltipColor={columnMetaTooltipColor}
              darkMode={darkMode}
              highlighted={highlightedColumnName === normalizedName}
              pinnedLeft={pinnedLeftColumnSet.has(normalizedName)}
              translate={translateDataGrid}
              onOpenForeignKey={foreignKeyTarget ? () => openForeignKeyTarget(foreignKeyTarget) : undefined}
              loadCurrentValueCounts={() => getCurrentColumnValueCounts(normalizedName)}
              columnFilter={columnFilterState ? {
                  active: columnFilterState.active,
                  operatorOptions: columnHeaderFilterOpOptions,
                  defaultOperator: columnFilterState.defaultOperator,
                  initialOperator: columnFilterState.initialOperator,
                  initialValue: columnFilterState.initialValue,
                  initialValue2: columnFilterState.initialValue2,
                  initialValueSelection: columnFilterState.initialValueSelection,
                  filterLabel: translateDataGrid('data_grid.toolbar.filter'),
                  applyLabel: translateDataGrid('data_grid.filter.apply'),
                  clearLabel: translateDataGrid('data_grid.filter.clear'),
                  valuePlaceholder: translateDataGrid('data_grid.filter.start_value_placeholder'),
                  secondValuePlaceholder: translateDataGrid('data_grid.filter.end_value_placeholder'),
                  listValuePlaceholder: translateDataGrid('data_grid.filter.list_values_placeholder'),
                  noValuePlaceholder: translateDataGrid('data_grid.filter.no_value_placeholder'),
                  isNoValueOp,
                  isBetweenOp,
                  isListOp,
                  onApply: (draft) => applyColumnHeaderFilter(normalizedName, draft),
                  onClear: () => clearColumnFilter(normalizedName),
              } : null}
          />
      );
  }, [
      applyColumnHeaderFilter,
      clearColumnFilter,
      columnHeaderFilterEnabled,
      columnHeaderFilterOpOptions,
      columnMetaHintColor,
      columnMetaTooltipColor,
      columnMetaMap,
      columnMetaMapByLowerName,
      darkMode,
      densityParams.metaFontSize,
      foreignKeyMap,
      foreignKeyMapByLowerName,
      getColumnHeaderFilterState,
      getCurrentColumnValueCounts,
      highlightedColumnName,
      isBetweenOp,
      isListOp,
      isNoValueOp,
      openForeignKeyTarget,
      pinnedLeftColumnSet,
      showColumnComment,
      showColumnType,
      translateDataGrid,
  ]);
  const selectedRowKeysRef = useRef(selectedRowKeys);
  const displayDataRef = useRef<any[]>([]);

  useEffect(() => { selectedRowKeysRef.current = selectedRowKeys; }, [selectedRowKeys]);

  useEffect(() => {
      if (!pendingScrollToBottomRef.current) return;
      pendingScrollToBottomRef.current = false;
      // 等待 Table 渲染出新增行后再滚动到底部（virtual 模式也适用）
      requestAnimationFrame(() => {
          scrollTableBodyToBottom();
          requestAnimationFrame(() => scrollTableBodyToBottom());
      });
  }, [addedRows.length, scrollTableBodyToBottom]);

  const rowKeyStr = useCallback((k: React.Key) => String(k), []);

  const {
      viewMode,
      setViewMode,
      ddlModalOpen,
      setDdlModalOpen,
      ddlLoading,
      ddlText,
      ddlViewLayout,
      setDdlViewLayout,
      ddlSidebarWidth,
      ddlSidebarResizePreviewX,
      ddlRequestSeqRef,
      isTableSurfaceActive,
      handleOpenTableDdl,
      handleViewModeChange,
      handleDdlSidebarResizeStart,
      resetDdlViewState,
      closeDdlView,
  } = useDataGridDdlView({
      canViewDdl,
      currentConnConfig,
      dbName: resolvedDdlDbName,
      dbType,
      tableName: resolvedDdlTableName,
      isV2Ui,
      isActive,
      cellEditMode,
      selectedRowKeys,
      mergedDisplayDataRef,
      rowKeyStr,
      closeCellEditModeRef,
      setTextRecordIndex,
      messageApi: {
          error: (content) => {
              void message.error(content);
          },
      },
      translate: translateDataGrid,
      initialViewMode,
      initialViewModeRequestId,
      initialViewModeScope,
  });

  const pageFindShortcutCombo = activeShortcutPlatform === 'mac' ? 'Meta+F' : 'Ctrl+F';

  const focusPageFindInput = useCallback(() => {
      requestAnimationFrame(() => {
          const inputHandle = pageFindInputRef.current as (InputRef & HTMLInputElement) | null;
          const input = inputHandle?.input ?? inputHandle;
          input?.focus?.({ preventScroll: true });
          input?.select?.();
      });
  }, []);

  const handleOpenPageFind = useCallback(() => {
      setPageFindOpen(true);
      focusPageFindInput();
  }, [focusPageFindInput]);

  const handleClosePageFind = useCallback(() => {
      setPageFindOpen(false);
      setPageFindText('');
      setActivePageFindMatchIndex(-1);
      requestAnimationFrame(() => {
          rootRef.current?.focus({ preventScroll: true });
      });
  }, []);

  const handleDataGridRootPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (isEditableElement(event.target)) return;
      event.currentTarget.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
      if (!isV2Ui || (isActive && viewMode === 'table')) return;
      setPageFindOpen(false);
      setPageFindText('');
      setActivePageFindMatchIndex(-1);
  }, [isActive, isV2Ui, viewMode]);

  useEffect(() => {
      if (!isV2Ui || !isActive || viewMode !== 'table') return;

      const handlePageFindShortcut = (event: KeyboardEvent) => {
          if (!isShortcutMatch(event, pageFindShortcutCombo)) return;

          const root = rootRef.current;
          const eventTarget = event.target;
          const targetNode = typeof Node !== 'undefined' && eventTarget instanceof Node
              ? eventTarget
              : null;
          const targetElement = eventTarget
              && typeof (eventTarget as Element).closest === 'function'
              ? eventTarget as Element
              : null;
          const activeElement = document.activeElement;
          const eventTargetInGrid = !!(root && targetNode && root.contains(targetNode));
          const activeElementInGrid = !!(root && activeElement && root.contains(activeElement));
          const isDocumentLevelTarget = eventTarget === window
              || eventTarget === document
              || eventTarget === document.body
              || eventTarget === document.documentElement;
          const hasGridShortcutContext = eventTargetInGrid
              || activeElementInGrid
              || (exportScope === 'table' && isDocumentLevelTarget);
          if (!hasGridShortcutContext) return;

          const isPageFindInput = !!targetElement?.closest('[data-grid-page-find="true"]');
          if (
              !isPageFindInput
              && (isEditableElement(event.target) || isEditableElement(activeElement))
          ) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          handleOpenPageFind();
      };

      window.addEventListener('keydown', handlePageFindShortcut, true);
      return () => {
          window.removeEventListener('keydown', handlePageFindShortcut, true);
      };
  }, [
      exportScope,
      handleOpenPageFind,
      isActive,
      isV2Ui,
      pageFindShortcutCombo,
      viewMode,
  ]);

  useEffect(() => {
      const handleExternalViewModeChange = (event: Event) => {
          const detail = (event as CustomEvent<any>)?.detail || {};
          if (String(detail.connectionId || '') !== String(connectionId || '')) return;
          if (String(detail.dbName || '') !== String(dbName || '')) return;
          if (String(detail.schemaName || '').trim() !== String(schemaName || '').trim()) return;
          if (String(detail.tableName || '') !== String(tableName || '')) return;
          const nextMode = String(detail.viewMode || '').trim();
          if (!nextMode) return;
          if (!['table', 'json', 'text', 'fields', 'ddl', 'er', 'sqlLog'].includes(nextMode)) return;
          handleViewModeChange(nextMode as GridViewMode);
      };

      window.addEventListener('gonavi:data-grid:set-view-mode', handleExternalViewModeChange as EventListener);
      return () => window.removeEventListener('gonavi:data-grid:set-view-mode', handleExternalViewModeChange as EventListener);
  }, [connectionId, dbName, handleViewModeChange, schemaName, tableName]);

  useEffect(() => {
      if (!enableSqlLogEvent || !isV2Ui || !isActive) return;
      const handleOpenSqlExecutionLog = () => {
          handleViewModeChange('sqlLog');
      };

      window.addEventListener('gonavi:show-sql-execution-log', handleOpenSqlExecutionLog as EventListener);
      return () => window.removeEventListener('gonavi:show-sql-execution-log', handleOpenSqlExecutionLog as EventListener);
  }, [enableSqlLogEvent, handleViewModeChange, isActive, isV2Ui]);

  const dataViewActiveRef = useRef(false);
  useEffect(() => {
      const requiresTableData = isActive && (
          viewMode === 'table'
          || viewMode === 'json'
          || viewMode === 'text'
          || (viewMode === 'ddl' && isTableSurfaceActive)
      );
      if (!requiresTableData) {
          dataViewActiveRef.current = false;
          return;
      }
      if (dataViewActiveRef.current) return;
      dataViewActiveRef.current = true;
      onDataViewActivate?.();
  }, [isActive, isTableSurfaceActive, onDataViewActivate, viewMode]);

  useEffect(() => {
      if (!isTableSurfaceActive || !isV2Ui || !cellContextMenu.visible) return;
      const portal = cellContextMenuPortalRef.current;
      if (!portal) return;
      const frame = requestAnimationFrame(() => {
          const element = cellContextMenuPortalRef.current;
          if (!element) return;
          const rect = element.getBoundingClientRect();
          const next = resolveContextMenuPosition(cellContextMenu.x, cellContextMenu.y, rect.width, rect.height);
          if (next.x !== cellContextMenu.x || next.y !== cellContextMenu.y) {
              setCellContextMenu((prev) => {
                  if (!prev.visible) return prev;
                  if (prev.x === next.x && prev.y === next.y) return prev;
                  return { ...prev, x: next.x, y: next.y };
              });
          }
      });
      return () => cancelAnimationFrame(frame);
  }, [cellContextMenu.visible, cellContextMenu.x, cellContextMenu.y, isTableSurfaceActive, isV2Ui, resolveContextMenuPosition]);

  useEffect(() => {
      cellEditModeRef.current = cellEditMode;
  }, [cellEditMode]);

  const columnIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    displayColumnNames.forEach((name: string, idx: number) => map.set(name, idx));
    return map;
  }, [displayColumnNames]);

  // 直接操作 DOM 同步单元格选区与活动行列，避免拖选时触发 React 重渲染。
  const updateCellSelection = useCallback((newSelection: Set<string>) => {
    const container = containerRef.current;
    if (!container) return;

    const selectionStart = selectionStartRef.current;
    syncDataGridCellSelectionVisuals({
      container,
      selectedCells: newSelection,
      activeCell: selectionStart
        ? { rowKey: selectionStart.rowKey, colName: selectionStart.colName }
        : null,
      makeCellKey,
    });
  }, []);

  const markCellSelectionDeleteEligible = useCallback((eligible: boolean) => {
    cellSelectionSourceDataRef.current = eligible ? data : null;
    setCellSelectionDeleteEligible(eligible);
  }, [data]);

  const markCellSelectionUserSelection = useCallback((active: boolean) => {
    cellSelectionUserSourceDataRef.current = active ? data : null;
  }, [data]);

  const resetCellSelection = useCallback((clearState: boolean = true) => {
    if (clearState) {
      setSelectedCells(new Set());
    }
    markCellSelectionDeleteEligible(false);
    markCellSelectionUserSelection(false);
    currentSelectionRef.current = new Set();
    selectionStartRef.current = null;
    pendingCellSelectionStartRef.current = null;
    isDraggingRef.current = false;
    cellSelectionPointerRef.current = null;
    if (cellSelectionRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionRafRef.current);
      cellSelectionRafRef.current = null;
    }
    if (cellSelectionScrollRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionScrollRafRef.current);
      cellSelectionScrollRafRef.current = null;
    }
    if (cellSelectionAutoScrollRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionAutoScrollRafRef.current);
      cellSelectionAutoScrollRafRef.current = null;
    }
    updateCellSelection(new Set());
  }, [markCellSelectionDeleteEligible, markCellSelectionUserSelection, updateCellSelection]);

  const closeCellEditMode = useCallback(() => {
    setCellEditMode(false);
    cellEditModeRef.current = false;
    closeBatchEditModal();
    resetCellSelection();
  }, [resetCellSelection]);

  const previousSelectionSourceDataRef = useRef(data);
  // Keep the data-refresh reset visible to the display-data effect. React may
  // run both effects before the setSelectedCells reset is rendered, and the
  // old selection must not be intersected with the new result set in between.
  const selectionResetSourceDataRef = useRef<Item[] | null>(null);
  useEffect(() => {
    if (previousSelectionSourceDataRef.current === data) return;
    previousSelectionSourceDataRef.current = data;
    selectionResetSourceDataRef.current = data;
    setSelectedRowKeys([]);
    resetCellSelection();
  }, [data, resetCellSelection]);

  useEffect(() => {
    closeCellEditModeRef.current = closeCellEditMode;
  }, [closeCellEditMode]);

  const canUseCellSelectionAsFillTemplateTargets = cellEditMode
      && cellSelectionDeleteEligible
      && cellSelectionSourceDataRef.current === data;

  // 批量填充选中的单元格
    const {
    handleBatchFillCells,
    handleSetNullForSelectedCells,
    handleCopySelectedColumnsFromRow,
    handlePasteCopiedColumnsToSelectedRows,
    handleBatchFillToSelected,
    selectEditableColumnCells,
  } = useDataGridBatchActions({
    CELL_SELECTION_DRAG_THRESHOLD_PX,
    GONAVI_ROW_KEY,
    addedRows,
    batchEditSetNull,
    batchEditValue,
    canModifyData,
    cancelAnimationFrame,
    cellEditModeRef,
    cellSelectionAutoScrollRafRef,
    cellSelectionPointerRef,
    cellSelectionRafRef,
    cellSelectionScrollRafRef,
    closeBatchEditModal,
    columnIndexMap,
    containerRef,
    copiedCellPatch,
    canUseCellSelectionAsFillTemplateTargets,
    currentSelectionRef,
    deletedRowKeys,
    displayColumnNames,
    displayDataRef,
    effectiveEditLocator,
    isCellValueEqualForDiff,
    isDraggingRef,
    isActive,
    isTableSurfaceActive,
    isWritableResultColumn,
    makeCellKey,
    modifiedRows,
    pendingCellSelectionStartRef,
    requestAnimationFrame,
    resetCellSelection,
    rowIndexMapRef,
    rowKeyStr,
    selectedCells,
    selectedRowKeysRef,
    selectionStartRef,
    setAddedRows,
    setCellContextMenu,
    setCellEditMode,
    setCopiedCellPatch,
    setModifiedColumns,
    setModifiedRows,
    setSelectedCells,
    markCellSelectionDeleteEligible,
    markCellSelectionUserSelection,
    splitCellKey,
    suppressCellSelectionClickRef,
    translateDataGrid,
    updateCellSelection,
  });

  const displayData = useMemo(() => {
      // 查询结果页没有服务端 WHERE 回调时，用列头筛选条件在客户端过滤当前结果集
      if (exportScope === 'queryResult' && filterConditions.length > 0) {
          return filterRowsByGridConditions(rowsBeforeClientFilter, filterConditions);
      }
      return rowsBeforeClientFilter;
  }, [exportScope, filterConditions, rowsBeforeClientFilter]);

  useEffect(() => {
      displayDataRef.current = displayData;

      if (selectionResetSourceDataRef.current === data) {
          if (currentSelectionRef.current.size === 0 && selectedCells.size === 0) {
              selectionResetSourceDataRef.current = null;
          } else {
              return;
          }
      }

      const activeSelection = currentSelectionRef.current.size > 0
          ? currentSelectionRef.current
          : selectedCells;
      if (activeSelection.size === 0) return;

      const nextRowIndexMap = new Map<string, number>();
      displayData.forEach((row, index) => {
          const rowKey = row?.[GONAVI_ROW_KEY];
          if (rowKey === undefined || rowKey === null) return;
          nextRowIndexMap.set(String(rowKey), index);
      });
      rowIndexMapRef.current = nextRowIndexMap;

      const visibleSelection = filterDataGridCellSelectionToVisibleRows({
          cellKeys: activeSelection,
          rows: displayData,
      });

      const previousAnchor = selectionStartRef.current;
      const nextAnchor = resolveDataGridCellSelectionAnchor({
          cellKeys: visibleSelection,
          rows: displayData,
          columnNames: displayColumnNames,
          preferredAnchor: previousAnchor,
      });
      const anchorChanged = previousAnchor?.rowKey !== nextAnchor?.rowKey
          || previousAnchor?.colName !== nextAnchor?.colName
          || previousAnchor?.rowIndex !== nextAnchor?.rowIndex
          || previousAnchor?.colIndex !== nextAnchor?.colIndex;
      selectionStartRef.current = nextAnchor;

      if (visibleSelection.size === 0) {
          resetCellSelection();
          return;
      }

      if (visibleSelection.size === activeSelection.size) {
          if (anchorChanged) updateCellSelection(visibleSelection);
          return;
      }

      currentSelectionRef.current = visibleSelection;
      setSelectedCells(visibleSelection);
      updateCellSelection(visibleSelection);
  }, [GONAVI_ROW_KEY, currentSelectionRef, data, displayColumnNames, displayData, filterDataGridCellSelectionToVisibleRows, resetCellSelection, resolveDataGridCellSelectionAnchor, rowIndexMapRef, selectedCells, selectionStartRef, updateCellSelection]);

  const pendingChangeCount = addedRows.length + Object.keys(modifiedRows).length + deletedRowKeys.size;
  const hasChanges = pendingChangeCount > 0;
  const dataEditCommitMode = dataEditTransactionOptions?.commitMode === 'auto' ? 'auto' : 'manual';
  const dataEditAutoCommitDelayMs = DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS.some((item) => item.value === dataEditTransactionOptions?.autoCommitDelayMs)
      ? Number(dataEditTransactionOptions?.autoCommitDelayMs)
      : 5000;
  const [autoCommitRemainingSeconds, setAutoCommitRemainingSeconds] = useState<number | null>(null);
  const autoCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCommitCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoCommitChangeTokenRef = useRef(0);
  const autoCommitFailedTokenRef = useRef(-1);
  const clearAutoCommitTimer = useCallback(() => {
      if (autoCommitTimerRef.current) {
          clearTimeout(autoCommitTimerRef.current);
          autoCommitTimerRef.current = null;
      }
      if (autoCommitCountdownRef.current) {
          clearInterval(autoCommitCountdownRef.current);
          autoCommitCountdownRef.current = null;
      }
      setAutoCommitRemainingSeconds(null);
  }, []);

  const visibleSelectedCells = useMemo(
      () => filterDataGridCellSelectionToVisibleRows({
          cellKeys: selectedCells,
          rows: displayData,
      }),
      [displayData, selectedCells],
  );
  const selectedCellCount = canUseCellSelectionAsFillTemplateTargets
      ? visibleSelectedCells.size
      : 0;
  const selectedCellRowCount = useMemo(
      () => collectDataGridCellSelectionRowKeys(visibleSelectedCells).length,
      [visibleSelectedCells],
  );
  // Cell selection represents rows independently from the table checkbox
  // selection. Use the same eligibility/source guard as other edit actions so
  // Page Find's focused cell does not appear as a data selection in the footer.
  const hasUserCellSelection = cellSelectionUserSourceDataRef.current === data;
  const selectedRowCount = hasUserCellSelection && visibleSelectedCells.size > 0
      ? selectedCellRowCount
      : selectedRowKeys.length;
  const fillTemplateTargetRowCount = useMemo(
      () => copiedCellPatch
          ? collectDataGridFillTemplateTargetRowKeys({
              selectedRowKeys,
              selectedCellKeys: canUseCellSelectionAsFillTemplateTargets ? selectedCells : [],
              sourceRowKey: copiedCellPatch.sourceRowKey,
              rowKeyToString: rowKeyStr,
          }).length
          : 0,
      [canUseCellSelectionAsFillTemplateTargets, copiedCellPatch, rowKeyStr, selectedCells, selectedRowKeys],
  );
  const selectedCellRowKeys = useMemo(
      () => cellEditMode
          && cellSelectionDeleteEligible
          && cellSelectionSourceDataRef.current === data
          ? collectDataGridCellSelectionRowKeys(selectedCells)
          : [],
      [cellEditMode, cellSelectionDeleteEligible, data, selectedCells],
  );
  const deleteTargetRowKeys = useMemo(
      () => selectedRowKeys.length > 0
          ? selectedRowKeys.map(key => rowKeyStr(key))
          : selectedCellRowKeys,
      [rowKeyStr, selectedCellRowKeys, selectedRowKeys],
  );
  const deleteTargetRowCount = deleteTargetRowKeys.length;
  const allSelectedAreDeleted = useMemo(() => {
      if (deleteTargetRowKeys.length === 0) return false;
      return deleteTargetRowKeys.every(key => deletedRowKeys.has(key));
  }, [deleteTargetRowKeys, deletedRowKeys]);

  const addedRowKeySet = useMemo(() => {
      const next = new Set<string>();
      addedRows.forEach((row) => {
          const key = row?.[GONAVI_ROW_KEY];
          if (key === undefined || key === null) return;
          next.add(rowKeyStr(key));
      });
      return next;
  }, [addedRows, rowKeyStr]);

  const modifiedRowKeySet = useMemo(() => new Set(Object.keys(modifiedRows)), [modifiedRows]);
  useEffect(() => {
      autoCommitChangeTokenRef.current += 1;
      autoCommitFailedTokenRef.current = -1;
  }, [addedRows, modifiedRows, deletedRowKeys]);

  const rowClassName = useCallback((record: Item) => {
      const k = record?.[GONAVI_ROW_KEY];
      if (k === undefined || k === null) return '';
      const keyStr = rowKeyStr(k);
      if (addedRowKeySet.has(keyStr)) return 'row-added';
      if (deletedRowKeys.has(keyStr)) return 'row-deleted';
      if (modifiedRowKeySet.has(keyStr)) return 'row-modified';
      return '';
  }, [addedRowKeySet, modifiedRowKeySet, deletedRowKeys, rowKeyStr]);

  const handleTableChange = useCallback((_pag: any, _filtersArg: any, sorter: any) => {
      if (isResizingRef.current) return; // Block sort if resizing
      const next = resolveGridSortInfoFromTableSorter({ sorter });
      setSortInfo(next);
      if (onSort) onSort(JSON.stringify(next), '');
  }, [onSort]);

  const applySortInfo = useCallback((next: Array<{ columnKey: string, order: string, enabled?: boolean }>) => {
      setSortInfo(next);
      if (onSort) onSort(JSON.stringify(next), '');
  }, [onSort]);

  const applyColumnSort = useCallback((columnName: string, order: 'ascend' | 'descend' | null) => {
      const normalizedName = String(columnName || '').trim();
      if (!normalizedName) return;
      const next = sortInfo.filter((item) => item.columnKey !== normalizedName);
      if (order) {
          next.push({ columnKey: normalizedName, order, enabled: true });
      }
      applySortInfo(next);
  }, [applySortInfo, sortInfo]);

  const {
      autoFitColumnWidth,
      handleResizeAutoFit,
      handleResizeStart,
      isResizingRef,
  } = useDataGridColumnResize({
      columnMetaMap,
      columnMetaMapByLowerName,
      columnWidths,
      containerRef,
      dataTableDensity,
      densityParams,
      displayColumnNames,
      displayData,
      displayDataRef,
      setColumnWidths,
      showColumnComment,
      showColumnType,
  });

  const handleCellSave = useCallback((row: any) => {
      const rowKey = row?.[GONAVI_ROW_KEY];
      if (rowKey === undefined) return;
      const keyStr = rowKeyStr(rowKey);
      const isAdded = addedRows.some(r => r?.[GONAVI_ROW_KEY] === rowKey);
      if (isAdded) {
          const currentAddedRow = addedRows.find(r => r?.[GONAVI_ROW_KEY] === rowKey);
          const normalizedRow = normalizeMongoEditedRow(row, currentAddedRow);
          setAddedRows(prev => prev.map(r => r?.[GONAVI_ROW_KEY] === rowKey ? { ...r, ...normalizedRow } : r));
          return;
      }
      if (deletedRowKeys.has(keyStr)) return;
      // 查找原始行数据，对比是否真正有值变更
      const originalRow = baseData.find(r => r?.[GONAVI_ROW_KEY] === rowKey);
      if (originalRow) {
          const currentRow = modifiedRows[keyStr] ? { ...originalRow, ...modifiedRows[keyStr] } : originalRow;
          const normalizedRow = normalizeMongoEditedRow(row, currentRow);
          const changedFields: Record<string, any> = {};
          for (const col of Object.keys(normalizedRow)) {
              if (col === GONAVI_ROW_KEY) continue;
              if (!isWritableResultColumn(col, effectiveEditLocator)) continue;
              if (!isCellValueEqualForDiff(originalRow[col], normalizedRow[col])) {
                  changedFields[col] = normalizedRow[col];
              }
          }
          if (Object.keys(changedFields).length === 0) {
              // 没有实际变更，从 modifiedRows 中移除该行
              setModifiedRows(prev => {
                  if (!(keyStr in prev)) return prev;
                  const next = { ...prev };
                  delete next[keyStr];
                  return next;
              });
              // 同时清除该行的 modifiedColumns
              setModifiedColumns(prev => {
                  if (!(keyStr in prev)) return prev;
                  const next = { ...prev };
                  delete next[keyStr];
                  return next;
              });
              return;
          }
          // 更新 modifiedColumns：记录所有变更的列
          setModifiedColumns(prev => {
              const newCols = new Set(Object.keys(changedFields));
              // 如果和之前一样，避免不必要的 state 更新
              if (prev[keyStr] && prev[keyStr].size === newCols.size &&
                  [...newCols].every(c => prev[keyStr].has(c))) {
                  return prev;
              }
              return { ...prev, [keyStr]: newCols };
          });
          setModifiedRows(prev => ({ ...prev, [keyStr]: normalizedRow }));
      }
  }, [addedRows, baseData, rowKeyStr, deletedRowKeys, effectiveEditLocator, modifiedRows, normalizeMongoEditedRow]);
  const handleCellSaveRef = useRef(handleCellSave);
  handleCellSaveRef.current = handleCellSave;

  const handleCellSetNull = useCallback(() => {
    const record = cellContextMenu.record;
    const dataIndex = String(cellContextMenu.dataIndex || '').trim();
    const rowKey = record?.[GONAVI_ROW_KEY];
    if (!record || !dataIndex || rowKey === undefined || rowKey === null) return;

    // The original contextual action batches when the clicked cell belongs to
    // an active range, while retaining single-cell fallback outside that range.
    // The separately labelled action always batches the current selection.
    handleSetNullForSelectedCells({ rowKey, colName: dataIndex });
  }, [GONAVI_ROW_KEY, cellContextMenu.dataIndex, cellContextMenu.record, handleSetNullForSelectedCells]);

  const canUndoContextMenuCellChange = useMemo(() => {
    const record = cellContextMenu.record;
    const dataIndex = String(cellContextMenu.dataIndex || '').trim();
    const rowKey = record?.[GONAVI_ROW_KEY];
    if (!record || !dataIndex || rowKey === undefined || rowKey === null) return false;
    const keyStr = rowKeyStr(rowKey);
    if (addedRowKeySet.has(keyStr)) return false;
    return !!modifiedColumns[keyStr]?.has(dataIndex);
  }, [addedRowKeySet, cellContextMenu.dataIndex, cellContextMenu.record, modifiedColumns, rowKeyStr]);

  const handleUndoContextMenuCellChange = useCallback(() => {
    const record = cellContextMenu.record;
    const dataIndex = String(cellContextMenu.dataIndex || '').trim();
    const rowKey = record?.[GONAVI_ROW_KEY];
    if (!record || !dataIndex || rowKey === undefined || rowKey === null) return;

    const keyStr = rowKeyStr(rowKey);
    if (addedRowKeySet.has(keyStr)) {
      void message.info(translateDataGrid('data_grid.message.undo_added_row_hint'));
      setCellContextMenu(prev => ({ ...prev, visible: false }));
      return;
    }
    if (!modifiedColumns[keyStr]?.has(dataIndex)) {
      setCellContextMenu(prev => ({ ...prev, visible: false }));
      return;
    }

    const originalRow = baseData.find((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === keyStr);
    if (!originalRow) {
      void message.error(translateDataGrid('data_grid.message.undo_cell_original_missing'));
      setCellContextMenu(prev => ({ ...prev, visible: false }));
      return;
    }

    handleCellSave({ ...record, [dataIndex]: originalRow[dataIndex] });
    setCellContextMenu(prev => ({ ...prev, visible: false }));
    void message.success(translateDataGrid('data_grid.message.undo_cell_success'));
  }, [addedRowKeySet, baseData, cellContextMenu.dataIndex, cellContextMenu.record, handleCellSave, modifiedColumns, rowKeyStr, translateDataGrid]);

  const handleCellEditorSave = useCallback(() => {
      if (!cellEditorMeta) return;
      const runtime = cellEditorRuntimeRef.current;
      if (!runtime.isActive || !isCellEditorSourceCurrent()) {
          closeCellEditor();
          return;
      }
      if (
          cellEditorMeta.readOnly
          || !runtime.canModifyData
          || !isWritableResultColumn(cellEditorMeta.dataIndex, runtime.effectiveEditLocator)
      ) {
          closeCellEditor();
          return;
      }
      const apply = cellEditorApplyRef.current;
      if (apply) {
          apply(cellEditorValue);
          closeCellEditor();
          return;
      }
      const nextRow: any = { ...cellEditorMeta.record, [cellEditorMeta.dataIndex]: cellEditorValue };
      handleCellSaveRef.current(nextRow);
      closeCellEditor();
  }, [cellEditorMeta, cellEditorValue, closeCellEditor, isCellEditorSourceCurrent]);

  const handleFormatJsonInEditor = useCallback(() => {
      if (!cellEditorIsJson) return;
      try {
          const obj = JSON.parse(cellEditorValue);
          setCellEditorValue(JSON.stringify(obj, null, 2));
      } catch (e: any) {
          const rawErrorMessage = e?.message || String(e);
          void message.error(translateDataGrid('data_grid.json_editor.invalid_format', { error: rawErrorMessage }));
      }
  }, [cellEditorIsJson, cellEditorValue, translateDataGrid]);

  const openVirtualInlineEditor = useCallback((record: Item, dataIndex: string, title: React.ReactNode) => {
      if (
          !record
          || !dataIndex
          || !isActive
          || !canModifyData
          || !isWritableResultColumn(dataIndex, effectiveEditLocator)
      ) {
          return;
      }
      const rowKey = record?.[GONAVI_ROW_KEY];
      if (rowKey === undefined || rowKey === null) return;

      closeVirtualInlineEditor();

      const raw = record?.[dataIndex];
      if (shouldOpenModalEditor(raw)) {
          openCellEditor(record, dataIndex, title);
          return;
      }

      const columnType = (columnMetaMap[dataIndex] || columnMetaMapByLowerName[dataIndex.toLowerCase()])?.type;
      const pickerType = getTemporalPickerType(columnType, dbType, currentConnConfig);
      const isDateTimeField = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(raw || '')));
      const fieldName = getCellFieldName(record, dataIndex);
      if (isDateTimeField) {
          setCellFieldValue(form, fieldName, parseToDayjs(raw, pickerType));
      } else {
          const initialValue = isMongoDBConnection
              ? mongoAwareEditableText(raw, dataIndex)
              : (typeof raw === 'string' ? normalizeDateTimeString(raw) : raw);
          setCellFieldValue(form, fieldName, initialValue);
      }
      const rowKeyText = rowKeyStr(rowKey);
      const sessionId = virtualEditingSessionSequenceRef.current + 1;
      virtualEditingSessionSequenceRef.current = sessionId;
      virtualEditingSessionRef.current = {
          sessionId,
          sourceData: data,
          connectionId,
          dbName,
          tableName,
          rowKey: rowKeyText,
          dataIndex,
      };
      setVirtualEditingCell({
          sessionId,
          rowKey: rowKeyText,
          dataIndex,
          title,
          columnType,
      });
  }, [canModifyData, closeVirtualInlineEditor, columnMetaMap, columnMetaMapByLowerName, connectionId, currentConnConfig, data, dbName, dbType, effectiveEditLocator, form, isActive, isMongoDBConnection, mongoAwareEditableText, openCellEditor, rowKeyStr, tableName]);

  const handleVirtualCellActivate = useCallback((record: Item, dataIndex: string, title: React.ReactNode) => {
      if (!canModifyData) return;
      openVirtualInlineEditor(record, dataIndex, title);
  }, [canModifyData, openVirtualInlineEditor]);

  const handleVirtualCellContextMenu = useCallback((e: React.MouseEvent, record: Item, dataIndex: string) => {
      e.preventDefault();
      e.stopPropagation();
      showCellContextMenu(e, record, dataIndex, dataIndex);
  }, [showCellContextMenu]);

  // Merge Data for Display
  // 'displayData' already merges addedRows. 
  // We need to merge modifiedRows into it for rendering.
  const mergedDisplayData = useMemo(() => {
      return displayData.map(row => {
          const k = row?.[GONAVI_ROW_KEY];
          const keyStr = k !== undefined ? rowKeyStr(k) : undefined;
          let result = row;
          if (keyStr !== undefined && modifiedRows[keyStr]) {
              result = { ...row, ...modifiedRows[keyStr] };
          }
          if (keyStr !== undefined && deletedRowKeys.has(keyStr)) {
              // 为已删除行创建新对象引用，确保 Ant Design 数据源检测到变化并触发行重渲染
              // 仅当 result 尚未被 modifiedRows 分支重新分配时才创建新引用
              result = result === row ? { ...row } : result;
          }
          return result;
      });
  }, [displayData, modifiedRows, deletedRowKeys]);
  mergedDisplayDataRef.current = mergedDisplayData;
  const {
      dataPanelOpen,
      dataPanelOpenRef,
      focusedCellInfo,
      dataPanelValue,
      setDataPanelValue,
      dataPanelIsJson,
      dataPanelDirtyRef,
      dataPanelOriginalRef,
      toggleDataPanel,
      updateFocusedCell,
      handleDataPanelFormatJson,
  } = useDataGridPreviewPanel({
      previewAvailable: mergedDisplayData.length > 0,
      toEditableText: mongoAwareEditableText,
      looksLikeJsonText,
      normalizeDateTimeString,
  });
  const focusedCellWritable = useMemo(() => (
      canModifyData &&
      !!focusedCellInfo &&
      isWritableResultColumn(focusedCellInfo.dataIndex, effectiveEditLocator)
  ), [canModifyData, focusedCellInfo, effectiveEditLocator]);
  const handleDataPanelSave = useCallback((): boolean => {
      if (!focusedCellInfo) return false;
      if (!focusedCellWritable) {
          void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
          return false;
      }
      // 与 updateFocusedCell 设置的原始值比较，避免幽灵变更
      if (dataPanelValue === dataPanelOriginalRef.current) {
          dataPanelDirtyRef.current = false;
          void message.info(translateDataGrid('data_grid.message.no_data_changes'));
          return true;
      }
      const nextRow: any = { ...focusedCellInfo.record, [focusedCellInfo.dataIndex]: dataPanelValue };
      handleCellSave(nextRow);
      dataPanelOriginalRef.current = dataPanelValue;
      dataPanelDirtyRef.current = false;
      void message.success(translateDataGrid('data_grid.message.saved'));
      return true;
  }, [focusedCellInfo, focusedCellWritable, dataPanelValue, handleCellSave, translateDataGrid]);
  const lastReportedDataFingerprintRef = useRef('');
  useEffect(() => {
      if (!onDataChange) return;
      const currentRows = mergedDisplayData.filter((row) => {
          const rowKey = row?.[GONAVI_ROW_KEY];
          return rowKey === undefined || !deletedRowKeys.has(rowKeyStr(rowKey));
      });
      // A hidden column is still part of the result snapshot. Only presentation
      // uses displayOutputColumnNames; detach/attach state must keep full rows.
      const outputRows = pickDataGridOutputRows(currentRows, dataChangeOutputColumnNames);
      const fingerprint = JSON.stringify(outputRows);
      if (fingerprint === lastReportedDataFingerprintRef.current) return;
      lastReportedDataFingerprintRef.current = fingerprint;
      onDataChange(outputRows);
  }, [dataChangeOutputColumnNames, deletedRowKeys, mergedDisplayData, onDataChange, rowKeyStr]);

  const dataSourceContextKey = useMemo(
      () => `${connectionId || ''}\u0001${dbName || ''}\u0001${tableName || ''}\u0001${resolvedDdlDbName || ''}\u0001${resolvedDdlTableName || ''}\u0001${connectionParamsOverride || ''}`,
      [connectionId, connectionParamsOverride, dbName, resolvedDdlDbName, resolvedDdlTableName, tableName],
  );
  const previousDataSourceContextKeyRef = useRef<string | null>(null);

  // Reset local state when data source likely changes (e.g. tableName change)
  useEffect(() => {
      const previousContextKey = previousDataSourceContextKeyRef.current;
      const contextChanged = previousContextKey !== dataSourceContextKey;
      previousDataSourceContextKeyRef.current = dataSourceContextKey;
      if (!contextChanged) return;

      setAddedRows([]);
      setModifiedRows({});
      setDeletedRowKeys(new Set());
      setModifiedColumns({});
      setSelectedRowKeys([]);
      resetCellSelection();
      setCopiedCellPatch(null);
      setCopiedRowsForPaste([]);
      closeRowEditor();
      const shouldKeepOpenV2DdlView = previousContextKey !== null
          && isV2Ui
          && viewMode === 'ddl'
          && canViewDdl
          && !!currentConnConfig
          && !!resolvedDdlTableName;
      if (!shouldKeepOpenV2DdlView && previousContextKey !== null) {
          resetDdlViewState();
      }
      closeVirtualInlineEditor();
      closeCellEditor();
      formRef.current.resetFields();
  }, [
      canViewDdl,
      closeCellEditor,
      closeRowEditor,
      closeVirtualInlineEditor,
      currentConnConfig,
      dataSourceContextKey,
      isV2Ui,
      resetCellSelection,
      resetDdlViewState,
      resolvedDdlTableName,
      viewMode,
  ]); // Reset on context change

  const mergedDisplayDataByRowKey = useMemo(() => {
      const next = new Map<string, Item>();
      mergedDisplayData.forEach((row) => {
          const key = row?.[GONAVI_ROW_KEY];
          if (key === undefined || key === null) return;
          next.set(rowKeyStr(key), row);
      });
      return next;
  }, [mergedDisplayData, rowKeyStr]);
  const mergedDisplayDataByRowKeyRef = useRef(mergedDisplayDataByRowKey);
  mergedDisplayDataByRowKeyRef.current = mergedDisplayDataByRowKey;

  const resolveRenderedCellInfoFromElement = useCallback((target: EventTarget | null) => {
      const closestSource = target && typeof target === 'object' && 'closest' in target
          ? target as { closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null }
          : null;
      const element = typeof closestSource?.closest === 'function'
          ? closestSource.closest('[data-row-key][data-col-name]')
          : null;
      if (!element) {
          return null;
      }
      const rowKey = element.getAttribute?.('data-row-key');
      const dataIndex = element.getAttribute?.('data-col-name');
      if (rowKey === null || rowKey === undefined || rowKey === '' || dataIndex === null || dataIndex === undefined) {
          return null;
      }
      const record = mergedDisplayDataByRowKeyRef.current.get(rowKey);
      if (!record) {
          return null;
      }
      return { rowKey, dataIndex, record };
  }, []);

  const handleSharedCellContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
      const eventTarget = (event.currentTarget as EventTarget | null) ?? event.target;
      const cellInfo = resolveRenderedCellInfoFromElement(eventTarget);
      if (!cellInfo) return;
      event.preventDefault();
      event.stopPropagation();
      showCellContextMenu(event, cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
  }, [resolveRenderedCellInfoFromElement, showCellContextMenu]);

  const handleSharedCellDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
      const eventTarget = (event.currentTarget as EventTarget | null) ?? event.target;
      const cellInfo = resolveRenderedCellInfoFromElement(eventTarget);
      if (!cellInfo) return;
      event.preventDefault();
      event.stopPropagation();
      openCellViewer(cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
  }, [openCellViewer, resolveRenderedCellInfoFromElement]);

  const handleVirtualTableClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      if (!dataPanelOpenRef.current) return;
      const cellInfo = resolveRenderedCellInfoFromElement(event.target);
      if (!cellInfo) return;
      updateFocusedCell(cellInfo.record, cellInfo.dataIndex);
  }, [resolveRenderedCellInfoFromElement, updateFocusedCell]);

  const handleVirtualTableDoubleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      const eventTarget = event.target && typeof event.target === 'object' && 'closest' in event.target
          ? event.target as { closest?: (selector: string) => unknown }
          : null;
      if (typeof eventTarget?.closest === 'function' && eventTarget.closest('.data-grid-virtual-inline-editing')) {
          return;
      }
      const cellInfo = resolveRenderedCellInfoFromElement(event.target);
      if (!cellInfo) return;
      const rowDeleted = cellInfo.record?.[GONAVI_ROW_KEY] !== undefined
          ? deletedRowKeys.has(rowKeyStr(cellInfo.record[GONAVI_ROW_KEY]))
          : false;
      if (rowDeleted) {
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!canModifyData || !isWritableResultColumn(cellInfo.dataIndex, effectiveEditLocator)) {
          openCellViewer(cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
          return;
      }
      handleVirtualCellActivate(cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
  }, [canModifyData, deletedRowKeys, effectiveEditLocator, handleVirtualCellActivate, openCellViewer, resolveRenderedCellInfoFromElement, rowKeyStr]);

  const handleVirtualTableContextMenuCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      const cellInfo = resolveRenderedCellInfoFromElement(event.target);
      if (!cellInfo) return;
      event.preventDefault();
      event.stopPropagation();
      showCellContextMenu(event, cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
  }, [resolveRenderedCellInfoFromElement, showCellContextMenu]);

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
      updateCellSelection(emptySelection);
  }, [markCellSelectionUserSelection, normalizedPageFindText, updateCellSelection]);

  const activePageFindPosition = activePageFindMatchIndex >= 0 && activePageFindMatchIndex < pageFindMatches.length
      ? activePageFindMatchIndex + 1
      : 0;

  const displayRenderVersion = useMemo(() => (
      `${isV2Ui ? 'v2' : 'legacy'}|${theme}|${dataTableDensity}|${effectiveUiScale}`
  ), [dataTableDensity, effectiveUiScale, isV2Ui, theme]);

  const tableRenderData = useMemo(
      () => attachDataGridVirtualEditRenderVersion(
          attachDataGridDisplayRenderVersion(
              attachDataGridFindRenderVersion(mergedDisplayData, normalizedPageFindText),
              displayRenderVersion,
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
                  if (!isV2Ui) return;
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
  }, [canModifyData, cellEditMode, columnWidths, currentConnConfig, dataTableDensity, displayColumnNames, displayColumnTypeMap, effectiveEditLocator, enableVirtual, handleResizeAutoFit, handleResizeStart, isV2Ui, language, normalizedPageFindText, onSort, pinnedLeftColumnSet, renderColumnTitle, reorderVisibleColumns, selectEditableColumnCells, showColumnComment, showColumnHeaderContextMenu, showColumnType, sortInfo]);

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
              const shouldUsePlainVirtualContent = isV2Ui;
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
                  if (shouldUsePlainVirtualContent) {
                      return originalRenderContent;
                  }
                  return <div style={virtualCellWrapperStyle}>{originalRenderContent}</div>;
              }
              if (enableVirtual) {
                  if (shouldUsePlainVirtualContent) {
                      return originalRenderContent;
                  }
                  return <div style={virtualCellWrapperStyle}>{originalRenderContent}</div>;
              }
              return originalRenderContent;
          }
      };
  }), [cancelVirtualInlinePickerInteraction, closeVirtualInlineEditor, columns, commitVirtualInlinePickerValue, currentConnConfig, dbType, deletedRowKeys, displayColumnTypeMap, enableInlineEditableCell, enableVirtual, form, handleCellSave, handleSharedCellContextMenu, handleSharedCellDoubleClick, handleVirtualCellActivate, inputCellPadding, isVirtualEditingSessionCurrent, lockVirtualInlineTableScroll, modifiedColumns, openCellEditor, rowKeyStr, saveVirtualInlineEditor, scheduleVirtualInlinePickerInteraction, updateFocusedCell, useInlineEditableBodyCell, virtualCellWrapperStyle, virtualEditingCellForRender]);

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

  const handleRowNumberDoubleClick = useCallback((index: number) => {
      handleViewModeChange('text', { textRecordIndex: index });
  }, [handleViewModeChange]);

  const rowNumberColumn = useMemo<ColumnType<any>>(() => ({
      title: (
          <div
              className="gn-v2-column-title is-single-line"
              data-grid-row-number-title="true"
              data-grid-column-title-single-line="true"
              style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 0,
                  width: '100%',
                  maxWidth: '100%',
                  minHeight: 'var(--gonavi-header-min-height, 40px)',
                  lineHeight: 1.2,
                  textAlign: 'center',
              }}
          >
              {/* 序号列默认固定，不展示 📌，仅用户钉住的数据列显示图标 */}
              <span aria-label={translateDataGrid('data_grid.aria.row_number')}>#</span>
          </div>
      ),
      key: GONAVI_ROW_NUMBER_COLUMN_KEY,
      dataIndex: GONAVI_ROW_NUMBER_COLUMN_KEY,
      width: rowNumberColumnWidth,
      className: 'data-grid-row-number-cell',
      align: 'center',
      // 横向滚动时固定在左侧；支持拖拽调宽，不参与排序
      fixed: 'left' as const,
      sorter: false,
      ellipsis: false,
      onHeaderCell: () => ({
          // 无 id → 不参与列拖拽排序；有 width + onResizeStart → 可拖列宽
          className: 'data-grid-row-number-cell ant-table-cell-fix-left',
          width: rowNumberColumnWidth,
          onResizeStart: handleResizeStart(GONAVI_ROW_NUMBER_COLUMN_KEY),
          onResizeAutoFit: handleResizeAutoFit(GONAVI_ROW_NUMBER_COLUMN_KEY),
          style: {
              textAlign: 'center' as const,
              paddingInline: 2,
              verticalAlign: 'middle' as const,
              width: rowNumberColumnWidth,
              minWidth: 28,
          },
      }),
      onCell: (record: Item, index?: number) => ({
          'data-grid-row-number-action': 'true',
          style: {
              width: rowNumberColumnWidth,
              minWidth: 28,
              padding: 0,
              textAlign: 'center' as const,
            },
          onClick: (event: React.MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              handleRowNumberClick(record);
          },
          onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
              event.preventDefault();
              event.stopPropagation();
              handleRowNumberDoubleClick(index ?? 0);
          },
      }),
      render: (_value: unknown, _record: Item, index: number) => {
          const currentPage = Math.max(1, Number(pagination?.current) || 1);
          const pageSize = Math.max(1, Number(pagination?.pageSize) || 0);
          const offset = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
          return (
              <Tooltip title={translateDataGrid('data_grid.row_number.double_click_to_view')}>
                  <span
                      className="data-grid-row-number"
                      data-grid-row-number="true"
                      style={{
                          display: 'flex',
                          width: '100%',
                          height: '100%',
                          minHeight: 24,
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                      }}
                      onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleRowNumberDoubleClick(index);
                      }}
                  >
                      {offset + index + 1}
                  </span>
              </Tooltip>
          );
      },
  }), [handleResizeAutoFit, handleResizeStart, handleRowNumberClick, handleRowNumberDoubleClick, pagination?.current, pagination?.pageSize, rowNumberColumnWidth, translateDataGrid]);

  const tableColumns = useMemo(() => {
      const baseColumns = resolvedShowRowNumberColumn
          ? [rowNumberColumn, ...mergedColumns]
          : mergedColumns;
      // 少列时把视口多余宽度只加到数据列，避免行号列被 rc-table 均摊撑宽
      const fixedKeys = [
          ...(resolvedShowRowNumberColumn ? [GONAVI_ROW_NUMBER_COLUMN_KEY] : []),
          ...pinnedLeftColumnNames,
      ];
      return absorbExtraWidthIntoFlexibleColumns({
          columns: baseColumns,
          selectionColumnWidth,
          tableViewportWidth,
          fixedColumnKeys: fixedKeys,
          defaultColumnWidth: densityParams.defaultColumnWidth,
      });
  }, [
      densityParams.defaultColumnWidth,
      mergedColumns,
      pinnedLeftColumnNames,
      resolvedShowRowNumberColumn,
      rowNumberColumn,
      selectionColumnWidth,
      tableViewportWidth,
  ]);

  const handleAddRow = () => {
      const newKey = `new-${Date.now()}`;
      const newRow: any = { [GONAVI_ROW_KEY]: newKey };
      visibleColumnNames.forEach(col => newRow[col] = '');
      pendingScrollToBottomRef.current = true;
      setAddedRows(prev => [...prev, newRow]);
  };

  const copyRowsForPaste = useCallback((keys: React.Key[]) => {
      if (keys.length === 0) {
          void message.info(translateDataGrid('data_grid.message.select_rows_to_copy'));
          return;
      }
      const copiedRows = buildCopiedRowsForPaste({
          rows: mergedDisplayData as Array<Record<string, any>>,
          selectedRowKeys: keys,
          columnNames: displayOutputColumnNames.filter((columnName) => isWritableResultColumn(columnName, effectiveEditLocator)),
          rowKeyField: GONAVI_ROW_KEY,
          rowKeyToString: rowKeyStr,
      });
      if (copiedRows.length === 0) {
          void message.info(translateDataGrid('data_grid.message.no_copyable_rows'));
          return;
      }

      setCopiedRowsForPaste(copiedRows);
      void message.success(translateDataGrid('data_grid.message.copied_rows', { count: copiedRows.length }));
  }, [mergedDisplayData, displayOutputColumnNames, rowKeyStr, effectiveEditLocator, translateDataGrid]);

  const handleCopySelectedRowsForPaste = useCallback(() => {
      copyRowsForPaste(selectedRowKeys);
  }, [copyRowsForPaste, selectedRowKeys]);

  const handlePasteCopiedRowsAsNew = useCallback(() => {
      if (copiedRowsForPaste.length === 0) {
          void message.info(translateDataGrid('data_grid.message.copy_rows_first'));
          return;
      }

      const nextRows = buildPastedRowsFromCopiedRows({
          rows: copiedRowsForPaste,
          columnNames: displayOutputColumnNames.filter((columnName) => isWritableResultColumn(columnName, effectiveEditLocator)),
          rowKeyField: GONAVI_ROW_KEY,
          createRowKey: (index) => {
              pastedRowSequenceRef.current += 1;
              return `paste-${Date.now()}-${pastedRowSequenceRef.current}-${index}`;
          },
      });
      if (nextRows.length === 0) {
          void message.info(translateDataGrid('data_grid.message.no_pasteable_rows'));
          return;
      }

      pendingScrollToBottomRef.current = true;
      setAddedRows(prev => [...prev, ...nextRows]);
      setSelectedRowKeys(nextRows.map(row => row[GONAVI_ROW_KEY]));
      void message.success(translateDataGrid('data_grid.message.pasted_rows_as_new', { count: nextRows.length }));
  }, [copiedRowsForPaste, displayOutputColumnNames, effectiveEditLocator, translateDataGrid]);

  const handleDeleteSelected = () => {
      const addedKeysToRemove: string[] = [];
      const baseKeysToDelete: string[] = [];
      for (const keyStr of deleteTargetRowKeys) {
          if (addedRowKeySet.has(keyStr)) {
              addedKeysToRemove.push(keyStr);
          } else if (!deletedRowKeys.has(keyStr)) {
              baseKeysToDelete.push(keyStr);
          }
      }

      if (addedKeysToRemove.length > 0) {
          const removeSet = new Set(addedKeysToRemove);
          setAddedRows(prev => prev.filter(row => {
              const k = row?.[GONAVI_ROW_KEY];
              return k === undefined || k === null || !removeSet.has(rowKeyStr(k));
          }));
      }
      if (baseKeysToDelete.length > 0) {
          setDeletedRowKeys(prev => {
              const newDeleted = new Set(prev);
              baseKeysToDelete.forEach(key => newDeleted.add(key));
              return newDeleted;
          });
      }
      setSelectedRowKeys([]);
      if (cellEditMode) resetCellSelection();
  };

  const handleUndoDeleteSelected = () => {
      setDeletedRowKeys(prev => {
          const newDeleted = new Set(prev);
          deleteTargetRowKeys.forEach(key => newDeleted.delete(key));
          return newDeleted;
      });
      setSelectedRowKeys([]);
      if (cellEditMode) resetCellSelection();
  };

  const handlePreviewChanges = useCallback(async () => {
      if (!connectionId || !tableName) return;
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return;
      const changeSetResult = buildDataGridCommitChangeSet({
          addedRows,
          modifiedRows,
          deletedRowKeys,
          data: baseData,
          editLocator: effectiveEditLocator,
          visibleColumnNames,
          rowKeyToString: rowKeyStr,
          normalizeCommitCellValue,
          shouldCommitColumn,
          rowLocatorMessages,
      });
      if (!changeSetResult.ok) {
          void message.error(changeSetResult.error
              ? translateDataGrid('data_grid.message.change_set_build_failed_detail', { detail: changeSetResult.error })
              : translateDataGrid('data_grid.message.change_set_build_failed'));
          return;
      }
      const { changes } = changeSetResult;
      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      try {
          const res = await PreviewChanges(buildRpcConnectionConfig(config) as any, dbName || '', tableName, {
              inserts: changes.inserts,
              updates: changes.updates,
              deletes: changes.deletes,
              locatorStrategy: effectiveEditLocator?.strategy || '',
          } as any);
          if (res.success) {
              const d = res.data as { deletes: string[]; updates: string[]; inserts: string[] };
              setPreviewSqlData({
                  deletes: d?.deletes || [],
                  updates: d?.updates || [],
                  inserts: d?.inserts || [],
              });
              setPreviewModalOpen(true);
          } else {
              void message.error(res.message
                  ? translateDataGrid('data_grid.message.preview_sql_failed_detail', { detail: res.message })
                  : translateDataGrid('data_grid.message.preview_sql_failed'));
          }
      } catch (e: any) {
          const rawErrorMessage = e?.message || String(e);
          void message.error(translateDataGrid('data_grid.message.preview_sql_failed_detail', { detail: rawErrorMessage }));
      }
  }, [addedRows, modifiedRows, deletedRowKeys, baseData, effectiveEditLocator,
      visibleColumnNames, rowKeyStr, normalizeCommitCellValue, shouldCommitColumn,
      connectionId, tableName, connections, rowLocatorMessages, translateDataGrid]);

  const handleCommit = useCallback(async (source: 'manual' | 'auto' = 'manual'): Promise<boolean> => {
      clearAutoCommitTimer();
      if (!connectionId || !tableName) return false;
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return false;
      const changeSetResult = buildDataGridCommitChangeSet({
          addedRows,
          modifiedRows,
          deletedRowKeys,
          data: baseData,
          editLocator: effectiveEditLocator,
          visibleColumnNames,
          rowKeyToString: rowKeyStr,
          normalizeCommitCellValue,
          shouldCommitColumn,
          rowLocatorMessages,
      });
      if (!changeSetResult.ok) {
          void message.error(changeSetResult.error
              ? translateDataGrid('data_grid.message.change_set_build_failed_detail', { detail: changeSetResult.error })
              : translateDataGrid('data_grid.message.change_set_build_failed'));
          return false;
      }

      const { inserts, updates, deletes } = changeSetResult.changes;
      if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
          void message.info(translateDataGrid('data_grid.message.no_changes_to_commit'));
          return true;
      }

      const config = { 
          ...conn.config, 
          port: Number(conn.config.port), 
          password: conn.config.password || "", 
          database: conn.config.database || "", 
          useSSH: conn.config.useSSH || false, 
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } 
      };

      const approved = await confirmProductionRisk({
          connection: conn,
          action: translateDataGrid('connection.production_risk.action.execute_sql'),
          target: [dbName, tableName].filter(Boolean).join(' / '),
          translate: translateDataGrid,
      });
      if (!approved) return false;
      
      const startTime = Date.now();
      const res = await ApplyChanges(buildRpcConnectionConfig(config) as any, dbName || '', tableName, { inserts, updates, deletes, locatorStrategy: effectiveEditLocator?.strategy } as any);
      const duration = Date.now() - startTime;
      
      const logSql = buildDataGridTransactionLog({
          dbType,
          tableName,
          preview: res.data,
          committed: res.success,
      });
      
      if (res.success) {
          autoCommitFailedTokenRef.current = -1;
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql.trim(),
              status: 'success',
              duration,
              message: res.message,
              dbName
          });
          setAddedRows([]);
          setModifiedRows({});
          setDeletedRowKeys(new Set());
          setModifiedColumns({});
          await onReload?.();
          void message.success(source === 'auto'
              ? translateDataGrid('data_grid.message.auto_commit_success')
              : translateDataGrid('data_grid.message.transaction_committed'));
          return true;
      } else {
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql.trim(),
              status: 'error',
              duration,
              message: res.message,
              dbName
          });
          if (source === 'auto') {
              autoCommitFailedTokenRef.current = autoCommitChangeTokenRef.current;
          }
          void message.error(source === 'auto'
              ? translateDataGrid('data_grid.message.auto_commit_failed', { detail: res.message })
              : translateDataGrid('data_grid.message.commit_failed', { detail: res.message }));
          return false;
      }
  }, [
      clearAutoCommitTimer,
      connectionId,
      tableName,
      connections,
      addedRows,
      modifiedRows,
      deletedRowKeys,
      baseData,
      effectiveEditLocator,
      visibleColumnNames,
      rowKeyStr,
      normalizeCommitCellValue,
      shouldCommitColumn,
      dbName,
      dbType,
      addSqlLog,
      onReload,
      translateDataGrid,
  ]);
  const handleCommitRef = useRef(handleCommit);
  handleCommitRef.current = handleCommit;

  useEffect(() => {
      if (!workbenchTabId) return undefined;
      return registerWorkbenchTabCloseGuard(workbenchTabId, {
          isDirty: () => hasChanges || dataPanelDirtyRef.current,
          save: async () => {
              if (dataPanelDirtyRef.current) {
                  const applied = flushSync(() => handleDataPanelSave());
                  if (!applied || dataPanelDirtyRef.current) return false;
              }
              return handleCommitRef.current('manual');
          },
          discard: () => {
              clearAutoCommitTimer();
              setAddedRows([]);
              setModifiedRows({});
              setDeletedRowKeys(new Set());
              setModifiedColumns({});
              setDataPanelValue(dataPanelOriginalRef.current);
              dataPanelDirtyRef.current = false;
          },
      });
  }, [clearAutoCommitTimer, handleDataPanelSave, hasChanges, setDataPanelValue, workbenchTabId]);

  useEffect(() => {
      if (!canModifyData || dataEditCommitMode !== 'auto' || !hasChanges) {
          clearAutoCommitTimer();
          return;
      }
      if (autoCommitFailedTokenRef.current === autoCommitChangeTokenRef.current) {
          clearAutoCommitTimer();
          return;
      }

      const delayMs = dataEditAutoCommitDelayMs;
      const dueAt = Date.now() + delayMs;
      const updateRemaining = () => {
          setAutoCommitRemainingSeconds(Math.max(1, Math.ceil((dueAt - Date.now()) / 1000)));
      };
      clearAutoCommitTimer();
      updateRemaining();
      autoCommitCountdownRef.current = setInterval(updateRemaining, 250);
      autoCommitTimerRef.current = setTimeout(() => {
          autoCommitTimerRef.current = null;
          if (autoCommitCountdownRef.current) {
              clearInterval(autoCommitCountdownRef.current);
              autoCommitCountdownRef.current = null;
          }
          setAutoCommitRemainingSeconds(null);
          void handleCommit('auto');
      }, delayMs);

      return clearAutoCommitTimer;
  }, [
      canModifyData,
      dataEditCommitMode,
      dataEditAutoCommitDelayMs,
      hasChanges,
      pendingChangeCount,
      handleCommit,
      clearAutoCommitTimer,
  ]);

  useEffect(() => clearAutoCommitTimer, [clearAutoCommitTimer]);

  const copyToClipboard = useCallback((value: string | DataGridClipboardPayload) => {
      const payload = typeof value === 'string' ? { plainText: value } : value;
      writeClipboardPayload(payload).catch(console.error);
      void message.success(translateDataGrid('data_grid.message.copied_to_clipboard'));
  }, [translateDataGrid]);

  const handleCopyContextMenuFieldName = useCallback(() => {
      const fieldName = resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title);
      if (!fieldName) {
          void message.info(translateDataGrid('data_grid.message.no_field_name'));
          return;
      }
      copyToClipboard(fieldName);
      setCellContextMenu(prev => ({ ...prev, visible: false }));
  }, [cellContextMenu.dataIndex, cellContextMenu.title, copyToClipboard, translateDataGrid]);

  const handleCopyColumnData = useCallback((columnName: string) => {
      const normalizedColumnName = String(columnName || '').trim();
      if (!normalizedColumnName || !displayOutputColumnNames.includes(normalizedColumnName)) {
          void message.info(translateDataGrid('data_grid.message.no_copyable_columns'));
          return;
      }
      if (mergedDisplayData.length === 0) {
          void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
          return;
      }

      const columnType = (columnMetaMap[normalizedColumnName] || columnMetaMapByLowerName[normalizedColumnName.toLowerCase()])?.type;
      const text = mergedDisplayData
          .map((row) => normalizeClipboardTsvCell(formatClipboardCellText(row?.[normalizedColumnName], columnType, currentConnConfig)))
          .join('\n');
      copyToClipboard(buildTabularClipboardPayloadFromTsv(text));
  }, [columnMetaMap, columnMetaMapByLowerName, copyToClipboard, currentConnConfig, displayOutputColumnNames, mergedDisplayData, translateDataGrid]);

  const {
    handleV2ColumnHeaderContextMenuAction,
    buildConnConfig,
    buildCopySqlBatchText,
    getTargets,
    handleCopyCsv,
    handleCopyDdl,
    handleCopyDelete,
    handleCopyInsert,
    handleCopyJson,
    handleCopyQueryResultCsv,
    handleCopyQueryResultJson,
    handleCopyQueryResultMarkdown,
    handleCopyRowData,
    handleCopySelectedCellsToClipboard,
    handleCopyUpdate,
    handleExportSelected,
    handleV2CellContextMenuAction,
    handleOpenExportDialog,
  } = useDataGridV2Actions({
    GONAVI_ROW_KEY,
    addTab,
    allTableColumnNames,
    applyColumnSort,
    autoFitColumnWidth,
    buildClipboardCsv,
    buildClipboardJson,
    buildClipboardMarkdown,
    buildClipboardTsv,
    buildCopyDeleteSQL,
    buildCopyInsertSQL,
    buildCopyUpdateSQL,
    buildDataGridSelectBaseSql,
    buildEffectiveFilterConditions,
    buildBackendExportOptions,
    buildOrderBySQL,
    buildPaginatedSelectSQL,
    buildRpcConnectionConfig,
    buildSelectedCellClipboardPayload,
    buildTableExportTab,
    buildWhereSQL,
    cellContextMenu,
    cellEditMode,
    canExportInsertSQL,
    closeCellEditMode,
    columnMetaMap,
    columnMetaMapByLowerName,
    columnTypeMapByLowerName,
    connectionId,
    connections,
    copiedCellPatch,
    copyRowsForPaste,
    copyToClipboard,
    currentConnConfig,
    currentSelectionRef,
    dbName,
    dbType,
    ddlText,
    displayColumnNames,
    displayData,
    displayDataRef,
    displayOutputColumnNames,
    escapeLiteral,
    exportData,
    filterConditions,
    handleBatchFillToSelected,
    handleCellSetNull,
    handleSetNullForSelectedCells,
    handleCopyColumnData,
    handleCopyContextMenuFieldName,
    handleOpenContextMenuRowEditor,
    handlePasteCopiedColumnsToSelectedRows,
    handlePasteCopiedRowsAsNew,
    handleUndoContextMenuCellChange,
    hasChanges,
    hasExplicitSort,
    hasFilteredExportSql,
    isActive,
    isTableSurfaceActive,
    isQueryResultExport,
    mergedDisplayData,
    modal,
    navigator: globalThis.navigator,
    objectType,
    pagination,
    pickDataGridOutputRows,
    pickRowsForClipboard,
    pkColumns,
    quickWhereCondition,
    quoteIdentPart,
    resetCellSelection,
    resolveContextMenuFieldName,
    resolveDataSourceType,
    resultExportAllSql,
    resultSql,
    rootRef,
    rowKeyStr,
    runExportWithProgress,
    selectedCells,
    selectedRowKeys,
    selectedRowKeysRef,
    setCellContextMenu,
    setQueryOptions,
    setSelectedRowKeys,
    sortInfo,
    splitCellKey,
    supportsCopyInsert,
    supportsSqlQueryExport,
    tableName,
    pinnedLeftColumnScope,
    toggleColumnVisibility,
    pinnedLeftColumnNames,
    setTablePinnedLeftColumns,
    translateDataGrid,
    uniqueKeyGroups,
    withSortBufferTuningSQL,
  });

  const handleImport = async () => {
      if (!connectionId || !tableName) return;
      const config = buildConnConfig();
      if (!config) return;

      const res = await ImportData(buildRpcConnectionConfig(config) as any, dbName || '', tableName);
      if (res.success && res.data && res.data.filePath) {
          setImportFilePath(res.data.filePath);
          setImportPreviewVisible(true);
      } else if (res.message !== "已取消") {
          void message.error(translateDataGrid('data_grid.message.select_file_failed', { detail: res.message }));
      }
  };

  const handleImportSuccess = async () => {
      setImportPreviewVisible(false);
      setImportFilePath('');
      await onReload?.();
      void message.success(translateDataGrid('data_grid.message.import_done'));
  };

  const queryResultCopyMenu: MenuProps['items'] = [
      { key: 'csv', label: 'CSV', onClick: handleCopyQueryResultCsv },
      { key: 'json', label: 'JSON', onClick: handleCopyQueryResultJson },
      { key: 'markdown', label: 'Markdown', onClick: handleCopyQueryResultMarkdown },
  ];
  const canCopyQueryResult = isQueryResultExport && mergedDisplayData.length > 0 && displayOutputColumnNames.length > 0;

  const columnInfoSettingContent = (
      <DataGridColumnInfoPopoverContent
          darkMode={darkMode}
          showColumnComment={showColumnComment}
          showColumnType={showColumnType}
          showRowNumberColumn={resolvedShowRowNumberColumn}
          columnSearchText={columnSearchText}
          allOrderedColumnNames={allOrderedColumnNames}
          localHiddenColumns={localHiddenColumns}
          enableColumnOrderMemory={enableColumnOrderMemory}
          enableHiddenColumnMemory={enableHiddenColumnMemory}
          canResetOrder={!!connectionId && !!dbName && !!tableName && !!tableColumnOrders[`${connectionId}-${dbName}-${tableName}`]}
          canResetHidden={!!connectionId && !!dbName && !!tableName && !!tableHiddenColumns[`${connectionId}-${dbName}-${tableName}`]}
          translate={translateDataGrid}
          onShowColumnCommentChange={(checked) => setQueryOptions({ showColumnComment: checked })}
          onShowColumnTypeChange={(checked) => setQueryOptions({ showColumnType: checked })}
          onShowRowNumberColumnChange={(checked) => setAppearance({ showDataTableRowNumber: checked })}
          onToggleAllColumnsVisibility={toggleAllColumnsVisibility}
          onColumnSearchTextChange={setColumnSearchText}
          onToggleColumnVisibility={toggleColumnVisibility}
          onEnableColumnOrderMemoryChange={setEnableColumnOrderMemory}
          onEnableHiddenColumnMemoryChange={setEnableHiddenColumnMemory}
          onResetOrder={() => {
              if (connectionId && dbName && tableName) {
                  clearTableColumnOrder(connectionId, dbName, tableName);
                  void message.success(translateDataGrid('data_grid.column_settings.reset_order_success'));
              }
          }}
          onResetHidden={() => {
              if (connectionId && dbName && tableName) {
                  clearTableHiddenColumns(connectionId, dbName, tableName);
                  setLocalHiddenColumns([]);
                  void message.success(translateDataGrid('data_grid.column_settings.reset_hidden_success'));
              }
          }}
      />
  );

  const dataContextValue = useMemo(() => ({
      selectedRowKeysRef,
      displayDataRef,
      handleCopyInsert,
      handleCopyUpdate,
      handleCopyDelete,
      handleCopyJson,
      handleCopyCsv,
      handleExportSelected,
      copyToClipboard,
      tableName,
      enableRowContextMenu: false,
      supportsCopyInsert,
  }), [handleCopyCsv, handleCopyDelete, handleCopyInsert, handleCopyJson, handleCopyUpdate, handleExportSelected, copyToClipboard, tableName, supportsCopyInsert]);

  const cellContextMenuValue = useMemo(() => ({
      showMenu: showCellContextMenu,
      handleBatchFillToSelected,
  }), [showCellContextMenu, handleBatchFillToSelected]);

  const rowSelectionConfig = useMemo(() => ({
      selectedRowKeys,
      onChange: setSelectedRowKeys,
      columnWidth: selectionColumnWidth,
      // 与行号列一起左侧固定，横向滚动时仍可勾选/识别行
      fixed: true as const,
      ...(isV2Ui ? {} : {
          renderCell: (_checked: boolean, _record: any, _index: number, originNode: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
                  {originNode}
              </div>
          ),
      }),
  }), [isV2Ui, selectedRowKeys, selectionColumnWidth]);

  const rowPropsFactory = useCallback((record: any) => ({ record } as any), []);

  const totalWidth = tableColumns.reduce((sum: number, col: any) => sum + (Number(col.width) || densityParams.defaultColumnWidth), 0) + selectionColumnWidth;
  const useContextMenuRow = false;
  const tableScrollX = useMemo(() => {
      // rc-table 在 scroll.x 小于容器宽度时会把实际列宽按视口补齐。
      // 这里必须与其使用同一套 scroll.x 口径，否则少字段场景下 header/body 会错位。
      return calculateVirtualTableScrollX({
          totalWidth,
          tableViewportWidth,
          isMacLike,
      });
  }, [totalWidth, isMacLike, tableViewportWidth]);
  const externalHorizontalScrollMetrics = useMemo(() => resolveExternalHorizontalScrollMetrics({
      tableScrollWidth: tableScrollX,
      tableViewportWidth,
      measuredScrollWidth: measuredHorizontalScrollMetrics.scrollWidth,
      measuredClientWidth: measuredHorizontalScrollMetrics.clientWidth,
      measuredTrackClientWidth: measuredHorizontalScrollMetrics.trackClientWidth,
      trackInset: floatingScrollbarInset,
  }), [
      floatingScrollbarInset,
      measuredHorizontalScrollMetrics.clientWidth,
      measuredHorizontalScrollMetrics.scrollWidth,
      measuredHorizontalScrollMetrics.trackClientWidth,
      tableScrollX,
      tableViewportWidth,
  ]);
  const horizontalScrollVisible = isTableSurfaceActive && externalHorizontalScrollMetrics.visible;
  const horizontalScrollWidth = externalHorizontalScrollMetrics.innerWidth;
  const tableScrollConfig = useMemo(() => ({ x: tableScrollX, y: tableHeight }), [tableScrollX, tableHeight]);
  const virtualRowHeightSignature = `${displayRenderVersion}|${effectiveUiScale}`;
  const measuredVirtualRowHeight = virtualRowHeightMeasurement?.signature === virtualRowHeightSignature
      ? virtualRowHeightMeasurement.height
      : undefined;
  const virtualListItemHeight = useMemo(() => (
      isV2Ui
          ? measuredVirtualRowHeight ?? Math.max(1, 28 * effectiveUiScale)
          : undefined
  ), [effectiveUiScale, isV2Ui, measuredVirtualRowHeight]);
  const virtualListItemHeightFixed = !!(
      isV2Ui
      && measuredVirtualRowHeight
      && measuredVirtualRowHeight > 0
      && !virtualEditingCellForRender
  );
  const virtualListItemColumnVirtual = isV2Ui && enableVirtual && !virtualEditingCellForRender;

  useEffect(() => {
      if (!isV2Ui || !enableVirtual || !isTableSurfaceActive || virtualEditingCellForRender) return;
      if (tableRenderData.length === 0) {
          setVirtualRowHeightMeasurement((current) => (
              current?.signature === virtualRowHeightSignature ? null : current
          ));
          return;
      }
      // Keep the handles initialized before scheduling: several host/test
      // environments invoke requestAnimationFrame synchronously.
      let firstRaf = 0;
      let secondRaf = 0;
      firstRaf = requestAnimationFrame(() => {
          firstRaf = 0;
          secondRaf = requestAnimationFrame(() => {
              secondRaf = 0;
              const tableContainer = tableContainerRef.current;
              if (!(tableContainer instanceof HTMLElement)) return;
              const rows = Array.from(tableContainer.querySelectorAll<HTMLElement>(
                  '.ant-table-tbody-virtual-holder-inner .ant-table-row',
              )).slice(0, 6);
              const heights = rows
                  .map((row) => row.getBoundingClientRect().height)
                  .filter((height) => Number.isFinite(height) && height > 0);
              if (heights.length === 0) return;
              const minHeight = Math.min(...heights);
              const maxHeight = Math.max(...heights);
              // Fixed mode is opt-in only while the rendered V2 rows prove that
              // the current layout is uniform. Clear a previous measurement as
              // soon as a data/layout refresh renders mixed heights.
              if (maxHeight - minHeight > 0.05) {
                  setVirtualRowHeightMeasurement((current) => (
                      current?.signature === virtualRowHeightSignature ? null : current
                  ));
                  return;
              }
              const nextHeight = heights.reduce((sum, height) => sum + height, 0) / heights.length;
              setVirtualRowHeightMeasurement((current) => (
                  current?.signature === virtualRowHeightSignature
                  && Math.abs(current.height - nextHeight) < 0.01
                      ? current
                      : { signature: virtualRowHeightSignature, height: nextHeight }
              ));
          });
      });
      return () => {
          if (firstRaf) cancelAnimationFrame(firstRaf);
          if (secondRaf) cancelAnimationFrame(secondRaf);
      };
  }, [enableVirtual, isTableSurfaceActive, isV2Ui, tableRenderData.length, virtualEditingCellForRender, virtualRowHeightSignature]);
  const tableComponents = useMemo(() => {
      const body: Record<string, any> = {};
      // 虚拟表模式下 render() 已返回 EditableCell；这里再挂 body.cell 会形成双层包装，
      // 增加滚动期间的组件与上下文开销。
      if (useInlineEditableBodyCell) {
          body.cell = EditableCell;
      }
      if (useContextMenuRow) {
          body.row = ContextMenuRow;
      }
      return Object.keys(body).length > 0
          ? { body, header: { cell: SortableHeaderCell } }
          : { header: { cell: SortableHeaderCell } };
  }, [useInlineEditableBodyCell, useContextMenuRow]);
  const tableOnRow = useMemo(() => (useContextMenuRow ? rowPropsFactory : undefined), [useContextMenuRow, rowPropsFactory]);

  const resolveVirtualHorizontalElements = useCallback((tableContainer: HTMLElement) => {
      const cached = virtualHorizontalElementsRef.current;
      if (
          cached.tableContainer === tableContainer
          && cached.holderEl?.isConnected
          && cached.innerEl?.isConnected
          && cached.headerEl?.isConnected
      ) {
          return cached;
      }

      const holderEl = tableContainer.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
      const innerEl = holderEl?.querySelector('.ant-table-tbody-virtual-holder-inner') as HTMLElement | null;
      const headerEl = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
      const nextElements = { tableContainer, holderEl, innerEl, headerEl };
      virtualHorizontalElementsRef.current = nextElements;
      return nextElements;
  }, []);

  useEffect(() => {
      if (!isTableSurfaceActive || !enableVirtual) return;
      const tableContainer = tableContainerRef.current;
      if (!(tableContainer instanceof HTMLElement)) return;

      const stopPreviewHeaderScroll = (event: Event) => {
          if (!virtualHorizontalPreviewActiveRef.current) return;
          const target = event.target;
          if (target instanceof HTMLElement && target.classList.contains('ant-table-header')) {
              // rc-table mirrors header scrollLeft back into rc-virtual-list. During a
              // visual preview that would turn every pixel into a React render.
              event.stopPropagation();
          }
      };

      tableContainer.addEventListener('scroll', stopPreviewHeaderScroll, true);
      return () => tableContainer.removeEventListener('scroll', stopPreviewHeaderScroll, true);
  }, [enableVirtual, isTableSurfaceActive]);

  const readVirtualHorizontalOffset = useCallback((tableContainer: HTMLElement): number => {
      const { innerEl, headerEl } = resolveVirtualHorizontalElements(tableContainer);
      // 虚拟表数据区横向靠 marginLeft 驱动（rc-virtual-list 约定），必须以此为准
      if (innerEl instanceof HTMLElement) {
          return Math.max(0, Math.abs(parseFloat(innerEl.style.marginLeft) || 0));
      }
      return headerEl ? Math.max(0, headerEl.scrollLeft) : 0;
  }, [resolveVirtualHorizontalElements]);

  /**
   * 虚拟表横滚视觉同步：
   * - 表体：filler marginLeft = -offset；预览时只移动当前固定单元格，避免修改
   *   继承变量导致整棵虚拟表体重新计算样式
   * - 表头：真实 scrollLeft + sticky 固定全选/行号（不要对 header table 做 transform，
   *   否则会把全选 checkbox / # 裁没或钉飞）
   */
  const syncVirtualHorizontalVisualOffset = useCallback((tableContainer: HTMLElement, nextOffset: number) => {
      const { holderEl, innerEl, headerEl } = resolveVirtualHorizontalElements(tableContainer);
      if (!(holderEl instanceof HTMLElement) || !(innerEl instanceof HTMLElement)) {
          return null;
      }

      virtualHorizontalPreviewActiveRef.current = true;

      const maxScroll = Math.max(0, tableScrollX - holderEl.clientWidth);
      const clampedOffset = Math.max(0, Math.min(maxScroll, nextOffset));
      const currentOffset = Math.max(0, Math.abs(parseFloat(innerEl.style.marginLeft) || 0));
      const nextMarginLeft = `${-clampedOffset}px`;
      virtualHorizontalPostCommitGuardRef.current?.update(clampedOffset);

      if (innerEl.style.marginLeft !== nextMarginLeft) {
          innerEl.style.marginLeft = nextMarginLeft;
      }

      applyDataGridFixedCellPreviewOffset(tableContainer, clampedOffset);
      if (tableContainer.style.getPropertyValue('--gn-datagrid-h-scroll')) {
          tableContainer.style.removeProperty('--gn-datagrid-h-scroll');
      }
      if (holderEl.style.getPropertyValue('--gn-datagrid-h-scroll')) {
          holderEl.style.removeProperty('--gn-datagrid-h-scroll');
      }

      if (headerEl instanceof HTMLElement) {
          headerEl.style.removeProperty('--gn-datagrid-h-scroll');
          if (Math.abs(headerEl.scrollLeft - clampedOffset) > 1) {
              headerEl.scrollLeft = clampedOffset;
          }
      }

      return { holderEl, innerEl, clampedOffset, currentOffset };
  }, [resolveVirtualHorizontalElements, tableScrollX]);

  virtualHorizontalPostCommitFrameHandlerRef.current = (offset) => {
      const tableContainer = tableContainerRef.current;
      if (!(tableContainer instanceof HTMLElement)) return;
      syncVirtualHorizontalVisualOffset(tableContainer, offset);
  };

  const getVirtualHorizontalPostCommitGuard = useCallback(() => {
      if (virtualHorizontalPostCommitGuardRef.current === null) {
          virtualHorizontalPostCommitGuardRef.current = createDataGridVisualFrameGuard<number>({
              onFrame: (offset) => virtualHorizontalPostCommitFrameHandlerRef.current(offset),
              shouldContinue: () => (
                  externalScrollbarDraggingRef.current
                  || Date.now() < externalScrollInteractionUntilRef.current
                  || !!externalIdleCommitSchedulerRef.current?.hasPending()
                  || externalSyncRafRef.current !== null
                  || externalScrollSettleRafRef.current !== null
                  || pendingExternalScrollLeftRef.current !== null
                  || tableHorizontalWheelRafRef.current !== null
                  || Math.abs(pendingTableHorizontalDeltaRef.current) >= 0.5
              ),
              onStop: () => {
                  virtualHorizontalPreviewActiveRef.current = false;
                  horizontalSyncSourceRef.current = '';
              },
          });
      }
      return virtualHorizontalPostCommitGuardRef.current;
  }, []);

  const scheduleVirtualHorizontalPostCommit = useCallback((tableContainer: HTMLElement, committedOffset: number) => {
      if (!tableContainer.isConnected) return;
      const guard = getVirtualHorizontalPostCommitGuard();
      guard.update(committedOffset);
      guard.start();
  }, [getVirtualHorizontalPostCommitGuard]);

  const applyVirtualHorizontalOffset = useCallback((
      tableContainer: HTMLElement,
      nextOffset: number,
      options?: { forceInternalScroll?: boolean },
  ) => {
      const synced = syncVirtualHorizontalVisualOffset(tableContainer, nextOffset);
      if (!synced) {
          return false;
      }

      const { holderEl, innerEl, clampedOffset, currentOffset } = synced;
      const deltaX = clampedOffset - currentOffset;
      if (Math.abs(deltaX) < 0.5 && !options?.forceInternalScroll) {
          scheduleVirtualHorizontalPostCommit(tableContainer, clampedOffset);
          return true;
      }

      const tableInstance = tableRef.current;
      if (tableInstance && typeof tableInstance.scrollTo === 'function') {
          // 更新 rc-virtual-list 内部 offsetLeft
          tableInstance.scrollTo({ left: clampedOffset });
          commitDataGridFixedCellOffset(tableContainer, innerEl, clampedOffset);
          lastCommittedVirtualHorizontalOffsetRef.current = clampedOffset;
          scheduleVirtualHorizontalPostCommit(tableContainer, clampedOffset);
          return true;
      }

      // 回退：合成 WheelEvent 驱动 rc-virtual-list 内部 offsetLeft state
      holderEl.dispatchEvent(new WheelEvent('wheel', {
          deltaX: deltaX,
          deltaY: 0,
          bubbles: true,
          cancelable: true,
      }));
      commitDataGridFixedCellOffset(tableContainer, innerEl, clampedOffset);
      lastCommittedVirtualHorizontalOffsetRef.current = clampedOffset;
      scheduleVirtualHorizontalPostCommit(tableContainer, clampedOffset);
      return true;
  }, [scheduleVirtualHorizontalPostCommit, syncVirtualHorizontalVisualOffset]);

  const scheduleVirtualHorizontalAlignment = useCallback((preferredLeft?: number) => {
      if (!enableVirtual || !isTableSurfaceActive) return;
      if (virtualHorizontalAlignmentRafRef.current !== null) {
          cancelAnimationFrame(virtualHorizontalAlignmentRafRef.current);
      }
      virtualHorizontalAlignmentRafRef.current = requestAnimationFrame(() => {
          virtualHorizontalAlignmentRafRef.current = null;
          const tableContainer = tableContainerRef.current;
          if (!(tableContainer instanceof HTMLElement)) return;

          virtualHorizontalElementsRef.current = { tableContainer: null, holderEl: null, innerEl: null, headerEl: null };
          const externalScroll = externalHorizontalScrollRef.current;
          const nextLeft = Math.max(0, preferredLeft ?? externalScroll?.scrollLeft ?? lastTableScrollLeftRef.current);
          const applied = applyVirtualHorizontalOffset(tableContainer, nextLeft, { forceInternalScroll: true });
          const resolvedLeft = applied ? readVirtualHorizontalOffset(tableContainer) : nextLeft;
          lastTableScrollLeftRef.current = resolvedLeft;
          if (externalScroll && Math.abs(externalScroll.scrollLeft - resolvedLeft) > 1) {
              externalScroll.scrollLeft = resolvedLeft;
          }
          lastExternalScrollLeftRef.current = externalScroll?.scrollLeft ?? resolvedLeft;
      });
  }, [applyVirtualHorizontalOffset, enableVirtual, isTableSurfaceActive, readVirtualHorizontalOffset]);


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
          && Math.abs(nextScrollLeft - lastCommittedVirtualHorizontalOffsetRef.current)
              >= Math.max(320, visual.holderEl.clientWidth)
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
          const headerEl = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
          const contentEl = tableContainer.querySelector('.ant-table-content') as HTMLElement | null;
          const candidates = [headerEl, contentEl].filter((node): node is HTMLElement => node instanceof HTMLElement);
          const active = candidates.find((target) => target.scrollWidth > target.clientWidth + 1) || candidates[0];
          if (active) {
              return [active];
          }
      }
      return pickHorizontalScrollTargets(tableContainer);
  }, [enableVirtual, pickHorizontalScrollTargets]);

  const pickVerticalScrollTarget = useCallback((tableContainer: HTMLElement): HTMLElement | null => {
      const virtualHolder = tableContainer.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
      const rcVirtualHolder = tableContainer.querySelector('.rc-virtual-list-holder') as HTMLElement | null;
      const body = tableContainer.querySelector('.ant-table-body') as HTMLElement | null;
      return virtualHolder || rcVirtualHolder || body;
  }, []);

  const focusPageFindMatch = useCallback((match: DataGridFindMatch) => {
      if (!match) return;
      const nextSelection = new Set([makeCellKey(match.rowKey, match.columnName)]);
      markCellSelectionUserSelection(false);
      markCellSelectionDeleteEligible(false);
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
      const externalScroll = externalHorizontalScrollRef.current;
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
  }, [enableVirtual, isExternalScrollbarInteractionActive, readVirtualHorizontalOffset]);

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
              if (alreadyCommitted) {
                  const { innerEl } = resolveVirtualHorizontalElements(tableContainer);
                  if (innerEl instanceof HTMLElement) {
                      commitDataGridFixedCellOffset(tableContainer, innerEl, resolvedScrollLeft);
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
  }, [applyVirtualHorizontalOffset, enableVirtual, isExternalScrollbarInteractionActive, readVirtualHorizontalOffset, resolveVirtualHorizontalElements, syncVirtualHorizontalVisualOffset, virtualListItemColumnVirtual]);

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
      if (!(externalScroll instanceof HTMLDivElement)) {
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
          // 用户连续拖动/滚动时，只写 marginLeft、header.scrollLeft 和当前固定单元格。
          // 不在每一帧调用 Table.scrollTo，否则 rc-virtual-list 会随数据量放大渲染开销。
          if (enableVirtual && tableContainer instanceof HTMLElement) {
              if (isExternalScrollbarInteractionActive()) {
                  const visual = syncVirtualHorizontalVisualOffset(tableContainer, requestedExternalScrollLeft);
                  if (visual) {
                      lastTableScrollLeftRef.current = visual.clampedOffset;
                      if (
                          virtualListItemColumnVirtual
                          && Math.abs(visual.clampedOffset - lastCommittedVirtualHorizontalOffsetRef.current)
                              >= Math.max(320, visual.holderEl.clientWidth)
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
              event.preventDefault();
              event.stopPropagation();
              horizontalSyncSourceRef.current = 'table';

              // 空数据回退：virtual-holder 不存在时，手动滚动表头
              const virtualHolder = container.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
              if (!virtualHolder) {
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
  }, [enableVirtual, isTableSurfaceActive, pickHorizontalScrollTargets, scheduleVirtualHorizontalWheel]);

  useEffect(() => {
      if (!isTableSurfaceActive) return;
      const rafId = requestAnimationFrame(() => recalculateTableMetrics(containerRef.current));
      return () => cancelAnimationFrame(rafId);
  }, [isTableSurfaceActive, totalWidth, mergedDisplayData.length, pagination?.total, pagination?.pageSize, recalculateTableMetrics]);

  useEffect(() => {
      if (!horizontalScrollVisible) return;
      scheduleVirtualHorizontalAlignment();
      return () => {
          if (virtualHorizontalAlignmentRafRef.current !== null) {
              cancelAnimationFrame(virtualHorizontalAlignmentRafRef.current);
              virtualHorizontalAlignmentRafRef.current = null;
          }
      };
  }, [horizontalScrollVisible, scheduleVirtualHorizontalAlignment, tableRenderData, tableScrollX, virtualEditingCellForRender]);

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
              headerTable.style.removeProperty('margin-left');
              headerTable.style.removeProperty('transform');
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
      const externalScroll = externalHorizontalScrollRef.current;
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
  }, [isTableSurfaceActive, mergedDisplayData.length, onScrollSnapshotChange, pickHorizontalScrollTargets, pickVerticalScrollTarget, scrollSnapshot]);

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
          if (horizontalSyncSourceRef.current) return;
          scheduleSyncExternalScrollFromTargets(source);
      };

      const bindCurrentTableTargets = () => {
          // Unbind previous targets
          boundTargets.forEach(t => t.removeEventListener('scroll', handleTargetScroll));
          const nextTargets = pickTableToExternalSyncTargets(tableContainer);
          tableScrollTargetsRef.current = nextTargets;
          boundTargets = nextTargets;
          // Bind scroll listener on new targets
          nextTargets.forEach(t => t.addEventListener('scroll', handleTargetScroll, { passive: true }));
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
          boundTargets.forEach(t => t.removeEventListener('scroll', handleTargetScroll));
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
  }, [isTableSurfaceActive, tableScrollX, mergedDisplayData.length, pickTableToExternalSyncTargets, scheduleSyncExternalScrollFromTargets, syncExternalScrollFromTargets]);

  const paginationSummaryText = useMemo(() => {
      if (!pagination) return '';
      return resolvePaginationSummaryText({
          pagination,
          prefersManualTotalCount,
          supportsApproximateTableCount,
          translate: translateDataGrid,
      });
  }, [pagination, prefersManualTotalCount, supportsApproximateTableCount, translateDataGrid]);

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
  const legacyAiButtonStyle: React.CSSProperties | undefined = isV2Ui ? undefined : {
      background: darkMode ? 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.05))' : 'linear-gradient(135deg, rgba(16,185,129,0.1), rgba(16,185,129,0.02))',
      borderColor: darkMode ? 'rgba(16,185,129,0.3)' : 'rgba(16,185,129,0.4)',
      color: '#10b981',
      fontWeight: 500,
      boxShadow: darkMode ? '0 2px 8px rgba(16,185,129,0.1)' : '0 2px 6px rgba(16,185,129,0.05)',
  };
    return (
    <DataGridShell
      {...{
        CellContextMenuContext,
        CustomEvent,
        DataContext,
        DataGridColumnQuickFind,
        DataGridPageFind,
        DataGridPaginationBar,
        DataGridResultViewSwitcher,
        DndContext,
        EditableContext,
        Form,
        JSON,
        Set,
        SortableContext,
        Table,
        activePageFindPosition,
        activeShortcutPlatform,
        addFilter,
        aiShortcutLabel,
        allSelectedAreDeleted,
        applyAllFiltersDisabled,
        applyAllFiltersEnabled,
        applyExternalScrollToTableTargets,
        handleExternalHorizontalScrollPointerDown,
        handleExternalHorizontalScrollPointerRelease,
        handleExternalHorizontalScrollLostPointerCapture,
        applyFilters,
        applyJsonEditor,
        applyQuickWhereCondition,
        applyRowEditor,
        applySortInfo,
        autoCommitFailedTokenRef,
        autoCommitRemainingSeconds,
        batchEditModalOpen,
        batchEditSetNull,
        batchEditValue,
        bgContent,
        bgContextMenu,
        bgFilter,
        canCopyQueryResult,
        canExport,
        canImport,
        canModifyData,
        canOpenObjectDesigner,
        canUndoContextMenuCellChange,
        canViewDdl,
        cellContextMenu,
        cellContextMenuPortalRef,
        cellContextMenuValue,
        cellEditMode,
        cellEditModeRef,
        cellEditorIsJson,
        cellEditorMeta,
        cellEditorOpen: cellEditorOpenForRender,
        cellEditorReadOnly,
        cellEditorViewerMode,
        cellEditorValue,
        clearAllFiltersAndSorts,
        clearAutoCommitTimer,
        clearQuickWhereCondition,
        closeBatchEditModal,
        closeCellEditMode,
        closeCellEditor,
        closeJsonEditor,
        closeRowEditor,
        closestCenter,
        columnInfoSettingContent,
        columnMetaCacheRef,
        columnMetaMap,
        columnMetaMapByLowerName,
        columnQuickFindOptions,
        columnQuickFindText,
        connectionId,
        connections,
        containerRef,
        contextHolder,
        copiedCellPatch,
        copiedRowsForPaste,
        copyRowsForPaste,
        copyToClipboard,
        currentConnConfig,
        designerReadOnly,
        currentTextRow,
        darkMode,
        dataContextValue,
        dataEditAutoCommitDelayMs,
        dataEditCommitMode,
        deleteTargetRowCount,
        dataPanelDirtyRef,
        dataPanelIsJson,
        dataPanelOpen,
        dataPanelOriginalRef,
        dataPanelValue,
        dbName,
        schemaName,
        dbType,
        ddlLoading,
        ddlModalOpen,
        ddlSidebarResizePreviewX,
        ddlSidebarWidth,
        ddlText,
        ddlViewLayout,
        displayColumnNames,
        displayOutputColumnNames,
        effectiveEditLocator,
        enableVirtual,
        exportProgressModal,
        externalHorizontalScrollRef,
        externalScrollbarMinWidth,
        filterConditions,
        filterLogicOptions,
        filterOpOptions,
        filterPanelRef,
        filterTopPadding,
        focusedCellInfo,
        focusedCellWritable,
        foreignKeyCacheRef,
        form,
        formatTextViewValue,
        getTargets,
        getTemporalPickerType,
        gridCssText,
        gridFieldSelectOptions,
        gridId,
        handleAddRow,
        handleBatchFillCells,
        handleBatchFillToSelected,
        handleCellEditorSave,
        handleCellSetNull,
        handleSetNullForSelectedCells,
        handleClosePageFind,
        handleCommit,
        handleCopyContextMenuFieldName,
        handleCopyCsv,
        handleCopyDdl,
        handleCopyDelete,
        handleCopyInsert,
        handleCopyJson,
        handleCopyQueryResultCsv,
        handleCopyRowData,
        handleCopySelectedCellsToClipboard,
        handleCopySelectedColumnsFromRow,
        handleCopyUpdate,
        handleDataPanelFormatJson,
        handleDataPanelSave,
        handleDataGridRootPointerDownCapture,
        closeDdlView,
        handleDdlSidebarResizeStart,
        handleDeleteSelected,
        handleDragEnd,
        handleExportSelected,
        handleFormatJsonEditor,
        handleFormatJsonInEditor,
        handleImport,
        handleImportSuccess,
        handleNavigatePageFind,
        handleOpenContextMenuRowEditor,
        handleOpenExportDialog,
        handleOpenJsonEditor,
        handleOpenTableDdl,
        handlePageSizeChange,
        handlePasteCopiedColumnsToSelectedRows,
        handlePasteCopiedRowsAsNew,
        handlePreviewChanges,
        handleQuickWherePaste,
        handleSubmitColumnQuickFind,
        handleTableChange,
        handleUndoContextMenuCellChange,
        handleUndoDeleteSelected,
        handleV2CellContextMenuAction,
        handleV2ColumnHeaderContextMenuAction,
        handleV2PageStep,
        handleViewModeChange,
        handleVirtualTableClickCapture,
        handleVirtualTableContextMenuCapture,
        handleVirtualTableDoubleClickCapture,
        hasChanges,
        headerCellMinHeight,
        horizontalListSortingStrategy,
        horizontalScrollVisible,
        horizontalScrollWidth,
        importFilePath,
        importPreviewVisible,
        isBetweenOp,
        isListOp,
        isNoValueOp,
        isQueryResultExport,
        isTableSurfaceActive,
        isV2Ui,
        isWritableResultColumn,
        jsonEditorOpen,
        jsonEditorValue,
        jsonViewText,
        legacyAiButtonStyle,
        loading,
        localizedDataEditAutoCommitDelayOptions,
        looksLikeJsonText,
        mergedDisplayData,
        metadataCacheKey,
        noAutoCapInputProps,
        normalizedPageFindText,
        onCancelTotalCount,
        onOpenErTable: openTableByName,
        onPageChange,
        onLastPage,
        onReload: exportScope === 'queryResult'
            ? () => {
                setFilterConditions([]);
                clearQuickWhereCondition();
                onReload?.();
            }
            : onReload,
        onRequestTotalCount,
        onSort,
        onToggleFilter,
        openBatchEditModal,
        openCurrentViewRowEditor,
        openRowEditorFieldEditor,
        pageFindMatches,
        pageFindInputRef,
        pageFindOpen,
        pageFindSummary,
        pageFindText,
        pagination,
        allowCustomPageSize: Boolean(pagination && queryMaxRows !== undefined),
        paginationControlTotal,
        paginationHasKnownTotalPages,
        paginationPageSizeOptions,
        paginationPageText,
        paginationSummaryText,
        paginationTotalPages,
        paginationV2SummaryText,
        panelFrameColor,
        panelOuterGap,
        panelPaddingX,
        panelPaddingY,
        panelRadius,
        pendingChangeCount,
        pinnedLeftColumnScope,
        pinnedLeftColumnSet,
        pkColumns,
        prefersManualTotalCount,
        previewModalOpen,
        previewSqlData,
        queryResultCopyMenu,
        quickWhereCondition,
        quickWhereDraft,
        quickWhereSuggestionOptions,
        quickWhereSuggestionsOpen,
        readOnly,
        removeFilter,
        renderGridFieldSelectOption,
        resetCellSelection,
        resolveColumnQuickFindTarget,
        resolveContextMenuFieldName,
        resolveWhereConditionSelectedValue,
        rootRef,
        rowClassName,
        rowEditorDisplayRef,
        rowEditorForm,
        rowEditorNullColsRef,
        rowEditorOpen,
        rowEditorRowKey,
        rowSelectionConfig,
        selectedCells,
        selectedCellCount,
        selectedCellRowCount,
        selectedRowCount,
        fillTemplateTargetRowCount,
        selectedRowKeys,
        selectionAccentHex,
        sensors,
        setAddedRows,
        setBatchEditSetNull,
        setBatchEditValue,
        setCellContextMenu,
        setCellEditMode,
        setCellEditorValue,
        setColumnQuickFindText,
        setDataEditTransactionOptions,
        setDataPanelValue,
        setDdlModalOpen,
        setDdlViewLayout,
        setDeletedRowKeys,
        setImportFilePath,
        setImportPreviewVisible,
        setJsonEditorValue,
        setMetadataReloadVersion,
        setModifiedColumns,
        setModifiedRows,
        setPageFindText,
        setPreviewModalOpen,
        setQuickWhereDraft,
        setQuickWhereSuggestionsOpen,
        setSelectedRowKeys,
        setTextRecordIndex,
        setTimeout,
        shouldApplyQuickWhereOnEnter,
        showColumnComment,
        showColumnType,
        showFilter,
        sortInfo,
        stopQuickWhereClipboardPropagation,
        supportsCopyInsert,
        tableBodyBottomPadding,
        tableColumns,
        tableComponents,
        tableContainerRef,
        tableName,
        tableOnRow,
        tableRef,
        tableRenderData,
        tableScrollConfig,
        textRecordIndex,
        textViewRows,
        toggleDataPanel,
        toolbarBottomPadding,
        toolbarDividerColor,
        toolbarExtraActions,
        translateDataGrid,
        uniqueKeyGroupsCacheRef,
        updateFilter,
        useCallback,
        useMemo,
        useStore,
        viewMode,
        virtualListItemHeight,
        virtualListItemHeightFixed,
        virtualListItemColumnVirtual,
        window,
      }}
    />
  );
};

// 使用 ErrorBoundary 包裹 DataGrid，防止数据渲染错误导致应用崩溃
const MemoizedDataGrid = React.memo(DataGrid);

const DataGridWithErrorBoundary: React.FC<DataGridProps> = (props) => {
    const language = useDataGridI18nLanguage();

    return (
        <DataGridErrorBoundary i18nLanguage={language}>
            <MemoizedDataGrid {...props} />
        </DataGridErrorBoundary>
    );
};

export default DataGridWithErrorBoundary;
