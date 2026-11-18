import type React from 'react';

import {
  DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
  type TableOverviewCompactColumn,
} from '../../utils/tableOverviewCompactColumns';
import type { TableOverviewSortField } from '../../utils/tableOverviewFilter';

export interface TableOverviewCompactColumnDefinition {
  key: TableOverviewCompactColumn;
  labelKey: string;
  minWidth: number;
  flex: number;
  align: 'left' | 'right';
  sortField?: TableOverviewSortField;
}

export const TABLE_OVERVIEW_COMPACT_COLUMN_DEFINITIONS: Record<
  TableOverviewCompactColumn,
  TableOverviewCompactColumnDefinition
> = {
  name: {
    key: 'name',
    labelKey: 'table_overview.sort.name',
    minWidth: 190,
    flex: 1.7,
    align: 'left',
    sortField: 'name',
  },
  comment: {
    key: 'comment',
    labelKey: 'table_overview.metric.comment',
    minWidth: 170,
    flex: 1.4,
    align: 'left',
    sortField: 'comment',
  },
  rows: {
    key: 'rows',
    labelKey: 'table_overview.sort.rows',
    minWidth: 88,
    flex: 0.65,
    align: 'right',
    sortField: 'rows',
  },
  dataSize: {
    key: 'dataSize',
    labelKey: 'table_overview.metric.data_size',
    minWidth: 104,
    flex: 0.75,
    align: 'right',
    sortField: 'dataSize',
  },
  indexSize: {
    key: 'indexSize',
    labelKey: 'table_overview.metric.index_size',
    minWidth: 104,
    flex: 0.75,
    align: 'right',
    sortField: 'indexSize',
  },
  engine: {
    key: 'engine',
    labelKey: 'table_overview.metric.engine',
    minWidth: 100,
    flex: 0.75,
    align: 'left',
    sortField: 'engine',
  },
  charset: {
    key: 'charset',
    labelKey: 'table_overview.metric.charset',
    minWidth: 104,
    flex: 0.7,
    align: 'left',
    sortField: 'charset',
  },
  collation: {
    key: 'collation',
    labelKey: 'table_overview.metric.collation',
    minWidth: 150,
    flex: 1.05,
    align: 'left',
    sortField: 'collation',
  },
  updateTime: {
    key: 'updateTime',
    labelKey: 'table_overview.metric.updated_at',
    minWidth: 154,
    flex: 1.1,
    align: 'left',
    sortField: 'updateTime',
  },
  createTime: {
    key: 'createTime',
    labelKey: 'table_overview.metric.created_at',
    minWidth: 154,
    flex: 1.1,
    align: 'left',
    sortField: 'createTime',
  },
};

export const TABLE_OVERVIEW_COMPACT_COLUMN_OPTIONS = DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS
  .map((key) => TABLE_OVERVIEW_COMPACT_COLUMN_DEFINITIONS[key]);

export const resolveTableOverviewCompactColumnDefinitions = (
  columns: TableOverviewCompactColumn[],
): TableOverviewCompactColumnDefinition[] => (
  columns.map((key) => TABLE_OVERVIEW_COMPACT_COLUMN_DEFINITIONS[key])
);

export const buildTableOverviewCompactGridStyle = (
  columns: TableOverviewCompactColumn[],
): React.CSSProperties => {
  const definitions = resolveTableOverviewCompactColumnDefinitions(columns);
  const minWidth = definitions.reduce((total, column) => total + column.minWidth, 0);
  return {
    '--gn-table-overview-compact-columns': definitions
      .map((column) => `minmax(${column.minWidth}px, ${column.flex}fr)`)
      .join(' '),
    '--gn-table-overview-compact-min-width': `${minWidth}px`,
  } as React.CSSProperties;
};
