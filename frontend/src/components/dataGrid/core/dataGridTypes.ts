import React from 'react';
import type { Reference as TableReference } from 'rc-table';
import type { ColumnMeta } from '../../dataGridColumnMeta';
import type { FilterCondition } from '../../../utils/sql';
import type { EditRowLocator } from '../../../utils/rowLocator';
import type { DataGridSessionStateProps } from '../../useControllableDataGridSelection';

export interface Item {
  [key: string]: any;
}

export interface DataGridProps {
    data: any[];
    columnNames: string[];
    loading: boolean;
    tableName?: string;
    /** Optional display-state identity for query results without a physical table. */
    columnPinScope?: string;
    objectType?: 'table' | 'view' | 'materialized-view';
    exportScope?: 'table' | 'queryResult';
    resultSql?: string;
    resultExportAllSql?: string;
    dbName?: string;
    schemaName?: string;
    /** DDL 查询使用的数据库/命名空间；查询结果页不复用列元数据目标。 */
    ddlDbName?: string;
    /** DDL 查询使用的表名；查询结果页仅在该目标明确时显示 DDL 入口。 */
    ddlTableName?: string;
    connectionId?: string;
    /** Query-result connection params snapshot (for example PostgreSQL search_path). */
    connectionParamsOverride?: string;
    pkColumns?: string[];
    editLocator?: EditRowLocator;
    readOnly?: boolean;
    showRowNumberColumn?: boolean;
    onReload?: () => void | Promise<void>;
    onSort?: (field: string, order: string) => void;
    onPageChange?: (page: number, size: number) => void;
    onLastPage?: (pageSize: number) => void;
    /** SQL query max rows used only as a result-grid page-size suggestion. */
    queryMaxRows?: number;
    pagination?: {
        current: number,
        pageSize: number,
        total: number,
        totalKnown?: boolean,
        totalApprox?: boolean,
        approximateTotal?: number,
        totalCountLoading?: boolean,
        totalCountCancelled?: boolean,
        totalCountUnavailableLabel?: string,
        totalCountUnavailableReason?: string,
    };
    onRequestTotalCount?: () => void;
    onCancelTotalCount?: () => void;
    sortInfoExternal?: Array<{ columnKey: string, order: string, enabled?: boolean }>;
    // Filtering
    showFilter?: boolean;
    onToggleFilter?: () => void;
    exportSqlWithFilter?: string;
    onApplyFilter?: (conditions: GridFilterCondition[]) => void;
    appliedFilterConditions?: FilterCondition[];
    quickWhereCondition?: string;
    onApplyQuickWhereCondition?: (condition: string) => void;
    scrollSnapshot?: { top: number; left: number };
    onScrollSnapshotChange?: (snapshot: { top: number; left: number }) => void;
    toolbarExtraActions?: React.ReactNode;
    isActive?: boolean;
    enableSqlLogEvent?: boolean;
    initialViewMode?: GridViewMode;
    initialViewModeRequestId?: string;
    initialViewModeScope?: 'shared' | 'local';
    onDataViewActivate?: () => void;
    onDataChange?: (rows: any[]) => void;
    /** Workbench tab that owns editable changes in this grid. */
    workbenchTabId?: string;
    /** Metadata already loaded while preparing a query execution plan. */
    initialColumnMetaMap?: Record<string, ColumnMeta>;
    initialUniqueKeyGroups?: string[][];
    sessionState?: DataGridSessionStateProps;
}

export type GridFilterCondition = FilterCondition & {
    id: number;
    column: string;
    op: string;
    value: string;
    value2?: string;
};

export type GridViewMode = 'table' | 'json' | 'text' | 'fields' | 'ddl' | 'er' | 'sqlLog';
export type DdlViewLayoutMode = 'bottom' | 'side';
export type DataGridExportScope = 'selected' | 'page' | 'all' | 'filteredAll';
export type VirtualEditingCellState = {
    sessionId: number;
    rowKey: string;
    dataIndex: string;
    title: React.ReactNode;
    columnType?: string;
};

export type ForeignKeyTarget = {
    columnName: string;
    refTableName: string;
    refColumnName: string;
    constraintName: string;
};

export type VirtualTableScrollReference = TableReference & {
    scrollTo: (config: { left?: number; top?: number; index?: number; key?: React.Key }) => void;
};
